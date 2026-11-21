# 本地论文管理与原位翻译桌面软件

目标是独立桌面论文管理软件：具备 Zotero 式的收录、分类和引用管理，在同一个阅读器里完成保留版面翻译、原文对照、批注和有出处的 AI 解读。

当前是 Windows 预发布项目，已有 Rust/SQLite 核心、Electron/React 桌面端、真实译文和万篇库测试。2026-11-01 的 [Windows CI #6](https://github.com/Bynshard/paperReader/actions/runs/41306172222) 已通过实际 ZIP 启动、PDF 渲染和离线 OCR；全文搜索性能、翻译安装/质量、真实账号、旧库与云端验收仍有缺口。

CI 现在同时产出 **Windows ZIP + MSI 安装包**和 **Android 平板 APK（连接桌面 LAN PWA 的 WebView 外壳）**，见 [Windows 测试与 CI](docs/WINDOWS_TESTING.md) 与 [`android/README.md`](android/README.md)。签名、上架与独立 Android 客户端路线见 [签名与 Android 分发](docs/SIGNING_AND_ANDROID_DISTRIBUTION.md)。

当前开发入口：[从预发布到日常可用的剩余工作与交付标准](docs/PRODUCT_READINESS.md)。包含优先级、代码入口、完成标准与推荐执行顺序。

当前阶段优先验证技术与体验，版权及许可证审查暂不作为前置条件；NeoRead 同样纳入源码与原位导出技术候选。

- [当前剩余工作](docs/PRODUCT_READINESS.md)：以最新代码和证据为基线，按 R01–R17 执行。
- [给 DS 的初始执行任务](DS_TASK.md)：保留原始需求；其中技术选型与起步阶段已属于历史。
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
- [目录、标签、速记与引用量](docs/LIBRARY_ORGANIZATION.md)：已实现的管理入口、缓存和数据兼容边界。
- [Zotero 兼容](docs/ZOTERO.md)：数据库/本地 API 两种迁移方式、字段映射与实测记录。
- [原生 GUI 复用评估](docs/RUST_GUI_REUSE.md)：miro / BarePDF / GPUI 候选对比与双轨决策。
- [安卓端评估](docs/ANDROID_CLIENT_EVALUATION.md)：加安卓端的硬约束、手机可读性实测、四种方案与排期；[竞品调研](docs/MOBILE_COMPETITOR_RESEARCH_20261120.md)含小绿鲸等来源。
- [vivo Pad 5 Pro 平板适配、全量代码 Bug/架构审查与「论文+代码」设计](docs/VIVO_PAD5_PRO_REVIEW_AND_DESIGN.md)：针对 13 寸 3:2 平板的专属视口适配、7 个真实代码 Bug 与 6 项架构缺陷重构指南、Zotero/小绿鲸/Sioyek/Corca 长处吸收，以及 DeepSeek 可直接执行的 Sprint 施工单。
- [用户体验差距审查与打磨规范（UX Polish Spec）](docs/UX_EXPERIENCE_GAP_AND_POLISH_SPEC.md)：围绕日常读写手感的 4 个反直觉 UX Bug、Sprint 2 接线收尾核对，以及对标 Zotero 7 / 小绿鲸 / Sioyek / Corca / MarginNote 4 的 6 大体验升级规范。
- [下一阶段缺陷修复与功能演进规范（Batch D → Batch F）](docs/NEXT_STAGE_BUGS_AND_FEATURES_SPEC.md)：7 个最新代码正确性 Bug（部分页翻译错位、Zotero 粗粒度锁、双栏滚动中心漂移、后台 Tab 缩放坍缩、LAN 白名单与 Token 持久化、网关与临时目录清理、搜索摘要匹配）+ 6 项 Zotero/小绿鲸体验闭环 + 5 项参考 GitHub 开源标杆的 AI 原生特性（无内链引用预览、多论文对比矩阵与联合 RAG、内置 MCP Server、Plan→Apply 整理 Agent、动态阈值与论点核查）。
- [Batch D/E/F 实施记录](docs/NEXT_STAGE_IMPLEMENTATION_20261121.md)：上述 18 项的落地位置、RPC/Schema 契约、155/186/61 项回归证据与已知限制。
- [用户提供的版面参考](docs/assets/reference-translation.png)：以双栏和段落区域大致同位为目标，不要求中英逐行等长。

实施顺序：验证翻译内核 → 确认桌面底座 → 接入原位译文 → 补齐对齐与解读 → 打包验证。各阶段按验收条件推进。
