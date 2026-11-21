# vivo Pad 5 Pro 专属适配、全栈代码审查与「论文 + 代码」产品设计方案

> **编写日期**：2026-11-20 ｜ **基线提交**：`6892fed` ｜ **适用对象**：DeepSeek / 开发者全栈重构与平板端落地施工规范  
> **重大定位变更**：放弃此前按“6 寸手机（412dp）”推导的妥协路线，目标移动设备明确收敛为 **vivo Pad 5 Pro（13 寸 3.1K 3:2 旗舰安卓平板）**，核心工作场景升级为 **「高保真论文阅读 + 配套开源代码对照（Paper ↔ Code）」**。  
> **用户体验补充规范**：针对 4 个反直觉前端交互 Bug、Sprint 2 前后端接线收尾及对标成熟产品的 6 大日常体验打磨细节，见 [用户体验差距审查与打磨规范](UX_EXPERIENCE_GAP_AND_POLISH_SPEC.md)。

---

## 目录

1. [vivo Pad 5 Pro 硬件规格与视口适配基线](#1-vivo-pad-5-pro-硬件规格与视口适配基线)
2. [代码层面的真实 Bug 清单（7 个必修 Defect）](#2-代码层面的真实-bug-清单7-个必修-defect)
3. [代码层面的程序设计缺陷（6 项架构与性能重构）](#3-代码层面的程序设计缺陷6-项架构与性能重构)
4. [产品设计审查与行业标杆吸收（Zotero 7 / 小绿鲸 / Sioyek / AI 原生阅读器）](#4-产品设计审查与行业标杆吸收)
5. [vivo Pad 5 Pro 专属「论文 + 代码（Paper ↔ Code）」双栏工作台设计](#5-vivo-pad-5-pro-专属论文--代码paper--code双栏工作台设计)
6. [DeepSeek 施工任务单（Sprint 1 → Sprint 4 验收路线）](#6-deepseek-施工任务单sprint-1--sprint-4-验收路线)

---

## 1. vivo Pad 5 Pro 硬件规格与视口适配基线

### 1.1 设备物理参数与逻辑视口

此前 [ANDROID_CLIENT_EVALUATION.md](ANDROID_CLIENT_EVALUATION.md) 基于 6 寸手机（412dp）得出的“原版版面失效、必须做单列裁剪、体验上限被 R02 流式重排锁死”的结论，**在 vivo Pad 5 Pro 上全部不成立**。

| 参数维度 | vivo Pad 5 Pro 实机规格 | 对阅读器设计的影响 |
| --- | --- | --- |
| **屏幕尺寸与比例** | **13.0 英寸（12.95"），3:2 比例** | 3:2 是最接近学术论文版芯（US Letter ≈ 1:1.29，A4 ≈ 1:1.41）的黄金比例；横屏双栏时比 16:10 平板纵向多出约 12% 正文可视高度。 |
| **物理分辨率与 PPI** | **3096 × 2064 px（3.1K，286 PPI）** | 单页高清 Canvas 需要更高像素预算（建议将 `PageView` 像素上限从 `8_388_608` 提升至 `12_582_912`）。 |
| **逻辑视口（CSS px / dp）** | 按 Android 典型 density ≈ 2.25x：<br>• **横屏**：**1376 × 917 dp**<br>• **竖屏**：**917 × 1376 dp** | 横屏逻辑宽度 **1376dp > 桌面最小窗口 1100px**，与桌面同一量级，无需重写“单列裁剪”，**直接以双栏工作台为主形态**。 |
| **刷新率与触控** | **144Hz** 自适应高刷，**480Hz** 触控采样；支持 **vivo Pencil 3** 与触控键盘 | 双指捏合缩放和滚动必须走合成层 `transform`/原生平滑滚动，避免 JS 主线程阻塞掉帧；必须补齐 Touch/Pointer 与手写笔交互。 |
| **SoC 与系统** | **天玑 9400**（3nm 八核），8/12/16GB RAM；Android 15（**OriginOS 5 HD**） | 性能充裕，可流畅运行多页 PDF 渲染与语法高亮代码树；支持 OriginOS 分屏、桌面级 Chrome PWA 全屏运行与外接键盘快捷键。 |

### 1.2 基于仓库真实样本的可读性几何核算

取仓库实测数据集（`corpus/raw/attn.pdf` 与 `hybridflow.pdf` 及其 BabelDOC 中文译文，页宽 `612pt × 792pt`，正文中位字号 `9.96pt`）：

| 使用姿态 | 可用阅读宽度 | 是否裁白边（Auto-Crop） | 缩放比例 `scale` | 有效正文字号（CSS px） | 物理像素字高 | 结论 |
| --- | --- | --- | --- | --- | --- | --- |
| **竖屏单栏整页** | ~893 dp（917dp 留 24dp 边距） | 否（全页 `612pt`） | `1.46` | **14.5 px** | ~32.7 px | 已达舒适阅读标准 |
| **竖屏单栏整页** | ~893 dp | **是**（裁去页边距，版芯 ~`510pt`） | `1.75` | **17.4 px** | ~39.2 px | **超越纸质 A4 印刷清晰度** |
| **横屏双栏对照（50% / 50%）** | 每栏 ~660 dp | 否（全页 `612pt`） | `1.08` | **10.8 px** | ~24.2 px | 偏紧凑但可看清角标 |
| **横屏双栏对照（50% / 50%）** | 每栏 ~660 dp | **是**（版芯 ~`510pt`） | `1.29` | **12.9 px** | ~29.0 px | **双栏并排直接清晰可读** |
| **横屏「左论文 46% + 右代码 54%」** | 论文 ~615 dp / 代码 ~740 dp | **是**（版芯 ~`510pt`） | `1.21` | 论文 **12.1 px**<br>代码 **14 px**（可容纳 **92–100 列不折行**） | ~27.2 px | **黄金工程工作台** |

> **关键设计推导**：在 vivo Pad 5 Pro 上，**「PDF 自动裁切白边（Auto-Crop Margins）」替代手机端的“单列裁剪”**成为最高性价比体验增强——裁掉页边距（约 12%–16% 空白）即可让横屏双栏正文无需横向滚动直接放大近 20%。

---

## 2. 代码层面的真实 Bug 清单（7 个必修 Defect）

以下 Bug 均通过直接核对仓库源码确认，精确到文件路径与行号，可直接派发修复。

### Bug 1：【严重】`paper_json()` 漏查 `source_version_id`，导致补充材料译文绑定在前端彻底失效
- **代码位置**：
  - [core/src/library.rs](file:///home/bynshard/paperReader/core/src/library.rs#L449-L460)（`paper_json` 查询 `versions`）
  - [core/src/library.rs](file:///home/bynshard/paperReader/core/src/library.rs#L1102)（`attach_translation` 写入 `model`）
  - [app/src/Reader.tsx](file:///home/bynshard/paperReader/app/src/Reader.tsx#L191-L196)（前端过滤译文版本）
- **问题根因**：
  1. Schema v2 已为 `versions` 表新增了 `source_version_id` 列，但 `library.rs:450` 的 SQL 仍写死为 `SELECT id,paper_id,kind,sha256,rel_path,pages,bytes,lang,engine,model,created_at FROM versions WHERE paper_id=? ORDER BY created_at`，**漏选了 `source_version_id`**！
  2. 结果前端拿到的所有译文版本 `version.source_version_id` 永远是 `undefined`。`Reader.tsx:193` 执行 `(version.source_version_id || sourceVersions[0]?.id) === source.versionId` 时，**补充材料生成的译文会错误归属到主文档 `sourceVersions[0]` 下**，切换回补充材料反而看不到自己的译文。
  3. 此外，`library.rs:1102` 插入 `versions` 时记录的 `model` 列仍取自 `std::env::var("MOONLIGHT_MODEL")`，而不是热更新后的 `self.gateway().map(|g| g.model)`，用户通过设置热更新模型后数据库记录的译文模型名是错的。
- **修复方案**：
  - 在 `library.rs:450` 补上 `source_version_id` 字段并返回 `"source_version_id": r.get::<_, Option<String>>(11)?`；
  - 在 `library.rs:1102` 改为优先读取 `self.gateway().map(|g| g.model).unwrap_or_else(|| std::env::var("MOONLIGHT_MODEL").unwrap_or_default())`；
  - 在 `library.rs` 补充单元测试断言 `lib.get_paper(&paper_id)["versions"]` 返回的译文对象包含非空且正确的 `source_version_id`。

### Bug 2：【严重】双栏段落对齐缺少 X 轴分栏约束（50% 概率串栏）且 `groupBlocks` 仅合并单行
- **代码位置**：
  - [app/src/Reader.tsx](file:///home/bynshard/paperReader/app/src/Reader.tsx#L258-L276) 与 [Reader.tsx](file:///home/bynshard/paperReader/app/src/Reader.tsx#L873-L883)（`nearestBlock`）
  - [app/src/PdfPane.tsx](file:///home/bynshard/paperReader/app/src/PdfPane.tsx#L67-L85)（`groupBlocks`）
- **问题根因**：
  1. `nearestBlock(blocks, targetY)` 仅比较 Y 轴中心距离 `Math.abs(center - targetY)`，完全忽略 X 坐标。双栏论文同一页的左栏和右栏处于相同的 Y 区间，点击左栏某一段时，另一侧译文页同高度的右栏段落若 Y 更近，就会**直接高亮错栏**。
  2. `groupBlocks()` 仅在 `Math.abs(last.bbox[1] - y) < h * 0.5`（同一水平基线）时合并文本碎片，不做纵向自然段合并，导致 `blocks` 表存入的是数百条单行碎片，既影响双栏高亮观感，也降低 `ai.rs` 检索上下文完整性。
- **修复方案**：
  - 升级 `nearestBlock(blocks, targetY, sourceNormX?: [number, number], targetWidth?: number)`：当源块已知归一化水平范围 `[x0/w, x1/w]` 时，先计算候选块与源块的水平重叠率（或中心 X 距离 `< 0.22` 页宽），优先在同一栏集合（左栏 / 右栏 / 通栏）中取 Y 距离最近者，避免跨栏误匹配；
  - 升级 `groupBlocks()` 为两遍合并：第一遍按行聚合；第二遍对相邻两行满足“X 左缘对齐或首行缩进（`|x0_a - x0_b| < h * 2.5`）、水平区间重叠 > 50%、行间距 `dy < h * 1.65` 且无跨栏跳变”的合并为一个段落级 Block（注意排除图片/公式碎片密集区）。

### Bug 3：【严重】云同步 `apply()` 忽略目录与标签的删除操作，导致跨端删目录/标签后复活
- **代码位置**：[core/src/sync_model.rs](file:///home/bynshard/paperReader/core/src/sync_model.rs#L126-L133)
- **问题根因**：
  `organization.rs` 已经实现了 `folder_delete` 和 `tag_delete`，SQLite 触发器会把删除的 `category:<id>` 或 `tag:<name>` 记入 `sync_dirty`，导出时值为 `Value::Null`。但 `sync_model.rs:128-133` 仍保留旧注释逻辑 `if !doc.is_null() { ... } return Ok(());`，对 `doc.is_null()` 的删除提交**静默忽略**。A 端删除标签/目录后，B 端同步不会删除，B 端下次同步甚至可能把已删目录重新推回。
- **修复方案**：
  - 当 `tag:<name>` 且 `doc.is_null()` 时：在事务内删除 `paper_tags` 关联及 `tags` 表对应行；
  - 当 `category:<id>` 且 `doc.is_null()` 时：复刻 `folder_delete` 语义，先将该目录的直接子目录 `parent_id` 提升为被删目录的 `parent_id`（避免孤儿目录），再删除 `paper_categories` 关联与 `categories` 记录。

### Bug 4：【严重】vivo Pad 5 Pro 触屏与手写笔下的 3 处交互断路
- **代码位置**：
  - [app/src/PdfPane.tsx](file:///home/bynshard/paperReader/app/src/PdfPane.tsx#L641-L676)（`onAreaPointerDown` 强依赖 `event.altKey`）
  - [app/src/PdfPane.tsx](file:///home/bynshard/paperReader/app/src/PdfPane.tsx#L688-L706) 与 [PdfPane.tsx](file:///home/bynshard/paperReader/app/src/PdfPane.tsx#L717)（`onMouseUp` 触发选词）
  - [app/src/Reader.tsx](file:///home/bynshard/paperReader/app/src/Reader.tsx#L395-L410)（缩放仅支持 `Ctrl + wheel`）
  - [app/src/Reader.tsx](file:///home/bynshard/paperReader/app/src/Reader.tsx#L703-L708)（框选模式下隐藏 AI 能力）
- **问题根因**：
  1. **触屏长按选词不弹菜单**：`PdfPane.tsx:717` 只在 `onMouseUp` 调用 `handleSelection()`。在 Android Chrome/WebView 上长按选词并拖动水滴手柄调整范围时，系统只派发 `selectionchange`，松手常不触发 `mouseup`，浮动工具条无法弹出。
  2. **平板无法框选公式/图表**：`PdfPane.tsx:642` 硬编码 `if (!event.altKey || event.button !== 0) return;`。平板无物理 `Alt` 键，顶栏也没有「框选工具」开关；且即使框选成功，`Reader.tsx:703` 在 `selection.area` 为 true 时隐藏了翻译、解释和提问按钮，导致框选只能画空心框，无法 AI 读图/识公式。
  3. **不支持双指捏合缩放（Pinch-to-Zoom）**：`Reader.tsx:398` 只监听了 `wheel`，未处理触摸屏双指捏合手势。
- **修复方案**：
  1. 在 `PdfPane.tsx` 监听 `document` 的 `selectionchange`（加 280ms 防抖，且仅在非活跃触摸按压期间触发），当选区落在当前 `.pane-scroll` 的某个 `.page-holder` 内时自动回调 `onSelect`，并避免与 Android 原生系统上下文菜单重叠（工具条优先定位在选区上方 `anchor.y - 52px` 或底部固定操作栏）。
  2. 在 `Reader.tsx` 顶栏新增显式「框选截图 / 区域批注」模式切换按钮（同时兼容 `Alt+拖拽` 和手写笔侧键）；框选后支持从 Canvas 裁剪图像并开放「AI 解读图表 / 公式转 LaTeX / 提取表格 / 保存批注」。
  3. 在 `PdfPane.tsx` 增加双指 Pointer/Touch 捏合监听：双指滑动时对舞台施加轻量 CSS `transform: scale(...)` 实现 144Hz 零延迟跟手预览，双指抬起时调用 `prepareZoom(midpoint)` + `zoomTo(nextScale)` 完成高清重绘。

### Bug 5：双栏对照模式下滚动另一栏会自动清空 `Ctrl+F` 文内查找高亮
- **代码位置**：[app/src/Reader.tsx](file:///home/bynshard/paperReader/app/src/Reader.tsx#L320)
- **问题根因**：
  `useEffect(() => { setFindMatches([]); setFindIndex(0); }, [activeSide, source?.versionId, translated?.versionId]);` 将 `activeSide` 放入了依赖数组。在双栏对照模式下，用户搜索一个词后只要滚动或点击另一侧页面，就会触发 `chooseActive(side)` 改变 `activeSide`，导致刚刚搜出的 30 个高亮命中框瞬间被清空且 `FindBar` 计数归零。
- **修复方案**：
  移除 `activeSide` 对 `findMatches` 的清空触发（仅在 `source?.versionId`、`translated?.versionId` 变更或关闭 `FindBar` 时清空），或由 `FindBar` 显式持有 `searchSide` 状态，仅在用户主动切换查找目标栏时重新执行查找。

### Bug 6：浮动工具条“写批注”保存时硬编码黄色，忽略用户选色
- **代码位置**：[app/src/Reader.tsx](file:///home/bynshard/paperReader/app/src/Reader.tsx#L700-L714)
- **问题根因**：
  用户选中文本后点开 `annotating` 写批注输入框，第 713 行点击「保存批注」写死调用 `addHighlight("yellow", annotationDraft)`；而上方颜色圆点在未写批注时点击会直接保存空评论并关闭工具条，用户无法在新建带评论批注时选择绿/蓝/红颜色。
- **修复方案**：
  引入 `draftColor` 状态（默认 `"yellow"`）：当 `annotating === true` 时，点击颜色圆点切换 `draftColor` 并高亮选中边框；点击「保存批注」时调用 `addHighlight(draftColor, annotationDraft)`，保存后复位为 `"yellow"`。

### Bug 7：`Inspector.tsx` 自动补全元数据时误设 `dirty = true`，导致无谓二次写库与乐观锁风险
- **代码位置**：[app/src/Inspector.tsx](file:///home/bynshard/paperReader/app/src/Inspector.tsx#L97-L118)
- **问题根因**：
  `fill()` 调用 `api.refreshMetadata(paper.id, false)` 时，Rust 后端 `pdfmeta::refresh_metadata` **已经将数据写入 SQLite 并递增 `updated_at`**。但前端在 110 行执行了 `setDirty(true); version.current++;`（同时 `onSaved(fresh)` 依赖异步状态传播），导致 900ms 后自动保存定时器再次触发 `persist(true)` 发送一次冗余 `save_paper` 请求；若调用 `fill()` 前用户刚好改了某个字段，还可能覆盖本地编辑或触发 `expected_updated_at` 冲突。
- **修复方案**：
  `fill()` 开始前若 `dirty === true`，先 `await persist(true)` 落盘用户本地修改；拿到 `fresh` 后更新 `fields`、递增 `version.current`，并直接设 `setDirty(false); setSaveState("saved");`。

---

## 3. 代码层面的程序设计缺陷（6 项架构与性能重构）

除了上述具体 Bug，代码库在并发模型、SQLite 索引维护、内存管理与模块边界上存在 **6 项程序架构缺陷**，会随着论文量增长和大屏/平板远程访问放大问题。

### 缺陷 1：`main.rs` 单线程 `heavy_tx` 队列饥饿 + `Library.conn` 粗粒度全局锁
- **代码位置**：[core/src/main.rs](file:///home/bynshard/paperReader/core/src/main.rs#L88-L93,L139-L140)、[core/src/library.rs](file:///home/bynshard/paperReader/core/src/library.rs#L112)
- **不良设计**：
  1. `main.rs` 把 `import_pdfs`、`zotero_import`、`explain`（超时 300s）、`translate_text`、`export`、`backup_create`、`refresh_citations`、`refresh_metadata`、`translation_probe`、`check_babeldoc` 全部丢进同一个 `sync_channel(16)`，后端却**只有 1 个 worker 线程**消费。只要发起一次慢速 AI 问答（阻塞在 `engine::chat`），用户点设置里的“测试连接”、刷引用量、甚至划词翻译全部卡死排队。
  2. `Library.conn: Mutex<Connection>` 保护了写连接，而 `import_paths` / `zotero_import` / `backup::create` 等长操作一旦在循环中长时间持锁或频繁加锁，主 RPC 线程的 `get_paper`、`add_annotation`、`set_blocks` 也会被阻塞。
- **重构设计**：
  - 将通道拆分为三类独立执行器：
    1. **IO/AI 网络并发池（4–8 线程）**：处理 `explain`、`translate_text`、`translation_probe`、`refresh_citations`、`refresh_metadata`、`ai_paper_to_code`、`ai_code_to_paper`——**严格规定在发起 HTTP 请求期间不得持有 `Library.conn` 锁**（先查库取出证据释放锁 → 调网络模型 → 再拿锁写回结果）。
    2. **本地重任务单写者队列**：处理 `import_pdfs`、`zotero_import`、`backup_create`、`backup_restore`、`repo_attach`，批量导入按每 20 篇拆小事务提交。
    3. **WAL 只读连接池（扩展为 4 个读连接）**：承接 `list_papers_page`、`get_paper`、`blocks`、`repo_tree`、`repo_file` 等高频读请求。

### 缺陷 2：SQLite 触发器内用 `WITH RECURSIVE` CTE 按字符切分中文 Bigram（$O(L^2)$ 写放大）
- **代码位置**：[core/src/search.rs](file:///home/bynshard/paperReader/core/src/search.rs#L148-L164)
- **不良设计**：
  `bigrams_expression` 在 SQLite `AFTER INSERT / UPDATE` 触发器里执行 `WITH RECURSIVE pos(i) AS (... substr(text, i, 1) ...)`。SQLite 的 `substr(text, i, 1)` 对 UTF-8 字符串是按字节从头扫描定位第 `i` 个字符的，长度为 $L$ 的文本跑递归 CTE 复杂度高达 $O(L^2)$。大批量导入中文译文块或万篇论文重建索引时，数据库写入极慢且触发递归栈开销。
- **重构设计**：
  利用 `rusqlite` 的 `Connection::create_scalar_function`（`bundled` feature 已内置支持），在 `Library::new` 及各只读连接初始化时直接注册 Rust 原生标量函数 `han_bigrams(text)`：
  ```rust
  conn.create_scalar_function(
      "han_bigrams",
      1,
      rusqlite::functions::FunctionFlags::SQLITE_UTF8 | rusqlite::functions::FunctionFlags::SQLITE_DETERMINISTIC,
      |ctx| {
          let text = ctx.get::<String>(0)?;
          Ok(crate::cjk::han_bigrams(&text).join(" "))
      },
  )?;
  ```
  触发器简化为 `INSERT INTO {index}_src(rowid, bigrams) SELECT new.rowid, han_bigrams(new.text) WHERE ...`，直接以 $O(L)$ 原生 Rust 速度完成切词，彻底消除规则漂移与 $O(L^2)$ 性能陷阱。

### 缺陷 3：`reload_gateway()` 泄漏旧 HTTP 监听线程与端口，且自定义 API 缺少 SSE 流式与取消
- **代码位置**：[core/src/engine.rs](file:///home/bynshard/paperReader/core/src/engine.rs#L19-L67,L176-L198)
- **不良设计**：
  1. 每次用户保存设置调用 `reload_gateway` 时，`start_gateway` 都会 `Server::http("127.0.0.1:0")` 并 `thread::spawn` 一个永久阻塞在 `server.incoming_requests()` 的监听线程，旧 `Server` 从未被销毁，长期运行会泄漏线程和文件描述符。
  2. `engine::chat()` 仍使用阻塞 `resp.json()` 等待 300s，前端消费了 `ai_delta` 事件，但非 Codex 用户既看不到流式打字效果，也无法中途点击“停止”。
- **重构设计**：
  1. 在 `Gateway` 结构中持有 `server: Arc<tiny_http::Server>`（或 `shutdown_handle`），当 `Library::reload_gateway` 替换 `self.gateway` 时对旧网关调用 `old_server.unblock()`，监听循环收到退出标志后优雅结束。
  2. 新增 `engine::chat_stream(...)`：向 OpenAI 兼容接口发送 `"stream": true`，用 `BufReader::new(resp).lines()` 逐行读取 SSE `data: {...}`，累加 delta 并通过 `lib.emit(json!({"event": "ai_delta", "request_id": req_id, "answer": accumulated}))` 实时推送；每次读行检查 `AtomicBool` 取消标志，中断即关闭流并返回。

### 缺陷 4：整文件 PDF 二进制通过 IPC 跨进程三重拷贝，3.1K 高分屏与大论文内存压力大
- **代码位置**：[app/electron/main.cjs](file:///home/bynshard/paperReader/app/electron/main.cjs#L254-L258)、[app/src/PdfPane.tsx](file:///home/bynshard/paperReader/app/src/PdfPane.tsx#L207-L209,L321)
- **不良设计**：
  `main.cjs` 用 `fs.promises.readFile(info.path)` 把整份 PDF 读入 Node Buffer 经 Electron IPC 序列化传给渲染器，`PdfPane.tsx:321` 又执行 `bytes.slice()` 拷贝一份传入 PDF.js Worker。双栏对照阅读一份 80MB 带高精扫描图的论文时，主进程 + 渲染进程 + 两个 PDF Worker 会瞬间占用 > 400MB 纯 PDF 字节拷贝。而在局域网向 vivo Pad 5 Pro 传大 PDF 时，一次性下载整包还会导致首屏白屏卡顿。
- **重构设计**：
  1. 桌面 Electron 端注册自定义流式协议 `moonlight-pdf://version/<version_id>`，支持 `Range: bytes=start-end`（HTTP 206 Partial Content），使用 `fs.createReadStream(path, { start, end })` 按需分片供流；
  2. 平板/HTTP 端在 `moonlight-core --serve` 上提供 `GET /api/pdf/:version_id`（同样支持 `Range` 请求与 `Accept-Ranges: bytes`）；
  3. `PdfPane.tsx` 改用 `pdfjsLib.getDocument({ url, rangeChunkSize: 65536, disableAutoFetch: false })`，实现 200 页大论文秒开。

### 缺陷 5：文档精细解析与离线 OCR 绑死在 `Reader` UI 生命周期内
- **代码位置**：[app/src/DocumentParsing.tsx](file:///home/bynshard/paperReader/app/src/DocumentParsing.tsx#L31-L61)
- **不良设计**：
  全文块提取和 Tesseract OCR 由 `Reader` 挂载的 `DocumentParsing` 组件在 `useEffect` 内驱动，一旦用户点击“返回论文库”或切换另一篇论文，组件卸载触发 `controller.current?.abort()`，未索引完的论文进度立刻中止，导致跨论文检索和 AI 问答残缺。
- **重构设计**：
  将解析/OCR 任务调度提升至全局状态（`App.tsx` 级后台调度器或独立隐藏 Worker/后台任务表），并统一汇报进度到 `TaskCenter`；平板端打开论文时，优先由桌面宿主机在后台完成全文解析与 OCR 入库，平板仅作为零算力消耗的消费者。

### 缺陷 6：“上帝文件”膨胀与跨端状态散落 `localStorage`
- **代码位置**：
  - `core/src/library.rs`（1757 行）、`app/src/Reader.tsx`（904 行）、`app/src/PdfPane.tsx`（743 行）
  - 阅读位置保存在 `Reader.tsx:41/152/324` 的 `localStorage.getItem("pos:" + paper.id)`，不同步、不跨设备。
- **重构设计**：
  1. **后端拆模块**：将 `library.rs` 拆分为 `core/src/annotations.rs`、`core/src/jobs.rs`、`core/src/versions.rs`、`core/src/export.rs`，新增代码仓模块 `core/src/repos.rs` 与平板 HTTP 服务模块 `core/src/server.rs`；
  2. **前端拆组件**：将 `Reader.tsx` 拆为 `reader/ReaderHeader.tsx`、`reader/AiChatPanel.tsx`、`reader/NotesPanel.tsx`、`reader/SelectionToolbar.tsx`、`reader/CodePane.tsx`；
  3. **阅读进度入库与同步**：在 `papers` 表增加 `last_read_page`、`last_read_fraction`、`last_read_mode`、`last_read_at` 字段并随 `sync_model` 自动同步，让桌面与 vivo Pad 5 Pro 之间真正实现“拿起平板接续上次段落”。

---

## 4. 产品设计审查与行业标杆吸收

对照当前版本（已参考 `MATURITY_BENCHMARK_AND_ROADMAP.md` 中部分 Phase 1 成果），与 **Zotero 7（+ Better Notes / Translate）、小绿鲸、Sioyek、MarginNote 4、Corca Moonlight、SciSpace、Elicit、NotebookLM** 对比，我们在**论文管理**与**论文阅读**上仍明确缺乏以下高价值能力：

### 4.1 论文管理层（吸收 Zotero 7 + 小绿鲸）

| 能力项 | 对标来源 | Moonlight 现状 | 补齐设计 |
| --- | --- | --- | --- |
| **重复论文无损合并** | Zotero 7 | `DuplicateFinder` 仅能查看分组，无法合并 | 实现 `merge_papers(primary_id, secondary_ids)` 事务：将重复条目的 PDF 版本、代码仓绑定、批注、AI 对话、笔记、分类与标签无损并入主条目并清除冗余记录。 |
| **目录/标签直觉交互** | Zotero 7 | 仅支持弹窗管理；无拖拽归类、无右键菜单、侧栏标签无颜色圆点、目录无计数 | `FolderTree` 与 `TaxonomyList` 支持表格行拖拽投放归类、右键上下文菜单（新建子目录/重命名/改色/合并/删除）、渲染颜色圆点及每项论文数量角标。 |
| **智能文件夹（Smart Collections）** | Zotero 7 | 缺失 | 保存常用组合条件（如 `最近两年 + CCF-A + 未读 + 含代码仓`）为左侧动态智能视图。 |
| **顶会/期刊等级自动识别** | 小绿鲸 / EasyScholar | 仅显示原始 `venue` 字符串 | 内置轻量本地 JSON 映射表（CCF-A/B/C 计算机会议与期刊 + 常见 AI 顶会别名如 NeurIPS/ICML/ICLR/ACL/CVPR/OSDI），列表标题下方离线渲染彩色等级徽章并支持按等级筛选。 |
| **BibTeX / RIS 导入与标准引文复制** | Zotero 7 | 仅支持导出 `.bib`/`.ris`，无法导入，缺 GB/T 7714 一键复制 | 增加 `.bib`/`.ris` 文件批量导入（自动解析元数据与本地 PDF 关联）；右键菜单与快捷键支持一键复制 `GB/T 7714-2015` / `BibTeX` / `APA` / `Markdown 引用`。 |
| **检索命中上下文摘录（Snippet）** | Zotero / 学术搜索 | 搜正文命中时列表只显示标题，看不出命中的是哪一页哪一句 | `list_papers_page` 对命中 `blocks` 的条目附带 1 条带高亮标记的 `hit_snippet` 与 `hit_page`，点击直达阅读器对应页。 |

### 4.2 论文阅读与笔记层（吸收 Sioyek + MarginNote 4 + Better Notes）

| 能力项 | 对标来源 | Moonlight 现状 | 补齐设计 |
| --- | --- | --- | --- |
| **PDF 自动裁切白边（Auto-Crop）** | Sioyek / 专业平板阅读器 | 仅按整页物理宽度 `fit-width`，浪费平板两侧 ~20% 屏幕 | 计算页面 `text/drawing` 内容包络框 `contentBox`，在视口层裁剪空白页边（**不改变底层 PDF 页面尺寸，归一化 0–1 批注坐标 100% 兼容**），平板双栏正文放大 ~20%。 |
| **引用/图表悬停预览与画中画钉选（Portal）** | Sioyek | 有 `AnnotationLayer` 内链跳转和历史栈，但跳转仍打断当前阅读流 | 悬停或手写笔轻点 `[12]` / `Fig. 3` / `Table 2` 弹出浮动预览卡片；支持将任意图表区域或参考页「Pin 为角落小窗（Pinned Portal）」，主视图继续往下翻页对照公式或实验表格。 |
| **跨页划线高亮** | Zotero 7 / PDF 原生引擎 | `PdfPane.tsx:694` 发现跨页选区直接丢弃 | 当 `Range` 跨越多个 `.page-holder` 时，按页面拆分计算每页各自的归一化 `rects` 并关联为一组批注（或连续多段）。 |
| **多标签页并发阅读（Multi-Tab）** | Zotero 7 | `App.tsx` 单 `openPaper`，一次只能开一篇 | 顶部保留 `论文库 + 已打开论文 Tabs`，同时挂着主论文与 2~3 篇 Referenced Work 随时切换不丢滚动位置。 |
| **结构化 Markdown 笔记与双向深链** | Better Notes / MarginNote | 右栏“笔记”只读，不能写、不能按颜色筛选、不能导出 | 升级右栏“笔记”为内置自动保存 Markdown 编辑器，内置精读/复现/审稿模板，支持「一键汇总所有批注插入笔记」并生成可跳回 PDF 高亮页的双向链接。 |

### 4.3 AI 原生科研精读层（吸收 Corca Moonlight + SciSpace + Elicit + NotebookLM）

| 能力项 | 对标来源 | Moonlight 现状 | 补齐设计 |
| --- | --- | --- | --- |
| **6 维论文速读导读卡 + 自动重点高亮** | 小绿鲸 / Corca Moonlight | 只有聊天区“提炼核心贡献”按钮，无持久结构化卡片 | 新增常驻 **「导读（Digest）」** 面板，一键生成“研究背景 / 痛点 / 核心方法 / 实验设计 / 主要结论 / 局限”结构化卡片并落库 `papers.digest_json`，并支持开关 AI 自动语义重点高亮层。 |
| **框选区域多模态 AI（读图 / 识公式 / 抽表）** | Corca Moonlight / SciSpace | 框选只能存空心框，无图像裁剪与多模态提问 | 从 `PdfPane` Canvas 裁剪选中框高分辨率 PNG，支持一键发送 Vision 模型：**① 解读架构图/消融图 ② 公式转 LaTeX ③ 表格转 Markdown/CSV ④ 存为带缩略图批注**。 |
| **专业术语表（Glossary）与双模型分流** | 小绿鲸 | 无自定义术语表；翻译与问答被迫共用同一个模型 | 设置中支持配置学科/全局术语表（透传 BabelDOC `--glossary-files` 与局部翻译 Prompt）；拆分“批量翻译高性价比模型”与“深度问答/视觉多模态模型”。 |
| **跨论文对比矩阵与目录联合 RAG** | Elicit / NotebookLM | AI 仅局限在单篇阅读器内 | 在论文库批量操作栏与目录菜单增加 **「多篇对比矩阵」** 与 **「目录联合问答」**，围绕选定论文集合提取 `Method / Dataset / Metrics / Limitations` 对比表并支持点击跳回原论文页码。 |

---

## 5. vivo Pad 5 Pro 专属「论文 + 代码（Paper ↔ Code）」双栏工作台设计

阅读计算机/AI 论文时，最高频的痛点是**“论文里写了一个算法伪代码或公式，但工程细节（张量维度、超参默认值、分布式切分、Loss 实现）全在 GitHub 代码仓里”**。利用 vivo Pad 5 Pro **13 寸 3:2 3.1K 横屏（1376×917dp）** 的充裕横向与纵向空间，将 Moonlight 升级为 **「左论文 + 右代码 + AI 双向映射」** 的科研精读工作台。

### 5.1 屏幕布局与多模态切换（专攻 vivo Pad 5 Pro）

```
┌────────────────────────────────────────────────────────────────────────────────────────┐
│ [☰ 库] [←]  HybridFlow: RLHF Framework   [原文][译文][双语对照][论文+代码]  [裁边][框选][AI] │ 48dp 触控顶栏
├───────────────────────────────────────┬────────────────────────────────────────────────┤
│ 左栏：论文 PDF (46% ≈ 630dp，可拖 35-65%)│ 右栏：代码阅读器 CodePane (54% ≈ 746dp)          │
│ ┌───────────────────────────────────┐ │ ┌────────────────────────────────────────────┐ │
│ │ 附件: 主文档 ▾ | [原文 ⇄ 译文] p.6/19 │ │ │ [📁 文件] verl/trainer/ppo/ray_trainer.py × │ │
│ └───────────────────────────────────┘ │ │ 🔎 @符号大纲  verl > trainer > ppo > ray...  │ │
│                                       │ ├────────────────────────────────────────────┤ │
│  3.2 3D-HybridEngine                  │ │  64 │ class RayPPOTrainer:                  │ │
│  在 Actor 生成与训练切换阶段，我们通过  │ │  65 │   def fit(self):                     │ │
│  重分片消除显存冗余...                  │ │  66 │     # 初始化 HybridEngine 参数切分    │ │
│  ┌─────────────────────────────────┐  │ │  67 │     with self.actor_rollout_wg.sharding │ │
│  │ Algorithm 1: HybridEngine Step  │  │ │  68 │       output = self.actor_rollout_wg...│ │
│  │  </> sharding_manager.py:L64   │◄─┼─┼──► [高亮选中 L64-L88]                       │
│  └─────────────────────────────────┘  │ │     浮动条: [📖对照论文解释][📌钉到PDF][📋复制]│ │
└───────────────────────────────────────┴─┴────────────────────────────────────────────┴─┘
```

- **横屏模式切换（1376×917dp）**：顶栏提供 4 个一级模式：
  1. **原文**：单栏居中（启用自动裁边，17px+ 舒适精读）；
  2. **译文**：单栏中文译文；
  3. **双语对照**：左原文 + 右译文（各 50% ≈ 660dp + 自动裁边 + 修复后的 X/Y 同栏段落级同步对齐）；
  4. **论文 + 代码（Paper ↔ Code）**：左论文 PDF（顶部自带 `[原文 ⇄ 译文]` 秒切胶囊，无需退出双栏即可随时核对中英文）+ 右 `CodePane`（文件树可抽屉收起，释放全部 746dp 宽度给代码行）。
- **竖屏自适应（917×1376dp，当 `@media (max-width: 1050px)` 时）**：
  - 双栏自动转为全屏单栏，顶栏分段胶囊切换 `[原文] / [译文] / [代码]`（保留各自的页码/文件/行号滚动状态）；
  - AI 对话、笔记与代码文件树统一收入底部可拖拽 **Bottom Sheet（半屏/全屏抽屉）**。

### 5.2 数据库 Schema v3 扩展（`core/src/library.rs`）

将 `SCHEMA_VERSION` 从 `2` 升级为 `3`（沿用现有 `backup_before_upgrade` 安全快照机制）：

```sql
-- 1. 跨端阅读进度 & AI 导读卡缓存
ALTER TABLE papers ADD COLUMN last_read_page INTEGER;
ALTER TABLE papers ADD COLUMN last_read_fraction REAL;
ALTER TABLE papers ADD COLUMN last_read_mode TEXT;
ALTER TABLE papers ADD COLUMN last_read_at INTEGER;
ALTER TABLE papers ADD COLUMN digest_json TEXT;

-- 2. 论文绑定的代码仓库（本地托管副本）
CREATE TABLE IF NOT EXISTS paper_repos (
  id TEXT PRIMARY KEY,
  paper_id TEXT NOT NULL REFERENCES papers(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  repo_url TEXT,
  rel_path TEXT NOT NULL,          -- 相对于库根目录，如 code/<paper_id>/<repo_id>
  default_branch TEXT,
  commit_sha TEXT,
  file_count INTEGER NOT NULL DEFAULT 0,
  indexed_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_paper_repos_paper ON paper_repos(paper_id);

-- 3. 轻量代码符号索引（供 @符号跳转 与 Paper↔Code AI 映射检索）
CREATE TABLE IF NOT EXISTS code_symbols (
  id TEXT PRIMARY KEY,
  repo_id TEXT NOT NULL REFERENCES paper_repos(id) ON DELETE CASCADE,
  paper_id TEXT NOT NULL REFERENCES papers(id) ON DELETE CASCADE,
  file_path TEXT NOT NULL,         -- 仓库内相对路径，如 verl/trainer/ppo/ray_trainer.py
  kind TEXT NOT NULL,              -- class | function | method | struct | impl | trait
  name TEXT NOT NULL,
  signature TEXT NOT NULL,
  start_line INTEGER NOT NULL,
  end_line INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_code_symbols_repo ON code_symbols(repo_id, file_path, start_line);
CREATE VIRTUAL TABLE IF NOT EXISTS code_symbols_fts USING fts5(
  name, signature, file_path,
  content='code_symbols', content_rowid='rowid', tokenize='unicode61'
);

-- 4. 批注扩展元信息（支持 Paper↔Code 钉选引用与图文截图路径）
ALTER TABLE annotations ADD COLUMN meta_json TEXT;
```

> **同步策略说明**：`paper_repos` 纳入 `sync_model.rs` 的 `paper:<id>` 同步文档子表（按需要把代码仓库打包为 `code/<sha256>.tar.zst` 或 `.zip` 不可变对象随同步上传）；`code_symbols` 与 `code_symbols_fts` 属于本地派生索引，不同步，解压时本地秒级重建。

### 5.3 Rust 后端新增模块：`core/src/repos.rs` 与 RPC 接口

建议新增 `core/src/repos.rs`（以及可选轻量语法提取器，不引入重型 C++ 编译依赖以免破坏 Android NDK 交叉编译）：

| RPC 方法 | 参数 | 职责与实现要点 |
| --- | --- | --- |
| `repo_detect` | `{ paper_id }` | 扫描论文 `abstract` 与前 3 页 `blocks`，正则提取 `https://github.com/<owner>/<repo>`（排除通用主页/许可证链接）作为一键拉取建议。 |
| `repo_attach` | `{ paper_id, source, name? }` | `source` 支持 GitHub URL（自动下载 `codeload.github.com/.../zip/HEAD`）或本地目录/ZIP；解压至 `<root>/code/<paper_id>/<repo_id>/`，过滤 `.git`、`node_modules`、`__pycache__`、`target`、单文件 `> 1MB` 及二进制文件；同时扫描常见源码后缀（`.py/.rs/.ts/.tsx/.js/.cpp/.cc/.h/.cu/.cuh/.java/.go/.md/.yaml`）提取符号写入 `code_symbols`。 |
| `repo_list` / `repo_remove` | `{ paper_id }` / `{ repo_id }` | 列出或删除绑定仓及托管目录。 |
| `repo_tree` | `{ repo_id }` | 返回目录树结构（路径、大小、语言、符号数），供左侧抽屉按需懒展开。 |
| `repo_file` | `{ repo_id, file_path }` | 校验路径防穿越后读取源码文本（UTF-8）及本文件符号列表 `symbols`，供 `CodePane` 渲染与大纲跳转。 |
| `repo_search` | `{ repo_id, query, limit? }` | 联合检索 `code_symbols_fts`（符号名瞬间定位）与源码文本行匹配，返回 `{ file_path, line, preview, symbol? }`。 |
| `ai_paper_to_code` | `{ paper_id, repo_id, quote, page? }` | **论文 → 代码智能定位**：从选段提取英文专有名词/算法变量/模块名，检索 `code_symbols` 与相关源码前 8 候选片段，构造 Prompt 请求 LLM 输出原理对应分析及结构化代码定位列表 `[{ file_path, start_line, end_line, symbol, reason }]`。 |
| `ai_code_to_paper` | `{ paper_id, repo_id, file_path, start_line, end_line, code }` | **代码 → 论文对照解释**：用代码注释、函数名、变量名结合 `ai::query_terms` 检索当前论文原文与译文 `blocks`，调用 LLM 逐行解释代码对应的论文公式、超参设计及与原文差异，返回可点击跳回 PDF 页码的 `sources`。 |

### 5.4 平板端专属代码阅读交互（`app/src/reader/CodePane.tsx`）

在安卓平板上看代码最大的痛点是**“触屏拖选多行极易滑脱、深层目录点击累、切回原文麻烦”**，因此 `CodePane.tsx` 专为触屏与手写笔设计：

1. **两点式行号区间选择（Two-Tap Line Range Select）**：
   - 手指轻点行号 `64`（标记为起点），再轻点行号 `88`，**无需长按拖拽**，直接选中 `L64–L88` 高亮代码块并弹出浮动工具条：
     `[📖 对照论文解释] [📌 钉到当前 PDF 页] [💬 引用代码提问] [📋 复制代码]`。
   - 若直接接入了外接键盘，也支持 `Shift + 点击` 行号连选。
2. **代码语法高亮与只读导航优化**：
   - 使用轻量的 `highlight.js` 或 `shiki`（按常见科研语言按需 bundle：Python/CUDA/C++/Rust/TS/Bash/YAML）渲染静态高亮行组件（配合 `@tanstack/react-virtual` 虚拟滚动，1 万行源码文件在平板上 144Hz 零卡顿）。
   - 顶部提供 **`@符号跳转`** 搜索栏，点开即可一键筛选当前文件或全仓库的 `class / def / struct / fn`。
   - **代码折叠**：点击缩进块或函数行左侧折叠箭头，收起长长的 boilerplate（如参数解析、日志打印），专注核心 Forward / Loss / Step 逻辑。
3. **Paper ↔ Code 双向钉选徽标（Pin Badge）**：
   - 点击浮动条的 `📌 钉到当前 PDF 页` 后，向 `annotations` 表写入一条 `meta_json = { "kind": "code_pin", "repo_id": "...", "file_path": "...", "start_line": 64, "end_line": 88 }`。
   - 在左侧 PDF 对应段落旁渲染绿色代码胶囊 **`</> ray_trainer.py:64`**；在平板上读论文时点一下这个胶囊，右侧立刻打开对应文件、滚动至第 64 行并脉冲高亮 `L64–L88`。

### 5.5 局域网 / Tailscale 平板直连服务端（`moonlight-core --serve`）

对于 vivo Pad 5 Pro 来说，**“PC 桌面运行 `moonlight-core` 守护服务 + 平板通过 Chrome / PWA 全屏访问”** 是一期落地最快、同时解决 **BabelDOC 全文翻译** 与 **代码仓库同步** 的最佳形态：

1. **后端新增 HTTP 服务模式（`core/src/server.rs`）**：
   - 复用 `core/Cargo.toml` 中已存在的 `tiny_http = "0.12"`，为 `moonlight-core` 增加 `--serve 0.0.0.0:8765` 启动参数（及 Electron 设置页一键开关「开启平板局域网阅读服务」并展示配对二维码 + Bearer Token）。
   - 暴露 4 个核心 HTTP 端点：
     - `POST /api/rpc`：校验 `Authorization: Bearer <token>` 后直接转发至 `dispatch()`（与 Electron JSONL 共用 100% 后端业务逻辑）；
     - `GET /api/events`：基于 `text/event-stream` (SSE) 转发 `Library::emit` 事件（翻译进度、AI `ai_delta` 流式打字、导入进度）；
     - `GET /api/pdf/:version_id`：校验库内安全路径，解析 HTTP `Range: bytes=...` 请求头返回 `206 Partial Content` 与 `Accept-Ranges: bytes`；
     - `GET /*`：托管打包好的 `app/dist` 静态资源 + `manifest.webmanifest`（使 vivo Pad 5 Pro 在 Chrome 中点击“添加到主屏幕”后以无地址栏原生全屏 PWA 运行）。
2. **前端透明桥接切换（`app/src/api.ts`）**：
   - 当检测到 `window.moonlight` 不存在时，`bridge()` 自动返回基于 `fetch` + `EventSource` 的 `createHttpBridge()` 实现；
   - `readPdf` 返回 `{ url: "/api/pdf/..." }` 供 PDF.js 流式拉取；
   - **平板遥控桌面翻译**：因为后端运行在 Windows 桌面端，用户在 vivo Pad 5 Pro 上读到一篇还没翻译的英文论文时，**可以直接点击平板顶部「翻译全文」，桌面端的 BabelDOC 就会在后台开始翻译，平板实时收到 SSE 进度条，翻完即刻在平板呈现中文原位译文！**
3. **后续离线进化路径（Phase 4 可选）**：
   - 当需要脱离电脑/无网环境阅读时，基于同一套前端 + `core/src/repos.rs` + `core/src/sync_model.rs`，用 Capacitor 或 Kotlin + JNI 封装 `moonlight-core`（`cfg(target_os = "android")` 仅裁剪 `engine.rs` BabelDOC 和 `sync_transport.rs` rclone 子进程），实现本机离线库按需缓存。

---

## 6. DeepSeek 施工任务单（Sprint 1 → Sprint 4 验收路线）

以下任务按依赖顺序拆分，每个 Sprint 均有明确修改范围与回归验收命令。

### Sprint 1：必修代码 Bug 与并发架构纠偏（3–4 天，桌面与平板共同受益）

> **实施状态（2026-11-20）**：T1.1–T1.5 已全部完成并通过回归（Rust 62 passed / 前端 tsc 0 error、vitest 44、Node 46、vite build 通过），逐项改动与证据见 [Sprint 1 实施记录](SPRINT1_IMPLEMENTATION_20261120.md)。

- [x] **T1.1 修复 `paper_json` 与 `attach_translation` 版本关联**：在 [core/src/library.rs](file:///home/bynshard/paperReader/core/src/library.rs#L450) 查询并输出 `source_version_id`，在 `library.rs:1102` 写入热更新网关的 `model`，补 Rust 单测。
- [x] **T1.2 修复 `sync_model.rs` 删除同步**：在 [core/src/sync_model.rs](file:///home/bynshard/paperReader/core/src/sync_model.rs#L126-L133) 处理 `tag:` 与 `category:` 的 `Value::Null` 删除提交，补 Rust 双向同步测试。
- [x] **T1.3 修复双栏对齐串栏与段落合并**：升级 [app/src/Reader.tsx](file:///home/bynshard/paperReader/app/src/Reader.tsx#L873-L883) 的 `nearestBlock`（加入 X 轴同栏约束）与 [app/src/PdfPane.tsx](file:///home/bynshard/paperReader/app/src/PdfPane.tsx#L67-L85) 的 `groupBlocks`（加入自然段聚类）。
- [x] **T1.4 修复前端 3 个交互 Bug**：
  - [app/src/Reader.tsx](file:///home/bynshard/paperReader/app/src/Reader.tsx#L320) 移除 `activeSide` 变化对 `findMatches` 的清空；
  - [app/src/Reader.tsx](file:///home/bynshard/paperReader/app/src/Reader.tsx#L700-L714) 补 `draftColor` 状态修复批注硬编码黄色；
  - [app/src/Inspector.tsx](file:///home/bynshard/paperReader/app/src/Inspector.tsx#L103-L118) 修复 `fill()` 自动补全后误设 `setDirty(true)` 的问题。
- [x] **T1.5 后端并发池、原生 Bigram 函数与网关流式改造**：
  - [core/src/main.rs](file:///home/bynshard/paperReader/core/src/main.rs) 拆分 AI/网络并发线程池（4 线程）与写库队列；
  - [core/src/search.rs](file:///home/bynshard/paperReader/core/src/search.rs) 绑定 Rust 原生 `han_bigrams` SQLite 标量函数替代递归 CTE；
  - [core/src/engine.rs](file:///home/bynshard/paperReader/core/src/engine.rs) 给 `Gateway` 增加 `unblock()` 优雅退出机制，并实现 `chat_stream` SSE 流式与 `AtomicBool` 取消。

### Sprint 2：vivo Pad 5 Pro 触屏适配 + 局域网 PWA 服务端（4–5 天）

- [ ] **T2.1 触屏选词、双指缩放与显式框选**：在 [app/src/PdfPane.tsx](file:///home/bynshard/paperReader/app/src/PdfPane.tsx) 落地 `selectionchange` 防抖选词、双指 Pinch-to-Zoom、`autoCrop` 自动裁白边模式；在 [app/src/Reader.tsx](file:///home/bynshard/paperReader/app/src/Reader.tsx) 增加显式「框选模式」按钮与 3:2 平板响应式 CSS（[app/src/styles.css](file:///home/bynshard/paperReader/app/src/styles.css) 适配横屏双栏与竖屏 Bottom Sheet）。
- [ ] **T2.2 Schema v3 迁移与阅读位置同步**：在 [core/src/library.rs](file:///home/bynshard/paperReader/core/src/library.rs) 升级 `SCHEMA_VERSION = 3`，把 `last_read_page/fraction/mode/at` 纳入数据库与 `sync_model.rs`；去除 `Reader.tsx` 对 `localStorage` 阅读进度的依赖。
- [ ] **T2.3 流式 PDF 与 `--serve` HTTP/SSE 服务端**：新增 `core/src/server.rs`（支持 Token 鉴权、Range 206 PDF 流、SSE 事件、静态资源托管），并在 Electron `main.cjs` 注册 `moonlight-pdf://` Range 协议；在 [app/src/api.ts](file:///home/bynshard/paperReader/app/src/api.ts) 实现 `createHttpBridge()` fallback 与 PWA `manifest.webmanifest`。

### Sprint 3：「论文 + 代码（Paper ↔ Code）」双栏工作台（1.5 周）

- [ ] **T3.1 代码仓管理与符号索引引擎**：实现 `core/src/repos.rs`（`repo_detect` / `repo_attach` / `repo_list` / `repo_remove` / `repo_tree` / `repo_file` / `repo_search` + `code_symbols_fts`），接入 `main.rs` 和 `server.rs`。
- [ ] **T3.2 Paper ↔ Code AI 双向映射**：在 `core/src/ai.rs` 实现 `ai_paper_to_code` 与 `ai_code_to_paper`；支持 `annotations.meta_json` 存储代码钉选锚点。
- [ ] **T3.3 平板代码阅读器 UI**：新增 `app/src/reader/CodePane.tsx`（虚拟滚动高亮行、两点式行号区间选择、文件树抽屉、`@符号大纲`、代码折叠、浮动操作条）并在 `Reader.tsx` 接入第 4 种模式 `mode === "paper-code"` 与 PDF 段落旁 `</> file:line` 徽标跳转。

### Sprint 4：产品成熟度补齐（absorbs Zotero 7 / 小绿鲸 / Sioyek / Corca 长处，1.5–2 周）

- [ ] **T4.1 阅读器生产级体验**：全局后台解析/OCR 队列（脱离 `Reader` 卸载限制）、多标签页阅读（Multi-Tab）、跨页划线高亮、框选区域 Canvas 裁剪多模态 AI 读图/公式转 LaTeX/表格抽 CSV。
- [ ] **T4.2 Sioyek 与 Better Notes 工作流**：引用/图表悬浮预览（Smart Hover）与画中画钉选窗（Pinned Portal）；右侧 Markdown 实时笔记编辑器与批注双向深链一键汇总导出。
- [ ] **T4.3 文献管理闭环与 AI 综述**：`merge_papers` 重复论文无损合并、目录/标签拖拽归档与右键菜单、本地 CCF 顶会徽章、`.bib/.ris` 导入与 GB/T 7714 一键复制、6 维论文导读卡（`digest_json`）与跨论文对比矩阵。

### 统一回归验收命令

每次完成一个 Sprint 后执行以下全套本地验证（不得跳过或放宽断言）：

```bash
# 1. Rust 核心单元与集成测试
cd core && cargo test --locked

# 2. 前端 TypeScript 类型检查、单测与生产包构建
cd app && npx tsc --noEmit && npm test && npm run build
```
