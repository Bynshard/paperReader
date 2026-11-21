# Moonlight（paperReader）用户体验差距审查与打磨规范（UX Polish Spec）

> **编写日期**：2026-11-21 ｜ **适用设备**：Windows 桌面端 + **vivo Pad 5 Pro**（13 寸 3.1K 3:2 平板端）  
> **适用对象**：DeepSeek / 前端与全栈开发者直接按本规格分批落地施工  
> **前置关联**：架构/Bug/Paper↔Code 规格见 [vivo Pad 5 Pro 专属适配与全栈审查](VIVO_PAD5_PRO_REVIEW_AND_DESIGN.md)；本文聚焦 **直接影响日常读写手感的“用户体验（UX）”问题与竞品差距**。

---

## 目录

- [1. 现存 4 个反直觉 UX Bug（UX-P0，立即修复）](#1-现存-4-个反直觉-ux-bugux-p0立即修复)
- [2. Sprint 2 前后端接线收尾核对清单（影响体验的 5 个断点）](#2-sprint-2-前后端接线收尾核对清单影响体验的-5-个断点)
- [3. 对标成熟软件的 6 大核心体验升级规格](#3-对标成熟软件的-6-大核心体验升级规格)
  - [3.1 文献库管理与快速初筛体验（vs Zotero 7 / 小绿鲸）](#31-文献库管理与快速初筛体验vs-zotero-7--小绿鲸)
  - [3.2 多任务阅读与文内跳转体验（vs Sioyek / Zotero 7 / ReadPaper）](#32-多任务阅读与文内跳转体验vs-sioyek--zotero-7--readpaper)
  - [3.3 双语对照与沉浸式翻译体验（vs 小绿鲸 / Immersive Translate）](#33-双语对照与沉浸式翻译体验vs-小绿鲸--immersive-translate)
  - [3.4 AI 伴读与多模态区域交互体验（vs Corca Moonlight / SciSpace）](#34-ai-伴读与多模态区域交互体验vs-corca-moonlight--scispace)
  - [3.5 批注沉淀与精读笔记闭环体验（vs Zotero Better Notes / MarginNote 4）](#35-批注沉淀与精读笔记闭环体验vs-zotero-better-notes--marginnote-4)
  - [3.6 设置清晰度与 vivo Pad 5 Pro 扫码即连体验](#36-设置清晰度与-vivo-pad-5-pro-扫码即连体验)
- [4. DeepSeek 分批施工路线图与验收命令](#4-deepseek-分批施工路线图与验收命令)

---

## 1. 现存 4 个反直觉 UX Bug（UX-P0，立即修复）

这 4 个问题均由核对当前前端源码确认，属于“用户一上手就会卡住或怀疑软件坏了”的直观体验瑕疵，修改成本低、收益极高。

### UX-BUG-01：未翻译论文无法点击「只翻译当前页」菜单

- **问题代码**：[app/src/Reader.tsx](file:///home/bynshard/paperReader/app/src/Reader.tsx#L782-L787)、[app/src/Reader.tsx](file:///home/bynshard/paperReader/app/src/Reader.tsx#L973-L978)
- **现状缺陷**：
  - `Reader.tsx:786` 写成了 `{translated && <button className="icon-btn" aria-label="翻译选项" ... />}`，下拉菜单按钮被 `{translated && ...}` 隐藏。
  - 当一篇 30 页的论文尚未翻译（`!translated`）时，用户想先试翻第 1 页或当前页验证术语/API 速度，界面上只有「翻译全文」一个按钮且点下拉都点不开，被迫整篇翻译。
- **改造规格**：
  1. 移除 `Reader.tsx:786` 的 `{translated && ...}` 门控，**无论是否已有译文，始终渲染「翻译选项」下拉箭头按钮**。
  2. 在 `showTranslateMenu`（`Reader.tsx:973-978`）中固定提供三个选项：
     - `只翻译当前页（第 ${page} 页）` → `startTranslate(String(page))`
     - `翻译指定页码范围…` → 展开一行内联输入框（placeholder 如 `1-5, 8`，校验匹配 `/^\d+(-\d+)?(\s*,\s*\d+(-\d+)?)*$/`），回车或点「开始」调用 `startTranslate(range.trim())`
     - `翻译全文` → `startTranslate(undefined)`

### UX-BUG-02：框选工具 (`tool === "area"`) 粘滞锁死平板单指滚动

- **问题代码**：[app/src/Reader.tsx](file:///home/bynshard/paperReader/app/src/Reader.tsx#L742)、[app/src/Reader.tsx](file:///home/bynshard/paperReader/app/src/Reader.tsx#L810)、[app/src/styles.css](file:///home/bynshard/paperReader/app/src/styles.css#L691-L693)
- **现状缺陷**：
  - 当用户点击工具栏「框选」开启 `tool === "area"` 后，`.pane-scroll.area-mode` 设置了 `touch-action: none`。
  - 用户画完一个图表框选触发 `onAreaSelect`（`Reader.tsx:810` / `825`）后，代码只设置了 `setSelection(...)` 和 `setAnnotating(true)`，**从未自动把 `tool` 重置回 `"select"`**。
  - 在 vivo Pad 5 Pro 上，用户接下来用手指往下滑翻页时，屏幕完全不滚动而是不断画出新的框选框，需要再抬头去点工具栏取消。
- **改造规格**：
  1. 新增 `const [areaLocked, setAreaLocked] = useState(false);`（区分单次框选与连续框选）。
  2. 单击「框选」按钮开启单次框选（`tool === "area"`，`areaLocked = false`）；双击该按钮（或下拉选择/长按）切换 `areaLocked = true`（按钮文案显示 `🔒 连续框选`）。
  3. 在 `onAreaSelect` 回调中，若 `!areaLocked`，立即执行 `setTool("select")`，划完框立刻恢复单指平滑滚动；若用户点 `Esc` 也退出框选态。

### UX-BUG-03：划词「翻译 / 解释」强行劫持右侧栏并污染 AI 对话记录

- **问题代码**：[app/src/Reader.tsx](file:///home/bynshard/paperReader/app/src/Reader.tsx#L605-L639)、[app/src/Reader.tsx](file:///home/bynshard/paperReader/app/src/Reader.tsx#L851-L856)
- **现状缺陷**：
  - 用户阅读时只是随手想查一个长难句/生词，点击选区浮动工具条的 `🌐 翻译` 或 `✨ 解释` 后，执行 `ask("translate")` / `ask("explain")`。
  - `Reader.tsx:615` 无条件执行 `setTab("ai")`，不仅**瞬间关掉用户正在写的笔记 Tab / 跳转视口**，还会把查词结果作为永久一轮对话写进 `chats` 表，造成后续正常多轮学术问答流充满零散查词噪音。
- **改造规格**：
  1. 为阅读器新增局部浮动气泡状态：
     ```ts
     const [quickResult, setQuickResult] = useState<{
       kind: "translate" | "explain";
       quote: string;
       answer: string;
       loading: boolean;
       error?: string;
       x: number;
       y: number;
     } | null>(null);
     ```
  2. 点击选区浮动工具条上的 `翻译` / `解释` 时：
     - **不再调用 `setTab("ai")`**，也不入队左侧/右侧持久 `chats` 历史（`translate_text` 本身无库记录；针对局部解释增加轻量化 RPC 或 `ephemeral: true` 参数，或在气泡内走只读预览不入库）；
     - 直接在选区工具条下方通过 `FloatingLayer` 渲染「**就地译文 / 释义浮窗**」（最大宽 `420px`，支持流式打字显示），底部提供三个微操作按钮：
       - `[复制译文]`
       - `[📌 存入高亮批注]`（直接把译文/释义填入当前选段批注的 `comment` 并调用 `addHighlight`）
       - `[💬 转入右侧深聊]`（此时才真正落库并打开 `setTab("ai")` 继续追问）。

### UX-BUG-04：阅读器「笔记」Tab 只读不可写，且硬编码标题「迁入笔记」

- **问题代码**：[app/src/Reader.tsx](file:///home/bynshard/paperReader/app/src/Reader.tsx#L892-L915)
- **现状缺陷**：
  - `Reader.tsx:894` 仅当 `paper.notes` 非空时才只读展示，并且标题写死为 `<h3>迁入笔记</h3>`（实际上用户在软件内手动编辑保存的也是 `paper.notes`）。
  - 边读边写整篇总结时，必须在 `Reader` 里点左上角打开全屏模态弹窗 `PaperEditor` 遮住 PDF，**无法一边看图/公式一边在右侧写笔记**。
- **改造规格**：
  1. 在 `Reader.tsx` 的 `tab === "notes"` 顶部固定渲染 **可实时编辑的 Markdown 笔记区**（标题正名为 `<h3>整篇阅读笔记</h3>`）。
  2. 绑定本地草稿状态 `noteDraft`（随 `paper.id` 重置），输入后 **600ms 防抖自动调用 `api.savePaper` / `api.updatePaper(paper.id, { notes: noteDraft })`** 并更新父组件 `onChanged(fresh)`，右上角展示 `保存中… / 已保存` 状态指示（具体增强见 §3.5）。

---

## 2. Sprint 2 前后端接线收尾核对清单（影响体验的 5 个断点）

> **说明**：后台核心（如 `core/src/main.rs`、`core/src/search.rs`、`core/src/ai.rs`）正在同步收敛 Sprint 2 改动；若以下某项在当前最新工作区已落地，验收确认后打 `[x]` 跳过即可，未完成项请按本清单补齐：

1. **前端 HTTP/SSE 桥接 Fallback（使 vivo Pad 5 Pro 真正连上后端）**：
   - 现状参照：[core/src/server.rs](file:///home/bynshard/paperReader/core/src/server.rs#L1-L14) 已完整实现 `/api/rpc`、`/api/events`、`/api/pdf/:id` 与静态资源托管，但 [app/src/api.ts](file:///home/bynshard/paperReader/app/src/api.ts#L29) 目前仍只有 `const bridge = () => window.moonlight;`。
   - 要求：在 `app/src/api.ts` 实现 `createHttpBridge()`（从 URL `?token=` 提取并持久化到 `sessionStorage`/`localStorage`，随后 `history.replaceState` 脱敏移除地址栏 token；`call` 走 `POST /api/rpc`；`onEvent` 走 `EventSource('/api/events?token=...')`；`appInfo` 复用 `app_info` RPC），当 `typeof window.moonlight === "undefined"` 时自动切换至 `createHttpBridge()`。
2. **PDF 流式 URL 按需加载（消除大 PDF 首开卡顿与内存峰值）**：
   - 现状参照：[app/electron/main.cjs](file:///home/bynshard/paperReader/app/electron/main.cjs#L169-L201) 已注册支持 `Range` 206 的 `moonlight-pdf://version/<version_id>` 协议，但 `main.cjs:293`（`pdf:bytes`）与 [app/src/PdfPane.tsx](file:///home/bynshard/paperReader/app/src/PdfPane.tsx#L505)（`pdfjsLib.getDocument({ data: bytes.slice() })`）仍未切换到 URL 模式。
   - 要求：`readPdf` / `PdfPane` 支持 `{ url, versionId, pages }`（桌面端优先使用 `moonlight-pdf://version/<id>`，平板 Web 端使用 `/api/pdf/<id>?token=...`），`PdfPane` 向 `pdfjsLib.getDocument({ url, rangeChunkSize: 65536, disableAutoFetch: false })` 传流式地址。
3. **HTTP 服务端读查询分流至只读连接池**：
   - 现状参照：[core/src/main.rs](file:///home/bynshard/paperReader/core/src/main.rs#L106-L120) 已让 HTTP Server 的 `list_papers_page` 走 `read_pool`，建议顺手把高频只读 RPC（`get_paper`、`list_annotations`、`ai_history`、`list_taxonomy`）在写操作间隙也评估分流，防止翻译/AI 写库期间阻塞平板端列表与批注读取。
4. **3.1K 平板高清 Canvas 像素预算提升**：
   - 现状参照：[app/src/PdfPane.tsx](file:///home/bynshard/paperReader/app/src/PdfPane.tsx#L370) 与 `650` 行仍以 `8_388_608`（8MP）封顶。在 vivo Pad 5 Pro（`3096 × 2064`，DPR ≥ 2）上放大至 `150%–200%` 时会触发降采样发虚。
   - 要求：根据设备特征动态放宽单页上限（当 `(window.devicePixelRatio || 1) >= 2 && Math.max(screen.width, screen.height) >= 1200` 时采用 `12_582_912`（12MP）预算，同时保留 `virtual` overscan 控制释放非可视区画布避免 OOM）。
5. **前后端「带入最近 6 轮对话」行为与文案彻底一致**：
   - 现状参照：[core/src/ai.rs](file:///home/bynshard/paperReader/core/src/ai.rs#L793-L821) 与 [core/src/main.rs](file:///home/bynshard/paperReader/core/src/main.rs#L538) 已支持 `include_history`；需确保 [app/electron/ai-service.cjs](file:///home/bynshard/paperReader/app/electron/ai-service.cjs#L45) 的 `preview()` 对 `api` 与 `codex` 两种 provider 返回一致的 `history` 预览，且 [app/src/Reader.tsx](file:///home/bynshard/paperReader/app/src/Reader.tsx#L933) 移除误导性的 `（Codex）` 后缀，统一写为 `带入最近 6 轮对话`。

---

## 3. 对标成熟软件的 6 大核心体验升级规格

以下按实际论文工作流拆解 **Moonlight 当前产品层与 Zotero 7 / 小绿鲸 / Sioyek / ReadPaper / Corca / MarginNote 4 的真实体验差距**，每项均给出具体模块、数据结构与交互规格。

---

### 3.1 文献库管理与快速初筛体验（vs Zotero 7 / 小绿鲸）

**当前差距分析**：
- 在 100 篇到 10,000 篇规模下，`PaperTable`（表格视图）缺少「期刊/会议 (Venue)」列，导致快速筛选顶会论文时只能退回占空间的卡片视图；
- 缺少 Zotero 7 / 小绿鲸常见的「顶会徽章（CCF-A / NeurIPS）」、侧边栏目录/标签拖拽归档、右键管理与文献数量统计；
- 全文搜正文命中时，列表只显示标题，看不到「正文哪一页命中了哪句话」；
- 缺少桌面向下兼容键盘 `↑ / ↓ / Enter / Shift+Click` 连续浏览体验。

**具体升级规格**：

1. **`PaperTable` 补齐 Venue 列与离线 CCF/顶会徽章**：
   - **目标文件**：新建 `app/src/venueTier.ts`，修改 [app/src/PaperTable.tsx](file:///home/bynshard/paperReader/app/src/PaperTable.tsx#L33-L115)、[app/src/Library.tsx](file:///home/bynshard/paperReader/app/src/Library.tsx#L250)。
   - `PaperTable.tsx`: `COLUMN_LABELS` 增加 `venue: "期刊 / 会议"`，`HIDEABLE_COLUMNS` 加入 `"venue"`（默认可见），`columnOrder` 调整为 `["select", "title", "venue", "year", "citations", "tags", "short_note", "categories", "status", "actions"]`。
   - `venueTier.ts`: 编写纯前端离线正则匹配字典 `matchVenueTier(venue?: string | null): { label: string; tone: "ccf-a" | "ccf-b" | "top-journal" } | null`，覆盖主流 AI/系统/安全顶会与期刊（如 `NeurIPS`, `ICML`, `ICLR`, `CVPR`, `ICCV`, `ECCV`, `ACL`, `EMNLP`, `AAAI`, `OSDI`, `SOSP`, `SIGCOMM`, `USENIX Security`, `CCS`, `VLDB`, `SIGMOD`, `TPAMI`, `Nature`, `Science` 等）。在表格 `venue` 列和卡片视图 `paper.venue` 旁渲染紧凑徽章（如 `CCF-A`）。

2. **侧边栏目录树 & 标签列表交互完整化（拖拽 + 右键 + 数量 + 颜色点）**：
   - **目标文件**：[app/src/FolderTree.tsx](file:///home/bynshard/paperReader/app/src/FolderTree.tsx#L6-L13)、[app/src/TaxonomyList.tsx](file:///home/bynshard/paperReader/app/src/TaxonomyList.tsx#L3-L16)、[app/src/PaperTable.tsx](file:///home/bynshard/paperReader/app/src/PaperTable.tsx)、[core/src/organization.rs](file:///home/bynshard/paperReader/core/src/organization.rs)。
   - **拖拽归类**：给 `PaperTable` 行和 `Library` 卡片添加 `draggable` 与 `onDragStart`（写入 `application/x-moonlight-paper-ids` JSON 数组；若当前行已在勾选集合 `selected` 中，则批量拖出所有已选论文）；在 `FolderTree` 行与 `TaxonomyList` 标签项支持 `onDragOver`/`onDrop` 高亮目标并调用 `api.bulkAssign({ paper_ids, category_id / tags })`。
   - **右键上下文菜单**：
     - `FolderTree` 单击右键触发浮层菜单：`新建子目录`、`重命名`、`移至根目录`、`删除目录`（复用已有 `save_category` / `folder_move` / `folder_delete` RPC）。
     - `TaxonomyList` 渲染标签真实颜色小圆点（复用 `tagColor(tag)`）并支持右键菜单：`重命名标签`、`切换颜色`、`删除标签`（复用 `tag_rename` / `tag_set_color` / `tag_delete`）。
   - **数量角标**：后端 `list_taxonomy` 返回每个 `category` / `tag` 的 `paper_count`（基于未进回收站文献统计），侧边栏右侧弱化展示数字（如 `18`）。

3. **拖入/导入 PDF 后自动后台静默补全元数据**：
   - **目标文件**：[app/src/App.tsx](file:///home/bynshard/paperReader/app/src/App.tsx#L131-L168)。
   - 在 `doImport` 与 `importDropped` 返回 `status === "imported"` 的新论文后，对提取出 `doi` 或 `arxiv` 且 `venue`/`year`/`abstract` 仍为空的条目，以并发度 2 后台静默调用 `api.refreshMetadata(paper_id, false)`（不阻塞用户当前交互，完成后刷新列表并 Toast 轻提示 `已自动补全 X 篇元数据`）。

4. **全文搜索命中页码与上下文摘要直达**：
   - **目标文件**：[core/src/search.rs](file:///home/bynshard/paperReader/core/src/search.rs)、[app/src/Library.tsx](file:///home/bynshard/paperReader/app/src/Library.tsx)、[app/src/Reader.tsx](file:///home/bynshard/paperReader/app/src/Reader.tsx)。
   - 当 `list_papers_page` 带有非空 `query` 且命中来自 `blocks` 全文索引时，为命中的每篇 `PaperSummary` 附加可选字段 `match_snippet?: { page: number; text: string; version_id?: string } | null`（返回第一个命中块前后约 80 字符与 0-based `page`）。
   - 前端在表格标题下方和卡片元信息下方展示高亮摘要片段与 `[p.{page + 1} 直达]` 按钮，点击后调用 `onOpen(paper, { initialPage: page + 1, searchQuery: query })`，打开阅读器即自动定位到命中页并打开高亮。

5. **桌面键盘流 & Shift 范围多选**：
   - **目标文件**：[app/src/PaperTable.tsx](file:///home/bynshard/paperReader/app/src/PaperTable.tsx)。
   - 表格容器聚焦时支持 `ArrowDown` / `ArrowUp` 移动 `inspectedId` 并自动触发 `onInspect` + `virtual.scrollToIndex` 跟随，按 `Enter` 直接调用 `onOpen`；复选框点击支持按住 `Shift` 键自动勾选上次点击索引到当前索引之间的全部论文。

---

### 3.2 多任务阅读与文内跳转体验（vs Sioyek / Zotero 7 / ReadPaper）

**当前差距分析**：
- 当前 [app/src/App.tsx](file:///home/bynshard/paperReader/app/src/App.tsx#L37) 使用单个 `openPaper: Paper | null`，切回论文库找参考文献会直接卸载 `<Reader>`，丢失已渲染的 PDF.js 缓存、缩放状态、文内查找结果与右侧问答滚动条；
- 阅读正文遇到 `[12]`、`Figure 4`、`Equation (3)` 时，[app/src/PdfPane.tsx](file:///home/bynshard/paperReader/app/src/PdfPane.tsx#L438) 直接整页跳转，读者看过图后再回原段落极易迷失上下文（虽然有 `Alt+←`，但在 vivo Pad 5 Pro 触屏上需要频繁点头部小按钮）。

**具体升级规格**：

1. **多标签页阅读工作区（Multi-Tab Reader）**：
   - **目标文件**：[app/src/App.tsx](file:///home/bynshard/paperReader/app/src/App.tsx#L37-L338)、[app/src/styles.css](file:///home/bynshard/paperReader/app/src/styles.css)。
   - 状态模型改造：
     ```ts
     type WorkspaceTab = { paper: Paper; initialJump?: { page: number; query?: string } };
     const [tabs, setTabs] = useState<WorkspaceTab[]>([]);
     const [activeTabId, setActiveTabId] = useState<string>("library"); // "library" 或 paper.id
     ```
   - UI 与保活策略：
     - 当 `tabs.length > 0` 时，在 `.main` 顶部渲染高度 `38px`（平板触控友好）的水平可滚动标签栏：`[📚 论文库] [📄 Paper A ×] [📄 Paper B ×] ...`。
     - 已打开的 `<Reader>` 实例（上限建议最近 5 篇，超出按 LRU 淘汰最久未激活 Tab 的组件或提醒关闭）通过 `hidden={activeTabId !== tab.paper.id}` + `display: none` 保持挂载，**从论文库切回正在精读的论文实现 0ms 瞬切，且保留页面、缩放、AI 对话与查找状态**。
     - 支持中键点击 Tab 关闭、平板点击 `×` 关闭、热键 `Ctrl+Tab` / `Ctrl+W` 切换与关闭。

2. **Sioyek 式引用/图表智能预览浮窗与固定传送门（Smart Hover & Pinned Portal）**：
   - **目标文件**：[app/src/PdfPane.tsx](file:///home/bynshard/paperReader/app/src/PdfPane.tsx#L435-L439)、[app/src/Reader.tsx](file:///home/bynshard/paperReader/app/src/Reader.tsx)。
   - 当用户点击 PDF 内部链接按钮 `.pdf-link`（`PdfPane.tsx:438`，包含 `dest.page` 与 `dest.fraction`，以及进一步从目标页位置推导或整幅可视区域）：
     - **行为改为优先弹出预览卡片**（而非立刻把主阅读窗滚走）：在点击位置旁弹出一个带阴影的预览浮窗（如 `380 × 260 dp`），使用 `doc.getPage(targetPage)` 离屏 Canvas 按清晰倍率渲染以 `dest.fraction` 为中心的目标区域片段（图/表/参考文献条目一目了然）。
     - 预览窗标题栏提供两个按钮：
       - `[📌 钉在角落对照]`：将该区域转为阅读区右下角/右上角可拖动小窗（Pinned Portal，类似 Sioyek `Overview` 窗口），读者继续往下滚动正文推导公式时，上方图表/公式始终常驻视野内！
       - `[↗ 跳转到第 X 页]`：记录 `remember()` 历史后执行原整页跳转并关闭浮窗。

---

### 3.3 双语对照与沉浸式翻译体验（vs 小绿鲸 / Immersive Translate）

**当前差距分析**：
- 翻译执行时，[core/src/engine.rs](file:///home/bynshard/paperReader/core/src/engine.rs#L789-L802) 只粗略汇报 `parsing / translating / typesetting / validating`，前端 [app/src/Reader.tsx](file:///home/bynshard/paperReader/app/src/Reader.tsx#L792) 的 `.progress` 进度条只是一个无明确数字的动画条，用户不知道翻到第几页、还要等多久；
- 双栏对照模式（`mode === "dual"`）只能死守 50% / 50% 等分，当一侧字体较小或需要主看译文辅查原文图注时，缺少中线拖动比例条。

**具体升级规格**：

1. **解析 BabelDOC 真实百分比、页码进度与计时器**：
   - **目标文件**：[core/src/engine.rs](file:///home/bynshard/paperReader/core/src/engine.rs#L789-L802)、[core/src/library.rs](file:///home/bynshard/paperReader/core/src/library.rs)、[app/src/Reader.tsx](file:///home/bynshard/paperReader/app/src/Reader.tsx#L792)。
   - 在 `engine.rs:789` 的 `wait_for_engine` 日志行回调中，用轻量正则/子串提取 BabelDOC（已传 `--report-interval 5`）输出的进度数字（如 `\b(\d{1,3})%` 或 `(\d+)\s*/\s*(\d+)` 页/段），当进度变化时（节流每秒最多 1 次）通过 `library.emit(json!({"event":"job", "jobId": job_id, "phase": phase, "progress": pct, "detail": detail}))` 推送给桌面前端及平板 SSE。
   - `Reader.tsx:792` 的 `.jobbar` 展示真实数值进度条 `width: ${job.progress}%` 与文本：`翻译中 · ${job.detail || ""} (${job.progress}%) · 已用时 ${elapsedText}`。

2. **双栏可拖拽分隔条（Resizable Dual Panes）**：
   - **目标文件**：[app/src/Reader.tsx](file:///home/bynshard/paperReader/app/src/Reader.tsx#L800-L832)、[app/src/styles.css](file:///home/bynshard/paperReader/app/src/styles.css)。
   - 为 `.panes.mode-dual`（含未来的 `mode-paper-code`）增加 `splitRatio` 状态（默认 `0.5`，范围限制 `[0.28, 0.72]`，持久化至 `localStorage`）。
   - 在两栏中间插入 6px 宽（触控热区 16px）的 `<div className="pane-splitter" role="separator" />`，支持鼠标与 `PointerEvent` 拖拽，双击自动重置为 `50:50`。

---

### 3.4 AI 伴读与多模态区域交互体验（vs Corca Moonlight / SciSpace）

**当前差距分析**：
- 当前右侧 `阅读助手` 打开后是一片空白聊天框 + 仅 2 个按钮（`总结本页`、`提炼核心贡献`），面对一篇 15 页的新论文，读者缺乏全局结构化认知入口；
- 在 vivo Pad 5 Pro 上每次针对选区提问（如某个公式变量含义、某个实验表对比），都要调出平板虚拟键盘打字；
- 框选区域追问 `areaAsk`（[app/src/Reader.tsx](file:///home/bynshard/paperReader/app/src/Reader.tsx#L666-L669)）目前仅弹提示 Toast，图表和复杂矩阵公式无法让多模态模型直接看图解读。

**具体升级规格**：

1. **一页纸结构化导读卡片（1-Page Paper Digest，可缓存持久化）**：
   - **目标文件**：[core/src/library.rs](file:///home/bynshard/paperReader/core/src/library.rs)、[core/src/ai.rs](file:///home/bynshard/paperReader/core/src/ai.rs)、[app/src/Reader.tsx](file:///home/bynshard/paperReader/app/src/Reader.tsx#L948)。
   - 在 `papers` 表增加可空列 `digest_json TEXT`（或在既有 `notes` 外的独立缓存表/JSON 列 + `get_paper` / `save_digest` RPC）。
   - 当右侧栏对话为空（`messages.length === 0 && !live`）或在顶部快捷栏点击 `✨ 生成结构化导读` 时，基于论文前几页与各节首段生成结构化 5 段导读（JSON/约定 Markdown 区块：**① 研究痛点、② 核心方法思路、③ 关键设计细节、④ 主要实验对比与结论、⑤ 局限性与启发**），每条结论附带可点击的 `[p.X]` 页码来源跳转胶囊；生成后自动缓存，下次打开该论文秒开展示，无需重复花额度。

2. **场景化触控 Prompt 胶囊（Smart Contextual Chips）**：
   - **目标文件**：[app/src/Reader.tsx](file:///home/bynshard/paperReader/app/src/Reader.tsx#L851-L856) 及 `L919-L924`。
   - 当用户选中文本后，检测选区文本特征动态展示 1–2 个高概率动作胶囊：
     - 含较多数学/希腊符号或 `Eq.`/`=` 时 → `[∑ 逐项解释公式符号]`、`[推导前后逻辑]`
     - 含 `Table`/`%`/`ablation`/`baseline`/`outperform` 时 → `[📊 提炼实验对比结论]`
     - 默认英文长难句 → `[译]`、`[精简释义]`
   - 点击即发，平板端几乎无需弹出虚拟键盘输入常用指令。

3. **真·多模态框选看图识公式（Canvas Crop → Vision API）**：
   - **目标文件**：[app/src/PdfPane.tsx](file:///home/bynshard/paperReader/app/src/PdfPane.tsx#L900-L945)、[app/src/Reader.tsx](file:///home/bynshard/paperReader/app/src/Reader.tsx#L666-L669,L848-L851)、[core/src/ai.rs](file:///home/bynshard/paperReader/core/src/ai.rs)、[app/electron/ai-service.cjs](file:///home/bynshard/paperReader/app/electron/ai-service.cjs)。
   - **前端裁剪**：在 `PdfPane.tsx` 完成 `onAreaPointerUp` 框选时，直接从该 `.page-holder` 的渲染 `<canvas>` 上按归一化 `rect`（考虑 `dpr` 与 `autoCrop` 偏移）调用离屏 Canvas `drawImage` 裁剪出清晰 PNG DataURL（压缩上限建议 ≤ 1280px 宽以控制体积），随 `onAreaSelect` 一起返回 `imageDataUrl`。
   - **浮窗与动作**：选中图/公式/表格后，工具条显示缩略小图及三个一键按钮：
     - `[📊 AI 解读图表]`（带图发问：解释图意、横纵坐标及作者要论证的结论）
     - `[∑ 公式转 LaTeX]`（提示词要求输出纯 `$$...$$` LaTeX + 符号表，一键复制）
     - `[📋 表格抽为 Markdown]`（输出可粘贴进笔记的 Markdown 表格）
   - **后端支持**：`ai.rs` 与 `ai-service.cjs` 接收可选 `image_data_url` 参数，组装符合 OpenAI Vision `content: [{type:"text",...}, {type:"image_url", image_url:{url}}]` 格式发送请求（`chats` 表存文字问题与回答即可，避免 SQLite 膨胀）。

---

### 3.5 批注沉淀与精读笔记闭环体验（vs Zotero Better Notes / MarginNote 4）

**当前差距分析**：
- 批注 4 种颜色目前只有「黄/绿/蓝/红」的视觉颜色区分，无学术语义标签、无按颜色筛选；
- 在阅读器「笔记」Tab 里，用户不能直接修改某条高亮下方的评论，也不能在右侧一边读 PDF 一边撰写整理整篇 Markdown 笔记，更没有「论文 + 批注 + 问答总结一键导出为 Obsidian/Notion 兼容 `.md`」的出口；
- 选中文字若跨过页脚到达下一页首行，[app/src/PdfPane.tsx](file:///home/bynshard/paperReader/app/src/PdfPane.tsx#L1039) 会因为 `holder !== endHolder` 直接丢弃选区。

**具体升级规格**：

1. **阅读器内嵌实时 Markdown 笔记工作区 + 学术模板 + 批注深链**：
   - **目标文件**：[app/src/Reader.tsx](file:///home/bynshard/paperReader/app/src/Reader.tsx#L892-L915)。
   - 在 `tab === "notes"` 上半部分放置结构化的 **整篇精读笔记编辑器**（带预览/编辑切换、支持 600ms 防抖自动保存 `notes` 到 SQLite），工具栏提供两个高频快捷按钮：
     - `[+ 套用精读模板]`：当笔记为空（或追加）时插入标准结构：
       ```markdown
       ## 一句话总结 (TL;DR)
       ## 核心问题与动机
       ## 方法与关键技术
       ## 实验结果与复现要点
       ## 我的启发 / 存疑
       ```
     - `[+ 引用当前页 p.X]`：在光标处插入 `[p.${page}]`（预览模式下点击 `[p.X]` 可直接跳页）。

2. **学术语义化颜色标签 + 筛选 + 侧栏直接改评 + 一键导出 `.md`**：
   - **目标文件**：[app/src/Reader.tsx](file:///home/bynshard/paperReader/app/src/Reader.tsx#L28-L35,L896-L914)。
   - 为高亮颜色赋予清晰语义提示与筛选药丸：
     - 🟡 **核心结论** (`yellow`)
     - 🟢 **方法与公式** (`green`)
     - 🔵 **实验与数据** (`blue`)
     - 🔴 **存疑与局限** (`red`)
   - 笔记栏的批注列表上方增加 `全部 | 🟡 | 🟢 | 🔵 | 🔴` 过滤条；每条批注卡片支持点击评论区域直接就地编辑保存（无需先滚回 PDF 找高亮块）；右上角新增 **`[导出精读笔记 .md]`** 按钮，调用 `api.saveText` 导出包含「标题/作者/年份/会议/DOI → 整篇笔记 → 按页码顺序与语义颜色分组的高亮摘录与批注」的完整 Markdown 文件。

3. **支持跨页文本选区高亮**：
   - **目标文件**：[app/src/PdfPane.tsx](file:///home/bynshard/paperReader/app/src/PdfPane.tsx#L1033-L1057)、[app/src/Reader.tsx](file:///home/bynshard/paperReader/app/src/Reader.tsx#L586-L603)。
   - 放开 `PdfPane.tsx:1039` 对同页 `.page-holder` 的硬性限制：当 `startHolder !== endHolder` 时（限制相邻页或同 Pane 内），分别提取首尾 `.page-holder` 范围内的 `getClientRects()` 切片组，生成 `extraSlices?: { page: number; rects: Rect[] }[]`；点击高亮保存时前端顺序写入关联批注（可用统一 `comment` 与首尾页片段），避免长段落跨页直接划不出工具条。

---

### 3.6 设置清晰度与 vivo Pad 5 Pro 扫码即连体验

**当前差距分析**：
- 在 [app/src/AiSettings.tsx](file:///home/bynshard/paperReader/app/src/AiSettings.tsx#L9-L25) 中，不管用户在下拉框选的是 `现有 API 服务` 还是 `Codex 账号额度`，下方都在显眼位置写着 `AI 对话 · Codex` 和 `尚未登录 Codex / 通过浏览器登录 Codex`，极易让纯 API 用户误以为没配置好不能用问答；
- 如果用户在平移使用 vivo Pad 5 Pro 连同一局域网下的桌面库，目前只能在命令行或日志找 IP 与 Token，普通用户操作门槛过高。

**具体升级规格**：

1. **AI 设置面板按 Provider 条件精简与独立模型覆盖**：
   - **目标文件**：[app/src/AiSettings.tsx](file:///home/bynshard/paperReader/app/src/AiSettings.tsx#L9-L26)、[app/electron/ai-service.cjs](file:///home/bynshard/paperReader/app/electron/ai-service.cjs)。
   - 将面板主标题正名为 `AI 阅读助手`。
   - 当 `provider === "api"` 时：**完全隐藏 Codex 登录按钮、账号状态与额度窗口**，改为展示当前正在复用的 API Base URL（来源：翻译引擎设置）及默认模型，并提供一个清晰的可选输入框：`问答专用模型（留空则复用翻译模型）`（典型场景：翻译用便宜快的 `qwen-mt` / `deepseek-chat`，而读论文问答/读图用强推理/视觉模型）。
   - 只有当用户显式切换 `provider === "codex"` 时，再展开 Codex 账号登录、额度刷新与模型选择区域。

2. **设置弹窗「平板伴读 (vivo Pad 5 Pro)」扫码即连卡片**：
   - **目标文件**：[core/src/main.rs](file:///home/bynshard/paperReader/core/src/main.rs#L129-L135)、[app/electron/main.cjs](file:///home/bynshard/paperReader/app/electron/main.cjs)、[app/src/SettingsModal.tsx](file:///home/bynshard/paperReader/app/src/SettingsModal.tsx#L10-L66)。
   - 桌面端可选一键开关（或配置端口后）启动 `moonlight-core --serve 0.0.0.0:8765`，并通过 `os.networkInterfaces()` 获取本机所有可用局域网 IPv4 地址（排除 loopback 与虚拟网卡）。
   - 在 `SettingsModal` 的 `通用与论文库`（或新增第 6 个 Tab `平板伴读`）中展示：
     - 局域网访问开关与运行状态；
     - 完整配对地址：`http://<LAN-IP>:8765/?token=<TOKEN>`（附带 `[复制链接]` 按钮）；
     - 轻量纯前端 SVG 二维码（无需联网，零外部请求），vivo Pad 5 Pro 原生相机或浏览器扫码 3 秒直达全屏伴读工作台，并附简明「Chrome 添加到桌面 / PWA 全屏提示」。

---

## 4. DeepSeek 分批施工路线图与验收命令

为避免一次性改动过散导致冲突，建议按以下 **三个独立验收批次** 顺序交给 DeepSeek 推进（建议配合已规划的 Paper↔Code 功能穿插安排）：

| 批次 | 优先级 | 包含任务项 | 预计工时 | 核心用户收益 |
| --- | --- | --- | --- | --- |
| **Batch A：立即止血与通信闭环** | **P0** | §1 全部 4 个反直觉 Bug（`UX-BUG-01`~`04`）+ §2 遗留 Sprint 2 收尾 5 项接线 + §3.6 `AiSettings.tsx` 条件显示 | 1.5–2 天 | 平板首次真机可用、单页试译/框选/划词/写笔记再无卡点 |
| **Batch B：核心读写与整理工作流** | **P1** | §3.2 Multi-Tab 多标签阅读器 + §3.1 表格 Venue/CCF 徽章 + 拖拽归档/右键菜单 + 自动补全元数据 + 键盘流 + 搜索页码直达 + §3.5 模板/颜色筛选/侧栏改评/一键导出 `.md` | 3–4 天 | 达到 Zotero 7 / 小绿鲸级的日常整理与精读产出闭环 |
| **Batch C：旗舰阅读器差异化打磨** | **P2** | §3.2 Sioyek 智能引用/图表预览窗与 Pinned Portal + §3.3 真实翻译进度与双栏拖动分屏 + §3.4 一页纸结构化导读 + 触控胶囊 + Canvas 真多模态识图转 LaTeX/表格 + §3.5 跨页选区 + §3.6 平板扫码二维码 | 4–5 天 | 在 13 寸 vivo Pad 5 Pro 上建立超越现有商业 App 的“科研精读工作台”体验 |

### 每批完成后的强制回归验收命令

每次交付一个 Batch 后，在仓库根目录按顺序执行以下命令确认零回归（**禁止跳过或放宽断言**）：

```bash
# 1. Rust 后端测试（按环境需要设置 cargo PATH）
cd core && cargo test --locked

# 2. 前端类型检查、Vitest 单元测试、Node 集成测试与生产包构建
cd ../app && npx tsc --noEmit && npm test && npm run build
```
