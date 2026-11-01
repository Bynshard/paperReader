# Codex 账号登录与论文对话

2026-11-01 已接入官方 Codex App Server 的本地托管 ChatGPT 登录和实际推理协议。

## 使用

1. 本机安装官方 Codex CLI（本轮验证版本 `codex-cli 0.159.2`）。默认从 PATH、`~/.local/bin/codex`、`~/.cargo/bin/codex` 查找，也可以设置主进程环境变量 `MOONLIGHT_CODEX_BIN` 为可执行文件路径。
2. 构建最新 Rust 核心与桌面前端后启动 Electron。
3. 打开“设置与状态”，点击“通过浏览器登录 Codex”，在系统浏览器完成账号认证。
4. 将“问答服务”选择为“Codex 账号额度”。可选择服务返回的模型，或使用 Codex 默认模型。
5. 在论文阅读助手中总结本页、解释选区、翻译选区或连续提问。支持流式输出、停止生成、原文位置跳转和最近 50 条历史记录回看。

额度、重置窗口与模型可用性由账号和官方服务决定。界面显示服务返回的使用百分比，不把它表示为 API 余额。遇到认证、限额或模型错误会直接提示，不会自动切换到需要付费 API Key 的服务。

整篇 PDF 的版式翻译继续使用现有 BabelDOC 引擎和 API 配置；本轮没有将其转换为 Codex 的批量翻译入口。此集成面向本地桌面运行，不能直接作为托管多租户服务部署。

## 凭据与对话生命周期

- 主进程启动一个复用的 `codex app-server --listen stdio://` 子进程；读取论文不会启动 Codex，只有打开认证设置或使用 Codex 对话才启动。
- 官方 `account/login/start` 生成网页登录地址，主进程核验 HTTPS 和官方域名后交给系统浏览器。回调、令牌交换与刷新由官方 CLI 完成。
- 使用 Electron 用户数据目录下独立的 `codex-home`，不会读取或复制其他 Codex 应用的 token。退出本软件登录不会退出用户现有 Codex 客户端。该目录不在论文库内，不随云同步上传。
- 不继承父进程的 OpenAI API Key、Codex 会话标识和模型网关环境变量。前端不接触认证 token。
- 纯阅读会话使用独立空工作目录、只读沙箱、关闭命令执行、联网搜索、应用连接和多代理；拒绝所有服务端工具/权限请求。官方 CLI 仍负责落实底层沙箱。
- 每次回答创建临时线程，完成后取消订阅，避免在服务内积累活动线程。最近最多 6 轮已完成的同一原文版本对话通过本地历史重建，单条历史截断，原文上下文最多 32,000 字，问题最多 16,000 字。
- `ai_prepare` / `ai_save` / `ai_history` Rust RPC 不依赖 API 网关。回答成功后才写 SQLite `chats`；取消、失败和空回答不写入。历史有论文与时间组合索引，读取最多 50 条。历史仅本地保存，当前云同步不承诺同步这些对话。
- 流式界面更新合并为最多每 50ms 一次。进程复用和有界上下文减少启动、渲染与重复传输开销。

## 验证与边界

证据位于 `artifacts/validation/codex-login-20261101/`。

- `live.json`：真实官方 App Server，复用此前已有的本机 ChatGPT 登录，读取 8 个运行时模型选项，实际完成一句学术文本翻译。默认模型 `gpt-6.1-sol`，首次文本约 7.1 秒，整次约 7.2 秒。此数值是单次验证，不是延迟分位数或稳定性能承诺。应用没有读取凭据文件。
- `desktop.json` / `desktop.png`：真实 Electron、preload、Rust、SQLite 和 PDF.js；模拟 App Server 的网页登录完成通知与模型输出，验证登录按钮调用系统浏览器、官方地址校验、模型与服务配置、总结、流式输出、原文跳转、取消后不保存、重启后历史和服务选择恢复。零页面异常。
- Node 协议测试覆盖通知早于请求响应、并发锁、退出登录、未登录、取消、进程退出与重启、官方登录域名校验、配置持久化、API 翻译兼容。
- Rust 测试验证无需 API Key 准备上下文、来源版本隔离、历史重启恢复、超长问题和不存在论文的写入拒绝。
- 人工在系统浏览器完成新账号 OAuth 尚未执行；桌面测试模拟了成功通知，不将其当作真实浏览器认证通过。
- 尝试补充“真实论文正文 → Rust 上下文 → 实际 Codex → 本地历史”联合实测时，自动审批因缺少对该具体论文向 OpenAI 外传的明确授权而拒绝，未执行该次请求。已有真实调用只发送了固定的单句测试文本；论文链路测试使用模拟模型。
- 此次没有重新跑万篇库基准；此前的全文高命中搜索超标和成熟度审计缺口仍有效。更换 AI 连接不会解决这些独立问题。

复现命令：

```sh
cargo test --offline --manifest-path core/Cargo.toml
cargo build --offline --release --manifest-path core/Cargo.toml
npm --prefix app test
npm --prefix app run build
# 有桌面显示环境及 Electron 系统依赖时：
node app/e2e/codex.mjs
```

真实认证与推理需要用户账号。默认自动测试不消耗线上额度。

## 官方协议依据

- [Codex App Server：认证、线程、流式消息、取消与限额](https://learn.chatgpt.com/docs/app-server)
- [官方配置参考：沙箱、功能开关和工具配置](https://learn.chatgpt.com/docs/config-file/config-reference)

## 后续完善（2026-11-01）

已补齐 AI 回答保存到笔记/导出、上下文截断提示与无效引用警告，并修复页尾、文档尾部检索缺失；已保存到 `chats` 的回答可随完整备份恢复。详见 [发布验收](RELEASE_VALIDATION.md)。
