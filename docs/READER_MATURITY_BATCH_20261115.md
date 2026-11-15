# 对照《产品成熟度审查》的一轮功能增强（2026-11-15）

依据 `MATURITY_BENCHMARK_AND_ROADMAP.md` 的 Phase 1 建议，本轮聚焦“阅读器闭环 + 高频桌面操作 + AI 对话可用性”。文档中更重的 Phase 2/3（多标签、画中画、跨论文 RAG、多模态读图等）仍未开始，已在末尾列出。

## 一、PDF 渲染与缩放

- **双缓冲换页**：`PageView` 缩放时先按新尺寸拉伸旧 canvas 占位，新位图与文本层就绪后再原子替换，消除连续缩放白屏。
- **页内缓存**：`(doc, index, textRevision)` 缓存 `PDFPageProxy`、自然尺寸、链接、文本内容、原生块与 OCR 块；缩放只重绘，不再重复 `getTextContent` / 查询 SQLite。
- **光标中心缩放**：`prepareZoom({clientX,clientY})` 捕获页面内锚点，`useLayoutEffect` 在提交阶段同步修正 `scrollTop/scrollLeft`；工具栏/快捷键缩放锁定视口中心，文档顶部保持顶对齐。
- **分离 `registerApi` 与 `scale`**：缩放不再触发 `goTo` 二次跳动；工具栏缩放不再丢掉水平偏移。
- **响应式适配**：`zoomMode = custom | fit-width | fit-page` 持久化；`ResizeObserver` 在单/双栏切换、侧栏收放、拖动分隔条、窗口缩放时重新适配，且以**当前激活栏**为基准（译文模式不再失效）。
- **缩放范围/手感**：统一 `40%–400%`，滚轮改为指数步进；支持 `Ctrl/Cmd + + / - / 0`；新增“一键适应页宽”；支持 **Space+拖拽** 与鼠标 **中键拖拽** 抓手平移。

## 二、阅读器双语/查找闭环

- **译文块入库**：译文 `<PdfPane>` 接入 `onBlocks`，逐页把译文文本块写入 `blocks`（`version_id` 为译文版本），激活 `ai.rs` 的跨语言检索。
- **激活栏感知**：`activeSide` 记录当前原文/译文栏；`Ctrl+F`、目录大纲、缩略图、适应页宽都指向当前激活栏；译文模式可搜中文。
- **查找增强**：300ms 防抖实时定位；新增区分大小写；**所有命中常驻半透明高亮**（当前命中橙色），不再只画一个孤立框。
- **批注版本**：阅读位置/批注跳转会同时切换激活栏。

## 三、论文库高频操作

- **批量 RPC**：新增 `bulk_set_status` / `bulk_trash` / `bulk_restore` / `bulk_purge` / `empty_trash`，事务化，替代前端 `for...of` 串行 IPC。
- **回收站闭环**：回收站表格/卡片开放多选框与全选；批量“恢复所选 / 永久删除 / 清空回收站”。
- **详情抽屉自动保存**：字段/标签/分类切换后 900ms 防抖自动保存；保存中/已保存状态提示；关闭时先 flush；冲突错误保留在面板。
- **抽屉内编辑目录**：分类胶囊多选（含层级路径），保存时连同 `category_ids` 提交。

## 四、AI 对话

- **自定义 OpenAI 兼容 API 多轮上下文**：`ai.rs::explain` 现在读取该论文最近 6 轮问答并拼入 messages（与 Codex 通道对齐）。
- **对话管理**：新增 `ai_clear` / `ai_delete` RPC；阅读器支持清空本篇对话、删除单条问答、按原问题重新生成。

## 五、任务中心

- `get_job` 联表返回论文标题；任务列表显示标题、状态胶囊、页码/全文、开始时间、耗时。
- 错误详情可展开复制；支持 `Escape`/遮罩关闭；运行中任务可直接停止，失败/取消可重试。

## 六、验证

```bash
cd app && PATH=/home/bynshard/.local/node22/bin:$PATH npm test   # 11 files / 41 tests + 46 node tests
cd app && PATH=/home/bynshard/.local/node22/bin:$PATH npm run build
cd core && PATH=$HOME/.cargo/bin:$PATH cargo test --release --locked --offline  # 49 passed / 4 ignored
```

Playwright 视觉回归覆盖阅读器缩放/查找/选区、任务中心、详情抽屉、回收站等（`app/e2e/visual-check.mjs`）。

## 七、尚未落地（下一批优先级建议）

1. 旧译文批注迁移（需页码/坐标预览与回滚 UI）；补充材料翻译与双栏段落对齐已完成，
   见 [SCHEMA_SUPPLEMENT_ALIGNMENT_20261115.md](SCHEMA_SUPPLEMENT_ALIGNMENT_20261115.md)。
2. 跨页选词合并、跨页段落匹配。
3. 区域框选截图 → 多模态 AI 读图 / 公式转 LaTeX / 表格转 Markdown（需要视觉模型与图像 IPC）。
4. 多标签页阅读、Sioyek 式悬停预览与画中画钉选。
5. 论文导读卡（Digest）与语义自动高亮层。
6. 跨论文对比矩阵 / 文件夹级联合 RAG。
7. 术语表（Glossary）管理并透传 BabelDOC `--glossary-files`。
8. 重复论文无损合并 `merge_papers`；BibTeX/RIS 导入；Watch Folder；引文格式（GB/T 7714 等）与一键复制。
9. 结构化笔记编辑器、批注汇总导出、智能文件夹。
10. 后台解析/OCR 任务队列、PDF Range 流式读取；`schema_version` 迁移台账与升级前快照已完成。
