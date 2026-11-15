import { chromium } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';

const base = process.env.MOONLIGHT_PREVIEW || 'http://127.0.0.1:4173';
const outDir = process.env.MOONLIGHT_SHOTS || '/tmp/moonlight-shots';
const pdfPath = process.argv[2] || path.resolve(process.cwd(), '../samples/generated/narrow-column.pdf');
fs.mkdirSync(outDir, { recursive: true });
const pdfBase64 = fs.readFileSync(pdfPath).toString('base64');

const store = {
  categories: [
    { id: 'c1', name: '大模型系统', parent_id: null },
    { id: 'c2', name: '推理与部署', parent_id: 'c1' },
    { id: 'c3', name: '强化学习', parent_id: null },
    { id: 'c4', name: '待读清单', parent_id: null },
  ],
  tags: ['KV Cache', '量化', 'MoE', '对齐', '蒸馏', '长上下文', '端侧', '评测'].map((name, index) => ({ id: `t${index}`, name })),
};
const rows = [
  { title: 'HybridFlow: A Unified Framework for 3D-Parallel LLM Training on Heterogeneous Clusters', authors: 'Zheng Wang, Li Chen, Arun Kumar', year: '2024', venue: 'NeurIPS', doi: '10.48550/arXiv.2409.19256', arxiv: '2409.19256', status: 'unread', citations: 128, source: 'Crossref', translated: true, note: '统一 3D 并行与显存优化，给出可复用的训练编排抽象。' },
  { title: 'Efficient Long-Context Inference with Hierarchical KV Cache Eviction', authors: 'M. Rossi, Y. Tanaka', year: '2025', venue: 'ICML', doi: '10.48550/arXiv.2502.01111', arxiv: '2502.01111', status: 'reading', citations: 64, source: 'Crossref', translated: false, note: '分层 KV 淘汰策略把长上下文显存压到 1/3。' },
  { title: 'Distilling Reasoning Models Without Losing Calibration', authors: 'A. Novak, R. Singh', year: '2024', venue: 'ACL', doi: null, arxiv: '2406.07777', status: 'read', citations: 41, source: 'Semantic Scholar', translated: false, note: '' },
  { title: 'On the Limits of Speculative Decoding at Scale', authors: 'K. Okafor, J. Lindqvist', year: '2023', venue: 'OSDI', doi: '10.1145/3600006.3613139', arxiv: null, status: 'unread', citations: 212, source: 'Crossref', translated: false, note: '' },
  { title: 'Sparse MoE Routing Revisited: Load Balance as a First-Class Citizen', authors: 'H. Park, D. Moreau', year: '2025', venue: 'ICLR', doi: '10.48550/arXiv.2501.09988', arxiv: '2501.09988', status: 'reading', citations: 33, source: 'Crossref', translated: true, note: '路由负载均衡比专家数量更影响吞吐。' },
  { title: 'Benchmarking Retrieval Augmented Generation for Scientific Papers', authors: 'S. Ibrahim, L. Feng', year: '2023', venue: 'EMNLP', doi: null, arxiv: '2310.12345', status: 'read', citations: 87, source: 'Semantic Scholar', translated: false, note: '' },
  { title: 'A Practical Guide to Quantizing Vision-Language Models', authors: 'T. Alvarez, N. Haddad', year: '2024', venue: 'CVPR', doi: '10.1109/CVPR.2024.00123', arxiv: null, status: 'unread', citations: null, source: null, translated: false, note: '' },
  { title: 'Latency-Aware Scheduling for Multi-Tenant Inference Serving', authors: 'E. Johansson, P. Mehta', year: '2022', venue: 'SIGCOMM', doi: '10.1145/3544216.3544260', arxiv: null, status: 'read', citations: 156, source: 'Crossref', translated: false, note: '' },
  { title: 'Alignment Tax or Measurement Artifact?', authors: 'R. Gupta, C. Duarte', year: '2025', venue: 'ICLR', doi: null, arxiv: '2503.00456', status: 'unread', citations: 12, source: 'Semantic Scholar', translated: false, note: '' },
  { title: 'Scaling Laws for Retrieval Memory in Agents', authors: 'Y. Kim, B. Fischer', year: '2024', venue: 'NeurIPS', doi: '10.48550/arXiv.2411.00077', arxiv: '2411.00077', status: 'reading', citations: 58, source: 'Crossref', translated: false, note: '' },
  { title: 'Token-Level Routing for Mixture-of-Experts Transformers', authors: 'F. Costa, L. Nguyen', year: '2021', venue: 'ICML', doi: null, arxiv: null, status: 'read', citations: 301, source: 'Crossref', translated: false, note: '' },
  { title: 'Reproducibility Notes on Large-Scale Pretraining', authors: 'D. Weber, A. Silva', year: '2020', venue: 'JMLR', doi: '10.5555/jmlr.2020.21.77', arxiv: null, status: 'unread', citations: 19, source: 'Crossref', translated: false, note: '' },
].map((row, index) => ({
  ...row,
  id: `p${index + 1}`,
  favorite: index === 1 || index === 4,
  imported_at: Date.now() - index * 86400000,
  updated_at: Date.now() - index * 3600000,
  categories: (index % 3 === 0 ? ['c1', 'c2'] : index % 3 === 1 ? ['c3'] : ['c1']).map((id) => store.categories.find((category) => category.id === id)),
  tags: [store.tags[index % 8], store.tags[(index + 3) % 8]],
}));

const summaryOf = (row) => ({
  id: row.id, title: row.title, authors: row.authors, year: row.year, venue: row.venue, doi: row.doi, arxiv: row.arxiv,
  imported_at: row.imported_at, updated_at: row.updated_at, favorite: row.favorite, read_status: row.status, deleted: false,
  short_note: row.note, citation_count: row.citations, citation_source: row.source, citation_updated_at: Date.now() - 7200000,
  has_translation: row.translated, categories: row.categories, tags: row.tags,
});

async function main() {
  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
  await context.addInitScript(({ store, rows, pdfBase64 }) => {
    const pdf = Uint8Array.from(atob(pdfBase64), (char) => char.charCodeAt(0));
    const summaryOf = (row) => ({
      id: row.id, title: row.title, authors: row.authors, year: row.year, venue: row.venue, doi: row.doi, arxiv: row.arxiv,
      imported_at: row.imported_at, updated_at: row.updated_at, favorite: row.favorite, read_status: row.status, deleted: false,
      short_note: row.note, citation_count: row.citations, citation_source: row.source, citation_updated_at: Date.now() - 7200000,
      has_translation: row.translated, categories: row.categories, tags: row.tags,
    });
    const fullOf = (row) => ({
      ...summaryOf(row),
      abstract: 'We present a unified system design for large-model training and inference on heterogeneous clusters. Our approach combines 3D parallelism with memory-aware scheduling, reducing peak GPU memory by 41% while keeping throughput within 3% of a hand-tuned baseline.',
      notes: '迁移笔记：重点看 4.2 节的显存剖析与附录 A 的消融实验。',
      versions: [{ id: 'v1', paper_id: row.id, kind: 'source', sha256: 'x', rel_path: `${row.id}.pdf`, pages: 3, bytes: pdf.length, lang: 'en', created_at: Date.now() }],
    });
    const send = (method, params) => {
      switch (method) {
        case 'list_papers_page': return Promise.resolve({ items: rows.map(summaryOf), total: 128, offset: 0, limit: 100 });
        case 'list_taxonomy': return Promise.resolve(store);
        case 'sync_status': return Promise.resolve({ configured: false, running: false });
        case 'list_jobs': return Promise.resolve([{ id: 'j1', paper_id: 'p2', status: 'translating', pages: '4-6', created_at: Date.now() - 60000 }]);
        case 'get_paper': {
          const row = rows.find((value) => value.id === params.paper_id) || rows[0];
          return Promise.resolve(fullOf(row));
        }
        case 'save_paper': { const row = rows.find((value) => value.id === params.paper_id) || rows[0]; return Promise.resolve(fullOf(row)); }
        case 'list_annotations': return Promise.resolve([]);
        case 'zotero_files': return Promise.resolve([]);
        case 'document_text_status': return Promise.resolve({ indexed_pages: 1, pages: 3 });
        case 'blocks': return Promise.resolve([]);
        case 'export': return Promise.resolve({ text: '@article{moonlight, title={HybridFlow}}' });
        case 'list_duplicates': return Promise.resolve({ count: 2, groups: [
          { kind: 'doi', key: '10.48550/arXiv.2409.19256', paper_ids: ['p1', 'p4'], count: 2 },
          { kind: 'title', key: 'alignment tax or measurement artifact?', paper_ids: ['p9', 'p12'], count: 2 },
        ] });
        case 'ai_history': return Promise.resolve([
          { id: 'm2', kind: 'ask', question: '作者是如何解决显存瓶颈的？', answer: '作者把 **显存瓶颈** 拆成三类：\n\n1. 参数分片（ZeRO-3）\n2. 激活重计算（checkpointing）\n3. KV Cache 分层淘汰\n\n其中第 3 点带来约 41% 的峰值显存下降 [1]。', sources: [{ version_id: 'v1', n: 1, block_id: 'b1', page: 2, bbox: [10, 20, 300, 40], text: 'memory-aware scheduling reduces peak GPU memory by 41%' }] },
          { id: 'm1', kind: 'ask', question: '总结这篇论文的核心贡献。', answer: '核心贡献是一个统一的 3D 并行编排抽象，以及显存感知的调度策略。', sources: [] },
        ]);
        default: return Promise.resolve({});
      }
    };
    window.moonlight = {
      call: (method, params) => send(method, params),
      pickPdfs: async () => [],
      readPdf: async () => ({ bytes: pdf, versionId: 'v1', pages: 3 }),
      pickDirectory: async () => null,
      revealAttachment: async () => undefined,
      syncSettings: async () => ({ profile: null, credentials_saved: false, auto_minutes: 0 }),
      configureSync: async () => ({}),
      saveText: async () => ({ saved: true, path: '/tmp/out' }),
      translationAction: async (action) => action === 'status' ? ({ base_url: 'https://api.example.com/v1', model: 'gpt-4o-mini', babeldoc: '', qps: 2, key_configured: true, pending_restart: false }) : action === 'test' ? ({ ok: true, model: 'gpt-4o-mini', latency_ms: 218 }) : action === 'checkBabeldoc' ? ({ ok: true, path: '/usr/local/bin/babeldoc', version: 'babeldoc 0.9.2' }) : ({}),
      aiAction: async (action) => action === 'preferences' ? ({ provider: 'api' }) : action === 'status' ? ({ provider: 'api', model: 'gpt-4o-mini', account: null, models: [], loginPending: false }) : action === 'preview' ? ({ prompt: '上下文片段…', history: '', history_count: 0, context_info: { pages: [1, 2], characters: 3200, indexed_pages: 1, total_pages: 3 } }) : ({ answer: '（示例回答）', sources: [] }),
      backup: async () => ({}),
      appInfo: async () => ({ version: '0.1.0', library: '/home/bynshard/Moonlight', headless: false, model: 'qwen3.8-flash', credentialConfigured: true }),
      onEvent: () => () => {},
    };
  }, { store, rows, pdfBase64 });

  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(String(error)));
  page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
  const shot = async (name) => { await page.waitForTimeout(320); await page.screenshot({ path: path.join(outDir, `${name}.png`) }); console.log('shot', name); };

  await page.goto(base, { waitUntil: 'networkidle' });
  await page.waitForSelector('.paper-row', { timeout: 15000 });
  await shot('01-library');
  await page.click('.paper-table-row button[aria-label^="更多操作"]');
  await page.waitForSelector('.context-menu');
  await shot('13-row-menu');
  await page.getByText('编辑资料').click();
  await page.waitForSelector('.paper-editor');
  await shot('14-paper-editor');
  await page.click('button[aria-label="关闭编辑"]');
  await page.getByRole('button', { name: '卡片', exact: true }).click();
  await page.waitForSelector('.card-row');
  await shot('15-cards');
  await page.getByRole('button', { name: '表格', exact: true }).click();

  await page.click('.paper-table-row .paper-title');
  await page.waitForSelector('.inspector-body');
  await page.check('.paper-table-row .table-select input[type="checkbox"]');
  await page.waitForSelector('.batch-bar');
  await shot('02-library-inspector-batch');

  await page.click('button[aria-label="关闭论文详情"]');
  await page.getByText('任务中心').click();
  await page.waitForSelector('.task-center');
  await shot('17-task-center');
  await page.click('button[aria-label="关闭任务中心"]');
  await page.getByText('设置与状态').click();
  await page.waitForSelector('.settings-modal');
  await shot('03-settings-general');
  await page.getByRole('button', { name: '翻译引擎' }).click();
  await shot('04-settings-translation');
  await page.getByRole('button', { name: '测试 API 连接' }).click();
  await page.waitForTimeout(400);
  await shot('04b-translation-test');
  await page.getByRole('button', { name: '检查 BabelDOC' }).click();
  await page.waitForTimeout(400);
  await shot('04c-babeldoc-check');
  await page.getByRole('button', { name: '通用与论文库' }).click();
  await page.getByRole('button', { name: '查找重复论文' }).click();
  await page.waitForSelector('.duplicate-modal');
  await page.waitForTimeout(500);
  await shot('16-duplicates');
  await page.click('button[aria-label="关闭重复论文"]');
  await page.click('button[aria-label="关闭设置"]');
  await page.click('button[aria-label="导入论文"]');
  await page.getByText('通过 DOI / arXiv 导入').click();
  await page.waitForSelector('.identifier-import');
  await shot('12-identifier-import');
  await page.click('button[aria-label="关闭标识符导入"]');
  await page.getByRole('button', { name: '管理', exact: true }).click();
  await page.waitForSelector('.tag-manager');
  await page.click('.tag-list-row');
  await shot('10-tag-manager');
  await page.click('button[aria-label="关闭标签管理"]');
  await page.getByRole('button', { name: '新建 / 管理' }).click();
  await page.waitForSelector('.folder-manager');
  await shot('11-folder-manager');
  await page.click('button[aria-label="关闭目录管理"]');

  await page.dblclick('.paper-table-row .paper-title');
  await page.waitForSelector('canvas[data-rendered="true"]', { timeout: 25000 });
  await shot('05-reader');
  await page.click('button[aria-label="目录与页面导航"]');
  await page.waitForSelector('.reader-nav');
  await shot('06-reader-outline');
  await page.getByRole('button', { name: '页面', exact: true }).click();
  await page.waitForTimeout(1200);
  await shot('07-reader-pages');

  await page.keyboard.press('Control+f');
  await page.waitForSelector('.find-bar');
  await page.fill('input[aria-label="文内查找关键词"]', 'the');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(1000);
  await shot('08-reader-find');
  await page.keyboard.press('Escape');

  await page.evaluate(() => {
    const spans = Array.from(document.querySelectorAll('.textLayer span')).filter((span) => (span.textContent || '').length > 12);
    if (spans.length < 5) return;
    const range = document.createRange();
    range.setStart(spans[2].firstChild, 0);
    range.setEnd(spans[4].firstChild, Math.min(24, spans[4].textContent.length));
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    document.querySelector('.pane-scroll').dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
  });
  await page.waitForSelector('.selection-toolbar', { timeout: 5000 }).catch(() => undefined);
  await shot('09-reader-selection');

  console.log('page errors:', errors.length ? errors.slice(0, 10) : 'none');
  await browser.close();
}
main().catch((error) => { console.error(error); process.exit(1); });
