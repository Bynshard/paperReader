# Moonlight Linux x64 预发布包

解压后运行 `./moonlight`。需要支持 Electron 的 Linux 桌面环境及系统 GTK/NSS/音频等运行库。系统必须支持 Chromium 沙箱（user namespace 或正确配置的 sandbox helper）；发行包不默认禁用沙箱。

包内包含 Electron、React/PDF.js、Rust 核心和 rclone；启动不需要源码、Node.js、Cargo 或 Python。Codex 对话需要另行安装官方 Codex CLI 并在设置中登录。整篇 PDF 翻译需要安装 BabelDOC 及其运行环境并配置模型 API；未配置时仍可管理论文、阅读、批注、检索、备份。

默认论文库位于系统应用用户数据目录。升级时退出应用、替换程序目录，再启动；不要删除用户数据目录。建议升级前通过设置创建完整备份。恢复会校验备份并创建新库，保留原库；恢复后应用重启进入新库。

这是未签名的 Linux x64 预发布包，不代表 Windows/macOS、真实云账号兼容性、人工新账号登录、模型翻译语义质量或所有万篇性能目标已通过。已知大范围全文检索延迟仍需继续优化。

发布证据见源码仓库 `artifacts/validation/release-20261101/`，完整使用说明见 `docs/CODEX.md`、`docs/CLOUD_SYNC.md` 与 `docs/ZOTERO.md`。
