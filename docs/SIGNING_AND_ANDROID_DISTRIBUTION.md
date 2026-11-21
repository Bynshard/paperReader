# 签名、分发与独立 Android 客户端路线

本文回答三个遗留问题：**MSI/EXE 未签名**、**APK 是 debug 签名 WebView 外壳**、以及**是否需要/如何做完全独立的 Android 客户端**。CI 已为前两项预留好密钥注入与签名流程；第三项是独立产品工程，不能靠 CI 配置完成。

## 1. Windows：让 MSI/EXE 变成可信签名包

### 1.1 证书怎么选

| 方式 | 适用 | 说明 |
| --- | --- | --- |
| **EV Code Signing（硬件令牌/HSM）** | 面向公众下载，想立刻减少 SmartScreen 警告 | 私钥不可导出，CI 需用云签名服务（DigiCert KeyLocker、Azure Trusted Signing、SignPath）或自托管 HSM；不能简单放 PFX secret。 |
| **OV Code Signing（HSM）** | 预算有限、可接受声誉累积期 | 签名有效，但 SmartScreen 信誉需要下载量/时间积累；同样受“私钥必须存硬件”约束。 |
| **Azure Trusted Signing** | GitHub Actions 最省事 | 微软云签名，按签名次数计费；CI 用 Azure 凭据调用官方 action，不需要 PFX。 |
| **SignPath.io（开源项目免费）** | 开源仓库 | 支持 OV/EV、GitHub Action；适合本仓库当前阶段。 |
| **自签名证书** | 内网/企业受控设备 | 可消除“未知发布者”，但必须在每台设备安装根证书（Intune/GPO）；对公网用户没有意义。 |

> 2023 年后公共 CA 的代码签名私钥必须存放在硬件/云 HSM，**不能把普通 PFX 当作长期公共发布方案**。本仓库 CI 的 PFX 支持主要面向企业内部分发或云签名导出的临时签名环境；公网发布建议接 SignPath/Azure Trusted Signing。

### 1.2 CI 已支持的 PFX 签名流程

在 GitHub 仓库 **Settings → Secrets and variables → Actions** 添加：

| Secret | 内容 |
| --- | --- |
| `WINDOWS_SIGN_PFX_BASE64` | PFX 文件的 Base64（`base64 -w0 cert.pfx`） |
| `WINDOWS_SIGN_PFX_PASSWORD` | PFX 密码 |

`windows` job 在打包前把 PFX 解码到 runner 临时目录，并设置 `MOONLIGHT_SIGN_PFX` / `MOONLIGHT_SIGN_PFX_PASSWORD` / `MOONLIGHT_SIGNTOOL`：

- `electron/package.mjs` 在生成 ZIP 之前调用 `sign-windows.mjs`，签名 `moonlight.exe` 和 `resources/bin/moonlight-core.exe`（设置 `MOONLIGHT_SIGN_ALL=1` 可递归签名全部 `.exe/.dll`，耗时更长）；
- `electron/msi.mjs` 在 WiX 生成 MSI 后签名 MSI，再计算 SHA-256；
- 未配置 secret 时自动跳过并打印 `unsigned test installers`，CI 不会失败。

验证：

```powershell
Get-AuthenticodeSignature .\Moonlight-0.1.0-windows-x64.msi
Get-AuthenticodeSignature .\Moonlight-win32-x64\moonlight.exe
```

EV 证书可立即改善 SmartScreen；OV 仍需信誉积累。签名不会改变 MSI 功能，只是安装/运行时的发布者与完整性校验。

### 1.3 如果使用云签名（推荐公网发布）

- **SignPath**：在 SignPath 创建 project/signing policy，GitHub Action 上传构建产物、下载签名后的 ZIP/MSI；私钥不离开 HSM。
- **Azure Trusted Signing**：创建 Trusted Signing Account + Certificate Profile，用 `azure/trusted-signing-action` 在 CI 中签名 EXE/MSI。
- **DigiCert KeyLocker**：CI 通过 KeyLocker 客户端/API 签名，证书私钥在云 HSM。

这些方案需要账号/证书与额外 secrets，本仓库没有预置；接入时只需替换 CI 的“Stage Windows code-signing certificate”步骤，`package.mjs`/`msi.mjs` 的产物路径不变。

## 2. Android：从 debug 侧载到正式分发

### 2.1 CI 已支持的 release 签名

生成一个长期保存的 keystore（**丢失后无法给已安装用户升级**）：

```bash
keytool -genkeypair -v -keystore moonlight-release.jks -alias moonlight \
  -keyalg RSA -keysize 4096 -validity 10000 \
  -storepass '<STORE_PASS>' -keypass '<KEY_PASS>' \
  -dname "CN=Moonlight, O=Moonlight, C=CN"
base64 -w0 moonlight-release.jks > moonlight-release.jks.b64
```

在仓库 Secrets 添加：

| Secret | 内容 |
| --- | --- |
| `ANDROID_KEYSTORE_BASE64` | `moonlight-release.jks.b64` 的内容 |
| `ANDROID_KEYSTORE_PASSWORD` | store password |
| `ANDROID_KEY_ALIAS` | `moonlight` |
| `ANDROID_KEY_PASSWORD` | key password（可留空则复用 store password） |

配置后 `android` job 自动构建 **release 签名 APK + AAB**：

- `release/Moonlight-<version>-pad.apk`
- `release/Moonlight-<version>-pad.aab`（Google Play 用）
- 每个文件对应 `.sha256`

未配置时回退为 debug 签名 APK，方便内部测试。`versionCode` 使用 `github.run_number`，保证每次上传 Play 的版本号递增。

验证：

```bash
apksigner verify --print-certs Moonlight-0.1.0-pad.apk
jarsigner -verify -verbose -certs Moonlight-0.1.0-pad.aab
```

### 2.2 “未知来源”怎么消除

- **Google Play / 国内应用商店**：用户从商店安装，不再需要手动允许未知来源；但纯 WebView 外壳可能触发 Play 的“最低功能/网页套壳”政策审核，风险较高。
- **企业 MDM（Intune、Workspace ONE、国内 MDM）**：把 APK 作为内部应用下发，设备策略自动允许安装；适合机构用户。
- **TWA（Trusted Web Activity）**：可把 PWA 装成“像原生”的 APK，但要求 **HTTPS + Digital Asset Links**；当前桌面端是局域网 `http://<PC-IP>:8765`，不满足 TWA 条件。除非提供云端 HTTPS 入口，否则不适用。
- **侧载**：无法从技术上消除“允许未知来源”，只能在文档/引导里写清楚；debug 签名的测试包仍会被系统提示。

### 2.3 Play 上架前仍需补齐

- 隐私政策、数据安全表单、权限说明（INTERNET；无存储/相机权限）；
- 应用图标、截图、平板适配截图、内容分级；
- target API 年度升级（当前 35）；
- WebView 外壳的“最低功能”说明，或改为 TWA/原生客户端；
- 若上架国内商店，还需软著/备案等材料（按目标商店要求）。

## 3. 完全独立的 Android 客户端（方案 B）

当前 APK 是“桌面 LAN PWA 的伴侣”，不是独立论文库。若产品要求 Android 端离线保存论文库、批注、AI，则按 [ANDROID_CLIENT_EVALUATION.md](ANDROID_CLIENT_EVALUATION.md) 的方案 B：**Kotlin + Compose + Rust core（JNI）**，而不是长期维护 WebView 套壳。粗分阶段：

| 阶段 | 内容 | 估算 |
| --- | --- | --- |
| 0. 产品/交互定稿 | 平板双栏阅读、导入、批注、AI、同步范围；与桌面端数据契约 | 2–3 周 |
| 1. Rust core Android 化 | `cargo-ndk` 交叉编译、JNI/UniFFI 桥、SQLite 路径、启动/迁移、去掉 `Command`/rclone/BabelDOC 依赖 | 6–8 周 |
| 2. Compose 文献库 + 阅读器壳 | 列表/筛选/标签/批量操作、文件 SAF 导入、阅读器容器 | 6–8 周 |
| 3. PDF 阅读与批注 | 复用 pdf.js（WebView）或原生 PDF 渲染；文本层、缩放、选词、批注坐标 | 4–6 周 |
| 4. AI 与同步 | AI 走 API（无本地 BabelDOC）；同步改用 Kotlin/HTTP 的 S3/WebDAV 或桌面中转，替代 rclone | 4–6 周 |
| 5. 设备矩阵与发布 | vivo Pad/主流 Android、后台任务、崩溃/性能、商店合规 | 4–6 周 |

合计约 **7–10 人月**（与评估文档一致），且需要 Android + Rust 两名工程师或一名全栈长期投入。关键取舍：

- **BabelDOC 不能装进 APK**（Python/PyMuPDF/字体/排版栈体积与 ABI 不兼容）：Android 端要么只读桌面已生成的译文，要么调用云端翻译服务。
- **rclone 不能作为子进程运行**：同步必须换成原生 HTTP/S3/WebDAV 实现，或继续以桌面端为同步主机。
- **SQLite/Rust 核心可复用**，但需要把 `engine.rs`/`sync_transport.rs` 的进程调用按 `cfg(target_os = "android")` 切掉，补 JNI 错误/线程/生命周期边界。

### 建议的顺序

1. **现在**：用已接好的 release 签名 + Play/MDM 分发当前伴侣 APK，验证平板真实使用需求；
2. **验证后**：若“必须离线/独立库”的需求成立，再启动方案 B 的阶段 1–2；
3. **不要**先把 WebView 外壳投入长期维护：大 PDF 内存、手势、后台索引与文件导出都会反复返工。

## 4. 当前 CI 需要你做的唯一动作

- 要公开可信 Windows 包：接入 SignPath/Azure Trusted Signing（推荐）或配置 `WINDOWS_SIGN_PFX_*` secrets；
- 要正式 Android 包：生成并保管 keystore，配置 `ANDROID_*` secrets；
- 要上架：准备商店素材/隐私政策，并评估 WebView 外壳的审核风险。
