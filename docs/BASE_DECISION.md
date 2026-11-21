# 桌面底座决策记录

> 日期：2026-11-02 · 适用提交：`~/paperReader` 当前工作树（HEAD `744431d` 之后）
> 本文补上设计文档要求的“底座选择证据”。结论：**采用最小 Electron + React + PDF.js + Rust sidecar 路线**，不 fork PaperQuay，也不整体采用 NeoRead。

## 1. 候选与实测

| 候选 | 核对 | 结果 | 阻断/代价 |
| --- | --- | --- | --- |
| PaperQuay | `1d65fdbfe0eb`，Node 22.14，`npm ci` 621 包，`npm run build` 2.45 s | **可构建**（Web/TS 层） | Electron 42 运行时依赖 `libatk-1.0`；本机无该库，GUI 未启动。接入 BabelDOC 需新增译文版本实体、sidecar 任务、双 PDF 阅读模式，改动面集中在 1.3 万行后端与 2.6 MB 前端 |
| NeoRead | `f93168232958`（0.9.5） | 仅源码评估 | 需要 Go + pnpm + Electron 工具链；Go/pnpm 本机缺失，未构建。技术栈为 Go server + pnpm monorepo + React 19 + Electron，迁移到本项目等于再建一套后端 |
| 最小 Electron 方案 | 本仓库 `app/` + `core/` | **已实现并持续集成**：Rust 20 项测试、React 27 项、Node 20 项；Windows CI #6 通过真实包启动/PDF/OCR；10,000 PDF 性能基准完成 | 需要自己维护阅读器与论文库，但代码面可控 |

## 2. 决策

选择**最小 Electron + React + PDF.js + Rust sidecar**：

- 保留已验收能力：PDF.js 渲染、TanStack 虚拟列表、SQLite/FTS5、Tesseract 离线 OCR、rclone 同步、BabelDOC 全文翻译。
- Rust 核心持有论文库、任务、搜索、Zotero 迁移、AI 编排；渲染进程无 Node/文件权限，凭据不进 renderer。
- 不 fork PaperQuay：它的构建通过不等于整合成本低；要接入“原文/译文同一条目 + 双 PDF 对照 + 翻译版本”需要改动其数据模型与阅读器，且会与现有已验收实现形成两套论文库。
- 不整体采用 NeoRead：Go 后端 + pnpm 前端 + Electron 的组合会重建已有能力，且本机无法完成构建验证。

这不是“PaperQuay 不可用”的结论。若后续需要它的笔记/知识图谱能力，可按模块评估复用，不整体替换底座。

## 3. 证据

- 构建：`work/PaperQuay` 的 `npm ci` / `npm run build` 日志（2026-10-31）。
- 本仓库：`docs/ACCEPTANCE_20261101.md`（14 个 Electron 流程、真实 OCR、万篇性能）、Windows CI #6、`docs/PRODUCT_READINESS.md`。
- 翻译：`artifacts/validation/m0-20261031T1005/`（真实 BabelDOC 输出与门禁）。
- 原生 GUI 复用评估：`docs/RUST_GUI_REUSE.md`（miro/BarePDF，留作后续阅读器升级）。

## 4. 复核触发条件

出现以下情况时重新评估底座：

1. 现有阅读器在真实论文上出现无法在可控改动内修复的渲染/选择缺陷；
2. 论文库/笔记模型需要 PaperQuay 已有的大规模能力（知识图谱、Zotero 双向）；
3. 原生阅读器 spike（miro/BarePDF）在目标 Windows 机器上达到 55fps、选择准确、内存达标，且集成成本低于继续维护 PDF.js 路线。

## 5. 附：与设计文档的偏差

设计文档把“fork PaperQuay”列为首选。本实现改用备用路线，原因不是构建失败，而是：整合改动面大于从零建立同一组核心流程；且备用路线已在 Windows CI、OCR、同步、万篇性能上形成可复核证据。按设计文档“记录切换路线的具体原因与证据”的要求，在此留档。
