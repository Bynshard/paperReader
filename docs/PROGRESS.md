# Moonlight 实施进度

> **2026-11-01 云同步增补**：接入 rclone 的七牛、OSS、WebDAV/S3 后端；加入后台同步、增量文档日志、附件哈希缓存、冲突选择、失败重试、本机凭据加密及坚果云分目录/限速。详见 [云同步](CLOUD_SYNC.md)。本地协议已测，真实云账号、GUI、系统密钥库与跨平台安装包仍待验收。

> **2026-11-01 Zotero 迁移增补**：改用 SQLite 一致快照、来源/库/key 关联、多附件复制、批注幂等、批事务及逐条失败回滚。补齐外链目录、缺失报告、迁入笔记、多 PDF 阅读和无 PDF 条目界面。详见 [Zotero 迁移兼容性](ZOTERO.md)。用户确认本机无真实旧库，真实库与 GUI 尚待验收。

> **2026-11-01 修复增补**：阅读同步、译文批注归属、零基页码、取消任务已修复；加入 SQLite 分页/索引和 TanStack 虚拟渲染。前端 10 项、Rust 8 项及真实 PDF 协议冒烟通过，完成十万条记录查询基准。详见 [修复与性能验证](PERFORMANCE.md)。以下保留 10 月 31 日翻译验证快照，GUI 和翻译人工复核仍未验收。

> 快照时间：2026-10-31 18:35（Asia/Shanghai） · 代码位置：`~/themoonlight`
> 状态：**M0 真实译文与证据已产出，自动门禁首轮未通过（原因可定位）；桌面端已迁移到 Rust 核心，GUI 在本机无法启动（缺系统库）**。

## 1. 一句话结论

两篇核心论文的真实整篇译文已经跑出来（15 页 + 19 页），双栏、段位、公式与图注基本保留，方向与参考图一致；首轮自动覆盖率只有 0.701 / 0.801；把参考文献续行、作者/单位、图内标签、脚注等不属于正文的区域从分母中剔除后（标注 v3），覆盖率为 **0.945**，仍差目标 0.95。逐块检查后确认剩余失败集中在公式/图内文字、算法伪代码和 2 个字号块，不是整段漏译。因此现在仍不能声称 M0 通过。

桌面端按新要求把后端从 Python 迁到 **Rust**：`core/` 可编译出 11.7 MB 的单文件 sidecar，已验证导入、查重、列表和一次真实翻译任务（含译文版本落库）。Electron + React 前端可构建，但本机缺 `libatk-1.0` 等 GUI 运行库且无 sudo，**界面验收目前是 not_run**。

## 2. 已完成

### 2.1 语料冻结

| 样本 | 版本/来源 | 页数 | 选定页 | SHA256（前 16） |
| --- | --- | --- | --- | --- |
| Attention Is All You Need | arXiv:1706.03762，Wayback 2024-06 快照 | 15 | 1,2,3,4,7,11 | `bdfaa68d8984f0dc` |
| HybridFlow | arXiv:2409.19256，Wayback 2026-10 快照 | 19 | 1,2,3,5,8,18 | `4807a008bdea448c` |

两个文件都重新校验过 SHA256，与 `corpus/corpus.json` 一致。语料清单还包含逐页几何、字体、栏位、公式比例和 v1 块级标注。

### 2.2 M0 真实翻译（已跑通）

- 引擎：BabelDOC 0.6.2（Python 3.11.15 venv），模型 `qwen3.8-flash`，OpenCode Go 端点。
- 网关：本地回环代理，注入 `x-opencode-session`，把 BabelDOC 的 `reasoning:{effort}` 改写为 `reasoning_effort`，日志不记录密钥与正文。
- 关键修复：禁用推理后单页从 **211 s 降到 19 s**（约 10–20 倍），否则 34 页需要数小时。

| 样本 | 输出 | 页数 | 耗时 | 输出 SHA256 | 请求/tokens |
| --- | --- | --- | --- | --- | --- |
| attn | `.../arxiv-1706.03762/attn.no_watermark.zh-CN.mono.pdf` | 15（1:1） | 131.3 s | `dff22dd667abd66f…` | 84 请求 / 71.5k in / 23.2k out |
| hybridflow | `.../arxiv-2409.19256/hybridflow.no_watermark.zh-CN.mono.pdf` | 19（1:1） | 284.1 s | `6dcbc23d01e0ec49…` | 351 请求 / 305k in / 91k out |

输出保留原页尺寸/旋转/页序；未选页在范围任务里保留原文。个别页面存在排版瑕疵（作者栏换行、少数行居中），已记录，进入人工复核清单。

### 2.3 证据目录

`artifacts/validation/m0-20261031T1005/`：

```text
report.md              # 自动生成报告（status: fail，含门禁与逐页表）
environment.json       # 硬件、系统、Python/Node、引擎、模型（不含凭据）
corpus.json            # 冻结语料与标注
dependency-lock/       # pip freeze --all、distributions.json、versions.json
metrics.json           # 首轮自动指标与门禁
review.csv             # 386 行块级审查表（人工列留空）
runs.jsonl             # 每次翻译运行记录与用量
edge-cases.json        # 4 个边界样本结果
range-probes.json      # 3 个页范围映射实验
logs/                  # BabelDOC 与 CLI 日志（脱敏）
outputs/               # 7 个 PDF：2 整篇 + 4 边界 + 3 范围（含未选页）
screenshots/           # 72 张：12 个核心页的原文/译文/并排/局部裁图
failures/              # 被拒绝或失败的输入
```

### 2.4 首轮自动门禁（真实结果，未修改阈值）

| 门禁 | 结果 | 数值 | 判断 |
| --- | --- | --- | --- |
| 文档几何 | pass | 页数/尺寸/旋转全部一致 | 真 |
| 正文覆盖 | **fail** | 总 0.945；attn 0.943，HF 0.947 | 标注 v3 后的真实分母；差 0.005 |
| 段落起始偏差 ≤3% | **fail** | 0.855（attn 0.960，HF 0.855） | 误差集中在图内文字/算法块/元数据 |
| 字号可读 | **fail** | attn 1.0，HF 0.984 | HF 第 1 页 2 块缩到 7.97pt |
| 回退透明 | pass | 保留/失败区域都有原因 | 真 |
| 边界样本 | pass | 见 §2.5 | 真 |
| 页范围映射 | pass | 3/3 实验 1:1 页号且只译请求页 | 真 |
| 公式/数值、语义、严重版面 | not_run | — | 人工审查未完成 |

三版口径与 v1/v2/v3 对比见 `artifacts/validation/m0-20261031T1005/annotation-changes.md`。v1 的分母（328 块）保留不改，v3 的分母（184 块）只剔除设计文档明确列为“单独列出”的区域：作者/单位、参考文献、图内文字、脚注/页眉页脚、公式编号。判定规则也修正为“CJK 字数相对源块”而不是字母比，避免把“中文正文 + 保留英文人名”误判为未译。

### 2.5 边界样本真实结果

| 样本 | 结果 | 证据 |
| --- | --- | --- |
| `rotated-cropbox.pdf` | completed | 输出页 692×540、旋转 90，几何一致，有中文文字层 |
| `narrow-column.pdf` | completed | 窄栏内中文 170 字，无越界/串栏 |
| `scanned-page.pdf` | unsupported | 引擎识别为扫描页，未伪造译文 |
| `encrypted.pdf` | rejected | 明确“需要密码”，不崩溃 |
| `corrupt.pdf` | rejected | 缺少 `%PDF`/`%%EOF`，明确拒绝 |

### 2.6 页范围映射实测

| 实验 | 请求页 | 输出页数 | 实际翻译页 | 结论 |
| --- | --- | --- | --- | --- |
| middle-page | 5 | 15 | 5 | 1:1，未选页保留原文 |
| non-contiguous | 3,9 | 15 | 3,9 | 页序不乱 |
| first-page | 1 | 15 | 1 | 无 off-by-one |

### 2.7 桌面底座评估

| 候选 | 核对提交 | 构建结果 | 结论 |
| --- | --- | --- | --- |
| PaperQuay | `1d65fdbfe0eb…` | Node 22.14 下 `npm ci`（621 包）+ `npm run build` 通过（2.45 s） | 可构建；Electron 42 运行时依赖 `libatk-1.0`，本机缺失，GUI 未启动 |
| NeoRead | `f93168232958…`（0.9.5） | 未构建：本机无 Go、pnpm，且同样是 Electron 桌面 | 仅源码级评估：Go server + pnpm monorepo + React 19 + Electron |
| 最小备用方案 | 本仓库 `app/` | Vite 构建通过；Electron 同样受限本机库 | 作为可控实现保留 |

PaperQuay 的论文库/阅读器/笔记代码量约 1.3 万行后端 + 2.6 MB 前端；接入 BabelDOC 需要新增“译文版本”实体、sidecar 任务与双 PDF 阅读模式。具体改动面已记录，尚未开工 fork。

### 2.8 Rust 核心（本轮新增，已可运行）

`core/`（Cargo，release 11.7 MB）：

- `library.rs`：SQLite（rusqlite bundled + FTS5）、导入/查重、元数据、分类/标签、批注、回收站、BibTeX/RIS、版本与任务表。
- `pdfmeta.rs`：lopdf + pdf-extract，标题/作者/年份/DOI/arXiv/摘要启发式；已用两篇论文实测，attn 得到 8 位作者、2017、arXiv:1706.03762。
- `engine.rs`：回环模型网关（token 鉴权、会话头、reasoning 映射、用量日志）；BabelDOC 子进程、阶段事件、取消（SIGTERM 进程组）、产物原子落库。
- `ai.rs`：证据检索（页/块/关键词）与带 `[n]` 引用的回答、划词翻译。
- `main.rs`：JSONL 协议（`ping/import_pdfs/list_papers/.../start_translate/set_blocks/explain`）。

已验证：导入 PDF → 查重 → 列表 → `start_translate`（第 1 页）→ 任务 `parsing/typesetting/validating/completed` → 译文版本写入并可在 `get_paper` 中看到；`explain` 真实调用模型返回带 `[1]..[8]` 引用的中文回答与 8 条证据；`translate_text` 返回中文译文。取消、备份恢复、`set_blocks`（PDF.js 几何回传）尚未端到端测试。

### 2.9 Electron + React 界面

`app/`：Vite + React 18 + PDF.js 4.8。

- 论文库：导入、搜索、星标、分类/标签、回收站、导出。
- 阅读器：原文/译文/左右对照、页码、缩放、位置记忆、逐页翻译/全文翻译、进度与取消。
- 批注：选区高亮/笔记，按页持久化；对照模式双向翻页同步。
- 阅读助手：总结本页、解释/翻译选区、提问，回答带可跳转的原文证据。
- 安全：`contextIsolation`、`sandbox`、无 Node 集成；文件路径只由 Rust/Python sidecar 解析；外部导航拒绝。

`tsc --noEmit` 与 `vite build` 均通过。本轮把 PDF 渲染改成**视口虚拟化**：只保留当前视口 ±1 页的 canvas 与文本层，离开窗口的页释放位图（`canvas.width=1`），翻页/缩放时按需重渲染；大文档不再一次性分配全部页位图。`electron` 二进制已下载，但启动报 `libatk-1.0.so.0: cannot open shared object file`，因此**界面截图、交互与安装包验收 = not_run**。

### 2.10 Zotero 兼容（本轮新增，数据库迁移已实测）

`core/src/zotero.rs`：

- 两种来源：直接读 `zotero.sqlite`（复制 `-wal/-shm` 到临时快照后只读打开，Zotero 运行中也可读），或 Zotero 7 本地 API `127.0.0.1:23119/api/users/0`。
- 迁移：分类树 → 分类（完整路径命名）、标签、作者、年份、DOI/arXiv、摘要、PDF 附件（复制/链接）、子笔记、highlight 批注（页码 + 归一化矩形 + 颜色 + 评论）。
- 幂等与去重：`zotero_map(item_key)`；顺序为 Zotero key → DOI → 文件 SHA256；重复导入只更新，不新增论文。
- 不写 Zotero、不移动/删除原文件；缺 PDF 的条目仍入库并标记 `imported_without_pdf`。
- 实测（`work/make_zotero_fixture.py` 生成的 Zotero 形状库）：2 条论文、1 个附件、三级分类、3 个标签、1 条笔记、1 条批注；结果 `imported=2, without_pdf=1, annotations=1, errors=[]`，第二次导入走 `updated`。
- 本地 API 路径已实现（分页 items → children → file），本机无 Zotero，标 `not_run`。

详见 [Zotero 兼容与迁移](ZOTERO.md)。

### 2.11 原生 GUI 复用调研（本轮新增）

结论：**不要从零写 Rust GUI + PDF 阅读器**。可复用项目已经覆盖渲染、页缓存、文本选择、高亮、搜索、缩略图：

| 候选 | 栈/许可 | 复用价值 | 风险 |
| --- | --- | --- | --- |
| miro（554★） | iced 0.14 + MuPDF，AGPL-3.0 | 完整阅读器交互：连续滚动、文本复制、搜索、标注、书签、总览、RPC | MuPDF 编译重；需扩双 pane |
| BarePDF（MIT） | Slint 1.9 + PDFium，模块化 crate | `barepdf-pdf/render/thumbnail`：内存预算、LRU 页缓存、调度器、字形高亮 | 阅读器壳需自建；社区小 |
| kkpdf-zed | GPUI + PDFium，Apache/GPL | PDF 引擎、栅格化、缓存 | 绑定未稳定的 GPUI |
| pdfium-render（717★） | Rust 绑定 | 底层渲染/文本/注释 | 不含 UI |

本机没有 X11/xkbcommon/fontconfig/GTK 开发库，也没有显示服务，iced/Slint/GPUI 均无法编译或验收，因此“构建 + 帧率”结论全部是 `not_run`。建议双轨：

- **轨道 A（默认）**：保留 Electron + React + PDF.js，先把阅读器做成虚拟化 + 分块缓存 + 预取的高性能版本；
- **轨道 B（Windows spike）**：构建 miro/BarePDF，用同一篇 HybridFlow 测 150% 滚动帧率、文本选择、20 页内存、双栏同步；达标再迁移。

详见 [Rust 原生阅读器复用评估](RUST_GUI_REUSE.md)。

## 3. 关键决策与偏差

1. **按用户要求把核心迁到 Rust**，保留 Electron/React 壳：本机无 GTK/WebKit 开发库且无 root，Tauri/Qt 路线不可行；纯 Rust GUI（egui）需要重写 PDF 渲染与阅读器，风险更高。
2. **BabelDOC 仍是唯一的翻译内核**（设计文档要求兼容 BabelDOC）。Rust 只替换论文库、任务、网关与 AI 编排，不重写版面引擎。
3. **模型凭据只存在于 sidecar 环境/网关**，不进入 renderer、argv、报告或日志。
4. **标注 v2 是“修正分母”而不是“降低阈值”**：参考文献续行/作者信息/图内标签本来就不属于应译正文。规则先写死并留档，重算时同时保留 v1。

## 4. 当前阻塞

| 阻塞 | 影响 | 处理 |
| --- | --- | --- |
| 本机缺 `libatk-1.0`/GTK，Electron 无法启动 | GUI 截图、点击验收、安装包 | 在有桌面的机器验收；或申请安装 `libatk1.0-0` 等运行库 |
| 人工审查未做 | 公式/语义/严重版面门禁 | 12 页截图已就绪，按清单复核并填 `review.csv` |
| v2 标注未重算 | 覆盖率/字号仍显示 fail | 运行 `moonlight.reannotate` + `run-m0 --reuse` |
| BabelDOC stdout 被 rich 缓冲 | 任务阶段只有粗粒度进度 | 适配层按文件/事件补充进度；不伪造百分比 |
| NeoRead 工具链缺失 | 底座对比不完整 | 记录为 not_run，不据此下结论 |

## 5. 下一步（按优先级）

1. 已执行标注 v3 并重算（复用现有 PDF，不重译）：覆盖率 0.945、起始偏差 0.855、字号 0.984；下一步只做 attn p4 / HF p18 的引擎参数实验，不再改分母。
2. 对 12 个核心页做视觉复核（已有并排图），填 `review.csv` 的 `layout_ok`，抽样 50 段做语义初审。
3. Rust 核心补齐 end-to-end 测试：`set_blocks`（PDF.js 几何回传）、AI 问答证据跳转、取消、备份恢复。
4. 在带桌面的环境跑 Electron 冒烟与截图；确认 `app` 能否作为 M1 基线。
5. 依据 PaperQuay / NeoRead / 最小方案的实测，写下底座决策记录，再进入 M1 完整流程。
6. Zotero：在真实库上跑迁移（含群组库/大库），补 UI 的“迁移预览 + 分类勾选”。
7. 原生 GUI：按 `docs/RUST_GUI_REUSE.md` 在 Windows 上做 miro/BarePDF spike，先测再决定是否 fork。

## 6. 复现命令

```bash
cd ~/themoonlight
. ~/.config/moonlight/model.env         # MOONLIGHT_UPSTREAM_KEY / MOONLIGHT_MODEL
export MOONLIGHT_UPSTREAM_KEY

# 冻结语料（已执行，输入 PDF 在 corpus/raw）
.venv/bin/python -m moonlight freeze --spec corpus/corpus.spec.json --out corpus/corpus.json

# 真实整篇翻译（已执行）
.venv/bin/python -m moonlight translate --pdf corpus/raw/attn.pdf \
  --out artifacts/validation/m0-20261031T1005/outputs/arxiv-1706.03762 --model qwen3.8-flash --qps 8

# 复用已有 PDF 重算指标 / 边界样本 / 页范围
.venv/bin/python -m moonlight run-m0 --corpus corpus/corpus.json \
  --out artifacts/validation --run-id m0-20261031T1005 --reuse --allow-not-run

# Rust 核心
cd core && cargo build --release
./target/release/moonlight-core --root /tmp/mlib

# 桌面前端构建
cd ../app && PATH=$HOME/.local/node22/bin:$PATH npm run build
```

## 7. 产物与代码位置

| 内容 | 路径 |
| --- | --- |
| M0 证据 | `artifacts/validation/m0-20261031T1005/` |
| 原始译文 PDF | `artifacts/validation/m0-20261031T1005/outputs/*/*.mono.pdf` |
| 并排截图 | `artifacts/validation/m0-20261031T1005/screenshots/*-side-by-side.png` |
| Python 验证工具链 | `moonlight/` |
| Rust 桌面核心 | `core/` |
| Electron/React 界面 | `app/` |
| 底座源码 | `work/PaperQuay`、`work/NeoRead` |
| 设计/验证文档 | `docs/DESIGN.md`、`docs/VALIDATION.md`、`docs/PROGRESS.md` |
| Zotero 兼容 | `core/src/zotero.rs`、`docs/ZOTERO.md`、`work/make_zotero_fixture.py` |
| 原生 GUI 评估 | `docs/RUST_GUI_REUSE.md` |

## 8. 状态口径

- `pass`：有可复核证据且达到阈值。
- `fail`：已测且未达标，保留分母与失败样本。
- `not_run`：本机条件不具备（GUI、人工语义、NeoRead 构建），不折算成通过。
- 版权/许可证审查按用户要求暂缓，不作为本轮门槛；来源与提交仍记录在 `docs/sources.json`。

## 9. 万篇库与实际浏览器验收

2026-11-01 已补齐独立的万份 PDF 导入、40 万余正文块、分类/标签/批注、并发负载和真实 Chromium/PDF.js 测试，见 [结果](SCALE_RESULTS.md) 与 [复现说明](SCALE_TESTING.md)。修复了长任务阻塞、逐块全库扫描更新、标题解码和高倍缩放画布分配问题。当前仍有高命中率全文搜索超过 200ms P95 目标，不能把本轮验收写成成熟发行版通过；Electron 完整桌面及安装包仍待验收。

## 10. Codex 登录与 AI 对话

2026-11-01 已实现独立网页登录入口、官方 App Server 真实调用、运行时模型与额度展示、流式问答/总结/选段翻译、取消与本地历史。真实固定文本调用成功；Electron + Rust + PDF.js 联合测试采用模拟认证完成与模型，未人工执行新登录。具体用法、证据与权限边界见 [CODEX.md](CODEX.md)。

## 11. 可靠性、管理与发布验收

2026-11-01 已完成导入/译文发布事务、删除与任务状态修复，补齐资料/分类/标签/笔记编辑、全局翻译任务中心、AI 回答保存导出、完整备份与恢复到新库。Linux x64 真实发布包在源码目录之外解压运行，通过管理、模拟 AI、翻译重试、旧结构升级与备份恢复流程。万篇首屏 P95 4.11ms；高命中全文检索仍为 463.31ms，超过 200ms 门槛，因此仍定位预发布。详见 [验收记录](RELEASE_VALIDATION.md)。

## 12. 仅 Windows 的 GitHub CI 配置

2026-11-01 按用户要求停止本地构建，替换 Linux CI 为 Windows Server 2025 原生构建：push/PR/手动触发，测试、核心编译、官方运行时校验、ZIP 检查、发布包启动检查后上传带运行编号的 artifact。包内集成官方 Codex App Server，Windows 不依赖 npm .cmd。当前仅配置，用户稍后关联仓库；远端构建与实际 Windows 验证尚未执行。详见 [Windows 测试说明](WINDOWS_TESTING.md)。

## 本地待验收：翻译配置与扫描页阅读

补上翻译 API 配置界面及加密保存、原位翻译引擎路径，扫描页 OCR 与文字层、索引复用、顺序解析与取消、问答上下文范围/预览/覆盖提示、当前版本历史隔离。详情见 `docs/CODEX.md` 的“本地待验收改进”。已完成 TypeScript 和 JS 静态检查；新 Rust 逻辑未编译，新增测试与 Windows OCR E2E 未执行。按用户要求保留工作区改动，不提交、推送或发布。

## 本地待验收：目录、标签、速记与引用量

新增真实父子目录与虚拟目录树、单篇/批量归类和标签、一句话速记与搜索、按精确 DOI/arXiv 查询并缓存引用量，以及 SQLite 引用量排序。Zotero 迁移保存真实层级并优化逐篇目录查找，目录同步多条移动保持事务一致。入口和验证边界见 `docs/LIBRARY_ORGANIZATION.md`。当前仅完成类型/差异检查，新增回归用例未执行，Rust/Windows/实际计数待验收；未提交或推送。


## 2026-11-01 本地验收更新

已按用户要求运行完整本地检查链：Rust 20 项、React 27 项、Node 17 项通过，release 核心和生产前端构建通过；真实 Electron 14 个步骤通过，覆盖目录/标签/速记/列宽、Markdown、离线 OCR、纯图片 PDF 自动识别、批注和重启保留。修复了长页后段 AI 证据被截掉的问题，并补测目录层级反转和速记的同步。

万篇库界面首屏 P95 113ms、排序 35ms、PDF 打开绘制 364ms；核心高命中全文检索 P95 491ms，仍超出 200ms 目标，因此不是成熟发行版全项通过。真实引用量接口连接超时，新 Windows 包及系统凭据保存待 CI 验收。此更新取代以上“未编译/未运行新增测试”的历史状态；不改变未提交、未推送、未发布的工作区状态。详见 [验收记录](ACCEPTANCE_20261101.md)。
