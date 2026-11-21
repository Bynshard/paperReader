# Windows 测试包与 GitHub CI

CI 构建 Windows x64（ZIP + MSI）和 Android 平板 APK，触发方式为每次 push、pull request，以及 Actions 中手动运行。编译、测试和打包均在 GitHub 的 Windows Server 2025 / Ubuntu runner 执行，本地无需运行构建。首次远端 Windows 流水线已通过，包含打包后桌面测试。

## 下载和使用

1. 优先从 [GitHub Releases](https://github.com/Bynshard/paperReader/releases) 下载 Windows MSI（推荐）或 ZIP；普通提交的测试包可按以下步骤从 Actions 下载。
2. 打开仓库的 **Actions → Installers (MSI + APK)**，选择绿色通过的运行。
3. 在 **Artifacts** 下载 `Moonlight-windows-x64-运行编号`（ZIP、MSI 及 SHA-256）和 `Moonlight-android-pad-运行编号`（APK 及 SHA-256）；运行摘要也提供本次下载链接。产物保留 14 天。
4. Windows 直接运行 `Moonlight-0.1.0-windows-x64.msi` 安装；或解压 artifact 中的 ZIP，进入 `Moonlight-win32-x64` 运行 `moonlight.exe`。请保留整个目录，不要只复制 EXE。
5. Android 平板安装 `Moonlight-0.1.0-pad-debug.apk`（debug 签名测试包，需允许“安装未知来源应用”）。首次打开后，粘贴桌面端「设置 → 平板伴读」里的配对链接；APK 只是局域网 PWA 外壳，论文库仍保存在桌面端。

ZIP 同时提供 SHA-256 文件与构建清单。每次包的文件名包含项目版本，artifact 名包含运行编号，构建清单记录提交 SHA，便于区分不同提交。

这是未签名的 Windows 10/11 x64 测试版，系统可能显示未知发布者提示。CI 的 Windows Server 环境通过不替代用户 Windows 桌面的账号、系统凭据与长期使用验收。

## 可以测试的功能

- 导入 PDF、去重、检索、排序、编辑元数据、分类与标签、笔记。
- PDF 阅读、文本选区、划线批注、重启后保存状态。
- 在“设置与状态”点击“通过浏览器登录 Codex”，完成认证后选择“Codex 账号额度”，测试问答、总结、选段翻译、停止生成和回答保存。
- 任务中心、完整备份、恢复到新库。
- 包内带有 Electron、PDF.js、Windows Rust 核心、rclone 与官方 Codex App Server。上述基础功能无需另装 Node、Rust、Python 或 Codex CLI。
- 整篇 PDF 保留版式翻译仍使用 BabelDOC，需另外安装引擎并配置模型；本包没有捆绑 Python、BabelDOC 模型及其全部依赖。

实际论文库路径在“设置与状态”中查看。先使用测试论文库，体验和迁移验证后再接管原库；恢复功能会创建新库并保留旧库。

## CI 的检查与产物门槛

工作流为 `.github/workflows/validate.yml`，包含 Windows 与 Android 两个构建 job，标签发布 job 汇总两者：

1. 安装 Node 22、Python 3.11、Rust 1.99.1；使用锁文件安装依赖。
2. 在真实 Windows/MSVC 上运行 Rust 单元测试、React 测试和 Node 协议测试。
3. 原生编译 Windows x64 核心，使用静态 CRT；不使用 Linux 交叉编译工具。
4. 下载固定版本 rclone 和官方 Codex App Server，核验上游 SHA-256 以及解压后二进制哈希。
5. 在中文临时路径测试真实 PDF 导入、去重、资料/标签/笔记、批注、正文检索、本地 AI 上下文、备份恢复和重启持久化。
6. 生成带 ASAR 的 Windows ZIP，检查包内 PE 架构、必需文件与哈希，实际启动包内核心和 rclone。
7. 解压发布 ZIP，在源码目录之外启动真实 `moonlight.exe`，测试资料编辑、PDF.js 渲染、实际离线 OCR、可选择文字层与索引，并初始化包内官方 Codex App Server、读取隔离的未登录状态。
8. 使用 WiX Toolset 3 从已打包目录生成 MSI，校验文件大小与 SHA-256。
9. Android job 安装 JDK 17、Android SDK 35、Gradle 8.9，构建 `android/` WebView 外壳的 debug APK 并生成 SHA-256。
10. 上述检查全部成功，才上传 ZIP/MSI/APK。失败时保留 `windows-checks-运行编号` 中已有的 JSON 报告及截图；编译/单元测试日志见对应步骤。

CI 不打开浏览器认证、不调用收费模型、不访问真实论文库或真实云账户。它不能替代你在 Windows 桌面上的人工体验、账户认证和真实服务验证。

Windows 测试中已避开 shell glob 和 `.cjs` shebang，原生 helper 与同步进程隐藏控制台窗口；官方 App Server 直接使用 EXE，不依赖 npm 的 `.cmd` 启动脚本。

## 如遇失败

- CI 构建失败：查看第一个红色步骤，下载 `windows-checks`（若已生成），保留失败日志。
- 软件启动或操作失败：记录对应 artifact 的运行编号、Windows 版本、触发步骤和错误提示。资料管理失败与“尚未配置全文翻译引擎”应分别记录。
- 首次成功运行：[Windows build #1](https://github.com/Bynshard/paperReader/actions/runs/41289973781)。

## 发布新版本

先将 `app/package.json`、锁文件及核心版本更新为一致的版本号，提交后推送对应的 `v版本号` 标签。标签触发完整 Windows + Android 构建和测试，全部通过后自动创建预发布 Release，上传 ZIP、MSI、APK、各自的 SHA-256 和构建清单；标签必须与包版本一致。普通分支提交仅上传 Actions artifact。

APK 目前是 **debug 签名**的 WebView 外壳，用于内测侧载：正式发布到应用商店前需配置固定 release keystore、隐私政策/权限说明，并决定是否继续采用“连接桌面 LAN PWA”的形态。签名、分发与独立 Android 客户端路线见 [SIGNING_AND_ANDROID_DISTRIBUTION.md](SIGNING_AND_ANDROID_DISTRIBUTION.md)。

Windows 代码签名：配置 `WINDOWS_SIGN_PFX_BASE64` / `WINDOWS_SIGN_PFX_PASSWORD` 后，CI 会签名 `moonlight.exe`、`moonlight-core.exe` 与 MSI；未配置时自动跳过并产出未签名测试包。公共 CA 的 HSM/EV 证书建议接 SignPath/Azure Trusted Signing。

Android release 签名：配置 `ANDROID_KEYSTORE_BASE64`、`ANDROID_KEYSTORE_PASSWORD`、`ANDROID_KEY_ALIAS`、`ANDROID_KEY_PASSWORD` 后，CI 产出 release APK + AAB；否则回退 debug APK。`versionCode` 自动使用 run number。

## 当前测试包状态（2026-11-01）

[Windows CI #6](https://github.com/Bynshard/paperReader/actions/runs/41306172222) 对应 `744431d`，完整检查通过。包内包含翻译 API/模型/BabelDOC 路径设置、分层目录/批量标签/速记、增强列表、Markdown、正文解析和本地 OCR、问答上下文范围与预览。

前次 #5 因 ASAR 路径分隔符检查误报 OCR 文件缺失；已修复并加入正斜杠/反斜杠回归。#6 已实际运行包内 OCR 引擎、检查识别证据和可选择文字层。

新增功能目前在 [Actions #6 测试包](https://github.com/Bynshard/paperReader/actions/runs/41306172222/artifacts/13083706259)，尚未更新旧 `v0.1.0` Release。不能只按 ZIP 内的 `0.1.0` 文件名判断是否含新功能，需核对清单中的提交 SHA。完整剩余工作与正式交付门槛见 [PRODUCT_READINESS.md](PRODUCT_READINESS.md)。
