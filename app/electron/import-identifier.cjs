/**
 * Import a paper from an arXiv identifier/URL or a DOI.
 *
 * Flow: parse identifier → resolve metadata (arXiv Atom / Crossref JSON) →
 * download an open PDF into a temp file → `import_pdfs` through the sidecar →
 * complete title/authors/year/venue/abstract with `save_paper` (falling back to
 * `refresh_metadata`) → return a small renderer-safe result object.
 *
 * Everything that touches the network, the filesystem temp dir or the sidecar is
 * injectable so the node regression tests never hit the internet:
 *
 *   importIdentifier({input, callSidecar, fetchImpl?, tmpDir?, download?, downloadUrl?})
 *
 * The module runs in the Electron main process (Node) only; the renderer never
 * sees paths or network access.
 */
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

const ARXIV_QUERY = 'https://export.arxiv.org/api/query?id_list=';
const CROSSREF_WORKS = 'https://api.crossref.org/works/';
const ARXIV_PDF = 'https://arxiv.org/pdf/';
const MAX_PDF_BYTES = 80 * 1024 * 1024; // arXiv PDFs are far smaller; refuse anything absurd.
const MAX_INPUT_LENGTH = 512;
const META_TIMEOUT_MS = 20 * 1000;
const DOWNLOAD_TIMEOUT_MS = 60 * 1000;
const IMPORT_TIMEOUT_MS = 10 * 60 * 1000;
const SAVE_TIMEOUT_MS = 60 * 1000;
const USER_AGENT = 'Moonlight/0.1 (desktop paper reader)';

// ---- small text helpers -------------------------------------------------

function collapse(value) {
  return String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
}

function decodeXml(value) {
  const codePoint = (text, radix) => {
    const code = parseInt(text, radix);
    try {
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : '';
    } catch {
      return '';
    }
  };
  return String(value)
    .replace(/&#x([0-9a-f]+);/gi, (_match, code) => codePoint(code, 16))
    .replace(/&#(\d+);/g, (_match, code) => codePoint(code, 10))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&');
}

/** Strip markup (Crossref JATS, Atom CDATA) and normalise whitespace. */
function plainText(value) {
  const stripped = String(value == null ? '' : value)
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/<[^>]*>/g, ' ');
  return collapse(decodeXml(stripped));
}

function firstString(value) {
  if (typeof value === 'string') return collapse(value);
  if (Array.isArray(value)) {
    for (const entry of value) {
      const text = firstString(entry);
      if (text) return text;
    }
  }
  return '';
}

// ---- transport ----------------------------------------------------------

function timeoutSignal(ms) {
  const controller = new AbortController();
  // Keep the timer ref'd while awaiting: it is always cleared in the caller's
  // finally block, and an unref'd timer would let a test process (or a quiet
  // main process) exit before the timeout can fire.
  let timer;
  // Resolves (never rejects) when the deadline passes, so callers can race it
  // with their own labelled error.
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => {
      controller.abort(new Error('timeout'));
      resolve();
    }, ms);
  });
  return { signal: controller.signal, timeout, cancel: () => clearTimeout(timer) };
}

function timeoutError(label) {
  return new Error(`${label}超时，请检查网络后重试`);
}

function transportError(label, error, signal) {
  const message = error && error.message ? error.message : String(error);
  if (signal?.aborted || (error && error.name === 'AbortError') || /abort/i.test(message)) {
    return new Error(`${label}超时，请检查网络后重试`);
  }
  return new Error(`${label}网络请求失败：${message}`);
}

function httpError(label, status) {
  const hint =
    status === 404 ? '（内容不存在）'
      : status === 429 ? '（请求过于频繁，请稍后重试）'
        : status >= 500 ? '（服务暂时不可用）'
          : '';
  return new Error(`${label}请求失败：HTTP ${status || '未知'}${hint}`);
}

async function openResponse(url, { fetchImpl, label = '请求', headers, signal } = {}) {
  const fetcher = fetchImpl || globalThis.fetch;
  if (typeof fetcher !== 'function') throw new Error('当前运行环境不支持网络请求');
  let response;
  try {
    response = await fetcher(url, {
      method: 'GET',
      redirect: 'follow',
      headers: { 'User-Agent': USER_AGENT, Accept: '*/*', ...headers },
      signal,
    });
  } catch (error) {
    throw transportError(label, error, signal);
  }
  const status = Number(response && response.status) || 0;
  const ok = typeof response?.ok === 'boolean' ? response.ok : status >= 200 && status < 300;
  if (!ok) throw httpError(label, status);
  return response;
}

/** GET with a hard timeout that also covers a stalled response body. */
async function request(url, { fetchImpl, timeoutMs = META_TIMEOUT_MS, label = '请求', headers } = {}) {
  const { signal, timeout, cancel } = timeoutSignal(timeoutMs);
  try {
    return await Promise.race([
      openResponse(url, { fetchImpl, label, headers, signal }),
      timeout.then(() => { throw timeoutError(label); }),
    ]);
  } finally {
    cancel();
  }
}

async function readJson(response, label) {
  try {
    return await response.json();
  } catch {
    throw new Error(`${label}返回的数据无法解析，请确认标识符是否正确`);
  }
}

async function readText(response, label) {
  try {
    return await response.text();
  } catch {
    throw new Error(`${label}返回的内容无法读取`);
  }
}

function limitError(label, maxBytes) {
  return new Error(`${label}文件超过 ${Math.round(maxBytes / 1024 / 1024)}MB 上限，已取消下载`);
}

/** Read a response body as a Buffer, refusing anything larger than maxBytes. */
async function responseBytes(response, maxBytes, label) {
  const declared = Number(response?.headers?.get?.('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) throw limitError(label, maxBytes);
  const body = response?.body;
  if (body && typeof body.getReader === 'function') {
    const reader = body.getReader();
    const chunks = [];
    let total = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = Buffer.from(value);
        total += chunk.length;
        if (total > maxBytes) {
          await reader.cancel().catch(() => {});
          throw limitError(label, maxBytes);
        }
        chunks.push(chunk);
      }
    } finally {
      reader.releaseLock?.();
    }
    return Buffer.concat(chunks, total);
  }
  if (typeof response?.arrayBuffer !== 'function') throw new Error(`${label}响应无法读取`);
  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.length > maxBytes) throw limitError(label, maxBytes);
  return buffer;
}

// ---- identifier parsing -------------------------------------------------

/** Split "2409.19256v2" / "arXiv:2409.19256" / an arXiv URL into base + version. */
function splitArxiv(value) {
  const text = String(value == null ? '' : value)
    .trim()
    .replace(/^arxiv\s*:\s*/i, '')
    .replace(/[?#].*$/, '')
    .replace(/^(?:https?:\/\/)?(?:export\.|www\.)?arxiv\.org\/(?:abs|pdf)\//i, '')
    .replace(/\.pdf$/i, '')
    .replace(/\/+$/, '')
    .trim();
  const match = /^(\d{4}\.\d{4,5}|[A-Za-z.-]+\/\d{7})(v\d+)?$/.exec(text);
  if (!match) return null;
  const result = { id: match[1].toLowerCase() };
  if (match[2]) result.version = match[2].toLowerCase();
  return result;
}

function isDoi(value) {
  return /^10\.\d{4,9}\/\S+$/.test(value) && value.length <= 500;
}

function arxivIdentifier(parsed) {
  const result = { kind: 'arxiv', id: parsed.id };
  if (parsed.version) result.version = parsed.version;
  return result;
}

function parseIdentifier(input) {
  const raw = typeof input === 'string' ? input.trim() : '';
  if (!raw) throw new Error('请输入 arXiv ID、arXiv 链接或 DOI');
  if (raw.length > MAX_INPUT_LENGTH) throw new Error(`标识符过长（最多 ${MAX_INPUT_LENGTH} 个字符），请只粘贴一条标识符`);

  const arxiv = splitArxiv(raw);
  if (arxiv) return arxivIdentifier(arxiv);

  const doiText = raw.replace(/^doi\s*:\s*/i, '').trim();
  if (isDoi(doiText)) return { kind: 'doi', id: doiText };

  const url = parseUrl(raw);
  if (url) {
    const host = url.hostname.toLowerCase();
    if (host === 'doi.org' || host.endsWith('.doi.org')) {
      const doi = safeDecode(url.pathname.replace(/^\//, '')).trim();
      if (!isDoi(doi)) throw new Error(`无法从该 doi.org 链接中识别 DOI：${raw}`);
      return { kind: 'doi', id: doi };
    }
    if (host === 'arxiv.org' || host.endsWith('.arxiv.org')) {
      throw new Error(`无法从该 arXiv 链接中识别编号：${raw}`);
    }
    throw new Error(`暂时只支持 arXiv 与 doi.org 链接：${raw}`);
  }

  throw new Error(`无法识别的标识符：${raw}。请输入 arXiv ID（如 2409.19256）、arXiv 链接或 DOI（如 10.1145/3600006.3613139）`);
}

function parseUrl(raw) {
  try {
    const url = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
    if (!/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(url.hostname)) return null;
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    return url;
  } catch {
    return null;
  }
}

function safeDecode(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

// ---- arXiv metadata -----------------------------------------------------

function arxivYear(feed) {
  const published = tagText(feed, 'published');
  const match = /\b(19|20)\d{2}\b/.exec(published) || /\b(19|20)\d{2}\b/.exec(tagText(feed, 'updated'));
  return match ? Number(match[0]) : null;
}

function tagText(xml, tag) {
  const pattern = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`);
  const match = pattern.exec(xml);
  return match ? plainText(match[1]) : '';
}

function arxivEntryId(value) {
  const match = /(?:abs|pdf)\/([^?#]+)$/.exec(String(value || '').trim());
  return match ? splitArxiv(match[1]) : null;
}

async function resolveArxiv(identifier, { fetchImpl, timeoutMs = META_TIMEOUT_MS } = {}) {
  const parsed = splitArxiv(identifier);
  if (!parsed) throw new Error(`arXiv 编号无效：${identifier}`);
  const requested = parsed.id + (parsed.version || '');
  const label = 'arXiv 元数据';
  // The id is already validated against a strict pattern; keep "/" readable for
  // legacy ids (hep-th/9901001) instead of percent-encoding it.
  const response = await request(`${ARXIV_QUERY}${requested}`, {
    fetchImpl,
    timeoutMs,
    label,
    headers: { Accept: 'application/atom+xml, application/xml;q=0.9, */*;q=0.8' },
  });
  const feed = await readText(response, label);
  const entry = /<entry(?:\s[^>]*)?>([\s\S]*?)<\/entry>/.exec(feed);
  if (!entry) throw new Error(`arXiv 上没有找到 ${requested}（可能编号有误或尚未公开）`);
  const body = entry[1];
  const found = arxivEntryId(tagText(body, 'id') || '');
  if (!found) throw new Error(`arXiv 返回的编号无法识别，已停止导入`);
  if (found.id !== parsed.id) throw new Error(`arXiv 返回的编号（${found.id}）与请求的 ${parsed.id} 不一致，已停止导入`);
  if (parsed.version && found.version !== parsed.version) {
    throw new Error(`arXiv 上没有 ${parsed.id}${parsed.version}（返回的是 ${found.id}${found.version || ''}），已停止导入`);
  }
  const title = tagText(body, 'title');
  if (!title) throw new Error(`arXiv 没有返回 ${requested} 的标题，已停止导入`);
  const authors = [...body.matchAll(/<author(?:\s[^>]*)?>([\s\S]*?)<\/author>/g)]
    .map((match) => tagText(match[1], 'name'))
    .filter(Boolean);
  const metadata = {
    title,
    authors,
    year: arxivYear(body),
    arxiv: found.id,
    source: 'arxiv',
  };
  const doi = tagText(body, 'arxiv\\:doi');
  if (doi) metadata.doi = doi;
  const venue = tagText(body, 'arxiv\\:journal_ref');
  if (venue) metadata.venue = venue;
  const abstract = tagText(body, 'summary');
  if (abstract) metadata.abstract = abstract;
  return metadata;
}

// ---- Crossref (DOI) metadata -------------------------------------------

function crossrefAuthors(message) {
  const list = Array.isArray(message?.author) ? message.author : [];
  const names = [];
  for (const author of list) {
    const given = typeof author?.given === 'string' ? author.given.trim() : '';
    const family = typeof author?.family === 'string' ? author.family.trim() : '';
    const literal = typeof author?.name === 'string' ? author.name.trim() : '';
    const name = collapse([given, family].filter(Boolean).join(' ')) || literal;
    if (name) names.push(name);
  }
  return names;
}

function crossrefYear(message) {
  for (const key of ['published-print', 'published-online', 'issued', 'created']) {
    const year = message?.[key]?.['date-parts']?.[0]?.[0];
    const value = Number(year);
    if (Number.isFinite(value) && value > 1800) return value;
  }
  return null;
}

function crossrefArxiv(message) {
  const candidates = [];
  for (const relations of Object.values(message?.relation || {})) {
    if (!Array.isArray(relations)) continue;
    for (const relation of relations) if (typeof relation?.id === 'string') candidates.push(relation.id);
  }
  for (const id of Array.isArray(message?.['alternative-id']) ? message['alternative-id'] : []) candidates.push(String(id));
  for (const link of Array.isArray(message?.link) ? message.link : []) if (typeof link?.URL === 'string') candidates.push(link.URL);
  for (const candidate of candidates) {
    const direct = splitArxiv(candidate);
    if (direct) return direct.id;
    const asDoi = /^10\.48550\/arxiv\.(.+)$/i.exec(candidate.trim());
    if (asDoi) {
      const parsed = splitArxiv(asDoi[1]);
      if (parsed) return parsed.id;
    }
    const inUrl = /arxiv\.org\/(?:abs|pdf)\/([^\s?#]+)/i.exec(candidate);
    if (inUrl) {
      const parsed = splitArxiv(inUrl[1]);
      if (parsed) return parsed.id;
    }
  }
  return null;
}

function crossrefPdfUrl(message) {
  const links = Array.isArray(message?.link) ? message.link : [];
  for (const link of links) {
    const url = typeof link?.URL === 'string' ? link.URL : '';
    const type = String(link?.['content-type'] || '').toLowerCase();
    if (/^https:\/\//i.test(url) && (type === 'application/pdf' || /\.pdf(?:$|\?)/i.test(url))) return url;
  }
  const primary = message?.resource?.primary?.URL;
  if (typeof primary === 'string' && /^https:\/\//i.test(primary) && /\.pdf(?:$|\?)/i.test(primary)) return primary;
  return null;
}

async function resolveDoi(identifier, { fetchImpl, timeoutMs = META_TIMEOUT_MS } = {}) {
  const requested = String(identifier || '').trim();
  if (!isDoi(requested)) throw new Error(`DOI 格式无效：${identifier}`);
  const label = 'Crossref 元数据';
  const response = await request(`${CROSSREF_WORKS}${encodeURIComponent(requested)}`, {
    fetchImpl,
    timeoutMs,
    label,
    headers: { Accept: 'application/json' },
  });
  const body = await readJson(response, label);
  const message = body?.message;
  if (!message || typeof message !== 'object') throw new Error(`${label}没有返回 ${requested} 的资料`);
  const returned = firstString(message.DOI);
  if (!returned || returned.toLowerCase() !== requested.toLowerCase()) {
    throw new Error(`Crossref 返回的 DOI（${returned || '空'}）与请求的 ${requested} 不一致，已停止导入`);
  }
  const title = firstString(message.title);
  if (!title) throw new Error(`Crossref 没有返回 ${requested} 的标题，已停止导入`);
  const metadata = {
    title,
    authors: crossrefAuthors(message),
    year: crossrefYear(message),
    venue: firstString(message['container-title']) || firstString(message['short-container-title']),
    doi: returned,
    source: 'doi',
  };
  const arxiv = crossrefArxiv(message);
  if (arxiv) metadata.arxiv = arxiv;
  const abstract = plainText(firstString(message.abstract));
  if (abstract) metadata.abstract = abstract.slice(0, 20000);
  const pdfUrl = crossrefPdfUrl(message);
  if (pdfUrl) metadata.pdfUrl = pdfUrl;
  return metadata;
}

// ---- PDF download -------------------------------------------------------

function sanitizeFileName(value) {
  return String(value || '')
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'paper';
}

async function downloadPdfUrl(url, destDir, options = {}) {
  const { fetchImpl, timeoutMs = DOWNLOAD_TIMEOUT_MS, maxBytes = MAX_PDF_BYTES, label = 'PDF 下载', name } = options;
  if (!/^https:\/\//i.test(String(url))) throw new Error(`只支持 https 下载地址：${url}`);
  const directory = destDir || path.join(os.tmpdir(), 'moonlight-import');
  await fsp.mkdir(directory, { recursive: true });
  const { signal, timeout, cancel } = timeoutSignal(timeoutMs);
  let bytes;
  try {
    const body = (async () => {
      const response = await openResponse(String(url), {
        fetchImpl,
        signal,
        label,
        headers: { Accept: 'application/pdf,*/*;q=0.8' },
      });
      return responseBytes(response, maxBytes, label);
    })();
    bytes = await Promise.race([body, timeout.then(() => { throw timeoutError(label); })]);
  } finally {
    cancel();
  }
  if (bytes.length < 5 || bytes.subarray(0, 5).toString('latin1') !== '%PDF-') {
    throw new Error(`${label}到的文件不是 PDF（缺少 %PDF 头），该文献可能没有开放版本`);
  }
  const file = path.join(directory, `${sanitizeFileName(name || 'paper')}-${Date.now()}-${randomUUID().slice(0, 8)}.pdf`);
  await fsp.writeFile(file, bytes, { mode: 0o600 });
  return file;
}

async function downloadArxivPdf(identifier, destDir, options = {}) {
  const parsed = splitArxiv(identifier);
  if (!parsed) throw new Error(`arXiv 编号无效：${identifier}`);
  const requested = parsed.id + (parsed.version || '');
  return downloadPdfUrl(`${ARXIV_PDF}${requested}`, destDir, {
    ...options,
    label: 'arXiv PDF 下载',
    name: `arxiv-${requested}`,
  });
}

// ---- import orchestration ----------------------------------------------

function metadataFields(metadata) {
  const fields = {};
  const title = collapse(metadata?.title);
  if (title) fields.title = title;
  const authors = Array.isArray(metadata?.authors) ? metadata.authors.map(collapse).filter(Boolean) : [];
  if (authors.length) fields.authors = authors.join(', ');
  const year = Number(metadata?.year);
  if (Number.isFinite(year) && year > 1800) fields.year = String(year);
  for (const [key, value] of [['venue', metadata?.venue], ['doi', metadata?.doi], ['arxiv', metadata?.arxiv], ['abstract', metadata?.abstract]]) {
    const text = collapse(value);
    if (text) fields[key] = key === 'abstract' ? text.slice(0, 20000) : text;
  }
  return fields;
}

function localPath(value) {
  if (typeof value === 'string' && value.trim()) return value;
  if (value && typeof value.path === 'string' && value.path.trim()) return value.path;
  throw new Error('下载 PDF 没有返回本地路径');
}

function sourceOf(kind) {
  return kind === 'arxiv' ? 'arxiv' : 'doi';
}

/**
 * Parse → resolve metadata → fetch an open PDF → import through the sidecar →
 * complete metadata. Resolves to:
 *   {status:'imported', paper_id, title, source, metadata_filled, doi?, arxiv?, warning?}
 *   {status:'duplicate', paper_id, title, source, message, doi?, arxiv?}
 * and rejects with a readable Chinese Error otherwise.
 */
async function importIdentifier({ input, callSidecar, fetchImpl, tmpDir, download = downloadArxivPdf, downloadUrl = downloadPdfUrl } = {}) {
  if (typeof callSidecar !== 'function') throw new Error('缺少 sidecar 调用函数，无法导入论文');
  const parsed = parseIdentifier(input);
  const source = sourceOf(parsed.kind);
  const metadata = parsed.kind === 'arxiv'
    ? await resolveArxiv(parsed.version ? parsed.id + parsed.version : parsed.id, { fetchImpl })
    : await resolveDoi(parsed.id, { fetchImpl });
  const directory = tmpDir || path.join(os.tmpdir(), 'moonlight-import');
  let temporary = null;
  try {
    if (parsed.kind === 'arxiv') {
      temporary = localPath(await download(parsed.version ? parsed.id + parsed.version : parsed.id, directory, { fetchImpl }));
    } else {
      if (!metadata.pdfUrl) throw new Error('该 DOI 没有可下载的开放 PDF，可在浏览器下载后拖入导入');
      temporary = localPath(await downloadUrl(metadata.pdfUrl, directory, { fetchImpl }));
    }
    const imported = await callSidecar('import_pdfs', { paths: [temporary] }, IMPORT_TIMEOUT_MS);
    const first = Array.isArray(imported) ? imported[0] : imported;
    if (!first || typeof first !== 'object') throw new Error('导入 PDF 没有返回结果，请重试');
    if (first.status === 'failed') throw new Error(`PDF 入库失败：${first.error || '未知错误'}`);
    if (typeof first.paper_id !== 'string' || !first.paper_id) throw new Error('导入结果缺少论文编号，请重试');
    const title = collapse(first.title) || collapse(metadata.title);
    if (first.status === 'duplicate') {
      return {
        status: 'duplicate',
        paper_id: first.paper_id,
        title,
        source,
        message: '论文库中已存在这篇论文，未重复导入',
        ...(metadata.doi ? { doi: metadata.doi } : {}),
        ...(metadata.arxiv ? { arxiv: metadata.arxiv } : {}),
      };
    }

    const fields = metadataFields(metadata);
    let metadata_filled = false;
    let warning;
    try {
      if (!fields.title) throw new Error('缺少标题');
      const paper = await callSidecar('save_paper', { paper_id: first.paper_id, fields }, SAVE_TIMEOUT_MS);
      metadata_filled = true;
      if (paper) {
        const savedTitle = collapse(paper.title);
        if (savedTitle) fields.title = savedTitle;
      }
    } catch {
      // Never lose a successful import because metadata completion failed.
      try {
        await callSidecar('refresh_metadata', { paper_id: first.paper_id, force: true }, SAVE_TIMEOUT_MS);
        metadata_filled = true;
      } catch (error) {
        warning = `已在论文库中，但元数据补全失败：${error && error.message ? error.message : error}`;
      }
    }

    const result = {
      status: 'imported',
      paper_id: first.paper_id,
      title: collapse(fields.title) || title,
      source,
      metadata_filled,
    };
    if (metadata.doi) result.doi = metadata.doi;
    if (metadata.arxiv) result.arxiv = metadata.arxiv;
    if (warning) result.warning = warning;
    return result;
  } finally {
    if (temporary) await fsp.rm(temporary, { force: true }).catch(() => {});
  }
}

module.exports = {
  parseIdentifier,
  splitArxiv,
  resolveArxiv,
  resolveDoi,
  downloadArxivPdf,
  downloadPdfUrl,
  importIdentifier,
  MAX_PDF_BYTES,
  MAX_INPUT_LENGTH,
};
