# 万篇库与阅读器验收

这套测试用于发现并复现性能问题，不代表项目已经达到成熟发行版标准。

## 数据和计时边界

`scripts/benchmark_library.py` 默认创建独立目录中的 10,000 份不同 PDF：9,998 份程序生成的 4–12 页文本/矢量文档，以及仓库内 Attention、HybridFlow 两篇实际论文。所有 PDF 都经过正式 Rust `import_pdfs` 协议、哈希、文件复制、元数据提取、分页文本提取和全文索引；不直接插入论文行，不用 10,000 个同内容链接冒充 10,000 篇论文。生成文档具有重复语言结构，不能代表一万篇自然论文的词汇、图片和字体分布。

随后通过公开接口为每篇设置分类、两个标签、笔记、一个批注。对启动、首次/末页、标题/年份排序、星标/状态/分类/标签筛选、稀疏/密集/短词搜索、详情、批注、正文、保存笔记和导出分别计时。报告包含 P50/P95/P99/max、响应大小、命中数；少量启动/PDF样本的 P99 只是样本最大值。操作系统文件缓存没有清空；重启指标只表示新进程启动。

另有导入 40 份新 PDF 时交替查询的竞争测试、3,000 次随机导航、核心及提取进程 RSS/PSS、最终 SQLite 完整性和外键检查。RSS/PSS 快照不等于完整生命周期峰值，也不代表 Electron 或 GPU 显存。

`app/e2e/benchmark.mjs` 在真实 Chromium 中运行生产构建的 React、TanStack 和 PDF.js；用仅绑定回环地址的 HTTP 桥接真实 Rust RPC 和 PDF 文件。它测量列表出现、搜索输入至结果出现（含 200ms 防抖）、排序到显示、真实论文首次绘制、缩放重绘、240 次滚动调度、300%/DPR 2 的画布分配和反复打开关闭后的 JS heap/DOM。实际浏览器测试不能等同 Electron IPC、物理显示帧率或真实 GPU 的验收。JS heap 也不包含完整 worker/Canvas/native 内存。

## 复现

需要 Node 22+、Rust/Cargo 已准备的离线依赖、Python 环境中的 `requirements-validation.txt`，以及已安装的 rclone。项目整体回归失败即停止，结果写 JSON：

`.github/workflows/validate.yml` 提供 push/PR 回归与手动万篇/浏览器验收。当前目录没有 Git 远端，工作流尚未在 GitHub 执行；本机运行的是同一验证脚本。规模预算失败不会被 CI 转成通过。

```bash
PATH="$HOME/.local/node22/bin:$PATH" .venv/bin/python scripts/validate_project.py
.venv/bin/python scripts/benchmark_library.py --work-dir /tmp/moonlight-10k --report artifacts/validation/scale-10k/report.json --enforce
# 对同一库复测，不重新导入；只用于 benchmark 创建的临时库。
.venv/bin/python scripts/benchmark_library.py --work-dir /tmp/moonlight-10k --reuse --report artifacts/validation/scale-10k/retest.json --enforce
```

浏览器测试先构建 `app`，安装 Playwright Chromium，启动测试桥接，然后在另一终端运行。结束桥接进程用 Ctrl+C；可选双栏占位版本会被移除。它使用同一份真实 PDF 的两个版本，只测双栏开销，不验收翻译内容。

```bash
cd app
npm ci
npx playwright install chromium
npm run build
cd ..
.venv/bin/python scripts/serve_benchmark.py --work-dir /tmp/moonlight-10k --dual-fixture
# 另一终端：
cd app
npm run bench:browser -- http://127.0.0.1:5201 ../artifacts/validation/scale-10k/browser.json
```

Linux 无头 Chromium 仍需 ATK、Pango、Cairo 等系统库。本机测试使用 `/tmp/moonlight-browser-deps/root/usr/lib/x86_64-linux-gnu` 临时解压的运行库和 `LD_LIBRARY_PATH`，没有更改系统安装。

本机也缺中文字体，截图预检曾出现方框；最终浏览器验收用临时解压的 `fonts-noto-cjk`，通过 `FONTCONFIG_FILE=/tmp/moonlight-browser-fonts/fonts.conf` 加载，未把测试机缺字体误判为应用字符串乱码。

## 本轮修复

- Rust 中有容量限制的后台任务队列；列表查询有两条独立 SQLite WAL 只读连接，每次请求在同一快照内做匹配、计数和分页。导入和慢查询不会占住主 RPC 请求循环。
- PDF 提取在持久子进程中运行，复用已有 `lopdf/pdf-extract`；进程全局 stdout 捕获不影响主 RPC 输出。损坏 PDF 后可恢复，队列满会明确报错，不静默丢请求。
- 全文搜索先按论文去重正文匹配，并在一次请求内复用匹配集，减少重复索引扫描和逐块查论文。
- 老 token 全文索引通过一次事务迁移与正文行号对齐，插入/更新/级联删除由 SQLite 触发器维护；按行号清除旧块，避免每个几何块扫描全库。重复提交未变化的页面不再重写索引。Rust 与 Python 共用迁移 SQL；升级之前的旧二进制不应继续写入升级后的库。
- Electron 每批导入 50 份，批间让出后台队列，界面显示完成数。
- 复用 lopdf 的 PDF 字符串解码，修复真实 HybridFlow 的 UTF-16 标题乱码；摘要截取遵守 Unicode 边界。
- PDF Canvas 单页最多 8,388,608 像素、最大边 16,384；高倍缩放时降低背板采样倍率，页面布局、文字和批注坐标不变。限制的是单页画布，不是全应用内存。

## 发布前仍需覆盖

真实用户的一万篇自然论文；不同硬盘/内存/操作系统；Electron 完整桌面、安装包和长期峰值内存；更多扫描件、复杂矢量和异常 PDF；真实 Zotero 库及云厂商账号；模型翻译时延和质量。这些不能由合成规模库和回环服务代替。

浏览器另可添加 `--stress-fixtures`，通过正式导入临时增加 300 页长文档、12 页扫描件和 6 页密集矢量文档，逐个测实际绘制和末页跳转，结束服务后清理这三篇。双栏版本必须标明只是复制源文件的性能占位。

性能预算不会为使测试变绿而提高。已知高命中率正文搜索仍可能超过 200ms 的 P95 目标；保留失败报告，单独列出实际延迟。首次升级重建旧索引也与后续普通启动分开解释。
