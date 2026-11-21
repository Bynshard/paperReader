# Moonlight 全栈深度审查与成熟化重构指南（功能 + 架构 + UI/UX 全量版）

> **适用代码仓库**：`/home/bynshard/paperReader`（`core/src/*.rs` + `app/src/*.tsx` + `app/electron/*.cjs` + `moonlight/*.py`）  
> **目标定位**：将项目从“核心链路刚跑通的工程原型”打磨为**“真正成熟、可作为日常唯一主力的论文管理与深度阅读桌面软件”**。  
> **使用方式**：本文档已精确到具体源码文件、函数/行号、问题根因与修改方案，可直接拆分给前端、Rust 后端及算法工程师按模块执行。

---

## 目录

1. [模块一：PDF 阅读器核心能力补齐（Reader 功能层）](#模块一pdf-阅读器核心能力补齐reader-功能层)
2. [模块二：文献管理闭环补齐（Library 管理层）](#模块二文献管理闭环补齐library-管理层)
3. [模块三：全文检索性能、AI 跨语言 RAG 与后台任务架构（Rust 核心层）](#模块三全文检索性能ai-跨语言-rag-与后台任务架构rust-核心层)
4. [模块四：原位翻译质量、API 热更新与开箱体验（Engine 与配置层）](#模块四原位翻译质量api-热更新与开箱体验engine-与配置层)
5. [模块五：前端视觉审美与交互体验重构（UI/UX 设计层）](#模块五前端视觉审美与交互体验重构uiux-设计层)
6. [分阶段交付路线图（Checklist）](#分阶段交付路线图checklist)

---

## 模块一：PDF 阅读器核心能力补齐（Reader 功能层）

当前阅读器（`app/src/Reader.tsx`、`app/src/PdfPane.tsx`）仅实现了最基础的 PDF.js 画布渲染与文本层，缺少科研阅读高频依赖的核心功能：

### 1. 缺失 PDF 目录大纲（Outline）与缩略图导航
- **现状问题**：打开 20–50 页的长论文或带 Appendix 的论文时，没有章节书签树（Table of Contents），只能手动输入页码或盲目滚动。
- **修改方案**：
  - 在 `PdfPane.tsx` 加载 `PDFDocumentProxy` 后调用 `doc.getOutline()` 提取树状书签，并通过 `doc.getDestination()` / `doc.getPageIndex()` 解析目标页码与页内坐标；
  - 在阅读器左侧提供可折叠的窄面板（`220px`），支持 **「目录大纲」** 与 **「页面缩略图」** 切换，点击章节直接跳转到对应页码与坐标。

### 2. 缺失阅读器内全文搜索（`Ctrl+F`）与高亮跳转
- **代码位置**：`core/src/library.rs`（第 690–702 行 `search_blocks`）、`app/src/Reader.tsx`
- **现状问题**：虽然 Rust 后端已实现 `search_blocks`，但前端阅读器完全没有接入文内查找框、关键词高亮及“上一个/下一个”跳转。
- **修改方案**：
  - 在阅读器内监听 `Ctrl+F / Cmd+F`，呼出右上角浮动查找条；
  - 支持对当前打开的 PDF（原文或译文）进行全篇匹配计数、当前页与跨页匹配项高亮渲染，以及 `Enter / Shift+Enter` 上下跳转。

### 3. PDF 内部交叉引用与超链接点击失效
- **代码位置**：`app/src/PdfPane.tsx`（第 71–118 行）
- **现状问题**：`PageView` 只挂载了 `canvas`、`textLayer` 和自定义 `highlightLayer`，**未渲染 PDF.js 的 `AnnotationLayer`**。论文正文中的引用编号（如 `[12]`）、图表跳转（如 `Figure 4`、`Table 2`）、章节引用（`Section 3.2`）和外部 URL 全部无法点击。
- **修改方案**：
  - 接入 `pdfjsLib.AnnotationLayer` 渲染内部跳转链接与外部链接；
  - **增加“阅读位置历史栈（Back / Forward）”**：当用户点击正文中的 `[12]` 跳到文末参考文献，或点击 `Figure 4` 跳到跨页图表后，左下角或顶部浮现 **「← 返回原阅读位置（第 X 页）」** 按钮（快捷键 `Alt+Left`）。

### 4. 双栏对照同步粗糙，缺乏段落级双向对齐
- **代码位置**：`app/src/Reader.tsx`（第 413–417、438–442 行）、`app/src/PdfPane.tsx`（第 192–204 行）
- **现状问题**：目前双栏对照（`mode === "dual"`）仅传递 `page` 和页内滚动百分比 `fraction`。由于中英文排版折行高度不同，滚动时左右两栏会逐渐错位；点击原文某一段时，译文侧也不会高亮对应位置。
- **修改方案**：
  - 利用原文与译文同页的 `blocks` 几何坐标（`bbox`）建立段落级映射；
  - 在双栏对照模式下，支持**点击/悬停原文段落时高亮译文对应段落**（反之亦然），滚动同步优先对齐视口中央段落的 `bbox` 顶部坐标，无匹配时再回退到 `fraction`。

### 5. 批注系统简陋：不支持页面内直接点击交互、不支持区域截图批注、不支持跨页选词
- **代码位置**：`app/src/PdfPane.tsx`（第 136–139、246–261 行）、`app/src/Reader.tsx`（第 219–235、466–514 行）
- **现状问题**：
  - `.highlightLayer` 设置了 `pointer-events: none`，点击 PDF 页面上已有的高亮块没有任何反应，只能在右侧列表里找对应条目才能查看评论或删除；
  - 仅支持黄、绿两色文字划线，**不支持区域框选批注（Area / Rect Selection）**——无法对论文中的架构图、复杂公式或表格进行框选记笔记；
  - `PdfPane.tsx` 第 252 行 `holder !== element(range.endContainer)?.closest(".page-holder")` 直接丢弃跨页选区，导致跨页句子无法划线或翻译。
- **修改方案**：
  - 将 `.highlight` 设为可点击（`pointer-events: auto`），点击页面高亮直接弹出气泡查看/编辑评论、切换颜色（扩展为黄/绿/蓝/红/紫 5 色）或删除；
  - 新增 **「框选批注 / 截图提问」** 工具：按住 `Alt` 拖拽或点击顶部框选工具，在页面上框选任意矩形区域（图表/公式），保存为区域批注并支持将该区域截图/文本直接发给 AI 解释；
  - 支持跨相邻页的文本合并选择。

### 6. 旧译文批注丢失 & 补充材料（Supplementary PDF）无法翻译
- **代码位置**：`app/src/Reader.tsx`（第 92–97、322–335、365 行）
- **现状问题**：
  - `translatedVersion` 永远只取 `created_at` 最新的一条，重新翻译后旧译文上的批注被 `a.version_id === translated?.versionId` 过滤隐藏，无法回看；
  - 第 94、329、365 行通过 `!isPrimary` 硬编码禁用了非主文档的翻译与对照按钮，导致补充材料 PDF 无法翻译。
- **修改方案**：
  - 支持为任意 `source` 附件版本独立发起翻译并关联 `source_version_id`；
  - 当存在多个历史译文版本时，允许在顶部切换历史译文，或在重译时自动将旧译文批注按页码+归一化矩形迁移到新译文。

### 7. 缩放控制单一 & 超大 PDF 整文件内存拷贝
- **代码位置**：`app/src/Reader.tsx`（第 355–363 行）、`app/electron/main.cjs`（第 221–225 行）
- **现状问题**：
  - 缩放只有固定的 `− / +`（步进 `15%`），没有“适应页宽（Fit Width）”、“适应整页（Fit Page）”和 `Ctrl+滚轮` 缩放；
  - `main.cjs` 的 `pdf:bytes` 使用 `fs.promises.readFile` 一次性把整个 PDF 读入内存并通过 IPC 传给渲染进程，双栏模式下同时驻留两份完整 `Uint8Array`，遇到 100MB+ 的高清论文容易内存暴涨。
- **修改方案**：
  - 增加 `适应页宽`、`适应页高`、`50% / 75% / 100% / 125% / 150% / 200%` 缩放预设，支持 `Ctrl/Cmd + 滚轮` 连续缩放与常用键盘快捷键（`J/K` 或方向键翻页、`H` 高亮、`F` 适应宽度）；
  - 通过自定义 Electron 协议（如 `moonlight-pdf://version/<id>`）配合 HTTP Range Requests 让 PDF.js 流式按需读取字节，避免整文件 IPC 拷贝。

---

## 模块二：文献管理闭环补齐（Library 管理层）

当前文献管理（`app/src/Library.tsx`、`core/src/library.rs`、`core/src/organization.rs`、`core/src/pdfmeta.rs`）距离 Zotero 等成熟文献管理工具有以下关键缺口：

### 1. 目录与标签“能加不能删、能建不能管”
- **代码位置**：`app/src/FolderManager.tsx`、`app/src/OrganizePapers.tsx`、`core/src/organization.rs`
- **现状问题**：
  - **目录无法删除或合并**：`FolderManager.tsx` 和 `organization.rs` 只有新建目录、改名、改父级，**完全没有删除目录的接口与 UI**；
  - **标签无法管理**：没有重命名标签、修改标签颜色、删除废弃标签的功能；
  - **批量归类只能追加不能移除**：`bulk_assign` 只做 `INSERT OR IGNORE`，无法从所选的 50 篇论文中批量移除某个目录或标签。
- **修改方案**：
  - 在 `organization.rs` 新增 `folder_delete`（删除目录并提升子目录或一并解除关联，不删论文）、`tag_rename`、`tag_set_color`、`tag_delete` 以及 `bulk_unassign`；
  - 在左侧边栏目录树和标签列表支持右键菜单（新建子目录 / 重命名 / 改色 / 删除）。

### 2. 缺失基于 DOI / arXiv ID 的联网标准元数据自动补全
- **代码位置**：`core/src/pdfmeta.rs`（第 154–246 行）、`core/src/citations.rs`
- **现状问题**：
  - 导入 PDF 时，`pdfmeta.rs` 仅靠本地启发式规则猜测标题、作者、年份和会议；
  - 第 243 行会议名正则硬编码仅匹配 `(NIPS|NeurIPS|ICLR|ICML|ACL|EMNLP|CVPR|ICCV|AAAI|OSDI|SOSP|SIGCOMM)`，其余期刊/会议全部漏掉；
  - 当 PDF 缺少内嵌 Info Title 时，靠前 60 行大写字母比例打分，极易抽错标题或变成 `Untitled`；
  - 哪怕已经从正文提取出了准确的 `DOI` 或 `arXiv ID`，也没有去拉取标准元数据。
- **修改方案**：
  - 在 Rust 后端新增 `refresh_metadata`（并在导入提取到 `DOI` / `arXiv ID` 后后台自动触发）：调用 **arXiv API**（针对 arXiv 论文）和 **Crossref / Semantic Scholar API**（针对 DOI 论文），自动补全准确的标题、完整作者列表、年份、期刊/会议（Venue）、摘要，并支持在编辑器里一键「通过 DOI/arXiv 自动补全资料」。

### 3. 导入入口单一：缺少拖拽导入、标识符抓取入库、监控文件夹
- **代码位置**：`app/src/App.tsx`（第 115–134 行）、`app/electron/main.cjs`（第 202–212 行）
- **现状问题**：只支持点击“导入 PDF”弹出系统文件选择框。
- **修改方案**：
  - **支持全局拖拽导入（Drag & Drop）**：将 PDF 文件直接拖入应用窗口即可批量导入（若当前处于某个分类目录下，导入后自动归入该目录）；
  - **支持“通过 arXiv 链接 / arXiv ID / DOI 导入”**：在“导入”下拉菜单中提供输入框，输入 `2409.19256` 或 `https://arxiv.org/abs/2409.19256` 直接自动下载 PDF + 抓取元数据入库；
  - **支持监控本地文件夹（Watch Folder，可选配置）**：自动导入浏览器下载目录中新增的学术 PDF。

### 4. 重复论文检测单一，不支持合并重复条目
- **代码位置**：`core/src/library.rs`（第 218–230 行）
- **现状问题**：仅按 PDF 文件 `SHA256` 判重。同一篇论文的不同版本（如 arXiv v1、v2、Camera-Ready）会被当成多篇独立论文，且没有合并功能。
- **修改方案**：
  - 增加按 `DOI` / `arXiv ID`（去除 `vN` 后缀）及归一化标题的重复检测视图；
  - 实现 `merge_papers(primary_id, secondary_ids)`：将重复条目的 PDF 版本、批注、笔记、分类和标签无损合并到主条目下。

### 5. 批量操作能力不完整
- **代码位置**：`app/src/Library.tsx`（第 76 行）
- **现状问题**：勾选多篇论文后，只能点“分类/标签”和“更新所选引用量”，不支持批量导出 BibTeX/RIS、批量移入回收站、批量修改阅读状态、批量加入翻译队列。
- **修改方案**：在批量操作栏补齐 `批量导出 BibTeX/RIS`、`批量标记已读/未读`、`批量移入回收站`、`批量翻译`。

---

## 模块三：全文检索性能、AI 跨语言 RAG 与后台任务架构（Rust 核心层）

### 1. 全文检索架构缺陷：中文二字词退化全表扫描 + 大库高命中超时（491ms）
- **代码位置**：`core/src/search.rs`（第 29–90 行）
- **现状问题**：
  - **缺陷 A（中文二字词与短缩写无法走索引）**：`papers_search` 和 `blocks_search` 使用了 `tokenize='trigram'`。SQLite 的 `trigram` 必须 `>= 3` 个字符才能工作！当用户搜索 2 个字的中文核心词（如“蒸馏”、“量化”、“微调”、“对齐”、“注意”）或 2 字母缩写（`RL`、`LM`）时，`query.chars().count() < 3`，直接退化到第 82 行的 `papers` 表 5 个字段 `LIKE '%...%'` 全表扫描 + `blocks_fts`（`unicode61` 分词器会把整句中文当成 1 个词，无法匹配句中二字词）！
  - **缺陷 B（全量 `rowid` 拉回 Rust 再塞回 `json_each`）**：第 72–89 行先把所有匹配的 `rowid` 全部查出到 Rust `Vec<i64>`，再序列化成 JSON 字符串传回 SQLite：`p.rowid IN (SELECT value FROM json_each(?))`。在万篇库（40 万正文块）搜常见词时，捞出数千个 ID 再反序列化导致 P95 达到 **460–491ms**（超标 200ms 门槛两倍以上）。
- **修改方案**：
  - **消除 `Vec<i64>` + `json_each` 往返**：将 FTS 子查询直接通过 CTE（`WITH matched_papers AS (...)`）留在 SQLite 内部与 `papers` 表关联排序分页，利用索引提前截断；
  - **引入按论文聚合的全文检索表 `paper_text_fts`**：在 `blocks` 基础上按 `(paper_id)` 聚合或维护支持 CJK 二元切分（bigram）/ 字符级前缀的 FTS5 索引，彻底解决中文 2 字词全表扫描与 40 万碎块重复归并问题，将万篇高命中检索耗时压至 `< 50ms`。

### 2. AI 阅读助手的跨语言检索（中文提问、英文原文）失灵
- **代码位置**：`core/src/ai.rs`（第 14–46、89–100 行）
- **现状问题**：
  - `load_evidence` 查找相关页面时，将用户问题切分为英文词和中文 bigram，然后直接在英文原文 `blocks` 表上执行 `CASE WHEN lower(text) LIKE ? THEN 1 ELSE 0 END`；
  - 当论文是英文、用户用纯中文提问（例如：“作者是怎么解决显存瓶颈的？”）时，中文分词在英文 `blocks` 里的 `LIKE` 得分全部为 `0`！
  - 此时代码走第 98 行的兜底逻辑：**按页码均匀抽样 8 页**，极大概率漏掉真正包含答案的实验或方法页。
- **修改方案**：
  - **联动已生成的译文块 / 双语关键词扩展**：
    1. 若该论文已有中文译文版本，同时在译文文本块与原文文本块上检索页码；
    2. 内置学术常见中英术语映射表（如 `显存 -> memory/vram`、`吞吐 -> throughput`、`基线 -> baseline`、`消融 -> ablation`、`损失 -> loss` 等），并在提问前或检索层支持轻量中英查询词扩展；
    3. 结合 FTS5 `bm25()` 排序替代简单的 `LIKE` 计数。

### 3. 自定义 API 问答不支持流式输出（SSE）与中途取消
- **代码位置**：`core/src/engine.rs`（第 176–198 行 `chat`）、`app/src/Reader.tsx`（第 546 行）
- **现状问题**：
  - Codex 模式支持流式输出和取消，但用户配置自己的 OpenAI / DeepSeek 兼容 API 时，`engine::chat` 使用 `reqwest::blocking::Client` 同步阻塞等待整段回答完成（超时 300s），期间界面卡在“模型正在阅读原文…”，且停止按钮仅在 `aiProvider === 'codex'` 时才渲染。
- **修改方案**：
  - 将 `engine::chat` 升级为 `stream: true` 的 SSE 流式读取，每收到 delta 即通过 `lib.emit(json!({"event": "ai_delta", "request_id": ..., "answer": ...}))` 推送给前端，并绑定 `AtomicBool` 取消标志，使 API 模式与 Codex 模式具备完全一致的流式打字与随时停止体验。

### 4. 文档精细解析与离线 OCR 绑死在前端阅读页面，关闭即中断
- **代码位置**：`app/src/DocumentParsing.tsx`、`app/src/PdfPane.tsx`（第 205–223 行）
- **现状问题**：
  - 导入时 `pdfmeta.rs` 仅提取无坐标粗文本（`bbox: "[]"`）；带精确坐标的文本块和扫描件 OCR 必须在前端打开 `Reader` 后由 `DocumentParsing.tsx` 逐页执行；
  - 一旦用户返回论文库列表，`DocumentParsing` 卸载，`AbortController` 立即中止解析任务。
- **修改方案**：
  - 将解析与 OCR 纳入全局后台任务中心（`TaskCenter`），在隐藏的后台 Worker 或主进程/Sidecar 任务队列中持续运行，翻页或退出阅读器不中断解析进度，并持久化每篇论文的索引状态（`未索引 / 部分索引 / 已完成 / 扫描件待 OCR`）。

---

## 模块四：原位翻译质量、API 热更新与开箱体验（Engine 与配置层）

### 1. 修改翻译 API 配置必须重启整个软件，且缺少“测试连接”
- **代码位置**：`app/src/TranslationSettings.tsx`（第 16–18 行）、`app/electron/main.cjs`（第 185–199 行）、`core/src/library.rs`（第 920–930 行）
- **现状问题**：
  - 用户在设置里修改 API Base URL、API Key、模型 ID 或 QPS 后，必须重启软件才能生效；
  - 没有 **「测试 API 连接」** 和 **「检测 BabelDOC 引擎」** 按钮，配置填错要等发起翻译任务失败后才知道。
- **修改方案**：
  - 在 Rust `Library` 中新增 `reload_gateway(upstream, model, key, qps, babeldoc_bin)` RPC 接口，保存配置时直接热更新内存中的 `Gateway` 实例，**无需重启软件**；
  - 在 `TranslationSettings.tsx` 增加 `[测试 API 连接]`（发送最小探针请求验证鉴权与模型名）和 `[检查 BabelDOC 环境]` 按钮，明确反馈成功或具体错误原因（如 401 Key 无效、404 模型不存在、超时、未找到可执行文件）。

### 2. 原位翻译版面缺陷修复（算法伪代码与行内公式）
- **代码位置**：`core/src/engine.rs`、`moonlight/engine.py`
- **现状问题**：根据 M0 实测（`artifacts/validation/m0-20261031T1005/visual-review.md`），HybridFlow 第 18 页的 `Algorithm 2` 伪代码块保留了英文但未做任何提示；部分段落的行内公式符号在译文文本层出现顺序移位；作者单位短块出现“谷歌大 / 脑”式碎裂换行。
- **修改方案**：
  - 在引擎适配与后处理层识别 `Algorithm` 伪代码块与公式块，明确保留原样并在任务结果/阅读器提示中标明“算法与公式块已按学术规范保留原文”；
  - 调整 BabelDOC 调用参数与字体回退策略，修复低于 8pt 的极端字号缩放。

---

## 模块五：前端视觉审美与交互体验重构（UI/UX 设计层）

> 本模块完整对应 [FRONTEND_UX_REVIEW.md](file:///home/bynshard/themoonlight/docs/FRONTEND_UX_REVIEW.md) 的前端专项规范。

### 1. 必改的 4 个硬伤级 UI/定位 Bug（P0）
1. **阅读器模式下左侧导航栏常驻且“点击假死”**（`App.tsx#L209-L288`）：
   - 打开 `Reader` 时左侧 `236px` 的 `.sidebar` 依然占地方，且点击里面的目录/标签不会关闭 `openPaper`（点了没反应）。
   - **修复**：进入阅读器时自动折叠左侧全局导航栏（把空间让给双栏对照 PDF），且点击任何全局分类/标签时自动切回列表视图；右侧边栏支持拖拽调宽与一键收起。
2. **左下角“任务中心”按钮悬浮遮挡侧栏**（`App.tsx#L290`、`styles.css#L238`）：
   - `.task-center-button { position: fixed; left: 12px; bottom: 72px; }` 直接浮在左侧目录树/标签上。
   - **修复**：移除 `position: fixed`，将其与“设置与状态”并排放入 `.sidebar-foot` 底部固定栏，并展示进行中任务数角标。
3. **表格“更多操作 `⋯`”菜单永远飞到表格右上角**（`PaperTable.tsx#L57`、`styles.css#L329`）：
   - `.table-context-menu { position: absolute; top: 42px; right: 10px; }` 导致点第 20 行的 `⋯`，菜单却弹在表格右上角，且点外部无法关闭。
   - **修复**：改为基于触发按钮 `getBoundingClientRect()` 的浮动 Popover，支持右键触发与点击外部/按 `Esc` 关闭。
4. **“编辑论文资料”弹窗漏写输入框样式 + 原生 `<select multiple>` 极易误清空**（`PaperEditor.tsx`、`styles.css#L234-L236`）：
   - `.paper-editor input/textarea/select` 没有写 `border`、`border-radius`、`padding`、`background`，直接渲染成丑陋的浏览器原生控件；分类用 `<select multiple>` 单点即清空旧分类。
   - **修复**：统一全局表单样式，改为双列紧凑网格布局，分类与标签改用多选胶囊组件（Checkbox Pills / Combobox）。

### 2. 论文库与阅读器的核心交互升级（P1）
1. **消除论文库顶部“三层工具栏堆叠”**：
   - 将 `.library-head`、`.library-organize-bar`、`.table-view-tools` 合并为单行清爽 Header；
   - 批量操作栏改为**仅当 `selected.size > 0` 时浮现的上下文操作胶囊（Contextual Action Bar）**；删掉满屏的灰色说明书文字。
2. **增加右侧“论文详情检视抽屉（Inspector Drawer）”**：
   - 改变“单击标题直接进 PDF 阅读器”的生硬跳转：**单击表格行**在右侧展开 `320px` 详情面板（预览/编辑标题、作者、DOI、速记、摘要、笔记、附件版本），**双击行**或点 `[阅读]` 才进入阅读器。
3. **PDF 选词改用“就地浮动菜单（Selection Popover）”**：
   - 删掉 `Reader.tsx#L421` 中 `if (s) setTab("notes")` 强行切 Tab 的逻辑；
   - 选中文字后直接在选区旁弹出浮动小工具条：`[🟡][🟢][🔵][🔴] | [📝 批注] [🌐 翻译] [✨ 解释] [💬 引用提问] [📋 复制]`。
4. **AI 阅读助手升级为标准三段式 Chat UI**：
   - 将顶部占地方的“上下文范围”、“带入 6 轮对话”、“查看将发送的上下文 Prompt”收进右上角 `⚙️` 气泡；
   - 中间改为按时间顺序滚动的对话消息流（Chat Thread），底部固定自适应输入框 + 选区引用预览条。
5. **收纳阅读器顶部的 `DocumentParsing` 工具条**：
   - 正常文本 PDF 不再常驻显示“解析当前页 / OCR 当前页 / 解析全文”一排按钮，简化为顶部状态徽标；仅当检测到当前页为无文本层的扫描页时才弹出温和的 OCR 引导条。
6. **拆分“设置与状态”大杂烩弹窗 & 引入矢量图标库**：
   - 将单列超长滚动的设置弹窗改为 **左侧分栏导航（通用 / 翻译引擎 / AI 助手 / 云同步 / 备份恢复）+ 右侧面板**；
   - 引入 `lucide-react` 矢量图标替换所有手写 Unicode 字符（`◐`、`◫`、`★`、`▾`、`⋯`），并将浑浊的 7 种米黄底色升级为高对比度的清爽暖白（`--bg: #f7f6f2`、`--panel: #ffffff`、`--accent: #256353`）。

---

## 分阶段交付路线图（Checklist）

团队可按以下 4 个 Sprint 并行推进：

### Sprint 1：前端 UI/UX 纠偏与基础体验修复（最快见效）
- [ ] 引入 `lucide-react` 图标库与新版清爽暖白 CSS 变量体系（`styles.css`）
- [ ] 修复 `.task-center-button` 悬浮遮挡、`.table-context-menu` 右上角错位、`.paper-editor` 漏写样式及 `<select multiple>` 问题
- [ ] 阅读器打开时自动折叠左侧 `.sidebar`（或点击侧栏自动切回列表），右侧 `.side` 支持拖拽宽度与收起
- [ ] 合并论文库三层工具栏，实现勾选后浮现的批量操作栏 + 单击右侧详情预览抽屉（Inspector Drawer） + 列表内一键切换阅读状态
- [ ] 重构设置弹窗为左右分栏 Tab 结构

### Sprint 2：阅读器深度阅读功能补齐
- [ ] 去掉 PDF 选词强切 `notes` Tab，实现选区旁浮动工具条（Popover）与页面内 `.highlight` 点击编辑/删除气泡
- [ ] 接入 PDF `getOutline()` 目录大纲与缩略图侧栏 + `AnnotationLayer` 内部引用点击跳转与“返回原位置”导航栈
- [ ] 实现阅读器内 `Ctrl+F` 全文查找与高亮上下跳转
- [ ] 增加“适应页宽 / 整页”缩放、`Ctrl+滚轮` 缩放、框选区域批注（Area Highlight）及补充材料/多译文版本切换
- [ ] 重构右侧 AI 面板为标准流式对话流（Chat Thread），收纳 `DocumentParsing` 工具条

### Sprint 3：文献管理闭环与自动化
- [ ] 补齐目录删除/合并、标签重命名/改色/删除、批量移除归类、批量导出与批量删除（`organization.rs` + 前端）
- [ ] 实现基于 `DOI` / `arXiv ID` 的 Crossref / arXiv API 标准元数据自动补全（`pdfmeta.rs` / `citations.rs`）
- [ ] 支持窗口拖拽导入 PDF（Drag & Drop）与输入 `arXiv ID / DOI / URL` 直接下载入库
- [ ] 实现重复论文检测与无损合并（`merge_papers`）

### Sprint 4：底层搜索性能、AI 检索与配置热更新
- [ ] 重构 `core/src/search.rs`：消除 `json_each` 大数组往返，补齐中文二字词 FTS5 索引支持，将万篇库检索压至 `< 50ms`
- [ ] 升级 `core/src/ai.rs` 与 `engine.rs`：支持跨语言（中问英答）证据检索，为自定义 OpenAI 兼容 API 接入 SSE 流式输出与中途取消
- [ ] 实现翻译配置热更新（`reload_gateway`，告别重启生效）与“测试 API 连接 / 检查 BabelDOC 环境”诊断按钮
- [ ] 将 PDF 精细块解析与离线 OCR 迁入后台持久任务队列，退出阅读器不中断
