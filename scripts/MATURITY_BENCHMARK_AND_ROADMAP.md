# Moonlight（paperReader）产品成熟度审查、行业对标与演进路线图

> **编写日期**：2026-11-15  
> **对标坐标系**：Zotero 7（及 Better Notes / Zotero PDF Translate 生态）、小绿鲸 / 小鲸鱼（Xiaolüjing）、ReadPaper、Sioyek、Corca Moonlight、SciSpace、Elicit、AlphaXiv、NotebookLM  
> **目标**：对照工业级“日常唯一主力”论文管理与 AI 双语精读桌面软件标准，系统梳理当前项目的**已知工程缺陷（操作体验与功能断层）**与**高价值功能缺口**，形成可执行的产品级演进蓝图。

---

## 一、 “成熟项目”的终极定义与行业对标矩阵

真正能成为科研人员唯一日常主力的“成熟论文阅读与管理软件”，应当同时融合以下四类标杆产品的核心能力：

1. **Zotero 7 生态（文献库管理与学术输出标杆）**：万篇库毫秒检索、多级文件夹与智能文件夹（保存的搜索）、鼠标拖拽归档与右键效率、DOI/BibTeX/RIS 导入导出与引文一键复制、重复条目一键合并、多标签页并发阅读。
2. **小绿鲸 / 小鲸鱼 & ReadPaper（国内硕博外文精读标杆）**：打开论文即生成结构化 AI 速读卡片（背景/痛点/方法/实验/结论/局限）、专业学科术语表（Glossary）约束翻译、期刊/会议等级与分区标签（CCF / JCR / 中科院分区 / IF 影响因子）、场景化科研笔记模板与大纲导图。
3. **Sioyek（硬核科研阅读效率标杆）**：全键盘高速阅读流、引用文献 `[12]` / 图表 `Fig. 3` / 公式 `Eq. (5)` **悬停预览（无需打断阅读翻页找图表）**、画中画对照小窗（Portal）。
4. **Corca Moonlight / SciSpace / Elicit / AlphaXiv / NotebookLM（新一代 AI 原生科研标杆）**：框选图表直接由多模态 AI 解读、公式一键识别转 LaTeX、表格一键提取 CSV/Markdown、**跨多篇论文生成文献综述对比矩阵（Method / Dataset / Metrics / Limitations）** 与文件夹级跨文献联合 RAG 问答。

### 1.1 横向能力对标矩阵

> 图例：`✅ 成熟可用` · `⚠️ 半成品 / 有明显缺陷` · `❌ 缺失`

| 能力维度 | 具体功能点 | Moonlight（当前） | Zotero 7 (+插件) | 小绿鲸（小鲸鱼） | Sioyek | 新锐 AI 阅读器<br>(Corca / SciSpace / Elicit) |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **文献入库** | 拖拽 PDF 导入 / DOI & arXiv 抓取 | ✅ 已实现 | ✅ | ✅ | ❌ | ✅ |
| | 监控文件夹自动导入（Watch Folder） | ❌ 缺失 | ⚠️ 插件实现 | ❌ | ❌ | ❌ |
| | BibTeX / RIS 文件批量导入 | ❌ 仅支持导出 | ✅ 原生支持 | ✅ | ❌ | ✅ |
| | Zotero 本地库无损单向迁移 | ✅ SQLite 快照迁移 | — | ⚠️ 需导出再导入 | ❌ | ⚠️ 需云授权 |
| | 期刊分区/会议等级（CCF/JCR/中科院/IF） | ❌ 缺失 | ⚠️ 依赖第三方插件 | ✅ 内置展示 | ❌ | ⚠️ 部分支持 |
| **组织与管理** | 多级文件夹分类与过滤 | ⚠️ 仅弹窗编辑，缺拖拽与右键 | ✅ | ✅ | ❌ | ⚠️ 较弱 |
| | 智能文件夹（保存高级检索条件） | ❌ 缺失 | ✅ | ❌ | ❌ | ❌ |
| | 标签着色与计数角标 | ⚠️ 列表无色点、无计数 | ✅ | ✅ | ❌ | ⚠️ |
| | 详情抽屉自动保存 & 键盘全流程操作 | ⚠️ 切走丢修改、缺方向键联动 | ✅ | ✅ | ✅ | ⚠️ |
| | 重复论文检测与合并 | ⚠️ 仅查看分组，不能合并 | ✅ 一键合并 | ⚠️ 基础去重 | ❌ | ❌ |
| | 回收站批量恢复 / 清空回收站 | ⚠️ 隐藏勾选框，只能逐条删 | ✅ | ✅ | ❌ | ✅ |
| **PDF 与双语翻译** | 原位版面翻译（BabelDOC） | ✅ 公式/图表/排版保留 | ⚠️ Zotero Translate 气泡为主 | ✅ 1:1 还原 | ❌ | ✅ Corca 侧栏对照 |
| | **无闪烁平滑缩放 / 光标中心缩放 / 自适应页宽 / 抓手拖拽** | ❌ 缩放白屏闪烁、丢位置、译文模式适应页宽失效 | ✅ | ✅ | ✅ | ✅ |
| | 术语表（Glossary）与学科翻译约束 | ❌ 缺失 | ⚠️ 基础术语替换 | ✅ 100+ 学科术语库 | ❌ | ⚠️ |
| | **双栏段落级对齐与点击/悬停双向高亮** | ⚠️ 仅粗暴页内百分比同步 | ❌ | ✅ 段落对应高亮 | ❌ | ⚠️ |
| | **译文全文检索 / 大纲 / 文本入库** | ❌ 译文块未入库，`Ctrl+F` 写死原文 | ✅ | ✅ | ❌ | ✅ |
| | 多标签页并发阅读（Multi-Tab） | ❌ 单窗口每次仅读一篇 | ✅ 原生多标签 | ✅ | ✅ | ⚠️ 多浏览器 Tab |
| | 图表/公式/参考文献悬停预览 & 画中画小窗 | ❌ 仅有内链跳转 | ⚠️ 仅引用悬停 | ✅ 提炼全部图表 | ✅ Smart Jump & Portal | ✅ 悬停引用总结 |
| **批注与笔记** | 跨页划线高亮 & 批注持久化迁移 | ⚠️ 跨页直接丢弃；重译隐藏旧批注 | ✅ 原生引擎最稳 | ✅ | ✅ | ⚠️ |
| | 区域框选截图 + AI 解读图表/公式/转 LaTeX | ⚠️ 只能画空心黄框 | ⚠️ 截图插入笔记 | ✅ AI 读图 | ❌ | ✅ Corca / SciSpace 核心卖点 |
| | Markdown 结构化笔记 & 一键导出读书笔记 | ⚠️ 右侧笔记只读且无导出 | ✅ Better Notes 标杆 | ✅ 大纲/导图 + Word | ❌ | ⚠️ |
| **AI 阅读与综述** | 单篇 AI 问答与原文页码溯源（`[p.X]`） | ✅ BM25 + CJK Bigram | ❌ 需装插件 | ✅ 边读边问 | ❌ | ✅ |
| | API 模式流式输出（SSE）、中断与多轮历史 | ❌ 阻塞同步、无取消、无多轮历史 | ❌ 需装插件 | ✅ | ❌ | ✅ |
| | 一键论文速读导读卡（6 大要素 + 自动重点高亮） | ❌ 需手动点“核心贡献” | ❌ | ✅ 30 秒速读卡 | ❌ | ✅ Corca 3行总结+自动高亮 |
| | 多文献对比矩阵 & 文件夹级跨论文 RAG 问答 | ❌ 缺失 | ⚠️ 插件实验性 | ✅ 综述辅助 | ❌ | ✅ Elicit / NotebookLM 核心 |
| **输出与底座** | BibTeX / RIS / GB/T 7714 一键复制引文 | ⚠️ 支持导出 BibTeX/RIS，无国标与快捷键复制 | ✅ 极强 | ✅ 上万引文格式 | ❌ | ⚠️ |
| | 本地优先 + 万篇级 SQLite WAL 性能 + 云同步 | ✅ Rust 核心 + rclone | ✅ 官方云同步 | ⚠️ 强绑定云端 | ✅ 纯本地 | ❌ 重云端绑定 |

---

## 二、 Moonlight 当前已具备的核心差异化优势（约 70% 基础水位）

在谈缺陷之前，必须肯定当前架构中已经达到高标准的工程底座（尤其是 2026-11-15 重构之后）：

1. **本地优先的 Rust 读写分离引擎**：`moonlight-core` 使用 SQLite WAL 模式（2 个读连接工作线程 + 1 个重写队列），万篇规模下排序、分页与统计在 SQLite 内部完成（[search.rs](file:///home/bynshard/paperReader/core/src/search.rs)），不会把全文与关联关系拉回前端阻塞 UI。
2. **高保真原位版面翻译管线**：本地 BabelDOC 引擎 + 局部 Loopback OpenAI 网关（[engine.rs](file:///home/bynshard/paperReader/core/src/engine.rs)），保留论文双栏结构、数学公式与图表排版。
3. **无损 Zotero 本地快照迁移**：通过 SQLite Backup API 迁移条目、层级分类、多 PDF、批注坐标（兼容旋转/裁剪页面 `Viewport`）与笔记，并隔离原库不被写坏（[ZOTERO.md](file:///home/bynshard/paperReader/docs/ZOTERO.md)）。
4. **隐私安全与多模型双栈支持**：原生离线 Tesseract.js WASM OCR，AI 阅读助手同时支持个人 Codex 账号与自定义 OpenAI 兼容 API，并支持 WebDAV / S3 同步（rclone）与库备份导出。

---

## 三、 现有工程缺陷详单（操作交互与功能断层）

以下问题直接影响日常使用体验，属于**现有代码中已经搭好架子但未能真正闭环**的“半成品断层”，应当列为最高优先级修复项：

### 3.1 阅读器（Reader）：双栏对照与译文侧功能断联

1. **双栏对照仅做粗糙的“页码 + 页内百分比”映射，缺乏段落级对齐与联动**
   * **代码位置**：[Reader.tsx](file:///home/bynshard/paperReader/app/src/Reader.tsx#L528-L539)
   * **现象与成因**：`onScrollFraction` 直接把一侧的 `(page, fraction)` 传给另一侧 `goTo(p, fraction)`。中英文段落折行高度差异极大，长文滚到页面中后段必然错位；同时，数据库 `blocks` 已经存储了文本块归一化 `bbox`，但阅读器既没有用视口中央文本块做跨栏对齐，也不支持“点击/悬停原文段落时，译文对应段落同步柔和亮起”。
2. **译文 PDF 的文本块从未写入 `blocks` 表，导致跨语言检索对译文完全失灵**
   * **代码位置**：[Reader.tsx](file:///home/bynshard/paperReader/app/src/Reader.tsx#L532-L541)、[library.rs](file:///home/bynshard/paperReader/core/src/library.rs#L857-L883)、[ai.rs](file:///home/bynshard/paperReader/core/src/ai.rs#L323-L336)
   * **现象与成因**：译文侧 `<PdfPane>` **没有传入 `onBlocks` 回调**，而后端 `attach_translation` 入库译文 PDF 时也没有提取任何文本块。因此 `ai.rs#L323` 专门编写的 `translation_hits`（用于在译文块中命中中文提问词并反推原文页码）在现实数据中查询到的译文 `blocks` 永远为空，中文检索只能勉强靠译文划线批注碰运气。
3. **文内查找（`Ctrl+F`）和大纲/缩略图导航（`ReaderNav`）硬编码绑定原文 `sourceApi`**
   * **代码位置**：[Reader.tsx](file:///home/bynshard/paperReader/app/src/Reader.tsx#L515-L518)、[FindBar.tsx](file:///home/bynshard/paperReader/app/src/FindBar.tsx#L26-L61)、[ReaderNav.tsx](file:///home/bynshard/paperReader/app/src/ReaderNav.tsx#L21-L33)
   * **现象与成因**：
     * 当用户切换到纯**“译文”**视图时，原文 `<PdfPane>` 被卸载（`sourceApi.current === null`），此时打开左栏“目录大纲 / 缩略图”会轮询等待后全部显示“不可用”或缩略图失败。
     * 在“译文”或“对照”视图按 `Ctrl+F` 搜索中文关键词，只查了原文 `sourceApi`，**完全搜不到译文内容**。
     * `FindBar.tsx` 必须按 `Enter` 才启动搜索（缺少输入防抖实时定位），且只画一个孤立的 `evidence-focus` 框，页面其余命中词没有常驻半透明底色高亮，也不支持区分大小写/全词匹配。
4. **补充材料（非主文档 PDF）仍被硬编码禁止翻译**
   * **代码位置**：[Reader.tsx](file:///home/bynshard/paperReader/app/src/Reader.tsx#L175,L481-L508)、[library.rs](file:///home/bynshard/paperReader/core/src/library.rs#L752-L764)
   * **现象与成因**：当一篇从 Zotero 迁移或合并的论文附带 Appendix / Supplementary PDF 时，切换查看补充 PDF 会因 `!isPrimary` 禁用翻译与对照切换，而后端 `source_version` 也死板取最早入库的 `source` 版本，没有支持按 `version_id` 启动翻译。

#### 3.1.A 专项深挖：PDF 渲染与缩放（Zoom & Viewport）体验缺陷与改造需求

当前阅读器的底层 PDF 视图由 [PdfPane.tsx](file:///home/bynshard/paperReader/app/src/PdfPane.tsx) 与 [Reader.tsx](file:///home/bynshard/paperReader/app/src/Reader.tsx) 共同驱动，但在缩放流畅度、视口定位和交互手感方面存在 **5 处根本性缺陷**，导致日常精读体验明显落后于 Zotero 7 / Sioyek / 浏览器原生 PDF 阅读器：

1. **缺陷 1：缩放时页面剧烈白屏闪烁（White-Flash Flicker on Zoom）**
   * **代码位置**：[PdfPane.tsx](file:///home/bynshard/paperReader/app/src/PdfPane.tsx#L92-L174)（`PageView` 组件）
   * **根因剖析**：`useEffect` 直接依赖 `scale`。每次 `scale` 发生变化（尤其是按住 `Ctrl + 滚轮` 或触控板捏合连续触发时），cleanup 函数会立刻同步执行 `canvas.remove(); text.remove();` 清空当前 DOM 画布；而随后新缩放倍率的 `doc.getPage()` 与 `page.render()` 是异步执行的，且连续滚动期间上一帧渲染会不断被 `task.cancel()` 中止。这导致用户在连续缩放过程中**整个 PDF 页面直接变成白屏空白**，直到停手等待数十毫秒重新绘制完成才突然闪现。
   * **成熟化需求**：实施**双缓冲无闪烁渲染（Double-Buffered Canvas Swap）**——当 `scale` 改变时，保留已渲染的旧 `<canvas>` 并在原地立即通过 CSS `style.width` / `style.height` 按新倍率弹性拉伸占位（0ms 视觉响应，彻底消除白屏）；新倍率 `<canvas>` 与 `textLayer` 在离屏构建并 `await Promise.all([task.promise, textTask?.render()])` 完成后，再原子替换（`replaceChildren`）并立即将旧画布宽高置零释放显存。

2. **缺陷 2：每次缩放微调都在重复解析 PDF 文本流与跨进程查询 OCR 数据库（Redundant I/O on Every Zoom Tick）**
   * **代码位置**：[PdfPane.tsx](file:///home/bynshard/paperReader/app/src/PdfPane.tsx#L111-L155)
   * **根因剖析**：`page.getAnnotations()`（提取链接批注）、`page.getTextContent()`、`groupBlocks()` 以及 `await loadOcr(index)`（通过 Electron IPC 异步查询 SQLite `blocks` 表）全部耦合写在依赖 `scale` 的 `useEffect` 内部。用户滚轮缩放 1 秒触发一二十次，每次都要重跑文本解析与跨进程查库，造成明显的渲染卡顿和无谓 CPU 消耗。
   * **成熟化需求**：在 `PageView` 内按 `(doc, index, textRevision)` 缓存 `PDFPageProxy`、自然页尺寸 `natural`、`rawLinks`、文本内容 `content`、`native` 块及 `saved` OCR 块；缩放变化仅重算 `viewport`、重绘位图与更新高亮/链接层位置，彻底杜绝缩放期间的文本重解析与 IPC 查库。

3. **缺陷 3：缩放后阅读位置跳页，且不支持“以鼠标光标为中心”缩放（Scroll Position Jump & No Focal-Point Zoom）**
   * **代码位置**：[PdfPane.tsx](file:///home/bynshard/paperReader/app/src/PdfPane.tsx#L203-L251,L437-L442)、[Reader.tsx](file:///home/bynshard/paperReader/app/src/Reader.tsx#L125-L126,L272-L276)
   * **根因剖析**：
     * `scale` 变化后，`virtual.measure()` 重算了所有虚拟页面的累计高度，但**没有同步按缩放比例重算 `scrollTop` 与 `scrollLeft`**。用户原本阅读第 10 页，从 100% 放大到 180% 后页面高度猛增而 `scrollTop` 不变，视口瞬间“倒退”回第 5~6 页。
     * `PdfPane.tsx#L437-L442` 将 `scale` 加入了 `registerApi` 的 `useEffect` 依赖数组，导致每次缩放都先执行 `registerApi(null)` 再重新注册，进而触发 `Reader.tsx#L125-L126` 里的 `pane?.goTo(positionRef.current.page, positionRef.current.fraction)`。这不仅在主线程重绘后产生二次视觉跳动，还会强制忽略水平偏移（`scrollLeft`），使得放大查看双栏论文右半栏时右栏直接飞出屏幕之外。
     * `Reader.tsx#L272-L276` 的滚轮监听完全未获取鼠标指针坐标 `(clientX, clientY)`，无法像 Chrome PDF / Zotero 7 / Sioyek 那样“鼠标悬停在哪个公式或图表上，就以该点为锚点原地放大”。
   * **成熟化需求**：
     * 将 `registerApi` 生命周期与 `scale` 彻底解耦，避免缩放引发误触发 `goTo`；
     * 在 `useLayoutEffect` 与渲染提交同步阶段实现**精确锚点缩放**：滚轮/捏合缩放时精确锁定鼠标指针所在页面位置 `(pageIdx, offsetWithinPage, dxFromCenter)` 不动；点击工具栏按钮或快捷键缩放时锁定视口中心内容（处于首页顶部时保持顶对齐），同步修正 `scrollTop` 与 `scrollLeft`，且保持 `programmatic.current = true` 防止双栏互锁死循环。

4. **缺陷 4：“适应页宽（Fit Width）”与“适应整页（Fit Page）”在译文模式下失效，且不具备响应式自适应能力**
   * **代码位置**：[Reader.tsx](file:///home/bynshard/paperReader/app/src/Reader.tsx#L50,L492-L501)、[PdfPane.tsx](file:///home/bynshard/paperReader/app/src/PdfPane.tsx#L336-L344)
   * **根因剖析**：
     * **译文视图完全失效**：`Reader.tsx#L494` 硬编码调用 `sourceApi.current?.fit(...)`。当切换到纯**“译文”**视图（`mode === "translated"`）时，`sourceApi.current` 为 `null`，点击“适应页宽”或“适应整页”没有任何反应。
     * **非响应式一次性计算**：选择“适应页宽”后仅计算一次数值赋给 `scale`，下拉菜单立即回落显示“当前百分比”（如 `127%`）；一旦用户切入双栏对照（每栏宽度减半）、展开/收起右侧栏或左侧大纲栏、拖动分隔条或缩放窗口，页面不会自动重新适配宽度；且初始写死 `scale = 1.15`，导致笔记本屏幕一进入双栏对照就必然水平溢出出现横向滚动条。
     * `PdfPane.tsx#L339-L341` 的 `fit()` 永远固定按第 1 页 `natural` 计算、且 `width` 下限硬写了 `240px`，遇到横版附录插页或较窄双栏时算不准。
   * **成熟化需求**：
     * 引入持久化的 `zoomMode: "custom" | "fit-width" | "fit-page"` 模式状态，在缩放工具区增加一键“适应页宽”快捷按钮并在下拉菜单准确标示当前适应状态（如 `适应页宽（127%）`）；
     * 根据当前可见栏（`sourceApi` 或 `transApi`）与当前页实际自然宽高计算适配比例，并通过 `ResizeObserver` 监听阅读容器尺寸变化与单/双栏/侧栏显隐切换，自动动态保持页宽/整页适配。

5. **缺陷 5：滚轮缩放手感失衡、倍率范围受限、缺少标准快捷键与抓手拖拽（Grab-to-Pan）**
   * **代码位置**：[Reader.tsx](file:///home/bynshard/paperReader/app/src/Reader.tsx#L272-L276,L282-L300,L491-L503)
   * **根因剖析**：
     * 滚轮缩放采用线性加减 `current - event.deltaY * 0.0015`，导致 50% 低倍率下步幅过猛、250% 高倍率下缓慢迟钝，且不同精度触控板与机械滚轮的手感不一致；
     * 缩放上限止步于 `3.0`、下限为 `0.5`（与 `fit()` 的 `0.4` 下限不一致），查看高密度矢量框图/超小字角标时放大余量不够；
     * 未拦截处理 `Ctrl/Cmd + =`（放大）、`Ctrl/Cmd + -`（缩小）与 `Ctrl/Cmd + 0`（恢复适应页宽），在 Electron 窗口内按键容易误触发整个应用 UI 的浏览器级缩放；
     * 当论文放大至超过视口宽度阅读时，缺乏**按住 `空格键 + 鼠标左键拖拽` 或 `鼠标中键拖拽` 进行二维平滑平移（Hand Tool / Grab-to-Pan）**的操作方式，只能笨拙地去拉底部细窄滚动条。
   * **成熟化需求**：
     * 滚轮缩放升级为指数比例步进 `scale * Math.exp(-deltaY * 0.002)`，缩放范围统一扩展为 `40%–400%`（`[0.4, 4.0]`）；
     * 完整拦截并响应 `Ctrl/Cmd + +/=`、`Ctrl/Cmd + -`、`Ctrl/Cmd + 0`，避免误触 Electron UI 缩放；
     * 阅读面板支持按住 `Space + 拖拽` 与 `中键拖拽` 进行二维抓手平移（切换 `grab`/`grabbing` 指针并在拖拽期间抑制文本误选）。

### 3.2 批注、高亮与笔记系统：半成品交互

1. **跨页划线选词被静默丢弃**
   * **代码位置**：[PdfPane.tsx](file:///home/bynshard/paperReader/app/src/PdfPane.tsx#L454)
   * **现象与成因**：`holder !== element(range.endContainer)?.closest(".page-holder")` 直接 `return`。科研论文大量重要推导和长难句跨栏/跨页断开，用户拖选跨页后工具栏毫无反应。
2. **区域框选（`Alt+拖拽`）极难发现，且框选后无 AI 能力**
   * **代码位置**：[Reader.tsx](file:///home/bynshard/paperReader/app/src/Reader.tsx#L525,L536,L550)、[PdfPane.tsx](file:///home/bynshard/paperReader/app/src/PdfPane.tsx#L430-L435)
   * **现象与成因**：顶部工具栏没有任何“框选批注/截图”开关按钮提示用户；且 `selection.area` 为真时，浮动工具栏**隐藏了翻译、AI 解释与引用提问按钮**，只允许画一个文本固定为 `"（框选区域）"` 的黄色矩形。用户无法把论文里看不懂的复杂公式图或实验架构图框出来让 AI 解释。
3. **写批注时颜色硬编码丢失用户选择**
   * **代码位置**：[Reader.tsx](file:///home/bynshard/paperReader/app/src/Reader.tsx#L560)
   * **现象与成因**：浮动工具栏点击“写批注 → 保存批注”固定传入 `"yellow"`，无法在新建批注时指定绿/蓝/红等颜色分类。
4. **重新翻译后旧译文批注消失且无迁移提示**
   * **代码位置**：[Reader.tsx](file:///home/bynshard/paperReader/app/src/Reader.tsx#L178)
   * **现象与成因**：`translatedAnnotations` 按当前最新的 `translated?.versionId` 严格过滤，切换模型重译一篇论文后，旧译文版本上的所有批注不会迁移也不显示入口。
5. **右侧“笔记”面板功能单薄**
   * **代码位置**：[Reader.tsx](file:///home/bynshard/paperReader/app/src/Reader.tsx#L588-L611)
   * **现象与成因**：阅读器右栏“笔记”Tab 只能只读展示 `paper.notes` 和批注流，**不能就地编辑论文笔记**（必须回列表或弹窗改），不支持按高亮颜色/页码筛选，也不支持一键导出当前论文的 Markdown 读书笔记与所有批注汇总。

### 3.3 论文库（Library）：桌面高频效率与直觉交互缺口

1. **左侧目录树与标签列表缺乏直觉交互（无拖拽、无右键、无颜色圆点、无计数）**
   * **代码位置**：[FolderTree.tsx](file:///home/bynshard/paperReader/app/src/FolderTree.tsx#L10-L12)、[TaxonomyList.tsx](file:///home/bynshard/paperReader/app/src/TaxonomyList.tsx#L10-L14)
   * **现象与成因**：
     * 不支持将论文从表格/卡片拖拽投放到左侧目录树或标签完成归类。
     * `FolderTree` 和 `TaxonomyList` 均未绑定 `onContextMenu`（右键菜单），想新建子目录、重命名、改标签颜色或删除标签必须去顶部点“新建/管理”弹窗并在下拉列表里重新定位。
     * `TaxonomyList.tsx` 没有渲染标签自带的 `color` 圆点，且目录与标签均不显示包含论文数量角标。
2. **列表/表格缺乏键盘流与连续多选体验**
   * **代码位置**：[PaperTable.tsx](file:///home/bynshard/paperReader/app/src/PaperTable.tsx#L82-L106)、[Library.tsx](file:///home/bynshard/paperReader/app/src/Library.tsx#L94,L117,L119-L128)
   * **现象与成因**：仅支持 `/`、`Ctrl+K` 聚焦搜索框；缺少 `↑/↓` 移动聚焦行并自动联动右侧 `Inspector` 预览、`Enter` 打开阅读、`Delete` 移入回收站、`Shift+点击` 连续区间选中、`Ctrl/Cmd+A` 全选当前页；翻页时 `selected` 集合被清空（无法跨页批量选择导出）。
3. **回收站缺少批量恢复与“清空回收站”**
   * **代码位置**：[PaperTable.tsx](file:///home/bynshard/paperReader/app/src/PaperTable.tsx#L82)、[Library.tsx](file:///home/bynshard/paperReader/app/src/Library.tsx#L226,L238)
   * **现象与成因**：因为多处判断 `!paper.deleted` 后隐藏复选框，用户在回收站视图无法勾选多篇论文做“批量恢复”或“批量彻底删除”，也没有“一键清空回收站”按钮，清理废纸篓只能一篇篇点菜单。
4. **右侧详情抽屉（`Inspector`）丢失未保存修改且无法编辑目录**
   * **代码位置**：[Inspector.tsx](file:///home/bynshard/paperReader/app/src/Inspector.tsx#L32-L38,L128-L130)
   * **现象与成因**：
     * 在 `Inspector` 修改速记或笔记后若未点击“保存修改”，单击表格另一篇论文时 `useEffect` 直接重置字段覆盖本地输入（无失焦自动保存或未保存提醒）。
     * 目录区域（`L129`）仅渲染只读 `<span className="chip">`，只能改标签不能在抽屉内改所属目录。
5. **重复论文检查（`DuplicateFinder`）有头无尾 & 批量操作前端串行风暴**
   * **代码位置**：[DuplicateFinder.tsx](file:///home/bynshard/paperReader/app/src/DuplicateFinder.tsx#L38-L50)、[App.tsx](file:///home/bynshard/paperReader/app/src/App.tsx#L170-L185)、[Library.tsx](file:///home/bynshard/paperReader/app/src/Library.tsx#L290)
   * **现象与成因**：
     * `DuplicateFinder` 明确写了“当前只做检测，不改动任何论文”，每组条目只有“打开”按钮，没有“选择主条目并一键合并其余重复项”的功能。
     * `markMany`、`translateMany` 和批量移入回收站均在前端用 `for (const id of ...)` **串行循环调用单篇 RPC**，其中批量删除每删 1 篇就执行一次 `await reload()`，选中 50 篇删除会触发 50 次串行 IPC 和上百次 query invalidate。
6. **全文检索结果缺少命中上下文片段（Snippet）与页码直达**
   * **代码位置**：[Library.tsx](file:///home/bynshard/paperReader/app/src/Library.tsx#L240-L250)
   * **现象与成因**：搜索关键词命中某篇论文的正文（`blocks`）或速记而非标题时，列表只显示标题与作者，用户无法判断为什么命中以及命中在哪一页哪一句。

### 3.4 AI 伴读、任务中心与底层稳健性

1. **自定义 OpenAI API 问答模式无流式 SSE、无中止按钮、无多轮对话历史**
   * **代码位置**：[engine.rs](file:///home/bynshard/paperReader/core/src/engine.rs#L176-L198)、[ai.rs](file:///home/bynshard/paperReader/core/src/ai.rs#L712-L731)、[Reader.tsx](file:///home/bynshard/paperReader/app/src/Reader.tsx#L628,L652-L656)
   * **现象与成因**：
     * `engine.rs` 的 `chat()` 使用同步阻塞 HTTP 等待完整回复，导致前端在非 Codex 模式下只显示静态文字“模型处理中…”、**无法中途停止请求**、长回答时干等十余秒没有打字机流式反馈。
     * `ai.rs` 的 `explain()` 只组装单轮 `system + user`，完全没有读取 `chats` 历史记录（`Reader.tsx` 复选框也写明仅限 Codex），使用自定义 API 的用户无法多轮上下文追问。
     * 对话区缺少“清空本篇对话”、“删除单条问答”、“重新生成（Regenerate）”操作。
2. **任务中心（`TaskCenter`）信息极度匮乏，解析/OCR 未脱离阅读器后台化**
   * **代码位置**：[TaskCenter.tsx](file:///home/bynshard/paperReader/app/src/TaskCenter.tsx#L5-L15)、[DocumentParsing.tsx](file:///home/bynshard/paperReader/app/src/DocumentParsing.tsx#L60-L95)
   * **现象与成因**：
     * `TaskCenter.tsx` 仅 15 行代码：任务行连**论文标题**都不显示（只有时间、状态和 `paper_id` 跳转），缺少翻译进度百分比（已译 `x/y` 页或阶段进度）、耗时、Token 用量与可点击复制的完整错误日志，也不支持按 `Escape` 或点击遮罩关闭弹窗。
     * 全文文本提取与离线 OCR 运行在 `Reader` 渲染进程组件内的 `AbortController` 生命周期中，用户切回论文库列表或打开另一篇论文时，未跑完的索引/OCR 立即中止。
3. **网关热更新线程未释放 & 缺少 Schema 迁移台账与自动备份**
   * **代码位置**：[engine.rs](file:///home/bynshard/paperReader/core/src/engine.rs#L30-L67)、[library.rs](file:///home/bynshard/paperReader/core/src/library.rs#L145-L158)、[search.rs](file:///home/bynshard/paperReader/core/src/search.rs#L81-L100)
   * **现象与成因**：
     * 每次热更新设置调用 `start_gateway` 都会 `thread::spawn` 一个永久阻塞在 `server.incoming_requests()` 的监听线程，旧端口与线程不会被优雅关闭。
     * 数据库结构升级仅靠启动时的零散 `CREATE TABLE IF NOT EXISTS` 与单字段探测 `PRAGMA table_info`，缺少 `schema_version` 版本迁移表、失败回滚及升级前/定时自动备份（见 [PRODUCT_READINESS.md](file:///home/bynshard/paperReader/docs/PRODUCT_READINESS.md) R03）。
     * `main.cjs#L254-L258` 加载 PDF 使用 `fs.promises.readFile` 把完整 PDF 经 IPC 一次性拷贝进渲染进程，大体积 PDF（50MB+）在双栏对照模式下内存占用偏高。

---

## 四、 对标竞品的核心功能缺口（从“可用”迈向“惊艳”）

修补上述内部断层只是达到及格线；对照 **Zotero 7 + 小绿鲸 + Sioyek + 新一代 AI 阅读器（Corca / SciSpace / Elicit / AlphaXiv / NotebookLM）**，以下 **6 大类功能缺口**决定了产品是否真正具备竞品级吸引力与长期留存能力：

### 缺口 1：【对标小绿鲸 & Corca Moonlight】AI 论文速读导读卡与语义自动高亮
* **竞品做法**：
  * **小绿鲸**打开任意英文文献即自动提炼“研究背景 / 核心问题 / 关键方法 / 实验设计 / 主要结论 / 研究局限”6 维结构化速读框架，并支持一键盘点所有图表和核心结论。
  * **Corca Moonlight** 在论文加载瞬间提供“3 句话顶层摘要 + 半页方法导读”，并按 **Innovation（创新点）/ Method（方法）/ Result（结果）** 在原文自动标出多色重点高亮。
* **Moonlight 现状**：仅在聊天栏放了“总结本页”和“提炼核心贡献”两个快捷提问按钮，回答散落在聊天流里，每次重开还要翻找聊天记录，也不具备“全篇重点段落自动高亮导航”功能。
* **建议产品形态**：
  * 新增常驻结构化 Tab **“论文导读（Digest）”**（一键生成后持久化到数据库 `papers.digest_json`，二次秒开）。
  * 支持一键点击“**AI 自动标注本文核心重点**”：生成带语义标签（创新点 / 方法 / 结论 / 局限）的只读可开关高亮层，点击导读条目直接跳转并高亮对应正文页码。

### 缺口 2：【对标 Corca Moonlight & SciSpace】多模态框选交互：读图、识公式、抽表格
* **竞品做法**：
  * 在密度极高的科研 PDF 中，最耗时的不是读纯文本，而是看懂架构图、理解复杂推导公式和把实验大表数据抄出来对比。
  * Corca Moonlight 与 SciSpace 均支持**框选论文中的任意区域，识别出它是图、公式还是表格**：框选公式一键生成规范 LaTeX（可复制进论文），框选图片/图表直接传给 Vision 模型解读坐标轴与消融实验结论，框选表格一键抽取为干净的 Markdown/CSV。
* **Moonlight 现状**：`Alt+拖拽` 框选后只会保存无文本的矩形框（[Reader.tsx](file:///home/bynshard/paperReader/app/src/Reader.tsx#L550)），完全不捕获渲染层 Canvas 图像，无法做任何视觉识别或 AI 问答。
* **建议产品形态**：
  * 在阅读器顶栏显式增加**“框选 / 截图工具”按钮**（兼容 `Alt+拖拽` 快捷键）。
  * 框选后直接从 `PdfPane` Canvas 裁剪高分辨率 PNG/WebP，弹出 4 个精准动作：**① AI 解读图表/公式（多模态直发） ② 识别公式为 LaTeX ③ 提取表格为 Markdown/CSV ④ 保存为图文批注**（图文批注缩略图可直接嵌入右侧读书笔记并导出）。

### 缺口 3：【对标 Sioyek & Zotero 7 & AlphaXiv】悬停预览、画中画对照小窗与多标签阅读
* **竞品做法**：
  * **Sioyek 的 Smart Jump & Portal**：读到正文第 7 页提及 `as shown in Fig. 2` 或 `refer to [14]` 时，传统 PDF 阅读器必须滚动到第 3 页或第 12 页参考文献表，再滚回第 7 页，思路极易被打断。Sioyek 允许悬停直接预览目标位置，或开一个固定小窗（Portal）长期钉住第 3 页的系统架构图或符号定义表，主栏继续往下翻页读实验分析。
  * **Zotero 7**：顶部原生多标签页（Multi-Tab），允许同时挂着 3~5 篇相关工作与主库列表随时切回。
* **Moonlight 现状**：有 `Alt+←/→` 跳转历史栈和 PDF 内链点击跳转，但缺乏悬停预览与画中画钉选；一次只能打开 1 篇论文阅读（`App.tsx` 单 `openPaper` 状态），对比阅读两篇同领域论文极不方便。
* **建议产品形态**：
  * **阅读器多标签栏（Multi-Tab）**：支持同时打开“论文库 + 最多 N 篇论文 Tab”，切换时无缝保留各自页码、缩放与选区状态。
  * **智能悬停预览卡片（Smart Hover Card）**：鼠标悬停文末引用编号 `[12]` 或文内图表引用 `Fig. X` / `Table Y`（有内部链接或正则匹配目标区块）时，自动弹出半透明悬浮预览小窗展示完整文献条目或对应图表缩略图。
  * **图/表/公式钉选小窗（Pinned Portal）**：允许把框选的区域或整页图钉在阅读器角落悬浮窗中，翻页读实验细节时不丢失对照视野。

### 缺口 4：【对标 Elicit & SciSpace & NotebookLM】跨论文对比矩阵与文件夹级联合 RAG 问答
* **竞品做法**：
  * 写 Related Work（相关工作）或开组会汇报时，研究人员真正要回答的问题往往跨越 **5~20 篇论文**（例如：“对比这 8 篇 RLHF/DPO 论文所用的 Reward 形式、基线数据集、显存开销和核心缺陷，列成对照表”）。
  * **Elicit / SciSpace Literature Matrix / NotebookLM** 能够把选中的一组论文自动提炼为结构化对比表格，或者围绕一个目录发起**多篇论文联合对话（Multi-Document RAG）**，每条结论附带跨论文页码引用（如 `[DeepSeek-R1, p.4]`、`[HybridFlow, p.7]`）。
* **Moonlight 现状**：AI 问答完全限定在单篇 `Reader` 内部；论文库虽然有多选操作条，但仅能做标记已读、改分类、导 BibTeX、批量翻译。
* **建议产品形态**：
  * 在论文库顶部批量操作栏新增**“AI 综述 / 对比矩阵”**与**“联合提问”**入口（支持对左侧选中分类目录或勾选的多篇论文发起工作流）。
  * 利用后端已有的 `blocks` 与 `fts5` 索引，实现轻量快速的**跨论文检索（Cross-Paper BM25 + 摘要汇总）**，生成可导出的 Markdown/CSV 实验参数对比矩阵，矩阵中的每条数据可点击直达对应论文的目标页码。

### 缺口 5：【对标小绿鲸 & Zotero 科研生态】专业术语库（Glossary）、期刊等级识别与学术元数据增强
* **竞品做法**：
  * **小绿鲸**：提供“学科专业术语库”和用户自定义术语表，防止 `Attention` 被直译成“注意力”而丢失上下文指代、`Agent` / `Token` / `Rollout` / `Alignment` 在特定领域错译；同时在列表与详情区醒目标注 **CCF-A / SCI Q1 / IF 14.3** 等含金量标识，帮科研新手 1 秒识别必读顶会顶刊。
  * **Zotero 7**：内置 Better BibTeX 风格自动 Citekey 生成（如 `sheng2024hybridflow`）、一键复制 GB/T 7714 / APA / IEEE 引文格式、监控下载文件夹自动入库、从 Semantic Scholar / OpenAlex 拉取引用数与相关参考文献网络。
* **Moonlight 现状**：
  * 翻译参数写死（无用户自定义术语表与翻译风格 Prompt 设置），且页面因含公式/伪代码块（如算法框）被 BabelDOC 保留原文时，UI 无温和原因提示。
  * `TranslationSettings`（[TranslationSettings.tsx](file:///home/bynshard/paperReader/app/src/TranslationSettings.tsx)）仅支持填写一个模型，无法分别指定“高性价比批量翻译模型”和“强推理 AI 伴读模型”。
  * 引文导出支持批导出 `.bib` 和 `.ris`，但缺乏常见中文期刊必用的 **GB/T 7714-2015** 与一键复制快捷键，也缺乏导入 `.bib/.ris` 及期刊等级（CCF/JCR 分区）映射展示。
* **建议产品形态**：
  * **自定义术语表（Glossary Manager）**：支持按全局或学科/目录配置 `原文术语 -> 译文保留/指定译法`（透传给 BabelDOC `--glossary` 及选段/AI 伴读 Prompt）。
  * **本地内置 CCF / 顶会 / JCR 简称映射词典**：在列表标题下方或标签栏自动渲染轻量学术等级徽章（如 `NeurIPS · CCF-A`），无需联网即可识别绝大多数顶会顶刊并支持筛选。
  * **引用格式增强 & 一键复制**：增加 `BibTeX / RIS` **导入**、**监控本地下载文件夹（Watch Folder）**自动导入，并在右键菜单和快捷键（`Ctrl+Shift+C`）提供 `BibTeX / GB/T 7714 / APA / Markdown 链接` 一键复制。

### 缺口 6：【对标 Better Notes & MarginNote】结构化知识管理与科研笔记工作流
* **竞品做法**：
  * **Better Notes（Zotero 第一热门插件）** 与 **小绿鲸大纲笔记** 成功的核心在于：**把“零散 PDF 划线”自动聚合为“可复用的结构化读书笔记”**，支持双向链接（点击笔记里的引用标签瞬间跳回 PDF 高亮页）和场景模板（精读模板 / 实验复现清单 / 论文评审 Review 模板）。
* **Moonlight 现状**：笔记与批注相互割裂——批注是一条条按时间排列的碎片卡片，笔记只是 `Inspector` 里一个纯文本 `<textarea>`（在阅读器侧栏甚至只读不可编辑）。
* **建议产品形态**：
  * 升级阅读器右栏“笔记”Tab 为**内置分屏 Markdown 笔记编辑器**，提供一键模板（精读总结 / 实验复现 / 审稿意见）。
  * 支持一键**“将批注汇总插入笔记”**，生成的引用带深度链接语法（如 `[高亮文本](moonlight://paper/<id>?page=4&ann=<annId>)`），点击笔记内容双向跳回 PDF 精确位置并闪动聚焦。
  * 支持**一键导出精美 Markdown 笔记包**（含 YAML frontmatter 元数据 + 摘要/导读 + 分色批注 + 截取的图表 PNG），无缝接入 Obsidian / Notion / Logseq。
  * 新增**智能文件夹（Smart Collections）**：把常用检索条件保存为左侧动态目录（如“2024 年后 · CCF-A · 未读 · 含译文”）。

---

## 五、 分阶段成熟化演进路线图（P0 → P3 建议排期）

为了用最稳妥的工程节奏把 Moonlight 推进到真正的成熟主力产品，建议按以下四个里程碑逐层推进：

### Phase 1（P0）：双栏核心闭环、PDF 流畅缩放与高频桌面操作修复（解决“卡手与断层”）

> **阶段目标**：消除现有半成品断层，让 PDF 缩放浏览、双栏翻译阅读、AI 对话与文献日常管理完全顺手、零功能失灵。

0. **PDF 渲染与缩放引擎丝滑化改造（彻底解决缩放闪烁与定位丢失）**
   * [PdfPane.tsx](file:///home/bynshard/paperReader/app/src/PdfPane.tsx) 改为**双缓冲画布切换**（缩放期间旧画布按新宽高 CSS 弹性占位，新图就绪再原子替换）并按 `(doc, index, textRevision)` 缓存页内文本、链接与 OCR 结果，消除连续缩放白屏卡顿。
   * 将 `registerApi` 与 `scale` 解耦，在 `useLayoutEffect` 中落地**鼠标光标中心锚点缩放**（滚轮/捏合锁定指针所在公式/文字，工具栏/快捷键缩放锁定视口中心并同步校正水平滚动，不跳页、不丢双栏视野）。
   * 引入响应式的 `zoomMode`（`custom | fit-width | fit-page`），支持译文视图适应页宽，利用 `ResizeObserver` 在单/双栏切换、侧栏收放与窗口缩放时自动保持页宽适配；增加工具栏一键“适应页宽”按钮。
   * 滚轮缩放改为指数比例步进（`40%–400%`），拦截处理 `Ctrl/Cmd + +/=`、`Ctrl/Cmd + -`、`Ctrl/Cmd + 0` 快捷键，并增加 `Space + 拖拽` 与鼠标中键拖拽**抓手平移（Grab-to-Pan）**。
1. **双栏阅读器与译文全面打通**
   * 译文 `<PdfPane>` 接入 `onBlocks`，后端 `attach_translation`（或渲染首次加载后增量）落盘译文文本块到 `blocks` 与 FTS 索引，彻底激活 [ai.rs](file:///home/bynshard/paperReader/core/src/ai.rs#L323) 的跨语言译文检索能力。
   * [FindBar.tsx](file:///home/bynshard/paperReader/app/src/FindBar.tsx) 与 [ReaderNav.tsx](file:///home/bynshard/paperReader/app/src/ReaderNav.tsx) 改为**感知当前激活栏（`activePane`：原文 / 译文）**，支持在译文模式搜索中文关键词并正确读取译文大纲/缩略图；`FindBar` 增加 200ms 输入防抖、页内所有命中词常驻高亮底色与区分大小写选项。
   * **双栏段落级同步对齐**：利用左右两侧同页 `blocks` 的归一化坐标与相对顺序，在滚动和点击段落时实现段落级滚动锚点纠偏与双向 Hover/Click 高亮联动。
   * 解锁补充材料 PDF（非主文档）按 `version_id` 发起独立翻译。
2. **自定义 AI API 体验拉齐 Codex 模式**
   * [engine.rs](file:///home/bynshard/paperReader/core/src/engine.rs) 的网关 `chat()` 升级为支持流式 SSE 转发（`text/event-stream` 事件推送至前端）与 `Abort` 请求取消；[ai.rs](file:///home/bynshard/paperReader/core/src/ai.rs#L712) 接入最近 6 轮 `chats` 上下文历史。
   * 前端问答面板增加取消生成、清空本篇对话、删除单条问答与“重新生成”按钮。
3. **论文库直觉化操作补齐**
   * [FolderTree.tsx](file:///home/bynshard/paperReader/app/src/FolderTree.tsx) 与 [TaxonomyList.tsx](file:///home/bynshard/paperReader/app/src/TaxonomyList.tsx) 支持**拖拽论文直接归档到目录/标签**、左键点按之外增加**右键上下文菜单**（新建子目录/重命名/改色/合并/删除）、渲染标签颜色圆点及所属论文数量角标。
   * [Inspector.tsx](file:///home/bynshard/paperReader/app/src/Inspector.tsx) 支持失焦/防抖**自动保存**（切走不丢修改），并补全所属目录（`categories`）的就地增删选择。
   * [PaperTable.tsx](file:///home/bynshard/paperReader/app/src/PaperTable.tsx) 支持 `↑/↓` 键切换并联动 `Inspector`、`Enter` 阅读、`Delete` 进回收站、`Shift+点击` 连续范围多选、`Ctrl+A` 全选；回收站模式开放多选框支持**批量恢复**与**一键清空回收站**。
   * 批量状态修改与批量删除收敛为后端单次事务 RPC（消除前端 `for...of` 循环串行风暴）。

### Phase 2（P1）：深度阅读体验与笔记系统成型（对标 Zotero 7 + 小绿鲸日常体验）

> **阶段目标**：补足多文档对比、图表公式交互、重复库清理与真正可用的科研笔记系统。

1. **阅读器多标签页（Multi-Tab）**：支持同时打开多个论文 Tab 与论文库 Tab，无缝保留滚动页码与缩放状态。
2. **批注与笔记系统升级**：
   * 支持跨页选词创建连续高亮（自动拆分归属不同页面的 normalized rects）。
   * 顶栏增设显式**“框选截图/批注”按钮**；框选后截取高分 Canvas 图像，支持**发送多模态 AI 解读图表 / 公式转 LaTeX / 表格抽 CSV**，并支持带图保存批注。
   * 修复批注保存硬编码黄色问题；支持在重新翻译后提示“迁移旧译文批注到新译文对应页码坐标”。
   * 阅读器右侧“笔记”Tab 升级为实时自动保存的 **Markdown 笔记编辑器**，支持分色筛选批注、一键汇总批注并生成含跳转深链的读书笔记、以及一键导出独立 Markdown（+ 截图附件）。
3. **重复论文合并与任务后台化**：
   * 在 [DuplicateFinder.tsx](file:///home/bynshard/paperReader/app/src/DuplicateFinder.tsx) 落地 `merge_papers` 事务（保留主记录，迁移合并重复项的多 PDF 版本、批注、笔记、分类与标签后归档删除冗余条目）。
   * 完善 [TaskCenter.tsx](file:///home/bynshard/paperReader/app/src/TaskCenter.tsx)（展示论文标题、翻译页码进度、耗时、错误详情日志与 `Escape` 关闭）；把全文解析与 OCR 从 `Reader` 生命周期解耦至后台独立任务队列，切换界面不中断。
4. **搜索结果高亮上下文 Snippet**：当关键词命中正文 `blocks` 或速记时，在论文列表行下方展示命中摘录并点击直达对应页。

### Phase 3（P2）：新一代 AI 原生科研能力（拉开体验代差）

> **阶段目标**：引入 Corca Moonlight / SciSpace / Elicit / Sioyek 的标志性高生产力特性。

1. **AI 一键结构化导读卡（Paper Digest）与自动重点高亮**：打开论文可一键生成“背景-痛点-方法-实验-贡献-局限”6 维结构化速读卡（本地 SQLite 缓存），并可切换开关“原文自动语义高亮层”。
2. **智能悬停预览（Smart Hover）与画中画钉选（Pinned Portal）**：悬停参考文献编号 `[12]` 或文内图表引用 `Fig. 3 / Table 2` 自动浮现目标预览卡片；允许把关键图表钉在阅读器角落跨页对照。
3. **跨论文文献对比矩阵 & 文件夹级 Multi-Paper RAG**：支持勾选多篇论文或针对整个分类目录生成横向对比表格（Method / Dataset / Metrics / Limitations）并支持跨论文综合问答与精准引文跳转。
4. **专业学术词典与术语表引擎**：引入自定义翻译术语表（Glossary）管理与本地 CCF/JCR 会议期刊等级徽章自动识别；支持分拆配置“翻译模型”与“深度问答/视觉多模态模型”。

### Phase 4（P3）：学术生态完整与工业级可交付稳健性

> **阶段目标**：完成从“极客自用工具”到“可公开发布的零门槛科研软件”的最后一公里。

1. **首次启动向导（Onboarding）与环境自检引导**：引导用户一步完成 BabelDOC 环境确认、AI 模型连通性校验与旧 Zotero 库快速导入。
2. **引文与格式生态补全**：增加 BibTeX / RIS 导入、本地监控文件夹（Watch Folder）自动入库、标准引文格式（含 GB/T 7714、APA、IEEE、BibTeX）快捷键一键复制，以及“智能文件夹（Smart Collection）”动态视图。
3. **底层长期稳健性加固**：
   * 落地统一的数据库 `schema_version` 迁移表与启动前/定时本地自动快照备份（覆盖 [PRODUCT_READINESS.md](file:///home/bynshard/paperReader/docs/PRODUCT_READINESS.md) R03）。
   * 网关热重载（`reload_gateway`）增加旧监听线程优雅关闭机制；大体积 PDF 读取改造为局部自定义协议按 Range 分片加载，降低内存峰值。
   * 中文 Bigram 索引从 SQLite 递归 CTE 触发器优化为 Rust 应用层批量预分词写入，降低万篇导入时的写放大。

---

## 六、 总结与建议落地起点

Moonlight 已经具备了极少数开源项目才有的硬核底座（**Rust 引擎 + SQLite WAL 读写隔离 + BabelDOC 原位翻译 + 无损 Zotero 迁移**）。现在阻碍它成为一款“操作极度顺手、功能真正成熟”的桌面主力产品的，**并不是底层算力或架构问题，而是 Phase 1 所列的“闭环断层”和 Phase 2~3 所列的“学术阅读生产力特性”**。

* **若希望立刻让现有功能全部顺畅可用**：建议优先按 **Phase 1（P0）** 逐项施工（打通译文检索与双栏段落联动 + AI API 流式与历史 + 论文库拖拽/自动保存/批量事务）。
* **若希望重点打造差异化科研爆点能力**：可在 Phase 1 完成后紧接推进 **“区域截图多模态 AI 读图/转 LaTeX + AI 论文速读卡 + 多论文对比矩阵”**。
