# Rust 原生阅读器复用评估（2026-10-31）

> 目标：在不重写 PDF 渲染/阅读器的前提下，评估可复用的 GitHub 项目，给 Moonlight 的“高性能桌面阅读器”选一条可落地路线。
> 本机限制：这台 Linux 服务器没有 X11/xkbcommon/fontconfig/GTK/WebKit 开发库，也没有显示服务，**iced / Slint / GPUI 都无法在这里编译或运行**。因此本文的构建与帧率结论均为 `not_run`，必须在有桌面的 Windows/Linux 机器上复核；源码与依赖事实已核对到具体提交。

## 1. 结论摘要

1. **不要从零写 Rust GUI + PDF 阅读器**。可复用项目已经覆盖“渲染、缓存、文本选择、高亮、搜索、缩略图、标注”这些最难的部分。
2. 最值得复用的是两条路线：
   - **miro**（Rust + iced 0.14 + MuPDF，AGPL-3.0，554★）：完整阅读器，已有文本选择、搜索、标注显示、标签页、总览、RPC，最接近 Moonlight 阅读器需要的交互。
   - **BarePDF**（Rust + Slint 1.9 + PDFium，MIT，模块化 crate）：`barepdf-pdf` / `barepdf-render` / `barepdf-thumbnail` 可直接作为渲染层，带内存预算、页缓存、调度器和 PDFium 字形高亮，许可证最干净。
3. **短期不建议切换 GUI**。Electron + React + PDF.js 已经能跑通 M1 流程，而本机无法验收任何原生 GUI；先把 Electron 阅读器做成“虚拟化 + 分块缓存 + 预取”的高性能版本，成本最低。
4. 原生路线设一个**可证伪的 spike**：在 Windows 上构建 miro 或 BarePDF，接入同一篇 PDF，测 150% 缩放下滚动帧率、文本选择准确率、20 页论文内存、双栏对照同步。达标再迁移，不达标保留 Electron。

## 2. 候选对比

| 项目 | 技术栈 | 许可证 | 规模/活跃度 | 可直接复用什么 | 主要风险 |
| --- | --- | --- | --- | --- | --- |
| [miro](https://github.com/vincent-uden/miro) | iced 0.14 + `mupdf` 0.8 | AGPL-3.0 | 554★，2026-10 活跃，9.2k 行 Rust | 完整阅读器：连续滚动、文本复制、搜索、标注显示、书签、标签页、页面总览、RPC、配置文件 | MuPDF 需从源码编译（C/C++，AGPL）；iced 0.14 API 较新；需要扩展成双 PDF 对照 |
| [BarePDF](https://github.com/Woffluon/BarePDF) | Slint 1.9 + pdfium-render 0.9 | MIT | 2★，2026-10 活跃，21k 行（多 crate） | `barepdf-pdf`（PDFium 封装）、`barepdf-render`（内存预算 + LRU 页缓存 + 调度器）、`barepdf-thumbnail`、字形级高亮/标注实现 | Windows 优先；Slint 生态小；需要自己搭阅读器壳与双栏 |
| [kkpdf-zed](https://github.com/kk376/kkpdf-zed) | GPUI + pdfium-render | Apache-2.0 OR GPL-3.0 | 6★，2026-10，3.4k 行 | PDF 引擎、栅格化、页缓存、GPUI 视图/工具栏 | 绑定 Zed 的 GPUI；GPUI 未稳定；Linux 需要 Vulkan/X11 |
| [pdfium-render](https://github.com/ajrcarey/pdfium-render) | Rust 绑定 PDFium | BSD-3（仓库 license 字段为 NOASSERTION，需再核对） | 717★，2026-10 | 渲染、文本、图片、注释、表单 | 只是底层绑定，不含阅读器 UI |
| [Open PDF Studio](https://github.com/OpenAEC-Foundation/open-pdf-studio) | Tauri + 自有 Rust 引擎 | LGPL-3.0 | 976★ | PDF 编辑/批注能力、打印 | Web 前端，不是原生 GUI；体积大 |
| [rust-pdf-viewer](https://github.com/lailogue/rust-pdf-viewer) | Dioxus + pdfium-render | 未声明 | 40★，2025 停更 | 连续滚动、书签、旋转 | 无许可证，不能直接复用 |
| [tdf](https://github.com/itsjunetime/tdf) / [mcat](https://github.com/Skardyy/mcat) | 终端 PDF 渲染 | MIT/Apache | 2k★/1.4k★ | 终端场景，不适合桌面 | 非 GUI |

### 2.1 miro 细节

- 依赖：`iced = 0.14`（wgpu + tiny-skia 双后端）、`mupdf = 0.8`、`axum`（RPC）、`arboard`（剪贴板）。
- 已实现：连续滚动与 page layout、按视口裁剪的页面缓存、文本复制、正则搜索、注释/评论显示、书签、最近文件、页面总览、PDF 热重载、外部链接。
- 对 Moonlight 的价值：**阅读器交互几乎不用重写**，只需：
  1. 把单文档视图扩成“原文/译文/左右对照”两到三个 pane；
  2. 页缓存 key 增加 versionId；
  3. 用 RPC 或 crate 依赖接 Moonlight 的 Rust 库（论文、批注、翻译任务）；
  4. 顶栏加翻译按钮/进度。
- 代价：AGPL-3.0（与 BabelDOC/PaperQuay 一致，本项目可接受）；MuPDF 首次编译较重；iced 版本升级需要跟。

### 2.2 BarePDF 细节

- workspace：`barepdf-core/pdf/render/thumbnail/ui/platform-*`。
- `barepdf-render` 提供：`MemoryBudget`、`PageCache::get/insert/evict_for`、`RenderScheduler::spawn`；`barepdf-pdf` 提供 PDFium 后端与 glyph 级高亮；`barepdf-thumbnail` 提供缩略图。
- 对 Moonlight 的价值：**渲染层可以整块搬走**，用 Slint 或自绘 UI 做双栏/批注/AI 面板；MIT 许可证比 AGPL 更宽松。
- 代价：阅读器壳要自己写（工具栏、页导航、选择层、双栏同步）；Slint 的软件渲染在超大页面上不如 GPU 后端；社区很小。

### 2.3 为什么不是 egui 从零写

egui 本身性能足够，但 PDF 阅读器真正难的是：页缓存与裁剪、文本层与选择、字形级高亮、缩放锚点、双栏同步、打印/导出。这些在 miro/BarePDF 里已有实现，从零写至少是数周量级，且本机无法验收。

## 3. 与 Moonlight 的集成映射

| Moonlight 能力 | 复用点 |
| --- | --- |
| 原文/译文/对照 | miro 的 `page_layout` + `widget` 拆成多 pane；BarePDF 用 `barepdf-render` 自建 pane |
| 页缓存/缩放 | miro 的 `RenderCacheKey`；BarePDF 的 `PageCache` + `MemoryBudget` |
| 文本选择/高亮 | miro 的 selection 实现；BarePDF 的 PDFium glyph 几何 |
| 批注持久化 | 已有 Rust `annotations` 表；阅读器只负责渲染与命中测试 |
| 翻译任务 | 已有 Rust `start_translate`/BabelDOC 子进程；阅读器订阅 job 事件 |
| 证据跳转 | 已有 `blocks` 表（PDF.js 回传 bbox）；原生阅读器可直接用 PDFium 文本块 |
| 论文库 | 已有 Rust `Library`（SQLite/FTS5）；原生 UI 通过 crate 或 JSONL 调用 |

## 4. 推荐路线（双轨，先证伪再迁移）

### 轨道 A（默认，立即执行）：Electron 阅读器高性能化

不换 GUI，先把已有阅读器做到“大文档不卡”：

1. **虚拟化（已实现）**：`app/src/PdfPane.tsx` 只保留视口 ±1 页的 canvas 与文本层，离开窗口即释放位图；其余页保留占位高度。
2. **分块渲染**：大页按 1024px tile 渲染，缩放只重绘可见 tile；LRU tile 缓存上限按内存预算。
3. **渲染线程**：PDF.js 已用 worker；把 `page.render` 的并发限制为 2，避免主线程抖动。
4. **缩放策略**：滚轮缩放先 CSS transform 即时反馈，200ms 防抖后再按新 scale 重渲染。
5. **文本层按需**：只有进入选择模式或鼠标按下时才构建 text layer；否则仅 canvas。
6. **预取**：空闲时预渲染下一页/下一屏；切换原文/译文复用同一位置锚点。
7. **测量**：20/100/300 页 PDF 的首次可读、滚动帧率、内存峰值，写入 `artifacts/perf/`。

这条轨道不需要新依赖，风险最低，也能直接服务 M1/M2 验收。

### 轨道 B（并行 spike）：原生阅读器

1. 在 Windows 机器上克隆 `miro` 与 `BarePDF`，按锁文件构建。
2. 用同一篇 HybridFlow 测：
   - 150% 缩放连续滚动 10 秒的帧率（目标 ≥55fps）；
   - 文本选择 20 次，选区与字形贴合；
   - 打开 20 页论文的内存峰值（目标 <300MB）；
   - 双 pane 同步（原文/译文同页同位置）。
3. 若 miro 达标：fork，加第二 pane 与翻译任务按钮；RPC 接 Moonlight core。
4. 若 BarePDF 渲染层达标但 UI 不达标：只复用 `barepdf-pdf/render/thumbnail`，UI 用 Slint 自建。
5. 两者都不达标：保留 Electron，记录失败数据，不启动 GUI 重写。

### 决策门槛

| 指标 | 门槛 | 不达标处理 |
| --- | --- | --- |
| 构建 | 干净机器一次构建成功 | 记录依赖/系统库缺口 |
| 滚动 | 150% 缩放 ≥55fps | 保留 Electron |
| 选择 | 20 次选择全部贴合 | 保留 Electron 或换 BarePDF |
| 内存 | 20 页 <300MB，100 页 <800MB | 调整缓存预算后复测 |
| 双栏 | 同页同位置误差 <1 行 | 修同步逻辑后再评 |
| 集成 | 翻译任务/批注/证据跳转可用 | 不迁移 |

## 5. 许可证

- miro：AGPL-3.0；BabelDOC/PaperQuay 已是 AGPL，项目整体按 AGPL 分发时可用。
- BarePDF：MIT，最宽松；其依赖 PDFium 为 BSD-3。
- kkpdf-zed：Apache-2.0 OR GPL-3.0；GPUI 本身 MIT。
- MuPDF：AGPL-3.0（商业授权另计）。
- 按用户要求，本轮不做正式许可证审查，只记录事实；对外分发前需复核。

## 6. 本机为何不能直接给结论

```text
pkg-config x11 xkbcommon wayland-client fontconfig freetype2 gtk+-3.0 → 全部 missing
无 DISPLAY / WAYLAND_DISPLAY；无 sudo；Electron 也因 libatk-1.0 无法启动
```

因此：

- `miro` / `BarePDF` / `kkpdf-zed` 的构建与帧率：**not_run**；
- Electron 界面截图与交互：**not_run**；
- 本文只对源码、依赖、许可证和集成面做事实核对，不把“看起来能跑”写成已通过。

## 7. 下一步

1. 轨道 A 的视口虚拟化已落到 `app/src/PdfPane.tsx`（`tsc`/`vite build` 通过）；下一步做 tile 分块缓存与预取。
2. 在 Windows 机器上执行轨道 B 的 spike，把数据写回本节。
3. spike 通过后再决定是否 fork；在此之前不并行维护两套阅读器。
