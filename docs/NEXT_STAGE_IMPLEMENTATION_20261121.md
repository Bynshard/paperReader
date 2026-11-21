# Batch D / E / F 实施记录（2026-11-21）

规范来源：[NEXT_STAGE_BUGS_AND_FEATURES_SPEC.md](NEXT_STAGE_BUGS_AND_FEATURES_SPEC.md) ｜ 基线：Sprint 1/2 + UX Batch A–C 已落地的工作区。

本轮按规范第 4 节顺序完成 **Batch D（7 个正确性/安全 Bug）→ Batch E（6 项体验闭环）→ Batch F（5 项 AI 原生能力）**。为压缩工期，文件范围按互斥原则分给并行子 agent，主 agent 负责整合、契约统一与全量回归。

## 0. 回归结果（全部实际执行）

```text
core:  cargo test --release --locked --offline  → 155 passed; 0 failed; 4 ignored
app:   tsc --noEmit                             → 0 error
app:   vitest run                               → 29 files / 186 tests passed
app:   node tests/run-node-tests.cjs            → 61 tests, 0 failed
app:   npm run build                            → ✓ built
smoke: moonlight-core --root <tmp> --mcp        → initialize + tools/list 2 行 JSON-RPC，5 个只读工具
smoke: --serve 真实进程                          → synthesis_matrix/claim_verify 可路由；import_pdfs 返回 403 forbidden over LAN
```

## 1. Batch D：正确性与安全边界

| Bug | 实施 |
| --- | --- |
| BUG-01 部分页翻译错位 | Schema **v6** 增加 `versions.page_map`（0-based 源页数组；NULL=全文恒等）。`attach_translation` 从 `jobs.pages` 解析 `8` / `5-8` / `1-5, 8` 并落库；`paper_json` 返回该字段；`set_blocks` 把译文子集页映射为源页存储；`add_annotation` 以源页校验/保存；`ai.rs` 翻译命中不再二次映射。前端新增 `pageMap.ts`：源页↔译文子页换算、批注映射、`translatedPageMissing` 遮罩「第 X 页尚未翻译 · 翻译当前页」；导航/同步/FindBar/预览/批注跳转全部走源页坐标系。 |
| BUG-02 Zotero 迁移持锁 | `zotero_local` 拆为 Prepare（无 `lib.conn()`：哈希、复制、页数、lopdf 批注矩形）与 Commit（每 25 条短事务）两阶段；新增“prepare 阶段不持写连接”的回归测试与孤儿文件清理。 |
| BUG-03 双栏滚动漂移 | 新增纯函数 `interpolatedTargetFraction`：按源段落内相对顶部插值映射目标段落顶部，不再把段落中心顶到视口上沿；`syncScroll` 改用该函数；Vitest 覆盖段首/段中/1.5 倍段落高度。 |
| BUG-04 后台 Tab 缩放坍缩/漏刷新 | `Reader.applyFit` 仅在 `active` 时执行，切回 Tab 用 `requestAnimationFrame` 重算；隐藏的 `ResizeObserver` 不注册；`PdfPane.fit()` 检测 `clientWidth/Height<=0` 时保持当前 scale；`App.refreshCloud` 遍历刷新所有已打开 Tab。 |
| BUG-05 LAN 安全/Token/并发 | HTTP handler 在 dispatch 前执行严格白名单（42 个平板安全方法），危险/未知方法返回 **HTTP 403 forbidden over LAN**；`--serve-token`/`MOONLIGHT_SERVE_TOKEN` 复用 32-hex 持久 Token（`lan-service.json` 0600，支持重置轮换）；`MAX_CONNECTIONS` 64→128，HTTP 桥对 503 做 250/750ms 两次退避。 |
| BUG-06 网关热更新/临时目录 | `Gateway` 改为共享 `Arc<RwLock<GatewayInner>>`，热更新原地替换 upstream/model/key，端口与 token 不变；翻译成功/失败/取消均清理 `tmp/job-*`（失败仅保留 2000 字日志尾进 `jobs.error`）；启动清扫孤儿目录与 staged PDF。 |
| BUG-07 搜索摘要漏匹配/旧译文 | `match_snippet` 先精确 LIKE，失败后按空白/CJK 分词做“全 token 命中”回退；候选只取主 source 版本与最新 translated 版本；新增跨行多词与旧译文过滤测试。 |

## 2. Batch E：日常管理与精读闭环

| 功能 | 实施 |
| --- | --- |
| FEAT-UX-01 首次引导 | `SettingsModal initialTab` + `Reader onOpenSettings`：AI 空态/凭据错误/翻译 BabelDOC 错误显示「前往配置 API / 登录 Codex →」，直达翻译引擎或 AI 设置页。 |
| FEAT-UX-02 重复论文合并 | 后端 `merge_papers`（单事务补全元数据、合并 notes、版本去重、批注/对话/标签/目录/Zotero 关系迁移后删次条目）；`DuplicateFinder` 支持选择主条目、影响摘要、合并确认与移入回收站。 |
| FEAT-UX-03 术语表 | Schema **v7** `glossary_terms`；`list_glossary/save_glossary`；`GlossaryEditor` 支持增删改、启用、CSV 导入导出、AI/CS 预设；BabelDOC 优先 `--glossary-files`（0.6.2 已支持），否则网关按任务窗口注入 system 术语；`translate_text`/`explain_with` 也附加术语规则。 |
| FEAT-UX-04 学术输入输出 | 新增 `bibliography.rs` 解析 BibTeX/RIS 文本并批量入库（DOI/arXiv/标题去重、上限 5MB/2000 条）；`export` 支持 `gbt7714`/`apa`；论文库导入菜单新增「导入 BibTeX / RIS 文献清单」，右键菜单/快捷键复制 GB/T 7714 与 BibTeX。目录自动同步 `.bib` 未实现（见限制）。 |
| FEAT-UX-05 键盘流 | `PaperTable` 增加 Space（Inspector）、Delete/Backspace（回收站）、Ctrl/Cmd+A（当前页全选）、Ctrl/Cmd+Shift+C（复制 GB/T 7714）、Escape（先清选择再关 Inspector），输入控件内不触发。 |
| FEAT-UX-06 图表画廊 | `PdfPane.extractFigures()` 扫描页文本匹配 `Figure/Table/Algorithm N`，`ReaderNav` 第三 Tab「图表」展示缩略图卡片，支持跳转与 📌 复用 Pinned Portal。 |

## 3. Batch F：AI 原生能力

| 功能 | 实施 |
| --- | --- |
| FEAT-AI-01 无内链引用 | `PdfPane.matchTextReference` 识别 `Fig./Figure N`、`Table N`、`Eq. N`、`Section N`、`Algorithm N`、`[N]`；点击文本层重建整行并校验光标落在引用上，Reader 通过 `search_blocks` 定位图注/右对齐公式/参考文献条目，复用智能预览与钉选。 |
| FEAT-AI-02 跨论文对比 | 新增 `synthesis.rs`：2–20 篇、48k 字预算、`digest_json` + `ai::prepare` 证据聚合，模型输出严格 JSON 矩阵（页码必须来自证据）；`SynthesisModal` 可编辑表格、`[p.X]` 跳转、Markdown/CSV 导出；论文库批量栏「跨论文提问 / 生成对比矩阵」。未落 `syntheses` 持久化表与列排序（见限制）。 |
| FEAT-AI-03 本地 MCP | 新增 `mcp.rs`：`moonlight-core --mcp` stdio JSON-RPC 2.0，提供 `search_papers`、`get_paper_summary`、`search_paper_evidence`、`list_paper_annotations`、`list_library_taxonomy` 五个只读工具；设置页展示可复制的 `mcpServers` JSON。实测 `initialize`/`tools/list` 仅输出协议行。 |
| FEAT-AI-04 整理 Agent | 后端 `agent_plan.rs` 按 goal（categorize/tag/short_note）生成结构化 `plan`（before 来自 DB，校验目录/标签，不写库）；`LibraryAgentModal` 逐条勾选 Diff 后调用现有 `bulk_assign`/`setShortNote`/`updatePaper` 应用。 |
| FEAT-AI-05 动态阈值 + 论点核查 | `select_ranked_pages` 保留最佳页、丢弃 `<best*0.35` 尾部噪声、单词命中需 `<best*0.6`；`ai::claim_verify` 输出 `supported/conditional/unsupported` + 真实证据 sources；阅读器选区工具条「🔍 核查原文依据」用现有气泡展示三态徽章。 |

## 4. 新增/修改文件

- Rust：`core/src/{library,ai,engine,organization,main,search,sync_model,zotero_local,server}.rs`，新增 `bibliography.rs`、`synthesis.rs`、`mcp.rs`、`agent_plan.rs`。
- 前端：`Reader/PdfPane/ReaderNav/App/Library/PaperTable/DuplicateFinder/PaperMenu/SettingsModal/TranslationSettings/api/types/styles`，新增 `pageMap.ts`、`readerScroll.ts`、`Snippet.tsx`、`drag.ts`、`venueTier.ts`、`GlossaryEditor.tsx`、`SynthesisModal.tsx`、`LibraryAgentModal.tsx`、`reader-gallery.css`、`glossary.css`。
- Electron：LAN token 持久化/轮换、`--serve-token` 透传、503 退避。
- 新测试文件：`pageMap/readerScroll/GlossaryEditor/SettingsModal/SynthesisModal/LibraryAgentModal/SettingsMcp/LibraryBatchE/PaperTableKeyboardBatchE/DuplicateFinderBatchE/AppBatchE/AppBatchF ...`。

## 5. 已知限制

- **真机/Electron GUI 未跑**：本机缺 `libatk` 等运行库；MCP/LAN/静态页面用真实进程冒烟，触控/range/扫码仍需真机。
- **部分页翻译旧数据**：v6 之前的局部译文 `page_map` 为 NULL，需重新翻译才会进入源页坐标系；`page_map` 长度未与 BabelDOC 输出 PDF 页数强校验。
- **Batch E 未做**：分类目录自动增量导出 `.bib`（FEAT-UX-04 §3）；GB/T 7714 为无卷期/页码/文献类型推断的基础格式；BibTeX/RIS 解析为轻量实现。
- **Batch F 未做**：`syntheses` 报告持久化、矩阵列排序、同义标签合并的专用 Apply 流程；跨论文「提问」目前以单列矩阵形式返回而非长文综述；MCP 证据检索为只读轻量实现（仅主 source 版本）；无内链引用是点击触发（无 350ms hover）；claim_verify 单次非流式。
- **网关热更新**期间进行中的 BabelDOC 后续请求会使用新 upstream/key/model（已开始的流不受影响）；Token 轮换需重启后生效。
