# Sprint 2 断头路修复记录（2026-11-21）

承接 [vivo Pad 5 Pro 适配与全栈审查](VIVO_PAD5_PRO_REVIEW_AND_DESIGN.md) 的 Sprint 2。2026-11-20 的实现把后端服务端、Range 协议与前端手势都写好了，但前后端之间有 5 处未接通或语义不一致；本次逐条修复，只动这些断点，不新增 Sprint 3/4 功能。

## 0. 结果

| # | 问题 | 状态 | 关键证据 |
| --- | --- | --- | --- |
| 1 | 平板浏览器没有 `window.moonlight`，首屏白屏 | 已修复 | [app/src/api.ts](../app/src/api.ts) 新增 `createHttpBridge()`；新增 `tests/api.test.tsx` 8 项 |
| 2 | `pdf:bytes` 仍全量 `readFile` + IPC；`moonlight-pdf://` 协议与 `/api/pdf` 是死代码 | 已修复 | `PdfBytes.url` + `PdfPane` url 分支；`main.cjs` 返回 Range URL；PdfPane 2 项新测试 |
| 3 | HTTP 端 `list_papers_page` 抢全局写锁 | 已修复 | `search::ReadPool`；`main.rs` HTTP handler 改走只读池；Rust 测试“持有写连接仍可分页” |
| 4 | 8 MP 画布上限压低 3.1K 平板 DPR | 已修复 | `pixelBudget()`：HiDPI 且物理长边 ≥2560 时 12 MP；4 组边界测试 |
| 5 | `include_history` 前后端不一致（预览 0 轮、API 实际仍带 6 轮） | 已修复 | `explain_with` 受开关控制；预览与实际共用同版本/同 6 轮语义；新增 `ai_preview` RPC |

回归（全部实际执行）：

```text
core:  cargo test --release --locked --offline   → 73 passed; 0 failed; 4 ignored
app:   npx tsc --noEmit                          → 0 error
app:   vitest run                                → 12 files / 60 tests passed
app:   node tests/run-node-tests.cjs             → 47 tests, 0 failed
app:   npm run build                             → ✓ built
smoke: core --serve + dist 静态托管              → app_info / list_papers_page / query-token / 401 / 404 / index 均符合预期
```

## 1. 平板 HTTP 桥（`app/src/api.ts`）

`bridge()` 原来无条件返回 `window.moonlight`。在平板 Chrome/PWA 里 preload 不存在，`api.paperPage()` / `api.appInfo()` 一调用就 `TypeError`。

- `bridge()` 现在为：有 Electron preload 用 preload，否则懒加载 `createHttpBridge()`。
- Token：从 `?token=…` 读取，写入 `sessionStorage`（主）+ `localStorage`（PWA 重开可用），随后 `history.replaceState` 把 token 从地址栏删掉；无 token 时给出“请用桌面端显示的带 token 链接重新打开”。
- RPC：`POST /api/rpc`，`Authorization: Bearer <token>`；`401` 转成可操作的“配对已失效”；支持 `timeoutMs` → `AbortController`。
- SSE：`EventSource("/api/events?token=…")`，解析 `message` 后转交 `onEvent`，关闭时 `close()` 并移除监听。
- PDF：先 `paper_pdf` 解析版本，再返回 `/api/pdf/<version>?token=…`，不把整份 PDF 读进内存。
- 首屏信息：core 新增 `app_info` RPC（`main.rs`），返回版本/库路径/模型配置状态。
- AI：`aiAction` 支持 `preferences` / `status` / `preview` / `run` / `cancel`，因此平板上的流式回答（`ai_delta`）与“停止”按钮仍可用；`ai_preview` 保证上下文预览可用。
- 浏览器无文件系统：`saveText` 改为 Blob 下载；选文件、选目录、云端同步、翻译引擎配置等桌面专属操作返回明确的“请在桌面端完成”，而不是崩溃。

## 2. 真正的 Range 流式 PDF（`main.cjs` / `PdfPane.tsx` / `Reader.tsx`）

- Electron `pdf:bytes` 不再 `fs.promises.readFile`，改为返回 `{ url: "moonlight-pdf://version/<id>", versionId, pages }`。
- `moonlight-pdf://` 协议补齐 CORS：`Access-Control-Allow-Origin: *`、`Expose-Headers: Content-Length, Content-Range, Accept-Ranges`，并处理 `OPTIONS`。pdf.js 对非 http(s) scheme 会走 XHR，缺少这些头时 `Content-Range` 不可见，Range 会静默退化为整文件下载。
- `PdfPane` 的 props 变为 `{ bytes?, url? }`：有 `url` 时 `getDocument({ url, rangeChunkSize: 64 * 1024 })`，否则保留 `getDocument({ data })` 兼容旧调用与单测。`Reader` 把 `source.url` / `translated.url` 一起传入。
- 效果：100 MB 扫描件不再经过 主进程堆 → IPC → 渲染进程 `Uint8Array` 的三份拷贝；首屏只需 64 KiB 分块。

## 3. HTTP 分页不再抢写锁（`core/src/search.rs` / `main.rs`）

- 新增 `search::ReadPool`：独立只读连接、每请求一个快照事务、用完回池；`tmp_match_papers` 是连接级临时表，并发搜索互不覆盖。
- HTTP handler 里 `list_papers_page` 直接走 `ReadPool::list_page`，其余方法仍走 `dispatch`，因此 JSONL 侧行为不变。
- JSONL 原有的 4 条只读连接池保持原样。
- 测试：持有 `Library::conn()` 写连接时，池仍能返回正确分页；连续两次分页复用连接。

## 4. 平板画布预算（`app/src/PdfPane.tsx`）

- 旧上限固定 `8_388_608` 像素，vivo Pad 5 Pro（3096×2064，286 PPI）放大到 1.5–2× 时 dpr 被压到 1.0–1.2，字体发糊。
- 新 `pixelBudget(cssLongEdge, dpr)`：`dpr >= 2` 且物理长边 `cssLongEdge * dpr >= 2560` 时 12 MP，否则 8 MP；DPR 仍受 `devicePixelRatio`、单边 16384 与预算三重上限约束。
- 桌面（1440 CSS px @1x）和小尺寸 HiDPI 窗口保持 8 MP，不额外吃显存。

## 5. `include_history` 语义统一（`ai.rs` / `main.rs` / `ai-service.cjs` / `Reader.tsx`）

- `ai::explain_with` 新增 `include_history` 参数；为 false 时完全不读历史，也不再拼进 messages。
- 历史选择抽成 `recent_history()`：同一论文 + 同一原文版本（`sources[].version_id`）、排除翻译记录、候选最近 50 条、取最近 6 轮后恢复正序；与桌面预览的过滤条件一致。
- `main.rs` 的 `explain` 从参数读取开关（默认 true，保持旧调用兼容），返回的 `context_info.history_count` 反映实际轮数。
- `ai-service.cjs` 的 `preview()` 不再只对 `provider === 'codex'` 带历史；API 模式同样按开关读取，因此“历史 N 轮”与实际发送一致。问题/回答截断都改为 4000 字，与后端一致。
- 新增 `ai_preview` RPC（core `ai::preview`），平板 HTTP 桥用它渲染预览；桌面仍走 `ai_prepare + ai_history`，两边语义相同。
- UI 文案去掉“（Codex）”。

## 6. 变更文件

| 文件 | 改动 |
| --- | --- |
| `app/src/api.ts` | `createHttpBridge()`、token 持久化与地址栏清理、RPC/SSE/PDF/AI、浏览器下载兜底 |
| `app/src/types.ts` | `PdfBytes` 增加可选 `url` |
| `app/src/PdfPane.tsx` | `url` Range 加载分支；`pixelBudget` 12 MP 平板预算 |
| `app/src/Reader.tsx` | 传入 PDF `url`；历史开关文案 |
| `app/electron/main.cjs` | `pdf:bytes` 返回 URL；`moonlight-pdf://` CORS/OPTIONS |
| `app/electron/ai-service.cjs` | 预览对 API/Codex 使用同一历史开关 |
| `core/src/ai.rs` | `include_history`、`recent_history`、`preview` 与 3 个测试 |
| `core/src/main.rs` | HTTP `list_papers_page` 走只读池；`app_info` / `ai_preview` RPC |
| `core/src/search.rs` | `ReadPool` + 1 个测试 |
| `app/tests/api.test.tsx` | HTTP 桥 8 项测试（新增文件） |
| `app/tests/PdfPane.test.tsx` | 12 MP 预算 + url/bytes 两条加载路径 |
| `app/tests/codex-client.test.cjs` | API provider 预览历史开关 |

## 7. 未验证 / 仍缺

- **真机与 Electron GUI 未跑**：本机缺少 Chromium/Electron 运行库（`libatk` 等），只能做 Rust/TypeScript/Vitest/Node 与 HTTP 冒烟；`moonlight-pdf://` + pdf.js 的真实 206 行为需在带显示器的机器上确认。
- **桌面端还没有“开启平板服务 / 显示配对二维码”入口**：当前需以 `moonlight-core --root … --serve 0.0.0.0:8765 --static app/dist` 启动，`serve_ready` 事件里带 `addr/token/url`。这是 T2.3 剩余的产品化步骤，不属于本次 5 个断点。
- 平板端云端同步设置、翻译引擎配置、本机文件导入仍是桌面专属，UI 会给出明确提示。
