# Windows 测试包与 GitHub CI

CI 只构建 Windows x64，触发方式为每次 push、pull request，以及 Actions 中手动运行。编译、测试和打包均在 GitHub 的 Windows Server 2025 执行，本地无需运行构建。首次远端 Windows 流水线已通过，包含打包后桌面测试。

## 下载和使用

1. 优先从 [GitHub Releases](https://github.com/Bynshard/paperReader/releases) 下载 Windows ZIP；普通提交的测试包可按以下步骤从 Actions 下载。
2. 打开仓库的 **Actions → Windows build**，选择绿色通过的运行。
3. 在 **Artifacts** 下载 `Moonlight-windows-x64-运行编号`；运行摘要也提供本次下载链接。产物保留 14 天。
4. 解压下载的 artifact，再解压其中的 `Moonlight-0.1.0-windows-x64.zip`。
5. 进入 `Moonlight-win32-x64`，运行 `moonlight.exe`。请保留整个目录，不要只复制 EXE。

ZIP 同时提供 SHA-256 文件与构建清单。每次包的文件名包含项目版本，artifact 名包含运行编号，构建清单记录提交 SHA，便于区分不同提交。

这是未签名的 Windows 10/11 x64 测试版，系统可能显示未知发布者提示。首次 Windows 构建成功前，不把本地的 Linux 验证当作 Windows 通过。

## 可以测试的功能

- 导入 PDF、去重、检索、排序、编辑元数据、分类与标签、笔记。
- PDF 阅读、文本选区、划线批注、重启后保存状态。
- 在“设置与状态”点击“通过浏览器登录 Codex”，完成认证后选择“Codex 账号额度”，测试问答、总结、选段翻译、停止生成和回答保存。
- 任务中心、完整备份、恢复到新库。
- 包内带有 Electron、PDF.js、Windows Rust 核心、rclone 与官方 Codex App Server。上述基础功能无需另装 Node、Rust、Python 或 Codex CLI。
- 整篇 PDF 保留版式翻译仍使用 BabelDOC，需另外安装引擎并配置模型；本包没有捆绑 Python、BabelDOC 模型及其全部依赖。

实际论文库路径在“设置与状态”中查看。先使用测试论文库，体验和迁移验证后再接管原库；恢复功能会创建新库并保留旧库。

## CI 的检查与产物门槛

工作流为 `.github/workflows/validate.yml`，构建和发布 job 均只使用 Windows：

1. 安装 Node 22、Python 3.11、Rust 1.99.1；使用锁文件安装依赖。
2. 在真实 Windows/MSVC 上运行 Rust 单元测试、React 测试和 Node 协议测试。
3. 原生编译 Windows x64 核心，使用静态 CRT；不使用 Linux 交叉编译工具。
4. 下载固定版本 rclone 和官方 Codex App Server，核验上游 SHA-256 以及解压后二进制哈希。
5. 在中文临时路径测试真实 PDF 导入、去重、资料/标签/笔记、批注、正文检索、本地 AI 上下文、备份恢复和重启持久化。
6. 生成带 ASAR 的 Windows ZIP，检查包内 PE 架构、必需文件与哈希，实际启动包内核心和 rclone。
7. 解压发布 ZIP，在源码目录之外启动真实 `moonlight.exe`，测试资料编辑和 PDF.js 渲染，并初始化包内官方 Codex App Server、读取隔离的未登录状态。
8. 上述检查全部成功，才上传可供测试的包。失败时保留 `windows-checks-运行编号` 中已有的 JSON 报告及截图；编译/单元测试日志见对应步骤。

CI 不打开浏览器认证、不调用收费模型、不访问真实论文库或真实云账户。它不能替代你在 Windows 桌面上的人工体验、账户认证和真实服务验证。

Windows 测试中已避开 shell glob 和 `.cjs` shebang，原生 helper 与同步进程隐藏控制台窗口；官方 App Server 直接使用 EXE，不依赖 npm 的 `.cmd` 启动脚本。

## 如遇失败

- CI 构建失败：查看第一个红色步骤，下载 `windows-checks`（若已生成），保留失败日志。
- 软件启动或操作失败：记录对应 artifact 的运行编号、Windows 版本、触发步骤和错误提示。资料管理失败与“尚未配置全文翻译引擎”应分别记录。
- 首次成功运行：[Windows build #1](https://github.com/Bynshard/paperReader/actions/runs/41289973781)。

## 发布新版本

先将 `app/package.json`、锁文件及核心版本更新为一致的版本号，提交后推送对应的 `v版本号` 标签。标签触发完整 Windows 构建和测试，全部通过后自动创建预发布 Release，上传 ZIP、SHA-256 和构建清单；标签必须与包版本一致。普通分支提交仅上传 Actions artifact。
