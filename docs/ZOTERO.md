# Zotero 迁移兼容性（2026-11-01）

目标：选择旧 Zotero 数据目录，将已有条目和本地附件迁入，由 Moonlight 独立管理。默认复制附件，不移动原文件，不写回 Zotero。当前是单向迁移，不是双向同步或 Zotero 插件运行环境。

实现：`core/src/zotero_local.rs`、`app/src/App.tsx`、`app/src/Reader.tsx`。正式迁移使用 Rust 核心，Python 兼容后端不提供此入口。

## 使用流程

1. 在 Zotero 设置中查看数据目录，找到含 `zotero.sqlite` 的文件夹；普通存储附件位于 `storage` 子目录。不需要先导出 BibTeX/RIS。
2. 在 Moonlight 点击“从 Zotero 导入”。支持默认位置和部分自定义目录自动探测，也可选择目录或输入路径。
3. 可选分类，父分类包含子分类；不选表示全部。默认复制所有本地附件，以便迁移后不依赖 Zotero 原文件位置。
4. 若使用外链基础目录，为 `attachments:` 相对路径选择对应基础目录。普通绝对外链直接解析。
5. 查看新增、已关联、合并重复、附件、批注、缺失与失败数，可保存完整 JSON 报告。缺失文件找回后，可以对同一来源目录再次迁移补齐。
6. 打开论文可选择多个原文 PDF；笔记页可查看迁入笔记和附件。非 PDF 文件可在系统文件夹中定位；没有 PDF 的条目仍能查看元数据和笔记。

官方说明：[数据目录](https://www.zotero.org/support/zotero_data)、[存储附件与外链](https://www.zotero.org/support/attaching_files)、[外链基础目录](https://www.zotero.org/support/kb/missing_linked_file)。云端按需下载的文件可能尚未存在本机；迁移器会报告缺失项，不能凭数据库生成这些文件。

## 覆盖范围

| 数据 | 工作库中的行为 | 保留方式与限制 |
| --- | --- | --- |
| 文献元数据 | 标题、作者、年份、出版物、DOI、arXiv、摘要 | 额外字段及作者角色等原结构保存在快照。 |
| 分类 | 全路径分类名称，父分类筛选含子分类 | 当前为路径列表，不是可折叠树；群组分类加库名和 ID。 |
| 标签 | 按名称关联去重 | 原类型、顺序、颜色在快照，未完整投影。 |
| 多个 PDF | 全部建立 source 版本，可切换阅读、独立批注和 AI 证据 | 全文翻译及译文对照当前使用主文档，补充 PDF 的翻译按钮禁用，避免错译。 |
| 绝对/相对外链 | 可复制或保留链接；支持 attachments: + 基础目录 | 保留链接时原位置仍须可用。缺目录或文件会报告。 |
| 网页快照、图片和其他附件 | 复制文件；存储型网页连同资源目录复制 | 非 PDF 暂通过系统文件夹管理，不执行迁入 HTML；快照内符号链接报错。 |
| 子笔记、独立笔记 | 转为保留段落的文字，可查看 | 原 HTML 留在快照，不声称富文本编辑等价。 |
| 独立附件 | 成为可管理条目，同一主 PDF 可合并至已有论文 | 包含对应批注。 |
| 高亮/下划线、带矩形的便签/区域批注 | 按实际 PDF 版本保存引文、评论与归一化矩形 | 识别整数类型并兼容旧夹具字符串；当前作为矩形高亮显示，颜色映射 yellow/green/blue，不等价复刻全部外观。 |
| 手写及不支持的几何 | 报告兼容提示，原 position 留在快照 | 暂无原生手写展示和编辑。 |
| 群组库 | 迁入本机已有条目和文件 | 来源 ID + libraryID + key 隔离；无组权限或在线同步。 |
| 回收站、关系、保存的搜索和其他表 | 完整数据库快照保留 | 回收站不迁入工作论文库；关系和保存的搜索不在当前界面执行。 |
| 插件、Word 引用链接、阅读偏好 | 不执行插件，也未接管引用字段 | 尚不能完全替代 Zotero 全部功能。 |

## 重复迁移与数据保护

- 使用 SQLite backup API 取得一致、包含已提交 WAL 的快照，替换旧版分别复制 DB/WAL/SHM 的做法。临时快照目录结束后清理。
- 工作库以来源目录 ID、库 ID、条目 key 关联，解决不同库相同 key 冲突。
- 首次关联优先 DOI，再检查主 PDF 的 SHA256；不同 DOI 不会因为共享 PDF 而强行合并，也不用任意补充附件合并文献。
- 再次迁移不重复新增论文、版本或批注，缺附件可以补齐。来源目录移动会改变来源 ID，缺 DOI/PDF 的条目可能无法关联，应使用同一来源目录补齐。
- 元数据和笔记仅在仍等于上次迁入值时更新，本地修改保留。分类与标签为增量补充，不删除本地关系。
- 已关联批注不重复追加、不覆盖本地修改；源端已有批注修改和删除不会同步，新批注可迁入。这是迁移，不是双向同步。
- 每 100 条提交事务，逐条用 SQLite 保存点隔离失败。损坏 PDF 使该条回滚并进入错误列表，其余继续；修好后可重试。
- PDF 副本在 `files/<sha256>.pdf`，其他附件在 `imports/zotero/<source-id>/attachments/`。保留链接的外部文件不被永久删除操作删除；共享 PDF 被其他条目引用时保留。
- `imports/zotero/<source-id>/zotero.sqlite` 保留最近一次一致快照，`last-report.json` 保留报告。删除工作条目不会自动清除迁移档案。快照保留原字段，不代表全部功能原生实现。

## 测试证据

`tests/fixtures/zotero/userdata.sql` 直接取自 [Zotero 官方源码](https://github.com/zotero/zotero/blob/main/resource/schema/userdata.sql)，schema 130；URL、日期与 SHA256 在同目录 `SOURCE.json`。记录和 PDF 为合成数据，不是真实个人库。旧简化夹具错误地把批注 type 当字符串，本轮已修正。

`scripts/test_zotero_migration.py` 覆盖：

- 多 PDF、独立笔记/附件、非 PDF、网页资源、群组相同 key、回收站排除。
- 裁剪和旋转页面批注，使用实际 PDF.js Viewport 独立校验；重复迁移不增殖。
- 父分类含子分类，无效分类不误导入全库，缺失和外链文件补齐。
- 本地修改保留、未修改元数据更新，链接文件不删除，移走源目录后复制件可读。
- WAL 已提交记录进入快照，损坏 PDF 单条回滚及重试。
- 不同 DOI 共享 PDF 不误合并，删除一条不破坏其他条目引用。
- 1,000 条额外元数据使用批事务导入。

证据：`artifacts/validation/zotero-20261101/migration.json`。单次测试约 1,000 条元数据从逐条事务约 7.8 秒降为约 0.7 秒；不是大批真实全文 PDF 复制基准。前端另有目录选择、参数传递、缺失报告、多 PDF 阅读、无 PDF 笔记测试；分类选择使用 TanStack Virtual。

复现（Node 22+，仓库根目录）：

```bash
cargo build --manifest-path core/Cargo.toml --release --offline
cargo test --manifest-path core/Cargo.toml --release --offline
.venv/bin/python scripts/test_zotero_migration.py
cd app
npm test
npm run build
```

本机没有用户真实旧库，用户已确认无法提供，所以真实个人库和 GUI 验收尚未执行。官方 schema 测试不等于所有历史版本、插件组合均无损。大批附件复制会占用同步 sidecar，迁移过程的 GUI 响应尚待任务化处理。

## 协议入口

- `zotero_probe {data_dir?}`：只读探测，接受目录或数据库文件路径。
- `zotero_import {data_dir?, collections?, linked_base_dir?, copy_attachments?, include_notes?, include_annotations?, limit?}`：正式本地迁移，默认复制并包含笔记与批注，limit=0 表示不限。
- `zotero_files {paper_id}`：查看附件状态；`zotero_attachment_path {paper_id,file_id}` 由主进程定位文件。
- `paper_pdf {paper_id,kind,version_id?}`：验证所属论文并读取指定 PDF。

旧 `zotero_api_import` 仅保留元数据/PDF 备用入口，本地 API 未连接验收，不提供上述完整迁移保证；正式桌面迁移不走此接口。
