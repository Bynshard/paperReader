# Moonlight（paperReader）下一阶段缺陷修复与功能演进规范（Batch D → Batch F）

> **编写日期**：2026-11-21 ｜ **基线提交**：`6892fed` + Sprint 1/2 及 UX Batch A–C 工作区改动  
> **前置关联**：[vivo Pad 5 Pro 适配与全栈审查](VIVO_PAD5_PRO_REVIEW_AND_DESIGN.md)（Sprint 1/2）、[用户体验差距审查与打磨规范](UX_EXPERIENCE_GAP_AND_POLISH_SPEC.md)（Batch A–C）  
> **文档目标**：在前述 Batch A–C 落地的基础上，基于全量源码走读与 GitHub 开源标杆（`PaperQuay`、`Sioyek`、`ScholarPhi`、`scholar-rag`、`PapersGPT`、`PaperLens`）对标，固化下一阶段必须修复的 **7 个代码正确性 Bug（Batch D）**、**6 项日常使用体验闭环功能（Batch E）** 以及 **5 项 AI 原生与硬核差异化能力（Batch F）**，供后续工程分批施工与验收。

---

## 目录

- [第一章：代码正确性缺陷修复清单（7 个必修 Bug，Batch D · P0）](#第一章代码正确性缺陷修复清单7-个必修-bugbatch-d--p0)
  - [BUG-01：部分页翻译（`--pages`）导致双栏对照、文内索引与批注页码坐标系错位](#bug-01部分页翻译--pages导致双栏对照文内索引与批注页码坐标系错位)
  - [BUG-02：Zotero 本地库迁移长时间持有全局写锁 `lib.conn()` 执行重度 I/O 与 PDF 解析](#bug-02zotero-本地库迁移长时间持有全局写锁-libconn执行重度-io-与-pdf-解析)
  - [BUG-03：双栏滚动同步（`syncScroll`）混用视口顶部比例与段落中心比例导致系统性向下漂移](#bug-03双栏滚动同步syncscroll混用视口顶部比例与段落中心比例导致系统性向下漂移)
  - [BUG-04：后台隐藏 Multi-Tab 在 `display: none` 下触发 `fit-width` 坍缩为 40% 且漏刷新状态](#bug-04后台隐藏-multi-tab-在-display-none-下触发-fit-width-坍缩为-40-且漏刷新状态)
  - [BUG-05：局域网服务端 `/api/rpc` 缺白名单、64 线程易 503、且重启轮换 Token 致 PWA 失效](#bug-05局域网服务端-apirpc-缺白名单64-线程易-503且重启轮换-token-致-pwa-失效)
  - [BUG-06：网关热更新立即关闭旧端口中断进行中翻译，且 `tmp/job-<id>` 临时目录永不清理](#bug-06网关热更新立即关闭旧端口中断进行中翻译且-tmpjob-id-临时目录永不清理)
  - [BUG-07：全文搜索 `match_snippet` 跨行折行漏匹配且未过滤已淘汰旧译文版本的 `blocks`](#bug-07全文搜索-match_snippet-跨行折行漏匹配且未过滤已淘汰旧译文版本的-blocks)
- [第二章：日常使用体验（UX）与文献管理闭环补齐（对标 Zotero 7 & 小绿鲸，Batch E · P1）](#第二章日常使用体验ux与文献管理闭环补齐对标-zotero-7--小绿鲸batch-e--p1)
  - [FEAT-UX-01：未配置模型凭据时的首次引导与一键直达设置入口](#feat-ux-01未配置模型凭据时的首次引导与一键直达设置入口)
  - [FEAT-UX-02：重复论文一键无损合并（`merge_papers` + `DuplicateFinder`）](#feat-ux-02重复论文一键无损合并merge_papers--duplicatefinder)
  - [FEAT-UX-03：自定义专业术语表（Glossary）管理与翻译/AI 约束](#feat-ux-03自定义专业术语表glossary管理与翻译ai-约束)
  - [FEAT-UX-04：学术输入输出闭环：`.bib/.ris` 导入、GB/T 7714 一键复制与目录自动同步 `.bib`](#feat-ux-04学术输入输出闭环bibris-导入gbt-7714-一键复制与目录自动同步-bib)
  - [FEAT-UX-05：论文库桌面全键盘效率流补齐（`Space` / `Delete` / `Ctrl+A`）](#feat-ux-05论文库桌面全键盘效率流补齐space--delete--ctrla)
  - [FEAT-UX-06：阅读器左侧导航新增「图表画廊（Figures & Tables）」Tab](#feat-ux-06阅读器左侧导航新增图表画廊figures--tables-tab)
- [第三章：参考 GitHub 开源标杆的高价值 AI 原生与硬核功能（Batch F · P2）](#第三章参考-github-开源标杆的高价值-ai-原生与硬核功能batch-f--p2)
  - [FEAT-AI-01：无超链接文本引用（`Fig. X`/`Table Y`/`Eq. Z`/`[N]`）正则识别与悬停预览](#feat-ai-01无超链接文本引用fig-xtable-yeq-zn正则识别与悬停预览)
  - [FEAT-AI-02：跨多篇论文联合 RAG 问答与文献对比矩阵（Multi-Paper RAG & Literature Matrix）](#feat-ai-02跨多篇论文联合-rag-问答与文献对比矩阵multi-paper-rag--literature-matrix)
  - [FEAT-AI-03：内置本地 MCP Server（`moonlight-core --mcp`）](#feat-ai-03内置本地-mcp-servermoonlight-core---mcp)
  - [FEAT-AI-04：「Plan（变更预览）→ 人工勾选确认 → Apply」的论文库整理 Agent](#feat-ai-04plan变更预览-人工勾选确认--apply的论文库整理-agent)
  - [FEAT-AI-05：AI 检索动态相关性阈值截断 + 论点原文核查（Claim Verification）](#feat-ai-05ai-检索动态相关性阈值截断--论点原文核查claim-verification)
- [第四章：分批施工路线图与强制回归验收命令](#第四章分批施工路线图与强制回归验收命令)

---

## 第一章：代码正确性缺陷修复清单（7 个必修 Bug，Batch D · P0）

以下缺陷均通过逐文件走读当前工作区源码确认，属于会直接引起**数据错位、并发锁死、安全边界越界或磁盘泄漏**的问题，必须在新增大功能前作为 **Batch D** 优先清零。

### BUG-01：部分页翻译（`--pages`）导致双栏对照、文内索引与批注页码坐标系错位

- **问题代码**：
  - [core/src/engine.rs](file:///home/bynshard/paperReader/core/src/engine.rs#L982-L984)（`run_translation` 透传 `--pages`）
  - [core/src/library.rs](file:///home/bynshard/paperReader/core/src/library.rs#L1228-L1258)（`attach_translation` 入库）
  - [app/src/Reader.tsx](file:///home/bynshard/paperReader/app/src/Reader.tsx#L439-L478,L954-L973,L1196-L1229)（`loadBlocks`、`syncScroll`、`addHighlight`）
  - [app/src/PdfPane.tsx](file:///home/bynshard/paperReader/app/src/PdfPane.tsx#L660-L677)（`goTo`）
- **根因分析**：
  1. UX-BUG-01 开放了「只翻译当前页（如第 8 页）」和「翻译指定页码范围（如 `5-8`）」。BabelDOC 产出的 `.mono.pdf` **仅包含被翻译的子集页面（总页数为 1 或 4）**，`attach_translation` 存入 `versions.pages` 的也是子集页数，且未保存原页码映射。
  2. 打开双栏对照后，前端原文与译文共用 1-based 原文页码 `page`（如 `page = 8`）：
     - `PdfPane.goTo`（`PdfPane.tsx#L663`）执行 `Math.min(d.numPages - 1, Math.max(0, page - 1))`，把译文强制 clamp 到 `index = 0`（子集译文第 1 页），导致翻看任意未译页时右侧仍显示第 8 页译文；
     - `Reader.tsx#L444` 和 `syncScroll`（`Reader.tsx#L457`）却拿原文页索引 `pageIndex = 7` 去读 `loadBlocks(translated.versionId, 7)`，而译文侧在 `blocks` 表写入的 `page` 是 `0`，导致段落对齐数据永远为空；
     - 在局部译文上划线批注时，`annotations.page` 被写入子集页码 `0`（封面页），后续全文重译或合并对照时批注全部错位。
- **修复规格**：
  1. **Schema 迁移（v6）与元数据持久化**：为 `versions` 表增加可空列 `page_map TEXT`（JSON 数组，存储译文每页对应的 0-based 原文页码，例如 `[7]` 或 `[4,5,6,7]`；全文翻译为 `NULL` 视为恒等映射 `i -> i`），或由 `attach_translation` 从 `jobs.pages` 解析展开后写入 `page_map`（并同步在 `paper_json()` 返回）。
  2. **双选一渲染对齐方案（推荐服务端补齐或前端映射二选一，推荐前端显式映射 + 补译入口）**：
     - 后端 `set_blocks` 与 `ai.rs` 的 `translation_hits` 在读取 `translated` 版本的 `blocks` 时，若存在 `page_map`，将子集页索引映射为真实原文页码 `source_page = page_map[translated_page]`；
     - 前端 `Reader.tsx` 计算 `translatedPageIndex = pageMap ? pageMap.indexOf(page - 1) : (page - 1)`：
       - 若 `translatedPageIndex >= 0`：`transApi.current?.goTo(translatedPageIndex + 1, ...)`，且 `loadBlocks`、`alignPoint`、`addHighlight` 均完成子集页码与原文页码的双向换算（`annotations.page` 统一以原文 0-based 页码为基准或记录映射后页码）；
       - 若 `translatedPageIndex < 0`（当前原文页不在局部译文范围内）：在译文槽位顶部/覆盖层显示轻量提示条 **「第 X 页尚未翻译 · [一键翻译当前页]」**，不强行错位显示其他页译文，且暂停对未译页的 `syncScroll` 强制对齐。

---

### BUG-02：Zotero 本地库迁移长时间持有全局写锁 `lib.conn()` 执行重度 I/O 与 PDF 解析

- **问题代码**：
  - [core/src/zotero_local.rs](file:///home/bynshard/paperReader/core/src/zotero_local.rs#L214-L314)（`import_item`）
  - [core/src/zotero_local.rs](file:///home/bynshard/paperReader/core/src/zotero_local.rs#L397-L416)（`import` 主循环）
- **根因分析**：
  - `zotero_local::import` 在第 397 行执行 `let mut dest = lib.conn();` 取得全局唯一的写连接 `MutexGuard`，并在整个条目遍历与每 100 条 commit 的周期内**全程不释放该互斥锁**。
  - 在持锁期间，`import_item` 内部直接调用了磁盘重 I/O（`sha256_file`、`fs::copy`、`copy_tree`）以及 `pdfmeta::page_count`、`lopdf::Document::load(pdf)` 解析整份 PDF（第 215、263、270、276、305 行）。
  - 虽然 `zotero_import` 运行在 `LocalWrite` 后台线程，但任何在 RPC 线程上需要调用 `lib.conn()` 的瞬时操作（`get_paper`、`add_annotation`、`set_reading_position`、`set_blocks`、`list_jobs`、`ai_save`）都会被该互斥锁阻塞数十秒甚至数分钟，引发前端超时。
- **修复规格**：
  1. **I/O 与解析前置无锁化**：将 `import_item` 拆分为两个阶段：
     - **Prepare 阶段（不持 `lib.conn()`）**：读取只读 Zotero 快照 `source` 的元数据、笔记、分类/标签，完成所有附件的 `sha256_file`、临时拷贝/复制进 `files/` 与 `imports/`、`page_count` 以及针对有批注 PDF 的 `lopdf::Document::load` + `normalized_rects` 计算，组装成内存结构体 `PreparedZoteroItem`；
     - **Commit 阶段（短暂持 `lib.conn()`）**：每批次（例如 25–50 条）或逐条获取 `lib.conn()` 开事务执行纯 SQLite `INSERT/UPDATE` 并提交后立即 `drop(conn)` 释放锁，允许阅读器批注与浏览间隙无感插入。
  2. **补充测试**：在 `zotero_local.rs` 测试中验证并发读写间隙（或单条制备完成后再取写锁），确保长耗时附件拷贝期间 `lib.conn()` 不会被长期占住。

---

### BUG-03：双栏滚动同步（`syncScroll`）混用视口顶部比例与段落中心比例导致系统性向下漂移

- **问题代码**：
  - [app/src/Reader.tsx](file:///home/bynshard/paperReader/app/src/Reader.tsx#L450-L478)（`syncScroll`）
  - [app/src/PdfPane.tsx](file:///home/bynshard/paperReader/app/src/PdfPane.tsx#L575-L592)（`position`）
  - [app/src/PdfPane.tsx](file:///home/bynshard/paperReader/app/src/PdfPane.tsx#L660-L677)（`goTo`）
- **根因分析**：
  - `PdfPane.position()` 返回的 `fraction` 是**视口上边缘（Top）**在当前页内的相对比例。
  - 但在 `Reader.tsx#L467` 的 `syncScroll` 中：
    1. 用 `fraction * fromSize.h`（视口顶部 Y）查找最近的段落 `fromBlock`；
    2. 接着用 `fromBlock` 的**垂直中心** `center = (fromBlock.bbox[1] + fromBlock.bbox[3]) / 2 / fromSize.h` 匹配对侧段落 `target`；
    3. 然后取 `target` 的**垂直中心** `targetFraction = (target.bbox[1] + target.bbox[3]) / 2 / toSize.h` 传给 `toApi.goTo(p, targetFraction)`！
  - 而 `goTo` 把传入的 `targetFraction` 当成**目标视口顶部（`scrollTop`）**定位，等同于把对侧段落的“中心线”强行顶到屏幕“最上沿”，导致每次同步后对侧都比源侧多向下滚动约半个段落的高度，在长段落处产生明显视觉错位。
- **修复规格**：
  1. 在 `Reader.tsx` 的 `syncScroll` 中改为**段落内相对顶部插值**：
     - 设源侧当前视口顶部自然坐标为 `sourceTopY = fraction * fromSize.h`；
     - 计算 `sourceTopY` 在 `fromBlock` 纵向区间 `[fromBlock.bbox[1], fromBlock.bbox[3]]` 内的夹紧相对进度：
       $$t = \text{clamp}\left(\frac{\text{sourceTopY} - \text{fromBlock.top}}{\max(1, \text{fromBlock.bottom} - \text{fromBlock.top})},\ 0,\ 1\right)$$
     - 映射回目标段落 `target` 对应的顶部自然坐标与页内比例：
       $$\text{targetTopY} = \text{target.top} + t \times (\text{target.bottom} - \text{target.top}), \quad \text{targetFraction} = \text{clamp}\left(\frac{\text{targetTopY}}{\text{toSize.h}},\ 0,\ 1\right)$$
  2. 补充单元测试（或提取纯函数 `alignedScrollFraction(fromBlocks, toBlocks, fromSize, toSize, fraction)` 进行 Vitest 断言）：当源侧恰好停在某段开头（`t = 0`）时，目标侧精确对齐到对应译文段落开头（而非中心），即使中英文段落高度相差 1.5 倍也不会向下偏移。

---

### BUG-04：后台隐藏 Multi-Tab 在 `display: none` 下触发 `fit-width` 坍缩为 40% 且漏刷新状态

- **问题代码**：
  - [app/src/App.tsx](file:///home/bynshard/paperReader/app/src/App.tsx#L46-L49,L89-L97,L451-L458)（`currentPaper`、Multi-Tab `hidden`、`refreshCloud`）
  - [app/src/Reader.tsx](file:///home/bynshard/paperReader/app/src/Reader.tsx#L639-L662)（`applyFit` 与 `ResizeObserver`）
  - [app/src/PdfPane.tsx](file:///home/bynshard/paperReader/app/src/PdfPane.tsx#L763-L775)（`fit`）
- **根因分析**：
  1. **缩放坍缩至 40%**：`App.tsx#L452` 使用 `hidden={activeTabId !== tab.paper.id}` 保活后台标签页。当后台标签页处于 `zoomMode === "fit-width"` 或 `"fit-page"`，且因窗口变化、自动裁白边 `noteCrop` 或译文加载完成触发 `Reader.tsx#L639` 的 `applyFit()` 时，由于其 DOM 处于 `display: none`，`PdfPane.tsx#L771` 读到的 `element.clientWidth` 为 `0`，`Math.max(200, 0 - 36)` 得到 `200px`，进而将 `scale` 计算为最小值 `0.4`（40%）。用户切回该 Tab 时，页面已经变成 40% 极小尺寸。
  2. **后台 Tab 漏刷新**：`App.tsx#L49` `currentPaper.current` 只指向当前激活的 `activePaper`。当用户切回「论文库」或阅读论文 B 时，论文 A 的后台全文翻译完成触发 `refreshCloud()`，因为 `currentPaper.current` 不是论文 A，论文 A Tab 里的 `paper.versions` 不会更新。
- **修复规格**：
  1. **激活态守卫与切回重算（`Reader.tsx` / `PdfPane.tsx`）**：
     - `Reader.tsx` 的 `applyFit`、`ResizeObserver` 与 `wheel` 初始化逻辑检查 `if (!active) return;`；
     - `PdfPane.fit()` 若检测到 `element.clientWidth <= 0 || element.clientHeight <= 0`，直接返回当前 `state.current.scale`，禁止按 `200px` 兜底计算；
     - `Reader.tsx` 在 `useEffect` 监听 `active` 从 `false` 变为 `true` 且 `zoomMode !== "custom"` 时，于下一帧 `requestAnimationFrame` 重新调用一次 `applyFit()`。
  2. **全 Tab 状态刷新（`App.tsx`）**：
     - `refreshCloud()` 改为遍历更新所有当前挂载在 `tabs` 中的 `paper`（或至少在收到 `job completed` 事件时按 `paper_id` 精确刷新对应 Tab 的 `getPaper`），确保后台 Tab 译文生成后切回去立即可看对照视图。

---

### BUG-05：局域网服务端 `/api/rpc` 缺白名单、64 线程易 503、且重启轮换 Token 致 PWA 失效

- **问题代码**：
  - [core/src/main.rs](file:///home/bynshard/paperReader/core/src/main.rs#L115-L132)（HTTP `handler` fallback 到全量 `dispatch`）
  - [core/src/server.rs](file:///home/bynshard/paperReader/core/src/server.rs#L37,L138,L173-L213)（`MAX_CONNECTIONS`、随机 `token`）
  - [app/electron/lan-service.cjs](file:///home/bynshard/paperReader/app/electron/lan-service.cjs#L60-L111)（配置存储）
  - [app/src/LanPairing.tsx](file:///home/bynshard/paperReader/app/src/LanPairing.tsx#L205-L210)（PWA 引导）
- **根因分析**：
  1. **RPC 安全边界缺口**：`main.rs#L130` 中 HTTP `handler` 仅显式匹配了 5 个读方法，其余所有方法直接穿透到全量 `dispatch(&lib, method, params)`。一旦局域网内设备拿到配对 Token，即可直接 POST `/api/rpc` 调用 `import_pdfs`（导入宿主机任意路径 PDF）、`backup_create`/`backup_restore`（读写宿主机目录）、`zotero_import`、`version_path`（泄露宿主机绝对路径）、`reload_gateway`（篡改网关 Upstream）或 `shutdown`（远程关闭服务）。
  2. **PWA 重启即失效**：`server.rs#L138` 每次启动都会执行 `uuid::Uuid::new_v4()` 重新生成随机 Token。平板端按提示将链接「添加到主屏幕」安装为 PWA 后，只要桌面端重启一次，PWA 内缓存的 Token 立即触发 `401 平板配对已失效`，必须每次重新扫码。
  3. **连接预算与 PDF.js Range 并发冲突**：`server.rs#L37` 限制 `MAX_CONNECTIONS = 64` 且无 HTTP Keep-Alive 复用（每个请求开一个 OS 线程），SSE 长连接加上双栏 PDF 并发加载 64KB Range 分块与静态资源时，瞬时并发触顶会直接回复 `503 server busy`，引发 PDF.js 报错。
- **修复规格**：
  1. **严格的 LAN RPC 白名单（`core/src/main.rs`）**：HTTP `handler` 显式列出允许平板端调用的方法白名单（`app_info`、`list_papers_page`、`list_papers`、`get_paper`、`list_annotations`、`add_annotation`、`update_annotation`、`delete_annotation`、`list_taxonomy`、`set_reading_position`、`paper_pdf`、`blocks`、`set_blocks`、`document_text_status`、`search_blocks`、`list_jobs`、`get_job`、`start_translate`、`cancel_job`、`ai_prepare`、`ai_preview`、`ai_digest`、`ai_history`、`ai_save`、`ai_delete`、`ai_clear`、`ai_cancel`、`explain`、`translate_text`、`update_paper`、`save_paper`、`append_note`、`set_short_note`、`export`、`zotero_files`、`trash_paper`、`restore_paper`、`bulk_assign`、`bulk_unassign`、`bulk_set_status`、`bulk_trash`、`bulk_restore`），对宿主机路径/进程/凭据类危险方法（`import_pdfs`、`backup_*`、`zotero_import`、`zotero_api_import`、`zotero_probe`、`zotero_attachment_path`、`version_path`、`reload_gateway`、`translation_probe`、`check_babeldoc`、`sync_*`、`shutdown`）一律返回 `403 forbidden over LAN`。
  2. **Token 持久化与手动重置（`lan-service.cjs` / `main.rs` / `server.rs` / `LanPairing.tsx`）**：
     - 由 `lan-service.cjs` 首次生成并持久化 32 位 hex `token` 到 `<userData>/lan-service.json`（文件权限 `0o600`），通过 `--serve-token <token>`（或环境变量 `MOONLIGHT_SERVE_TOKEN`）传给 `moonlight-core`（注意：不要写死在易泄露的日志里）；
     - `LanPairing.tsx` 增加「🔄 重置配对令牌」按钮（调用 `lan:configure({ rotateToken: true })`，重置后重启生效），使平板 PWA 在桌面正常重启后免扫码继续使用。
  3. **连接限流优化**：将 `MAX_CONNECTIONS` 分为静态/Range 轻量并发预算与重 RPC 预算（或将 `MAX_CONNECTIONS` 提升至 `128` 并在 `api.ts` 对 `503` 增加指数退避重试 2 次）。

---

### BUG-06：网关热更新立即关闭旧端口中断进行中翻译，且 `tmp/job-<id>` 临时目录永不清理

- **问题代码**：
  - [core/src/library.rs](file:///home/bynshard/paperReader/core/src/library.rs#L1376-L1397)（`install_gateway`、`reload_gateway`）
  - [core/src/engine.rs](file:///home/bynshard/paperReader/core/src/engine.rs#L20-L81,L948-L1062)（`Gateway`、`run_translation`）
- **根因分析**：
  1. `reload_gateway` 重建了一个监听全新随机端口与新 `token` 的 `Gateway` 并对旧网关执行 `old.shutdown()`。如果用户此时后台正有 BabelDOC 翻译任务在跑（命令行固定传了启动时的旧 `127.0.0.1:<old_port>` 与旧 `token`），旧监听退出后 BabelDOC 下一批请求即遭遇连接拒绝（Connection Refused）并导致整篇翻译失败。
  2. `run_translation` 在 `<library>/tmp/job-<job_id>` 下执行 BabelDOC 输出 `.mono.pdf` 与日志，随后 `attach_translation` 将产物复制到 `derived/`，但 **`run_dir` 在任务成功、失败或取消后从未被清理**，长期翻译会在 `tmp/` 下堆积大量与原文/译文等大的冗余 PDF 与中间文件。
- **修复规格**：
  1. **复用单一网关监听实例**：`Gateway` 内部配置（`upstream`、`model`、`api_key`）改用 `Arc<RwLock<GatewayInnerConfig>>` 共享状态，`reload_gateway` 原地更新该配置对象而**不销毁重绑 TCP 端口和变更本地 `token`**；若因极端原因未启动过网关再启动一次。这样正在执行的 BabelDOC 子进程和 SSE 回答都不会断连。
  2. **清理翻译临时目录**：`run_translation` 结束时清理 `<library>/tmp/job-<job_id>` 中的 `.pdf` 及中间目录；若任务失败，仅保留体积极小的 `babeldoc.log`（或截断保存最近日志到错误详情后删除整个 `run_dir`），同时在 `Library::new()` 启动异常任务恢复后清扫遗留的 `tmp/job-*` 孤儿目录。

---

### BUG-07：全文搜索 `match_snippet` 跨行折行漏匹配且未过滤已淘汰旧译文版本的 `blocks`

- **问题代码**：
  - [core/src/search.rs](file:///home/bynshard/paperReader/core/src/search.rs#L372-L386)（`list_page` 摘要片段查询）
  - [core/src/library.rs](file:///home/bynshard/paperReader/core/src/library.rs#L1249)（`attach_translation` 插入新译文版本时未隔离旧译文块）
- **根因分析**：
  1. `search.rs#L374` 在 FTS5 命中后使用连续子串 `text LIKE '%query%'` 去 `blocks` 捞取摘要。当用户搜索多词短语（如 `attention bottleneck`）且 FTS5 索引已命中某段，但该段在 PDF 文本层中两个词之间有换行或被多词拆开时，`LIKE '%attention bottleneck%'` 匹配失败，导致列表项漏掉 `match_snippet` 和 `p.N 直达` 按钮。
  2. 同一篇论文重译多次后，旧译文版本的 `blocks` 仍留在 `blocks` 表中；`search.rs#L374` 未按有效最新版本筛选 `version_id`，可能把旧译文版本里的过时碎片当成 `match_snippet.version_id` 返回，点进阅读器跳转到非默认译文版本。
- **修复规格**：
  1. 摘要提取逻辑在 `LIKE` 精确子串未命中时，按空白/中文词拆分为 token 组合在候选 `blocks`（优先匹配最新 `source` 版本或最新 `translated` 版本）中定位包含所有检索词的最优段落并围绕第一个命中词生成 `±80` 字符摘要。
  2. 限定 `blocks` 摘要候选条件仅匹配当前主/有效 `source` 版本与最新 `translated` 版本（或提供后台清理已淘汰译文派生 `blocks` 的维护策略），并在 `search.rs` 增加多词跨空白命中与多译文版本下的 `match_snippet` 单元测试。

---

## 第二章：日常使用体验（UX）与文献管理闭环补齐（对标 Zotero 7 & 小绿鲸，Batch E · P1）

在修复上述 Bug 后，Batch E 聚焦于补齐日常高频科研工作流中最明显的“卡手点”与“Zotero/小绿鲸基础生态缺口”。

### FEAT-UX-01：未配置模型凭据时的首次引导与一键直达设置入口

- **对标差距**：新用户安装后尚未填写 API Key 或登录 Codex 时，点击「翻译全文」「生成结构化导读」或「提问」仅在顶部闪出一条错误 Toast，缺乏明确的操作引导与设置直达入口。
- **涉及文件**：[app/src/App.tsx](file:///home/bynshard/paperReader/app/src/App.tsx)、[app/src/Reader.tsx](file:///home/bynshard/paperReader/app/src/Reader.tsx)、[app/src/SettingsModal.tsx](file:///home/bynshard/paperReader/app/src/SettingsModal.tsx)
- **实现规格**：
  1. `SettingsModal` 接收可选受控属性 `initialTab?: TabKey`，允许外部（如阅读器报错引导、空白库空状态提示）直接打开并定位到 `translation`（翻译引擎）或 `ai`（AI 阅读助手）标签页。
  2. `App.tsx` 与 `Reader.tsx` 识别错误消息中的未配置凭据/缺少 BabelDOC 特征（或根据 `info?.credentialConfigured === false`），在 AI 面板空态、翻译按钮旁以及错误提示框中渲染可点击的 **「前往配置 API / 登录 Codex →」** 按钮，一点即达对应设置面板；配置完成并保存后自动关闭引导提示。

### FEAT-UX-02：重复论文一键无损合并（`merge_papers` + `DuplicateFinder`）

- **对标差距**：[DuplicateFinder.tsx](file:///home/bynshard/paperReader/app/src/DuplicateFinder.tsx#L38) 目前明确写着“当前只做检测，不改动任何论文”，无法像 Zotero 7 一样将 arXiv 预印本与期刊正式版两条记录合并。
- **涉及文件**：[core/src/organization.rs](file:///home/bynshard/paperReader/core/src/organization.rs)、[core/src/main.rs](file:///home/bynshard/paperReader/core/src/main.rs)、[app/src/api.ts](file:///home/bynshard/paperReader/app/src/api.ts)、[app/src/DuplicateFinder.tsx](file:///home/bynshard/paperReader/app/src/DuplicateFinder.tsx)
- **实现规格**：
  1. **后端事务 `merge_papers(primary_id, secondary_ids)`**（在 `organization.rs` 实现，注册到 `main.rs` 同步/本地写路由）：
     - 元数据补齐：若主条目 `authors`/`year`/`venue`/`doi`/`arxiv`/`abstract`/`short_note` 为空，从次条目按优先级补全；`notes` 按分隔符无损拼接去重；`favorite` 取逻辑或、`read_status` 取进度更高者（`read > reading > unread`）；
     - 关系迁移：将次条目的 `versions`（跳过同 `sha256` 重复 PDF 文件）、`annotations`、`chats`、`zotero_files`、`zotero_items`、`paper_categories`、`paper_tags` 全量重新绑定到 `primary_id`；
     - 在删除次条目行之前提交上述迁移，确保外键 `ON DELETE CASCADE` 不会误删迁移后的文件或批注；若已打开了次条目的 Tab，通知前端更新或关闭冗余 Tab。
  2. **前端 `DuplicateFinder.tsx`**：每组重复条目增加单选框指定「保留为主条目」，点击 **「合并为一条」** 后展示合并影响摘要（将合入 N 个 PDF 版本、M 条批注与笔记）并执行合并；同时在单行旁补充「移入回收站」快捷按钮。

### FEAT-UX-03：自定义专业术语表（Glossary）管理与翻译/AI 约束

- **对标差距**：小绿鲸核心卖点之一是学科术语库约束（防止 `Attention`、`Rollout`、`Head`、`Register`、`Alignment` 等领域词被直译失真）。当前 Moonlight 仅在 `ai.rs` 检索阶段内置了 60+ 词典，翻译过程无法自定义术语约束。
- **涉及文件**：[core/src/library.rs](file:///home/bynshard/paperReader/core/src/library.rs)、[core/src/engine.rs](file:///home/bynshard/paperReader/core/src/engine.rs)、[core/src/ai.rs](file:///home/bynshard/paperReader/core/src/ai.rs)、[app/src/TranslationSettings.tsx](file:///home/bynshard/paperReader/app/src/TranslationSettings.tsx)
- **实现规格**：
  1. 在 `app_settings`（或新建 `glossary_terms(id, source, target, domain, enabled)` 表，Schema v6）存储全局自定义术语映射表（支持导入/导出 CSV，格式 `source,target`）。
  2. **注入整篇翻译**：在 `engine::run_translation` 启动 BabelDOC 时，若启用术语表非空，生成临时 CSV 术语文件并透传给 BabelDOC（如 `--glossary <csv_path>`，若当前 BabelDOC 版本不支持该参数则检测能力并回退到在网关 `system` Prompt 注入术语约束规则）。
  3. **注入划词翻译与问答**：`ai::translate_text` 与 `ai::explain_with` 在组装 System Prompt 时附加匹配当前片段或全局启用的术语对照规则（“遇到以下专业术语请按指定译法或保留英文：`Rollout -> Rollout（轨迹采样）`…”）。
  4. **前端界面**：在「设置 → 翻译引擎」下方新增「专业术语表（Glossary）」折叠编辑区，支持快速增删改查与一键导入常用 AI/CS 术语预设。

### FEAT-UX-04：学术输入输出闭环：`.bib/.ris` 导入、GB/T 7714 一键复制与目录自动同步 `.bib`

- **对标差距**：Zotero 不可替代的核心在于文献引用生态的完整闭环。目前 Moonlight 仅支持导出 `.bib/.ris` 文件，不支持导入 `.bib/.ris`，也没有国内硕博写学位论文/中文期刊必用的 **GB/T 7714-2015** 一键复制引文与 LaTeX 实时 `.bib` 联动。
- **涉及文件**：[core/src/library.rs](file:///home/bynshard/paperReader/core/src/library.rs)、[core/src/main.rs](file:///home/bynshard/paperReader/core/src/main.rs)、[app/src/Library.tsx](file:///home/bynshard/paperReader/app/src/Library.tsx)、[app/src/PaperMenu.tsx](file:///home/bynshard/paperReader/app/src/PaperMenu.tsx)、[app/electron/main.cjs](file:///home/bynshard/paperReader/app/electron/main.cjs)
- **实现规格**：
  1. **`.bib / .ris` 批量导入**：在 Rust 后端实现轻量 `import_bib_ris` 解析器（解析 `title`、`author`、`year`、`journal/booktitle`、`doi`、`eprint`、`abstract`），支持在「导入」下拉菜单新增「导入 BibTeX / RIS 文献清单」，按 DOI/arXiv 去重入库为元数据条目（无 PDF 时允许后续拖拽 PDF 挂载或通过 DOI/arXiv 自动拉取开放 PDF）。
  2. **多格式引文一键复制**：
     - 后端 `export` 或前端工具函数支持 `bibtex`、`ris`、`gbt7714`（GB/T 7714-2015 标准格式，如 `[1] 作者. 题名[J/OL]. 刊名, 年份. DOI.`）、`apa`；
     - 在 `PaperMenu.tsx`（右键菜单）及表格选中状态快捷键 `Ctrl/Cmd+Shift+C` 下提供 **「复制 GB/T 7714 引文」** 与 **「复制 BibTeX」**，复制成功轻提示 Toast。
  3. **目录自动导出 `.bib`（Overleaf / 本地 LaTeX 联动）**：允许为任意分类目录绑定一个本地 `.bib` 文件输出路径（仅桌面端），当该目录下论文新增或元数据变更时自动增量刷新该 `.bib` 文件（对标 Zotero Better BibTeX Auto-Export）。

### FEAT-UX-05：论文库桌面全键盘效率流补齐（`Space` / `Delete` / `Ctrl+A`）

- **对标差距**：当前 [PaperTable.tsx](file:///home/bynshard/paperReader/app/src/PaperTable.tsx#L132-L149) 仅支持 `↑/↓` 与 `Enter`，尚未形成真正的免鼠标全键盘操作流。
- **涉及文件**：[app/src/PaperTable.tsx](file:///home/bynshard/paperReader/app/src/PaperTable.tsx)、[app/src/Library.tsx](file:///home/bynshard/paperReader/app/src/Library.tsx)
- **实现规格**：
  1. 在 `PaperTable` 键盘处理中补齐：
     - `Space`：切换展开/收起当前高亮行的右侧 `Inspector` 详情抽屉；
     - `Delete` / `Backspace`（非输入焦点时）：若勾选多篇则弹出确认批量移入回收站，否则将当前高亮行移入回收站；
     - `Ctrl/Cmd + A`：全选当前页所有论文；
     - `Ctrl/Cmd + Shift + C`：复制当前聚焦/勾选论文的 BibTeX 或 GB/T 7714 引文；
     - `Escape`：依次清除多选集合或关闭 `Inspector`。

### FEAT-UX-06：阅读器左侧导航新增「图表画廊（Figures & Tables）」Tab

- **对标差距**：小绿鲸与 AlphaXiv 的高频实用功能是进入论文后 1 秒浏览全文所有实验图表，无需一页页滚找。
- **涉及文件**：[app/src/ReaderNav.tsx](file:///home/bynshard/paperReader/app/src/ReaderNav.tsx)、[app/src/PdfPane.tsx](file:///home/bynshard/paperReader/app/src/PdfPane.tsx)
- **实现规格**：
  1. `ReaderNav` 顶部导航从 2 个 Tab（`目录` / `页面`）扩展为 3 个 Tab：**`目录` / `页面` / `图表`**。
  2. `PdfPane` 新增 `extractFigures(): Promise<{ label: string; caption: string; page: number; fraction: number }[]>` 接口：扫描已缓存的 PDF 页面文本块（或调用后端 `blocks`），正则匹配以 `^(?:Figure|Fig\.|Table|Algorithm)\s+\d+[.:：]` 开头的图注/表注，并按其上下邻近空白区域估算图表中心 `fraction`，复用 `pane.current.renderRegion(page, fraction, 240)` 生成预览卡片。
  3. 点击图表卡片直接跳转到目标页与坐标，并提供 **「📌 钉选」** 按钮直接转成右下角 `Pinned Portal` 对照小窗。

---

## 第三章：参考 GitHub 开源标杆的高价值 AI 原生与硬核功能（Batch F · P2）

本章直接吸收了当前 GitHub 上最成熟的科研工具与开源代码实现（含仓库 `work/PaperQuay` 本地已有源码），用最低工程代价让 Moonlight 具备 AI 原生阅读器的一线竞争力。

### FEAT-AI-01：无超链接文本引用（`Fig. X`/`Table Y`/`Eq. Z`/`[N]`）正则识别与悬停预览

- **开源参考**：`ahrm/sioyek`（Regex Smart Jump）+ `allenai/scholarphi`（符号/引用就地展开）
- **核心价值**：大量顶会论文或老 PDF 没有内嵌 `<Link>` 批注，导致 Moonlight 现有的 `onInternalLink -> openInternalPreview / Pinned Portal` 无从触发。
- **涉及文件**：[app/src/PdfPane.tsx](file:///home/bynshard/paperReader/app/src/PdfPane.tsx)、[app/src/Reader.tsx](file:///home/bynshard/paperReader/app/src/Reader.tsx)
- **实现规格**：
  1. 在 `PdfPane` 新增文本引用解析器 `resolveTextReference(spanElement, pageBlocks)`：
     - 当用户在非拖拽状态点击或悬停（Hover ≥ 350ms，可设开关防误触）文本层内匹配 `/\b(?:Fig(?:ure)?\.?|Table|Tab\.?|Eq(?:uation)?\.?|Sec(?:tion)?\.?|Algorithm|Alg\.?)\s*(\d+(?:\.\d+)?)\b/i` 或 `/\[(\d{1,3}(?:\s*,\s*\d{1,3})*)\]/` 的词组时；
     - 优先检查是否命中原生 `linkLayer`；若无原生链接，则在整篇已索引的 `blocks`（或按页扫描文本层缓存）中检索目标锚点：
       - 图表/公式/章节：匹配以 `Figure N:`、`Table N:`、`Section N` 开头的块坐标；或匹配带 `(N)` 右对齐公式编号的行；
       - 参考文献 `[N]`：从后往前扫描最后 30% 页码中以 `[N]` 或 `N.` 开头的文献条目。
  2. 找到目标 `(targetPage, targetFraction)` 后，直接复用 `Reader.tsx#L894` 已实现的 **`openInternalPreview`（智能预览浮窗 + 📌 钉在角落对照）**，零重新发明轮子。

### FEAT-AI-02：跨多篇论文联合 RAG 问答与文献对比矩阵（Multi-Paper RAG & Literature Matrix）

- **开源参考**：本地源码 [work/PaperQuay/src/services/reviewWriting.ts](file:///home/bynshard/paperReader/work/PaperQuay/src/services/reviewWriting.ts#L48-L137)（`ReviewBlueprint` 分阶段生成与校验点协议）+ `LaiXiansong/scholar-rag`（`维度提取 -> 矩阵填充 -> 对比合成 -> 幻觉核查`）
- **核心价值**：补齐 Moonlight 相对 **Elicit / SciSpace / NotebookLM** 最大的能力空白——从“读单篇”跨越到“读一批论文、写 Related Work 与组会对比表”。
- **涉及文件**：新增 `core/src/synthesis.rs`（或扩展 `core/src/ai.rs`）、[core/src/main.rs](file:///home/bynshard/paperReader/core/src/main.rs)、[app/src/Library.tsx](file:///home/bynshard/paperReader/app/src/Library.tsx)、新增 `app/src/SynthesisModal.tsx`
- **实现规格**：
  1. **入口与作用域**：
     - 在 `Library.tsx` 批量操作栏（`.batch-bar`）及左侧目录树右键菜单新增 **「💬 跨论文提问」** 与 **「📊 生成对比矩阵」**（单次建议限制 `2–20` 篇，避免超预算）。
  2. **跨论文证据聚合（`multi_paper_prepare`）**：
     - 复用各篇论文已缓存的 `digest_json`（一页纸导读）作为高密度骨架，同时对用户的对比问题或维度关键词在选定 `paper_ids` 的 `blocks` 中执行 BM25 + 中英术语扩展检索，每篇保留最相关的 2–4 个高分段落，打上跨论文唯一编号如 `[P1-1] (HybridFlow, p.4)`；
     - Token 预算严格受控（如总上限 48,000 字按论文篇数均分保底 + 动态得分分配）。
  3. **分阶段矩阵协议（借鉴 `ReviewBlueprint`）**：
     - 第一阶段让模型输出或由用户确认对比维度列（默认：`研究问题`、`核心方法`、`数据集与基线`、`关键指标/结果`、`主要局限` + 支持用户自定义列如 `显存开销`）；
     - 第二阶段按维度/论文填充结构化 JSON 表格（每个单元格强制带 `[paper_id, page]` 依据标注）；
     - 前端展示可交互表格：支持排序、编辑、点击任意单元格 `[p.X]` 直接在 `App.tsx` 打开对应论文 Tab 并跳转到目标页码，支持一键导出为 **Markdown 表格** 或 **CSV**，并支持持久化保存对比报告到新表 `syntheses(id, title, paper_ids_json, matrix_json, created_at)`。

### FEAT-AI-03：内置本地 MCP Server（`moonlight-core --mcp`）

- **开源参考**：`papersgpt/papersgpt-for-zotero`
- **核心价值**：Moonlight 的定位核心之一是「论文 + 代码」联合研究。通过给 Rust 二进制增加标准 **Model Context Protocol (MCP)** stdio 接口，用户在 Cursor / Claude Desktop / Windsurf / VS Code 编写复现代码或 LaTeX 论文时，可以让编程 Agent 直接检索并引用本地 Moonlight 文献库中的公式、实验结论与笔记。
- **涉及文件**：新增 `core/src/mcp.rs`、[core/src/main.rs](file:///home/bynshard/paperReader/core/src/main.rs)
- **实现规格**：
  1. 在 `main.rs` 命令行解析增加 `--mcp` 模式（与 `--serve` 互斥或共存，通过标准输入输出走 JSON-RPC 2.0 MCP 协议）。
  2. 复用 `ReadPool` 与 `Library` 暴露 5 个只读工具（不暴露凭据、不执行写破坏操作）：
     - `search_papers(query, category?, tag?, limit?)` → 复用 `search::list_page`；
     - `get_paper_summary(paper_id)` → 返回元数据、摘要、完整用户笔记 `notes` 与缓存的 `digest_json`；
     - `search_paper_evidence(paper_id, query)` → 复用 `ai::load_evidence_detailed` 返回带页码与段落文本的精确证据；
     - `list_paper_annotations(paper_id)` → 返回按页码排列的高亮摘录与批注；
     - `list_library_taxonomy()` → 返回当前目录树与标签分布。
  3. 在设置页「通用与论文库」展示一键复制的 `mcpServers` JSON 配置片段（含 `moonlight-core` 路径与 `--root <library>` `--mcp` 参数）。

### FEAT-AI-04：「Plan（变更预览）→ 人工勾选确认 → Apply」的论文库整理 Agent

- **开源参考**：本地源码 [work/PaperQuay/src/services/libraryAgent.ts](file:///home/bynshard/paperReader/work/PaperQuay/src/services/libraryAgent.ts#L48-L90)
- **核心价值**：避免 AI 自动整理文献库时“静默改乱标题和分类”，通过可审查的 Diff 计划卡片安全解放批量打标与分类负担。
- **涉及文件**：新增 `app/src/LibraryAgentModal.tsx`、[core/src/ai.rs](file:///home/bynshard/paperReader/core/src/ai.rs)、[core/src/organization.rs](file:///home/bynshard/paperReader/core/src/organization.rs)
- **实现规格**：
  1. 针对论文库多选的论文（或“未分类”视图），用户选择整理目标：**自动归类到现有目录 / 智能生成规范标签 / 清理合并同义标签 / 一句话速记批生成**。
  2. 后端提取待整理文献的 `title`、`venue`、`abstract`、`digest_json` 与现有 `taxonomy`（目录树与高频标签），调用模型生成结构化 JSON `OrganizePlan`（每条记录包含 `paper_id`、`before`、`after`、`reason`）。
  3. 前端渲染 Diff 审查列表，用户可逐条勾选/取消，点击 **「应用已选变更」** 后才调用事务型批量接口（`bulk_assign` / `save_paper` / `tag_rename`）写入数据库。

### FEAT-AI-05：AI 检索动态相关性阈值截断 + 论点原文核查（Claim Verification）

- **开源参考**：本地源码 [work/PaperQuay/src/services/localRag.ts](file:///home/bynshard/paperReader/work/PaperQuay/src/services/localRag.ts#L99-L117)（`filterRelevantRetrievals`）+ `DreamPerday/PaperLens-Zotero`（Claim Verification）
- **涉及文件**：[core/src/ai.rs](file:///home/bynshard/paperReader/core/src/ai.rs#L490-L536)、[app/src/Reader.tsx](file:///home/bynshard/paperReader/app/src/Reader.tsx)
- **实现规格**：
  1. **动态相关性阈值截断（`ai.rs`）**：当前 `load_evidence_detailed` 固定取 `ranked.iter().take(6)`（前 6 页），即使第 3–6 页仅命中单个低权重词也会被塞入 Prompt。改为在保留第 1 名最高分页面后，过滤掉得分低于 `best_score * 0.35`（或仅含单一停用/低 IDF 弱命中）的尾部噪声页，显著提升问答准确度并节省 Token。
  2. **论点原文核查（Claim Verification）**：在阅读器选区浮动工具条（或用户选中一段自己的/AI 的陈述）增加 **「🔍 核查原文依据」** 动作：检索论文最相关段落并让模型严格输出三态结论：**`支持（Supported）` / `部分支持或有条件成立（Conditional）` / `未提及或矛盾（Unsupported / Contradicted）`**，逐条列出原文精确页码与引文核对。

---

## 第四章：分批施工路线图与强制回归验收命令

建议按以下 3 个批次严格顺序推进，每批完成后必须执行全量回归验收并记录实测证据：

| 批次 | 优先级 | 包含任务项 | 核心验收目标 |
| :--- | :--- | :--- | :--- |
| **Batch D：正确性与安全边界清零** | **P0** | `BUG-01` ~ `BUG-07` 全部 7 项 | 局部翻译页码不再错位；Zotero 大库导入期间阅读器读写零卡顿；双栏滚动不再向下漂移；后台 Tab `fit-width` 不坍缩；LAN RPC 有安全白名单且 Token 持久化；`tmp/job-*` 自动清理。 |
| **Batch E：日常管理与精读闭环** | **P1** | `FEAT-UX-01` ~ `FEAT-UX-06` | 新手引导可直达设置；查重可真正合并条目；自定义术语表生效；支持 `.bib/.ris` 导入与 GB/T 7714 一键复制；表格全键盘流完备；左侧导航可浏览全文图表画廊。 |
| **Batch F：AI 原生与生态破局** | **P2** | `FEAT-AI-01` ~ `FEAT-AI-05` | 无内链 `Fig. X` / `[N]` 可悬停预览并钉选；支持多论文对比矩阵与联合 RAG；支持 `moonlight-core --mcp` 联动外部 IDE；支持 Agent Diff 预览整理与论点核查。 |

### 每批完成后的强制回归验收命令

```bash
# 1. Rust 后端全量测试（禁止放宽断言或跳过新增回归）
cd core && cargo test --release --locked --offline

# 2. 前端 TypeScript 严格检查、Vitest 单元测试、Node 集成测试与生产包构建
cd ../app && npx tsc --noEmit && npx vitest run && node tests/run-node-tests.cjs && npm run build
```
