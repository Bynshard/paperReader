# UX 打磨规格实施记录（Batch A → B → C）

实施日期 2026-11-21 ｜ 规范来源 [UX_EXPERIENCE_GAP_AND_POLISH_SPEC.md](UX_EXPERIENCE_GAP_AND_POLISH_SPEC.md) ｜ 基线为 Sprint 1/2 已修复后的工作区（含未提交改动）。

本文按规范第 4 节的三批路线记录实际落地内容与验证结果。三个后端/设置子任务由并行子 agent 在互斥文件范围内完成，主 agent 负责 Reader/PdfPane/文献库前端与统一回归。

## 0. 回归结果（全部实际执行）

```text
core:  cargo test --release --locked --offline   → 98 passed; 0 failed; 4 ignored
app:   tsc --noEmit                              → 0 error
app:   vitest run                                → 17 files / 103 tests passed
app:   node tests/run-node-tests.cjs             → 57 tests, 0 failed
app:   npm run build                             → ✓ built
```

## 1. Batch A：止血与通信闭环（P0）

| 项目 | 实施 |
| --- | --- |
| UX-BUG-01 未翻译无法单页试译 | `Reader.tsx` 的「翻译选项」箭头不再受 `translated` 门控；菜单固定提供「只翻译当前页 / 翻译指定页码范围…（`1-5, 8` 校验与页码上限）/ 翻译全文」 |
| UX-BUG-02 框选粘滞锁死滚动 | 单击「框选」= 单次框选，`onAreaSelect` 后自动回到 `select` 恢复单指滚动；双击（260ms 内）= 锁定「连续框选」，按钮显示锁图标；Esc 退出 |
| UX-BUG-03 划词劫持 AI Tab / 污染历史 | 新增 `quickResult` 就地气泡（`FloatingLayer`）：翻译走 `translate_text`、解释走 `explain {ephemeral:true}`（后端 `persist=false`，不写 `chats`），支持流式 `ai_delta`；提供复制 / 存入高亮批注 / 转入深聊 |
| UX-BUG-04 只读“迁入笔记” | 各 Tab 与元数据阅读页均改为「整篇阅读笔记」Markdown 编辑器，600ms 防抖 `update_paper({notes})`，显示保存中/已保存/失败，卸载时冲刷未保存草稿 |
| §2.1–2.5 接线核对 | HTTP 桥、Range URL、HTTP 只读池、12MP 预算、`include_history` 已在上一轮完成；本轮补 `get_paper / list_annotations / list_taxonomy / ai_history` 走 HTTP 只读池 |
| §3.6.1 AI 设置 | `AiSettings.tsx` 正名「AI 阅读助手」；`provider=api` 时隐藏 Codex 登录/额度，显示复用 Base URL 与翻译模型，并提供「问答专用模型」覆盖；后端 `x-moonlight-model` 头使 loopback gateway 按请求切换模型，翻译模型不变 |

## 2. Batch B：核心读写与整理工作流（P1）

| 项目 | 实施 |
| --- | --- |
| §3.2.1 Multi-Tab | `App.tsx` 改为 `tabs[] + activeTabId` 工作区；最多 5 个 Reader 常驻（LRU 淘汰），`display:none` 保活；顶部 38px 横向标签栏、关闭按钮、中键关闭、`Ctrl+W` 关闭、`Ctrl+Tab` 切换；从搜索/任务中心 `open(paper,{page,query})` 直达 |
| §3.1.1 Venue/CCF | 新增 `venueTier.ts` 离线字典（CCF-A/B、顶刊、ICLR 顶会），`PaperTable` 新增「期刊 / 会议」列与徽章，卡片视图同步显示；无网络请求 |
| §3.1.2 目录/标签交互 | 目录行支持拖入论文（`application/x-moonlight-paper-ids`，选中多篇则批量拖出）、右键菜单（新建子目录/重命名/移至根目录/删除）、论文数角标；标签支持拖入、真实颜色圆点、数量角标、右键（重命名/循环换色/删除）；`taxonomy` RPC 返回未进回收站的 `paper_count` |
| §3.1.3 导入后静默补全 | `App.tsx` 对 `status=imported` 且带 DOI/arXiv、venue/year/abstract 缺失的论文并发度 2 调 `refresh_metadata`，完成后轻提示并刷新 |
| §3.1.4 搜索片段直达 | `search.rs` 为带 query 的分页结果附加 `match_snippet {page,text,version_id}`（LIKE 转义、±80 字符、换行折叠）；表格/卡片显示高亮片段与 `p.N 直达`，Reader 以 `initialPage/initialSearch` 定位并预填文内查找 |
| §3.1.5 键盘流 | 表格容器可聚焦：`↑/↓` 移动 inspectedId 并 `scrollToIndex`，`Enter` 打开；Shift+Click 复选范围选择 |
| §3.5 笔记闭环 | 精读模板、光标处插入 `[p.X]`、预览/编辑切换、语义颜色筛选（全部/核心结论/方法与公式/实验与数据/存疑与局限）、批注就地编辑、按颜色分组导出完整 `.md` |

## 3. Batch C：旗舰阅读体验（P2）

| 项目 | 实施 |
| --- | --- |
| §3.2.2 Smart Hover / Pinned Portal | PDF 内部链接点击不再直接跳走：按点击位置弹出目标页区域预览（`PdfPane.renderRegion` 离屏裁剪），可「📌 钉在角落对照」（可拖动常驻小窗）或「↗ 跳转」 |
| §3.3.1 真实翻译进度 | `engine.rs` 解析 BabelDOC 的百分比/`n/m 页`、ANSI 清理、1s 节流、只增不减，推送 `{progress,detail,elapsed_ms}`；Reader `.jobbar` 显示数值进度、detail、`已用时 m:ss` |
| §3.3.2 双栏拖动 | `splitRatio` 28%–72%、PointerEvent 拖动、双击复位 50%、`localStorage` 持久化；平板触控热区加宽 |
| §3.4.1 一页纸导读 | `papers.digest_json`（Schema v4 迁移）+ `ai_digest` RPC 缓存；Reader 侧栏展示 5 段 Markdown 导读，`[p.X]` 转为可点击页码，支持强制重新生成；缓存命中不调用模型 |
| §3.4.2 触控 Prompt 胶囊 | 选区按公式/实验表格/英文长句特征显示 1–2 个胶囊（解释公式符号、推导逻辑、提炼实验对比、精简释义），点击即问 |
| §3.4.3 多模态识图 | `PdfPane` 框选时从渲染 canvas 裁剪 ≤1280px PNG DataURL；工具条提供「AI 解读图表 / 公式转 LaTeX / 表格抽 Markdown」；`explain` 支持 `image_data_url`，后端组装 OpenAI Vision content blocks 并校验 scheme/8MB |
| §3.5.3 跨页选区 | `PdfPane` 允许相邻两页文本选区，输出 `extraSlices`；保存时按页写入关联批注，提示「已保存跨页划线」 |
| §3.6.2 扫码即连 | 新增 `lan-service.cjs`（持久化 enabled/port、IPv4 枚举、过滤 loopback/虚拟网卡）、`lan:info`/`lan:configure` IPC、Settings 第 6 个 Tab「平板伴读」；展示每个局域网配对 URL、复制、离线 SVG 二维码（MIT QR 编码器移植，零外部请求）、PWA 提示；开关重启生效 |

## 4. 并行实施与文件归属

| 子任务 | 负责 agent | 独占文件 |
| --- | --- | --- |
| BabelDOC 进度 | `progress-backend` | `core/src/engine.rs` |
| 导读缓存 + Vision 后端 | `digest-vision-backend` | `core/src/library.rs`、`core/src/ai.rs`、`core/src/main.rs` |
| 平板配对 + QR | `pairing-ui` | `app/electron/main.cjs`、`preload.cjs`、`lan-service.cjs`、`SettingsModal.tsx`、`LanPairing.tsx`、`app/src/qr/`、相关测试 |
| 其余 UX/前端 | 主 agent | `Reader.tsx`、`PdfPane.tsx`、`api.ts`、`types.ts`、`App.tsx`、`Library.tsx`、`PaperTable.tsx`、`FolderTree.tsx`、`TaxonomyList.tsx`、`AiSettings.tsx`、`MarkdownAnswer.tsx`、`styles.css`、`search.rs` 等 |

新增测试：`api.test.tsx`、`AiSettings.test.tsx`、`venueTier.test.tsx`、`taxonomy.test.tsx`、`LanPairing.test.tsx`、`lan-service.test.cjs`，以及 Reader/Library/App/PdfPane 的批量新增用例。

## 6. Review 复审后的 5 个缺陷修复（同日）

第二轮交叉审查发现并修复了 5 个跨调用链缺陷：

1. **`chat_model` 只在 aiAction 内生效**：新增持久化 `app_settings`（Schema v5）与 `set_chat_model` RPC；`explain` / `ai_digest` 的模型优先级改为「显式 params.model → `lib.chat_model()` → 网关模型」。`ai-service.cjs` 在 load/configure 后镜像到 sidecar；Codex 路径支持 `ephemeral` 不落库，并对 `image_data_url` 给出「请切换 API 问答服务」的明确错误。桌面/平板/划词/导读现在共享同一问答模型。
2. **后台 Multi-Tab 仍响应全局快捷键**：`App` 传入 `active`，`Reader` 在非激活 Tab 不绑定全局 keydown，避免多篇论文一起翻页/缩放或拦截论文库按键。
3. **笔记草稿覆盖外部追加 + 预览页码不可点**：`paper.notes` 外部变化时仅在无未保存草稿时同步；`saveAnswer` 先冲刷草稿再 `append_note`，杜绝 600ms 自动保存覆盖 AI 追加；笔记预览也对 `[p.X]` 绑定跳页。
4. **纯译文模式引用预览空白 + 缩略图缓存不刷新**：`openInternalPreview` 按点击侧优先用 `transApi/sourceApi` 并互为 fallback；`PdfPane` 缩略图缓存依赖从 `[bytes]` 改为 `[bytes,url]`，切换附件/译文不再显示旧缩略图。
5. **`p.X 直达` 被 FindBar 跳回第 1 页 + 导读云同步冲突**：`FindBar` 在 PaneApi 未就绪时短暂重试，并在首次 `land` 时优先选中 `preferredPage` 上的命中；`sync_model` 新增 `unify_digest`，按 `generated_at` 取较新导读，派生缓存不再产生同步冲突。

新增回归：Reader 的 active/笔记同步/预览/译文侧预览、FindBar 3 项、digest 同步 2 项、chat_model 持久化与 RPC 集成、Codex ephemeral/vision 拒绝等。

## 7. 打包与中文搜索收尾（同日）

- **正式包静态目录**：`package.mjs` 改为 `asar: { unpackDir: "dist" }`，并用 `@electron/asar` 实测生成 `app.asar.unpacked/dist`（asar 内仍可读）；`main.cjs` 的 `staticDistDir()` 首选 `resources/app.asar.unpacked/dist`。打包版 `moonlight-core --static` 现在能读到前端，平板扫码不再 404。实际执行 `node electron/package.mjs linux` 后，用包内 `moonlight-core --serve --static .../app.asar.unpacked/dist` 启动，`/` 返回 200 且含 `#root`，`/manifest.webmanifest` 返回 `application/manifest+json`。
- **中文命中自动查译文侧**：全文命中携带 `match_snippet.version_id`，`Reader` 新增 `initialVersionId`；当命中版本属于译文，或搜索词含中文且存在译文时，初始 `mode=dual`、`activeSide=translated`，并在该译文版本上直接打开 FindBar，避免在英文原文里搜中文显示“无匹配”。

## 8. 已知限制

- **未做真机 / Electron GUI 验证**：本机缺 `libatk` 等 Chromium/Electron 运行库，无法启动真实窗口；所有验证为 Rust/TS/Vitest/Node 与 HTTP 冒烟。真机需重点复核 `moonlight-pdf://` Range、触控框选/双指、扫码配对。
- **打包版静态资源**：已用 `asar.unpackDir` + `app.asar.unpacked/dist` 修复并在 `@electron/asar` 层验证；仍建议在真实 Windows 安装包上启动一次确认 `staticDistDir()` 命中。
- **服务开关重启生效**：`--serve` 在 sidecar 启动时固定，设置页保存后需重启应用；配对 token 每次启动轮换，需重新扫码。
- **导读/多模态依赖 API 网关**：只用 Codex 账号且未配置翻译 API 时，`ai_digest` 与 Vision 会返回可操作的“请配置 API”错误；Codex 路径未接入视觉。
- **跨页批注**：首尾页各写一条关联批注（quote/comment 相同），不是单条多页记录；跨 3 页以上仅保留首尾页片段。
- **目录计数**为直属论文数（不含子目录汇总）；与标题“包含子目录论文”的检索行为不同。
