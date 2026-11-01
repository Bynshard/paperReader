# 2026-11-01 修复与性能验证

后续已补充 [万篇 PDF 与真实浏览器验收](SCALE_TESTING.md)。下面的十万条记录是较早的数据库基准；新增的万篇测试还实际运行导入、文本提取、批注、RPC、竞争负载和 Chromium/PDF.js 绘制，不能混用两类结果。

本轮修复已有 Rust + Electron/React 原型，保留 BabelDOC 翻译内核。没有重新执行模型翻译，也没有改变 M0 翻译质量结论。

## 实现

| 范围 | 变化 |
| --- | --- |
| 论文列表 | 新增 `list_papers_page`，默认每页 100 条，上限 200 条。SQLite 完成筛选、排序、计数和分页，ID 保证顺序稳定。列表不带版本、摘要、笔记，打开时才加载详情。 |
| 关联数据 | 当前页分类和标签各一次批量查询，消除 N+1。总共四次查询：计数、列表、分类、标签。 |
| 数据索引 | 最近导入、标题、年份、星标、阅读状态及分类/标签关系增加相应索引；三个主要排序的查询计划无需临时排序表。 |
| 搜索 | SQLite FTS5 trigram 索引元数据和正文，触发器维护增删改。至少三个字符走子串索引；更短查询使用元数据 LIKE 和旧正文 token 前缀索引，正文不保证任意短子串命中。旧库首次建立索引，之后不重复全量重建。 |
| 渲染 | 论文、分类、标签、PDF 页复用 TanStack Virtual，只挂载可见区和少量邻近内容；离屏 PDF 取消渲染并释放画布，页尺寸按需读取。 |
| 异步状态 | TanStack Query 管理分页缓存，旧搜索结果不会覆盖新结果；搜索防抖 200ms，详情保护最后一次点击。PDF 阅读器按需加载，主 JS 约 224KB（gzip 71KB）。 |
| 双栏同步 | 程序跳页不触发对侧回调；用户滚动按动画帧合并通知，避免双向递归。阅读位置延迟保存，退出时刷新。 |
| 批注 | 保存实际 `source/translated` 和 `version_id`，验证归属和页范围，只在对应版本显示。兼容旧空版本字段；无法自动推断此前错误保存为原文的译文批注。 |
| 页码与证据 | 显示从 1 开始，存储和 AI 从 0 开始。新导入 PDF 按实际页分割初始文本；PDF.js 回传页面几何，重复索引保持块 ID 稳定；AI 出处返回 bbox 并定位。旧库粗索引不强制重抽，阅读时逐页更新几何。 |
| 文字选择 | 使用 PDF.js 官方 TextLayer。跨页选区暂不保存，避免引文与矩形归错页面。 |
| 取消翻译 | 不依赖子进程日志；50ms 检查取消。Unix 向进程组 TERM，超时两秒 KILL；Windows 子进程树终止待验收。 |
| Python 兼容 | 支持分页和版本批注，能重开 Rust 索引库；下列性能数字仅对应 Rust。 |

开源复用：[TanStack Virtual](https://github.com/TanStack/virtual)、[TanStack Query](https://github.com/TanStack/query)、[PDF.js](https://github.com/mozilla/pdf.js)、[SQLite FTS5](https://www.sqlite.org/fts5.html)。虚拟滚动、请求缓存、文字层和全文索引直接复用现成实现。

## 十万条记录实测

证据：`artifacts/validation/performance-20261101/sqlite-100k.json`。

临时磁盘 SQLite WAL 库：100,000 篇合成论文、100,000 个版本、100,000 个正文块。每场景 30 次，OS 缓存已热，每页 100 条；包含计数、当前页关联数据和 DTO 组装，不包含 Electron IPC、浏览器绘制或 PDF 加载。建库约 12.1 秒。

| 查询 | 中位数 ms | P95 ms |
| --- | ---: | ---: |
| 最近导入第一页 | 4.39 | 4.68 |
| 最近导入末页（offset 99,900） | 6.94 | 8.83 |
| 标题排序 | 3.19 | 3.26 |
| 年份排序 | 3.35 | 3.43 |
| 星标（匹配 50,000 篇） | 2.25 | 2.37 |
| 元数据子串（匹配 1 篇） | 12.69 | 13.02 |
| 正文子串（匹配 100 篇） | 17.93 | 18.18 |

100 条普通列表响应约 26KB。不能外推为十万篇真实全文 PDF 的搜索速度；块数、命中率、硬盘和冷缓存会影响结果。当前 OFFSET 分页在百万级深翻页需另测后决定是否增加游标分页。

## 回归验证

- 前端 4 个文件、10 项通过：实际 TanStack 在 100,000 行输入下只挂载少量行；模拟 500 页 PDF 只挂载附近页面；静默跳页、缩放取消、译文批注版本、零基页码、位置恢复、搜索/详情竞态。PDF 引擎和 DOM 尺寸为测试替身，不代表 GPU/FPS 实测。
- Rust 8 项通过：分页上限/稳定顺序、排序筛选先于分页、中文/字面搜索、触发器增删改/重开、批注版本、稳定块 ID、查询计划、无日志子进程取消。十万条基准另显式执行通过。
- 真实 `corpus/raw/attn.pdf` 离线协议冒烟通过：导入/去重、轻量分页、第二页索引、重复几何索引、批注版本、星标、回收站恢复；Python 重开 Rust 库并搜索通过。使用临时库，不改用户库，不调用模型。
- TypeScript 检查、Vite 生产构建、Rust release 构建通过。

复现（仓库根目录，Node 22+ 及已安装依赖）：

```bash
cd app
npm test
npm run build
cd ..
cargo test --manifest-path core/Cargo.toml --release --offline
cargo build --manifest-path core/Cargo.toml --release --offline
PYTHONPATH=. .venv/bin/python scripts/smoke_library.py
MOONLIGHT_BENCH_REPORT=/tmp/moonlight-100k.json cargo test --manifest-path core/Cargo.toml --release --offline benchmark_100k -- --ignored --nocapture
```

## 尚未验收

完整 Electron 桌面、全程峰值内存和安装包尚未验收。后续已在临时运行库及中文字体支持下完成真实 Chromium/PDF.js 绘制、滚动调度、缩放和画布分配测试，见 [万篇实测结果](SCALE_RESULTS.md)；无头 rAF 调度不能当作物理显示帧率，也不能声称已比 Zotero 快多少。

万篇验收已将 Rust 批量导入/AI 请求放进有界后台队列，列表使用独立 WAL 读取连接，提取器在持久子进程运行。Python 兼容后端仍不具备同样的并发性能保证。

翻译版面与语义质量仍按 `PROGRESS.md` 的 M0 证据和人工复核状态验收；本轮不会自动改善 BabelDOC 排版。
