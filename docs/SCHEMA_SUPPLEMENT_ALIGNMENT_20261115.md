# Schema 迁移/升级备份、补充材料翻译、双栏段落对齐

本轮完成《产品成熟度审查》Phase 1 的三块地基能力。日期：2026-11-15。

## 1. `schema_version` + 升级前自动备份

### 版本约定

- `schema_migrations(version INTEGER PRIMARY KEY, applied_at INTEGER)` 记录已应用版本。
- 当前 `SCHEMA_VERSION = 2`：
  - v1：既有库结构（SCHEMA + Zotero/同步/检索初始化）。
  - v2：`annotations.version_id`（吸收旧的临时 ALTER）、
    `versions.source_version_id`、`jobs.source_version_id`、
    `idx_versions_source`。

### 启动流程

`Library::new()` 在打开数据库后先调用 `initialize_schema()`：

1. 检测 `papers` 表是否存在；存在但无 `schema_migrations` 的旧库按 v1 处理。
2. `schema_version > SCHEMA_VERSION` 时直接拒绝打开（“来自更新版本”），避免旧程序写坏新库。
3. 旧库低于当前版本时：
   - 用 SQLite Backup API 复制到 `<论文库>/backups/pre-upgrade-v{from}-to-v{to}-{timestamp}.db`；
   - 对快照执行 `PRAGMA integrity_check`，失败则删除快照并**中止升级**；
   - 只保留最近 5 份升级快照。
4. 执行幂等的 `SCHEMA`，然后在**一个事务**中补齐列/索引并写入 `schema_migrations`。
5. 任何迁移失败：事务回滚，原库保持旧版本，备份文件保留，下次启动可重试/人工恢复。
6. 全新库：直接建当前 schema，写入 v1/v2 记录，不产生备份。

备份位于论文库内部，不随云同步上传；恢复仍走现有 `backup_restore` 流程。

### 测试

`library::gateway_tests::schema_upgrade_snapshots_the_library_before_migrating`：
构造缺少 `schema_migrations`、`versions.source_version_id`、`jobs.source_version_id` 的旧库，
打开后断言版本为 2、列已补齐、生成 1 份快照且 `integrity_check=ok`。

## 2. 补充材料（非主文档）独立翻译

### 数据模型

- `jobs.source_version_id` 记录任务针对哪个原文附件。
- `versions.source_version_id` 记录译文由哪个原文附件生成（主文档为 `NULL` 兼容旧译文）。
- `start_translate` RPC 新增可选 `version_id`；`Library::source_version_for()` 按 id 校验
  `paper_id + kind='source'`，不存在返回可读错误。
- `attach_translation(..., source_version_id)` 写回绑定；`get_job` 返回该字段供任务中心重试。

### 前端行为

- 阅读器“翻译全文/重新翻译”始终针对**当前 `原文附件`**，不再禁止补充 PDF。
- 译文列表按当前原文附件过滤：旧译文（`source_version_id IS NULL`）视为主文档译文。
- `TaskCenter` 重试会把原任务 `source_version_id` 一起带回。
- 切换原文附件时自动选中该附件的最近译文；没有译文则回到原文模式。

### 测试

`library::gateway_tests::translation_version_binds_to_the_supplementary_source_pdf`：
为同一论文插入补充 PDF、创建任务、调用 `attach_translation`，断言新译文
`source_version_id` 与任务字段一致；前端 `Reader.test` 断言翻译按钮用
`('paper', undefined, 'supplement')` 启动任务。

## 3. 双栏段落级对齐

### 实现

- 缓存 `(version,page,textRevision)` 的 `blocks`；双栏模式下按当前页并行读取原文/译文块。
- `PdfPane.pageSize(page)` 暴露页面自然尺寸，用于把指针坐标换算成自然 PDF 坐标。
- 鼠标悬停/点击（无选区时）上报 `{page,x,y}`；阅读器用 bbox 命中最小块。
- 对应段落选择：把块中心归一化到页高，在另一栏找**归一化中心最近**的块。
  - 点击/悬停误差 > 0.25 页高时视为不可靠，只高亮当前栏；
  - 滚动同步误差 > 0.35 页高时回退到原始“页码 + 页内百分比”。
- 命中段落以虚线框 `.alignment-focus` 同时绘制在原文/译文；滚动同步改为
  按中心段落映射，而不是直接复制 fraction。
- 双栏滚动使用短 token 防止异步块加载返回乱序。

### 已知限制

- BabelDOC 通常保持布局，但复杂跨栏/跨页/图表段落可能出现一对多；启发式只做近似对齐，
  失败时回退旧行为，不会阻断阅读。
- 只有已入库/已渲染页的 `blocks` 可参与对齐；未解析页仍按页面比例同步。
- 尚未做跨页段落匹配与“旧译文批注迁移”。

## 4. 验证

```bash
cd core && PATH=$HOME/.cargo/bin:$PATH cargo test --release --locked --offline   # 51 passed / 4 ignored
cd app  && PATH=/home/bynshard/.local/node22/bin:$PATH npm test                   # 11 files / 42 tests + 46 node tests
cd app  && PATH=/home/bynshard/.local/node22/bin:$PATH npm run build
```

Playwright 视觉回归：论文库/阅读器/查找/任务中心/详情抽屉/回收站等无 page error；
双栏段落对齐由前端单测 + 真实 blocks 数据路径覆盖。

## 5. 后续

- 旧译文批注迁移（需页码/坐标预览与回滚 UI）。
- 跨页选词合并、跨页段落匹配。
- `schema_version` 接入“定时/退出前自动快照”和周检（目前仅升级前）。
- 直接读取 `backups/` 的恢复入口（当前仍用“备份到用户选定目录 + 恢复到新库”）。
