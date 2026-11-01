# 本地论文管理与原位翻译桌面软件

目标是独立桌面论文管理软件：具备 Zotero 式的收录、分类和引用管理，在同一个阅读器里完成保留版面翻译、原文对照、批注和有出处的 AI 解读。

当前已有 Rust 核心、Electron/React 桌面原型和真实论文翻译验证产物。2026-11-01 已修复阅读同步、批注归属和页码问题，并加入数据库分页、开源虚拟渲染及十万条记录性能验证；桌面 GUI 和安装包验收仍待执行。

当前阶段优先验证技术与体验，版权及许可证审查暂不作为前置条件；NeoRead 同样纳入源码与原位导出技术候选。

- [给 DS 的执行任务](DS_TASK.md)：可以直接作为开发任务输入。
- [产品与技术设计](docs/DESIGN.md)：界面、架构、数据模型、翻译及对齐方案。
- [验证与验收计划](docs/VALIDATION.md)：样本、测试方法、指标、阶段关口和交付证据。
- [来源与版本记录](docs/sources.json)：本轮核对的上游提交及初始依赖候选。
- [实施进度](docs/PROGRESS.md)：M0 真实译文、自动指标、边界/页范围结果、Rust 核心与桌面端现状。
- [修复与性能验证](docs/PERFORMANCE.md)：本轮实现、十万条记录查询数据、回归命令与验证边界。
- [万篇库与阅读器验收](docs/SCALE_TESTING.md)：10,000 份 PDF 实际导入、40 万块全文索引、竞争负载和真实浏览器测试；包含失败门槛与复现入口。
- [万篇实测结果](docs/SCALE_RESULTS.md)：修复前后延迟、浏览器和内存数据，以及仍未达标的高命中率搜索。
- [Windows CI 与测试包](docs/WINDOWS_TESTING.md)：每次提交只在 GitHub Windows runner 构建，自动上传 ZIP、校验文件与检查报告。
- [可靠性与真实发布验收](docs/RELEASE_VALIDATION.md)：故障修复、资料编辑、备份恢复、任务中心、Linux 预发布包和万篇复测。
- [Codex 账号与 AI 对话](docs/CODEX.md)：浏览器认证、账号额度、流式问答、历史与验证边界。
- [云同步](docs/CLOUD_SYNC.md)：七牛、阿里云 OSS、坚果云/WebDAV 配置、增量同步和冲突处理。
- [Zotero 兼容](docs/ZOTERO.md)：数据库/本地 API 两种迁移方式、字段映射与实测记录。
- [原生 GUI 复用评估](docs/RUST_GUI_REUSE.md)：miro / BarePDF / GPUI 候选对比与双轨决策。
- [用户提供的版面参考](docs/assets/reference-translation.png)：以双栏和段落区域大致同位为目标，不要求中英逐行等长。

实施顺序：验证翻译内核 → 确认桌面底座 → 接入原位译文 → 补齐对齐与解读 → 打包验证。各阶段按验收条件推进。
