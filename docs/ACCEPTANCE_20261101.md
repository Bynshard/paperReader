# 本地验收记录 · 2026-11-01

结论：主要本地工作流通过；性能尚未全部达标，保留预发布定位。本轮未提交、推送或发布。

## 验证范围

真实 Linux Electron 主进程、preload、Rust sidecar、file:// 页面和 PDF.js；临时独立论文库，无用户真实库。模型使用本机 HTTP 模拟响应，整篇翻译使用复制 PDF 的模拟 BabelDOC，仅验证调用、任务和双栏工作流，不代表翻译或模型质量。OCR 使用真实离线 Tesseract/WASM/语言资源，没有替换识别结果。

- Rust：20 项通过，1 项忽略（独立 100k 基准）；生产 release 构建通过。
- React/Vitest：27 项通过；Node：17 项通过；TypeScript 与 Vite 生产构建通过。
- 完整检查链 11 个阶段通过：另含真实 PDF 导入/索引、并发响应、7 项 Zotero 合成库迁移、8 项数据可靠性、故障路径与 AI 证据审计、WebDAV/S3 传输。同步全套最终 8 项通过，新增目录层级反转和速记同步回归。
- 真实桌面 14 个步骤通过，无页面异常：导入、父子目录、批量标签、父目录包含子项、速记保存与搜索、显示列和拖动列宽、星标、翻译配置入口及非法地址校验、PDF 渲染、离线强制 OCR、批注、Markdown 表格和数学公式、模拟 AI 的原文跳转、模拟整篇翻译与双栏、重启保留数据/视图、回收站恢复、纯图片 PDF 自动 OCR 后构建 AI 上下文。（部分步骤包含多个断言。）
- 纯图片 PDF 没有原生文字层，点击“解析当前页”自动 OCR；识别约 6.5 秒，48 个证据片段进入上下文，显示 OCR 提醒。

## 修复

初次测试中，搜索框占位文本改变、Reader 新增 parsePage 后，旧测试未更新；改为稳定的无障碍标签并补全解析接口替身。

AI 检索确有回归：关键词命中的长页仍从页首拼上下文，使页尾证据被截断；常见疑问词也会把不相关页面排到前面。现在优先提供命中片段及相邻行，过滤常见疑问词。增加多页、长前缀、页尾命中的 Rust 回归；实际 RPC 审计中第 1299 个片段的哨兵文本已进入模型请求。全文顺序范围仍按长度截断并明确提示。

## 万篇库性能

复用此前通过真实导入构建的独立磁盘库：9,998 份生成的有效 PDF 加 2 篇真实论文，401,378 个正文块、10,000 条批注、20,000 条标签关联。不是万篇独立收集的真实论文。OS 缓存未清除；测量来自本机 Linux，不代表 Windows 或低配置机器。核心主要场景重复 20 次，导航压力 1,000 次；浏览器用生产构建和真实 Rust，经 loopback HTTP 替代 Electron IPC。

| 场景 | P95 |
|---|---:|
| 核心列表首批 100 篇 | 7.69 ms |
| 核心标题 / 年份 / 引用量排序 | 3.27 / 3.90 / 3.16 ms |
| 核心稀有词正文搜索 | 9.16 ms |
| 核心高命中全文搜索 | **491.32 ms，超过 200 ms 目标** |
| 导入期间交互 RPC | 22.05 ms |
| 界面首屏 | 113.13 ms |
| 界面排序到显示 | 34.82 ms |
| 输入搜索到显示（含防抖） | 297.08 ms |
| PDF 打开到首屏绘制完成 | 364.26 ms |

列表只挂载 15 行；PDF 滚动最多 5 个 canvas，关闭后 DOM 中 0 个残留 canvas。300 页、扫描页、密集矢量文档也完成打开和末页跳转。高倍缩放单画布低于 8,388,608 像素上限。1,000 次核心导航前后 RSS 都是 44.97 MiB；这只覆盖本轮压力测试，不能证明长期无泄漏。数据库完整性与外键检查通过。

高命中搜索两轮 P95 为约 361 ms 和 491 ms，反复存在超标，不能因常用列表流畅就写成性能全部通过。后续应优化从大量正文片段归并论文匹配结果的成本；两字符前缀查询也有约数百毫秒延迟，应一并跟踪。

## 尚未验收

- 真实引用量：已对公共 DOI `10.1038/nature14539` 通过实际 RPC 发起查询，Crossref 与 Semantic Scholar 连接失败；独立 Python 请求也出现 TLS/读取超时。本轮无法确认真实联网计数成功。缓存 0、标识变更失效、引用量排序已有测试。
- 新版本 Windows ZIP/EXE、DPAPI 凭据保存和实际用户 Windows 环境未运行；现有 Windows CI E2E 已含离线 OCR 断言，需要下次 CI 构建验证。
- 未发起付费 Codex/模型请求，未重新评估 BabelDOC 的真实整篇翻译质量；复杂表格、公式和扫描件原位翻译质量不能由当前 OCR 测试推出。
- 同步使用认证的本地 WebDAV 和 Moto S3 测试，含七牛/阿里配置；没有真实坚果云、七牛、阿里账号验收。Zotero 使用合成旧库，用户真实旧库仍未提供。

## 证据与复现

- `artifacts/validation/acceptance-20261101/project-checks.json`：检查链。
- 同目录 `desktop.json` / `browser-10000.json` / `scale-10000.json`：完整桌面与性能数据。
- `ai-context.json` / `faults.json` / `citations-live.json` / `summary.json`：边界审计和未完成项。
- `library.png` / `desktop.png` / `scanned-reader.png`：实际界面截图（截图按仓库规则忽略，不进入 Git）。

```bash
# 使用已准备的 Python 环境，Node 22+ 和 Cargo 在 PATH 上
.venv/bin/python scripts/validate_project.py --report artifacts/validation/acceptance-20261101/project-checks.json
.venv/bin/python scripts/benchmark_library.py --work-dir /tmp/moonlight-scale-10k --reuse --repeats 20 --soak-operations 1000 --enforce --report artifacts/validation/acceptance-20261101/scale-10000.json
node app/e2e/acceptance.mjs
```

桌面测试在 Linux 需要显示服务器、Electron 系统库和中文字体；本机使用临时 Xvfb、解压的运行库及 `FONTCONFIG_FILE`，未改变系统安装。`--enforce` 基准因全文搜索超标返回非零，属于真实验收未达标，保留原始失败数据。
