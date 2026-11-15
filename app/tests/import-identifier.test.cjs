const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const {
  parseIdentifier,
  resolveArxiv,
  resolveDoi,
  downloadArxivPdf,
  downloadPdfUrl,
  importIdentifier,
  MAX_PDF_BYTES,
} = require('../electron/import-identifier.cjs');

const ARXIV_TITLE = 'Distilling Long Context Models for Efficient Retrieval';
const ARXIV_ABSTRACT = 'We study & measure retrieval quality.';

const ATOM = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <link href="http://arxiv.org/api/query?search_query%3D%26id_list%3D2409.19256" rel="self" type="application/atom+xml"/>
  <title type="html">ArXiv Query: search_query=&amp;id_list=2409.19256</title>
  <id>http://arxiv.org/api/xxxxxxxxxxxxxxxxxxxxxxxx</id>
  <updated>2024-10-01T00:00:00-04:00</updated>
  <opensearch:totalResults xmlns:opensearch="http://a9.com/-/spec/opensearch/1.1/">1</opensearch:totalResults>
  <entry>
    <id>http://arxiv.org/abs/2409.19256v2</id>
    <updated>2024-10-02T10:00:00Z</updated>
    <published>2024-09-30T17:59:59Z</published>
    <title>Distilling   Long Context
      Models for Efficient Retrieval</title>
    <summary>  We study &amp; measure
      retrieval quality.  </summary>
    <author><name>Alice Zhang</name></author>
    <author><name>Bob Martin</name></author>
    <arxiv:doi xmlns:arxiv="http://arxiv.org/schemas/atom">10.1145/3600006.3613139</arxiv:doi>
    <arxiv:journal_ref xmlns:arxiv="http://arxiv.org/schemas/atom">NeurIPS 2024</arxiv:journal_ref>
    <link href="http://arxiv.org/abs/2409.19256v2" rel="alternate" type="text/html"/>
  </entry>
</feed>`;

const EMPTY_ATOM = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title type="html">ArXiv Query: search_query=&amp;id_list=2409.00000</title>
  <id>http://arxiv.org/api/empty</id>
  <opensearch:totalResults xmlns:opensearch="http://a9.com/-/spec/opensearch/1.1/">0</opensearch:totalResults>
</feed>`;

const DOI = '10.1145/3600006.3613139';
const DOI_TITLE = 'Distilling Long Context Models for Efficient Retrieval';
const DOI_ABSTRACT = 'We study <retrieval> quality & speed.';
const CROSSREF = {
  status: 'ok',
  message: {
    DOI,
    title: [DOI_TITLE],
    author: [
      { given: 'Alice', family: 'Zhang' },
      { given: 'Bob', family: 'Martin' },
      { name: 'Moonlight Research Group' },
    ],
    'container-title': ['Proceedings of the 30th ACM SIGKDD'],
    'published-print': { 'date-parts': [[2024, 8, 1]] },
    abstract: '<jats:p>We study &lt;retrieval&gt; quality &amp; speed.</jats:p>',
    link: [
      { URL: 'https://example.org/paper.html', 'content-type': 'text/html' },
      { URL: 'https://example.org/paper.pdf', 'content-type': 'application/pdf' },
    ],
    relation: { 'is-preprint-of': [{ id: '10.48550/arXiv.2409.19256', 'id-type': 'doi' }] },
  },
};

// ---- test doubles -------------------------------------------------------

function headerMap(values = {}) {
  const map = new Map();
  for (const [key, value] of Object.entries(values)) map.set(key.toLowerCase(), String(value));
  return { get: (name) => map.get(String(name).toLowerCase()) ?? null };
}

function textResponse(body, { status = 200, contentType = 'text/plain', extra = {} } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: headerMap({ 'content-type': contentType, ...extra }),
    async text() { return body; },
    async json() { return JSON.parse(body); },
    async arrayBuffer() { return Buffer.from(body).buffer; },
  };
}

function jsonResponse(value, options = {}) {
  return textResponse(JSON.stringify(value), { contentType: 'application/json', ...options });
}

function binaryResponse(bytes, { status = 200, contentLength } = {}) {
  const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  const extra = contentLength === undefined ? {} : { 'content-length': String(contentLength) };
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: headerMap({ 'content-type': 'application/pdf', ...extra }),
    async arrayBuffer() { return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength); },
    async text() { return buffer.toString('latin1'); },
  };
}

function streamResponse(chunks, { status = 200 } = {}) {
  let index = 0;
  const cancelled = [];
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: headerMap({ 'content-type': 'application/pdf' }),
    cancelled,
    body: {
      getReader() {
        return {
          async read() {
            if (index >= chunks.length) return { done: true, value: undefined };
            return { done: false, value: new Uint8Array(chunks[index++]) };
          },
          async cancel() { cancelled.push(true); },
          releaseLock() {},
        };
      },
    },
  };
}

/** Route fake fetches by URL substring/RegExp and record every request. */
function fakeFetch(routes) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    const hit = routes.find(([match]) => (typeof match === 'string' ? String(url).includes(match) : match.test(String(url))));
    if (!hit) throw new Error(`unexpected fetch: ${url}`);
    return typeof hit[1] === 'function' ? hit[1](String(url), init) : hit[1];
  };
  return { fetchImpl, calls };
}

/** Record sidecar calls and answer method by method. */
function fakeSidecar(handlers) {
  const calls = [];
  const call = async (method, params, timeoutMs) => {
    calls.push({ method, params, timeoutMs });
    const handler = handlers[method];
    if (!handler) throw new Error(`unexpected sidecar call: ${method}`);
    return typeof handler === 'function' ? handler(params) : handler;
  };
  return { call, calls };
}

async function tempDir(t) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'moonlight-import-test-'));
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));
  return dir;
}

async function seedPdf(dir, name = 'arxiv-2409.19256v2.pdf') {
  const file = path.join(dir, name);
  await fsp.writeFile(file, Buffer.from('%PDF-1.7\n% test\n'));
  return file;
}

// ---- parseIdentifier ----------------------------------------------------

test('parseIdentifier accepts arXiv ids, versions and arXiv URLs', () => {
  const cases = [
    ['2409.19256', { kind: 'arxiv', id: '2409.19256' }],
    ['  2409.19256  ', { kind: 'arxiv', id: '2409.19256' }],
    ['2409.19256v2', { kind: 'arxiv', id: '2409.19256', version: 'v2' }],
    ['2409.19256v10', { kind: 'arxiv', id: '2409.19256', version: 'v10' }],
    ['arXiv:2409.19256v2', { kind: 'arxiv', id: '2409.19256', version: 'v2' }],
    ['ARXIV: 2409.19256', { kind: 'arxiv', id: '2409.19256' }],
    ['https://arxiv.org/abs/2409.19256', { kind: 'arxiv', id: '2409.19256' }],
    ['http://www.arxiv.org/abs/2409.19256v2', { kind: 'arxiv', id: '2409.19256', version: 'v2' }],
    ['https://export.arxiv.org/abs/2409.19256v1', { kind: 'arxiv', id: '2409.19256', version: 'v1' }],
    ['https://arxiv.org/pdf/2409.19256v2.pdf', { kind: 'arxiv', id: '2409.19256', version: 'v2' }],
    ['arxiv.org/abs/hep-th/9901001', { kind: 'arxiv', id: 'hep-th/9901001' }],
    ['https://arxiv.org/abs/2409.19256?context=cs.CL', { kind: 'arxiv', id: '2409.19256' }],
  ];
  for (const [input, expected] of cases) assert.deepEqual(parseIdentifier(input), expected, input);
});

test('parseIdentifier accepts DOIs and doi.org links', () => {
  const cases = [
    [DOI, { kind: 'doi', id: DOI }],
    ['doi:10.1000/xyz123', { kind: 'doi', id: '10.1000/xyz123' }],
    ['DOI: 10.1000/xyz123', { kind: 'doi', id: '10.1000/xyz123' }],
    [`https://doi.org/${DOI}`, { kind: 'doi', id: DOI }],
    [`https://dx.doi.org/${DOI}`, { kind: 'doi', id: DOI }],
    [`doi.org/${DOI}`, { kind: 'doi', id: DOI }],
    ['https://doi.org/10.1002%2Fadv.202400001', { kind: 'doi', id: '10.1002/adv.202400001' }],
  ];
  for (const [input, expected] of cases) assert.deepEqual(parseIdentifier(input), expected, input);
});

test('parseIdentifier rejects empty, unknown and over-long input', () => {
  assert.throws(() => parseIdentifier(''), /请输入 arXiv ID/);
  assert.throws(() => parseIdentifier('   '), /请输入 arXiv ID/);
  assert.throws(() => parseIdentifier(42), /请输入 arXiv ID/);
  assert.throws(() => parseIdentifier('hello world'), /无法识别的标识符/);
  assert.throws(() => parseIdentifier('10.12/too-short'), /无法识别的标识符/);
  assert.throws(() => parseIdentifier('https://example.com/paper.pdf'), /只支持 arXiv 与 doi\.org/);
  assert.throws(() => parseIdentifier('https://arxiv.org/abs/not-an-id'), /无法从该 arXiv 链接中识别编号/);
  assert.throws(() => parseIdentifier('https://doi.org/not-a-doi'), /无法从该 doi\.org 链接中识别 DOI/);
  assert.throws(() => parseIdentifier(`10.1000/${'x'.repeat(600)}`), /标识符过长/);
});

// ---- resolveArxiv -------------------------------------------------------

test('resolveArxiv parses the Atom entry and validates the requested version', async () => {
  const { fetchImpl, calls } = fakeFetch([['export.arxiv.org/api/query', textResponse(ATOM, { contentType: 'application/atom+xml' })]]);
  const meta = await resolveArxiv('2409.19256v2', { fetchImpl });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://export.arxiv.org/api/query?id_list=2409.19256v2');
  assert.equal(calls[0].init.headers['User-Agent'], 'Moonlight/0.1 (desktop paper reader)');
  assert.equal(calls[0].init.signal instanceof AbortSignal, true);
  assert.equal(meta.title, ARXIV_TITLE);
  assert.deepEqual(meta.authors, ['Alice Zhang', 'Bob Martin']);
  assert.equal(meta.year, 2024);
  assert.equal(meta.arxiv, '2409.19256');
  assert.equal(meta.doi, DOI);
  assert.equal(meta.venue, 'NeurIPS 2024');
  assert.equal(meta.abstract, ARXIV_ABSTRACT);
  assert.equal(meta.source, 'arxiv');

  const base = await resolveArxiv('2409.19256', { fetchImpl });
  assert.equal(base.arxiv, '2409.19256');

  // Legacy ids keep their readable slash in the API query.
  const legacy = ATOM.replace('abs/2409.19256v2', 'abs/hep-th/9901001');
  const legacyCalls = fakeFetch([['export.arxiv.org', textResponse(legacy)]]);
  const legacyMeta = await resolveArxiv('hep-th/9901001', { fetchImpl: legacyCalls.fetchImpl });
  assert.equal(legacyCalls.calls[0].url, 'https://export.arxiv.org/api/query?id_list=hep-th/9901001');
  assert.equal(legacyMeta.arxiv, 'hep-th/9901001');
});

test('resolveArxiv rejects a mismatched or unavailable arXiv version', async () => {
  const mismatched = ATOM.replace('abs/2409.19256v2', 'abs/2409.99999v2');
  await assert.rejects(
    resolveArxiv('2409.19256', { fetchImpl: fakeFetch([['export.arxiv.org', textResponse(mismatched)]]).fetchImpl }),
    /不一致/
  );
  await assert.rejects(
    resolveArxiv('2409.19256v3', { fetchImpl: fakeFetch([['export.arxiv.org', textResponse(ATOM)]]).fetchImpl }),
    /没有 2409\.19256v3/
  );
  await assert.rejects(resolveArxiv('not-an-id'), /arXiv 编号无效/);
});

test('resolveArxiv reports missing entries, HTTP failures and network errors readably', async () => {
  await assert.rejects(
    resolveArxiv('2409.19256', { fetchImpl: fakeFetch([['export.arxiv.org', textResponse(EMPTY_ATOM)]]).fetchImpl }),
    /没有找到 2409\.19256/
  );
  await assert.rejects(
    resolveArxiv('2409.19256', { fetchImpl: fakeFetch([['export.arxiv.org', textResponse('nope', { status: 404 })] ]).fetchImpl }),
    /arXiv 元数据请求失败：HTTP 404/
  );
  await assert.rejects(
    resolveArxiv('2409.19256', {
      fetchImpl: async () => { throw new Error('getaddrinfo ENOTFOUND export.arxiv.org'); },
    }),
    /网络请求失败：getaddrinfo ENOTFOUND/
  );
  const aborted = Object.assign(new Error('The operation was aborted'), { name: 'AbortError' });
  await assert.rejects(
    resolveArxiv('2409.19256', { fetchImpl: async () => { throw aborted; } }),
    /超时/
  );
  const hanging = (_url, init) => new Promise((_resolve, reject) => {
    init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
  });
  await assert.rejects(resolveArxiv('2409.19256', { fetchImpl: hanging, timeoutMs: 10 }), /超时/);
  // A fetch that ignores AbortSignal must still time out instead of hanging the main process.
  await assert.rejects(resolveArxiv('2409.19256', { fetchImpl: () => new Promise(() => {}), timeoutMs: 10 }), /超时/);
});

// ---- resolveDoi ---------------------------------------------------------

test('resolveDoi parses Crossref metadata, the PDF link and a related arXiv id', async () => {
  const { fetchImpl, calls } = fakeFetch([['api.crossref.org/works/', jsonResponse(CROSSREF)]]);
  const meta = await resolveDoi(DOI, { fetchImpl });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, `https://api.crossref.org/works/${encodeURIComponent(DOI)}`);
  assert.equal(calls[0].init.headers.Accept, 'application/json');
  assert.equal(meta.title, DOI_TITLE);
  assert.deepEqual(meta.authors, ['Alice Zhang', 'Bob Martin', 'Moonlight Research Group']);
  assert.equal(meta.year, 2024);
  assert.equal(meta.venue, 'Proceedings of the 30th ACM SIGKDD');
  assert.equal(meta.doi, DOI);
  assert.equal(meta.arxiv, '2409.19256');
  assert.equal(meta.abstract, DOI_ABSTRACT);
  assert.equal(meta.pdfUrl, 'https://example.org/paper.pdf');
  assert.equal(meta.source, 'doi');
});

test('resolveDoi rejects a mismatched DOI and unreadable payloads', async () => {
  const mismatched = { ...CROSSREF, message: { ...CROSSREF.message, DOI: '10.1145/9999999.9999999' } };
  await assert.rejects(
    resolveDoi(DOI, { fetchImpl: fakeFetch([['api.crossref.org', jsonResponse(mismatched)]]).fetchImpl }),
    /与请求的 10\.1145\/3600006\.3613139 不一致/
  );
  await assert.rejects(
    resolveDoi(DOI, { fetchImpl: fakeFetch([['api.crossref.org', textResponse('<html>oops</html>', { contentType: 'text/html' })]]).fetchImpl }),
    /无法解析/
  );
  await assert.rejects(
    resolveDoi(DOI, { fetchImpl: fakeFetch([['api.crossref.org', jsonResponse({ status: 'ok' })]]).fetchImpl }),
    /没有返回/
  );
  await assert.rejects(
    resolveDoi(DOI, {
      fetchImpl: fakeFetch([['api.crossref.org', jsonResponse({ message: { DOI, title: [] } })]]).fetchImpl,
    }),
    /标题/
  );
  await assert.rejects(
    resolveDoi(DOI, { fetchImpl: fakeFetch([['api.crossref.org', textResponse('missing', { status: 404 })]]).fetchImpl }),
    /Crossref 元数据请求失败：HTTP 404/
  );
  await assert.rejects(resolveDoi('not-a-doi'), /DOI 格式无效/);
});

test('resolveDoi tolerates a record without an open PDF or arXiv relation', async () => {
  const plain = {
    message: {
      DOI,
      title: [DOI_TITLE],
      author: [{ given: 'Alice', family: 'Zhang' }],
      issued: { 'date-parts': [[2023]] },
      link: [],
    },
  };
  const meta = await resolveDoi(DOI, { fetchImpl: fakeFetch([['api.crossref.org', jsonResponse(plain)]]).fetchImpl });
  assert.equal(meta.year, 2023);
  assert.equal(meta.arxiv, undefined);
  assert.equal(meta.pdfUrl, undefined);
  assert.equal(meta.venue, '');
});

// ---- PDF download -------------------------------------------------------

test('downloadArxivPdf writes a validated PDF into the temp directory', async (t) => {
  const dir = await tempDir(t);
  const pdf = Buffer.from('%PDF-1.7\n% moonlight test\n');
  const { fetchImpl, calls } = fakeFetch([['arxiv.org/pdf/', binaryResponse(pdf, { contentLength: pdf.length })]]);
  const file = await downloadArxivPdf('2409.19256v2', dir, { fetchImpl });
  assert.equal(calls[0].url, 'https://arxiv.org/pdf/2409.19256v2');
  assert.equal(path.dirname(file), dir);
  assert.match(path.basename(file), /^arxiv-2409\.19256v2-\d+-[0-9a-f]{8}\.pdf$/);
  assert.deepEqual(await fsp.readFile(file), pdf);

  const legacy = await downloadArxivPdf('hep-th/9901001', dir, { fetchImpl });
  assert.match(path.basename(legacy), /^arxiv-hep-th-9901001-\d+-[0-9a-f]{8}\.pdf$/);
});

test('downloadArxivPdf streams the body and rejects non-PDF payloads', async (t) => {
  const dir = await tempDir(t);
  const chunks = [Buffer.from('%PDF-1.4'), Buffer.from(' streamed body')];
  const stream = streamResponse(chunks);
  const file = await downloadArxivPdf('2409.19256', dir, { fetchImpl: fakeFetch([['arxiv.org/pdf/', stream]]).fetchImpl });
  assert.deepEqual(await fsp.readFile(file), Buffer.concat(chunks));

  const html = Buffer.from('<html>not a pdf</html>');
  await assert.rejects(
    downloadArxivPdf('2409.19256', dir, { fetchImpl: fakeFetch([['arxiv.org/pdf/', binaryResponse(html)]]).fetchImpl }),
    /不是 PDF/
  );
});

test('downloadArxivPdf enforces the 80MB size cap and readable HTTP errors', async (t) => {
  const dir = await tempDir(t);
  assert.equal(MAX_PDF_BYTES, 80 * 1024 * 1024);

  const huge = Buffer.alloc(64 * 1024, 1);
  await assert.rejects(
    downloadArxivPdf('2409.19256', dir, { fetchImpl: fakeFetch([['arxiv.org/pdf/', binaryResponse(huge, { contentLength: 100 * 1024 * 1024 })]]).fetchImpl }),
    /超过 80MB/
  );
  await assert.rejects(
    downloadPdfUrl('https://arxiv.org/pdf/2409.19256', dir, { fetchImpl: fakeFetch([['arxiv.org', binaryResponse(huge)]]).fetchImpl, maxBytes: 10 }),
    /上限/
  );
  const stream = streamResponse([Buffer.alloc(8, 1), Buffer.alloc(8, 1)]);
  await assert.rejects(
    downloadPdfUrl('https://arxiv.org/pdf/2409.19256', dir, { fetchImpl: fakeFetch([['arxiv.org', stream]]).fetchImpl, maxBytes: 10 }),
    /上限/
  );
  assert.equal(stream.cancelled.length, 1);
  await assert.rejects(
    downloadPdfUrl('https://arxiv.org/pdf/2409.19256', dir, { fetchImpl: () => new Promise(() => {}), timeoutMs: 10 }),
    /超时/
  );
  await assert.rejects(
    downloadArxivPdf('2409.19256', dir, { fetchImpl: fakeFetch([['arxiv.org/pdf/', textResponse('gone', { status: 404 })]]).fetchImpl }),
    /HTTP 404/
  );
  await assert.rejects(
    downloadPdfUrl('http://example.org/paper.pdf', dir, { fetchImpl: fakeFetch([['example.org', binaryResponse(Buffer.from('%PDF-1.4'))]]).fetchImpl }),
    /只支持 https/
  );
});

// ---- importIdentifier ---------------------------------------------------

test('importIdentifier imports an arXiv paper, completes metadata and cleans the temp PDF', async (t) => {
  const dir = await tempDir(t);
  const pdfFile = await seedPdf(dir);
  const sidecar = fakeSidecar({
    import_pdfs: [{ status: 'imported', paper_id: 'paper-1', title: 'PDF 内嵌标题' }],
    save_paper: (params) => ({ id: params.paper_id, ...params.fields }),
  });
  const { fetchImpl, calls: fetches } = fakeFetch([['export.arxiv.org/api/query', textResponse(ATOM)]]);
  const downloads = [];
  const download = async (id, destDir) => { downloads.push({ id, destDir }); return pdfFile; };

  const result = await importIdentifier({ input: 'arXiv:2409.19256v2', callSidecar: sidecar.call, fetchImpl, tmpDir: dir, download });

  assert.deepEqual(downloads, [{ id: '2409.19256v2', destDir: dir }]);
  assert.equal(fetches[0].url, 'https://export.arxiv.org/api/query?id_list=2409.19256v2');
  assert.deepEqual(sidecar.calls.map((entry) => entry.method), ['import_pdfs', 'save_paper']);
  assert.deepEqual(sidecar.calls[0].params, { paths: [pdfFile] });
  assert.equal(sidecar.calls[0].timeoutMs, 10 * 60 * 1000);
  assert.equal(sidecar.calls[1].params.paper_id, 'paper-1');
  assert.deepEqual(sidecar.calls[1].params.fields, {
    title: ARXIV_TITLE,
    authors: 'Alice Zhang, Bob Martin',
    year: '2024',
    venue: 'NeurIPS 2024',
    doi: DOI,
    arxiv: '2409.19256',
    abstract: ARXIV_ABSTRACT,
  });
  assert.deepEqual(result, {
    status: 'imported',
    paper_id: 'paper-1',
    title: ARXIV_TITLE,
    source: 'arxiv',
    metadata_filled: true,
    doi: DOI,
    arxiv: '2409.19256',
  });
  assert.equal(fs.existsSync(pdfFile), false, 'temporary PDF must be removed after the import');
});

test('importIdentifier reports an existing paper as duplicate without touching metadata', async (t) => {
  const dir = await tempDir(t);
  const pdfFile = await seedPdf(dir);
  const sidecar = fakeSidecar({
    import_pdfs: [{ status: 'duplicate', paper_id: 'paper-9', title: '库中已有标题' }],
  });

  const result = await importIdentifier({
    input: '2409.19256',
    callSidecar: sidecar.call,
    fetchImpl: fakeFetch([['export.arxiv.org', textResponse(ATOM)]]).fetchImpl,
    tmpDir: dir,
    download: async () => pdfFile,
  });

  assert.deepEqual(result, {
    status: 'duplicate',
    paper_id: 'paper-9',
    title: '库中已有标题',
    source: 'arxiv',
    message: '论文库中已存在这篇论文，未重复导入',
    doi: DOI,
    arxiv: '2409.19256',
  });
  assert.deepEqual(sidecar.calls.map((entry) => entry.method), ['import_pdfs']);
  assert.equal(fs.existsSync(pdfFile), false);
});

test('importIdentifier falls back to refresh_metadata when save_paper is rejected', async (t) => {
  const dir = await tempDir(t);
  const sidecar = fakeSidecar({
    import_pdfs: [{ status: 'imported', paper_id: 'paper-2', title: 'PDF 标题' }],
    save_paper: () => { throw new Error('标题不能为空'); },
    refresh_metadata: (params) => {
      assert.deepEqual(params, { paper_id: 'paper-2', force: true });
      return { id: 'paper-2', title: '刷新后的标题', updated_fields: ['title'] };
    },
  });

  const result = await importIdentifier({
    input: '2409.19256',
    callSidecar: sidecar.call,
    fetchImpl: fakeFetch([['export.arxiv.org', textResponse(ATOM)]]).fetchImpl,
    tmpDir: dir,
    download: async () => seedPdf(dir),
  });

  assert.equal(result.status, 'imported');
  assert.equal(result.metadata_filled, true);
  assert.equal(result.warning, undefined);
  assert.deepEqual(sidecar.calls.map((entry) => entry.method), ['import_pdfs', 'save_paper', 'refresh_metadata']);
});

test('importIdentifier still imports when metadata completion fails completely', async (t) => {
  const dir = await tempDir(t);
  const sidecar = fakeSidecar({
    import_pdfs: [{ status: 'imported', paper_id: 'paper-3', title: 'PDF 标题' }],
    save_paper: () => { throw new Error('boom'); },
    refresh_metadata: () => { throw new Error('网络不可用'); },
  });

  const result = await importIdentifier({
    input: '2409.19256',
    callSidecar: sidecar.call,
    fetchImpl: fakeFetch([['export.arxiv.org', textResponse(ATOM)]]).fetchImpl,
    tmpDir: dir,
    download: async () => seedPdf(dir),
  });

  assert.equal(result.status, 'imported');
  assert.equal(result.paper_id, 'paper-3');
  assert.equal(result.metadata_filled, false);
  assert.equal(result.warning, '已在论文库中，但元数据补全失败：网络不可用');
});

test('importIdentifier imports a DOI paper through the Crossref PDF link', async (t) => {
  const dir = await tempDir(t);
  const pdfFile = await seedPdf(dir, 'doi-paper.pdf');
  const sidecar = fakeSidecar({
    import_pdfs: [{ status: 'imported', paper_id: 'paper-4', title: 'PDF 标题' }],
    save_paper: (params) => ({ id: params.paper_id, title: params.fields.title }),
  });
  const downloads = [];
  const downloadUrl = async (url, destDir) => { downloads.push({ url, destDir }); return pdfFile; };

  const result = await importIdentifier({
    input: `https://doi.org/${DOI}`,
    callSidecar: sidecar.call,
    fetchImpl: fakeFetch([['api.crossref.org/works/', jsonResponse(CROSSREF)]]).fetchImpl,
    tmpDir: dir,
    downloadUrl,
  });

  assert.deepEqual(downloads, [{ url: 'https://example.org/paper.pdf', destDir: dir }]);
  assert.deepEqual(sidecar.calls[0].params, { paths: [pdfFile] });
  assert.equal(result.status, 'imported');
  assert.equal(result.source, 'doi');
  assert.equal(result.doi, DOI);
  assert.equal(result.arxiv, '2409.19256');
  assert.deepEqual(sidecar.calls[1].params.fields, {
    title: DOI_TITLE,
    authors: 'Alice Zhang, Bob Martin, Moonlight Research Group',
    year: '2024',
    venue: 'Proceedings of the 30th ACM SIGKDD',
    doi: DOI,
    arxiv: '2409.19256',
    abstract: DOI_ABSTRACT,
  });
});

test('importIdentifier rejects a DOI without an open PDF before touching the sidecar', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'moonlight-import-test-'));
  try {
    const closed = { message: { DOI, title: [DOI_TITLE], author: [], link: [] } };
    const sidecar = fakeSidecar({});
    await assert.rejects(
      importIdentifier({
        input: DOI,
        callSidecar: sidecar.call,
        fetchImpl: fakeFetch([['api.crossref.org', jsonResponse(closed)]]).fetchImpl,
        tmpDir: dir,
        downloadUrl: async () => { throw new Error('must not download'); },
      }),
      /该 DOI 没有可下载的开放 PDF/
    );
    assert.deepEqual(sidecar.calls, []);
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test('importIdentifier reports sidecar failures readably and cleans up the temp PDF', async (t) => {
  const dir = await tempDir(t);
  const pdfFile = await seedPdf(dir, 'broken.pdf');
  const sidecar = fakeSidecar({
    import_pdfs: [{ status: 'failed', path: pdfFile, error: 'not a PDF file' }],
  });

  await assert.rejects(
    importIdentifier({
      input: '2409.19256',
      callSidecar: sidecar.call,
      fetchImpl: fakeFetch([['export.arxiv.org', textResponse(ATOM)]]).fetchImpl,
      tmpDir: dir,
      download: async () => pdfFile,
    }),
    /PDF 入库失败：not a PDF file/
  );
  assert.equal(fs.existsSync(pdfFile), false);

  const noId = fakeSidecar({ import_pdfs: [{ status: 'imported' }] });
  await assert.rejects(
    importIdentifier({
      input: '2409.19256',
      callSidecar: noId.call,
      fetchImpl: fakeFetch([['export.arxiv.org', textResponse(ATOM)]]).fetchImpl,
      tmpDir: dir,
      download: async () => seedPdf(dir, 'missing-id.pdf'),
    }),
    /缺少论文编号/
  );
});

test('importIdentifier validates its arguments before any network access', async () => {
  await assert.rejects(importIdentifier({ input: '2409.19256' }), /缺少 sidecar/);
  await assert.rejects(
    importIdentifier({ input: 'hello world', callSidecar: async () => assert.fail('sidecar must not be called') }),
    /无法识别的标识符/
  );
});
