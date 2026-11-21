# Moonlight Pad（Android 平板伴侣 APK）

这是一个**极简 WebView 外壳**，不是独立的 Android 论文库客户端：

- 论文库、SQLite、PDF.js 与 AI 请求仍由桌面端 `moonlight-core --serve` 提供；
- APK 只保存并打开桌面端「设置 → 平板伴读」里的配对链接（`http://<PC-IP>:8765/?token=...`）；
- 支持 JavaScript、DOM storage、JS `alert/confirm/prompt`、局域网明文 HTTP、外链跳浏览器、返回键/重载/修改配对地址。

## 构建

CI（`.github/workflows/validate.yml` 的 `android` job）使用 JDK 17、Android SDK 35、Gradle 8.9 自动构建：

```bash
gradle -p android :app:assembleDebug -PmoonlightVersion=0.1.0 -PmoonlightVersionCode=1
# 产物：android/app/build/outputs/apk/debug/app-debug.apk
# 配置 release keystore 后：gradle -p android :app:assembleRelease :app:bundleRelease
```

本地构建需要安装 Android SDK 35 与 JDK 17，并设置 `ANDROID_HOME`；仓库不提交 Gradle wrapper 与 SDK。

## 限制

- 当前为 **debug 签名**测试包；上架前需正式 keystore、隐私政策/权限说明与真机兼容性验收。CI 已支持通过 `ANDROID_KEYSTORE_BASE64` 等 secrets 构建 release 签名 APK + AAB，详见 [SIGNING_AND_ANDROID_DISTRIBUTION.md](../docs/SIGNING_AND_ANDROID_DISTRIBUTION.md)。
- 需要桌面端开启平板服务；配对链接包含访问令牌，请勿分享。
- WebView 对超大 PDF、文件下载（Blob 导出）与后台索引的能力弱于桌面/原生客户端；复杂导出请在桌面完成。
- 若未来做原生 Android 客户端，按 `docs/ANDROID_CLIENT_EVALUATION.md` 的方案 B（Kotlin + Compose + Rust core/JNI），而不是长期维护 WebView 套壳。
