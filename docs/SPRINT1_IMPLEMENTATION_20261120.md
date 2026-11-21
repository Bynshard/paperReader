# Sprint 1 实施记录：必修 Defect 与并发纠偏

实施日期 2026-11-20 ｜ 基线 `6892fed`（工作区含此前未提交的文档/产物改动）｜ 任务来源 [vivo Pad 5 Pro 适配与全栈审查](VIVO_PAD5_PRO_REVIEW_AND_DESIGN.md) 第 6 节 Sprint 1（T1.1–T1.5）。

只做 Sprint 1，不做 Sprint 2 的触屏/手写笔/局域网 PWA（T2.x）。本文每一条都对应实际代码改动与可复现的验证结果；没验证的写在“未验证”里。

## 0. 结果

| 任务 | 状态 | 关键证据 |
| --- | --- | --- |
| T1.1 版本关联与译文模型名 | 完成 | `paper_json` 返回 `source_version_id`；新增测试 `paper_json_exposes_the_source_version_binding` |
| T1.2 目录/标签删除同步 | 完成 | `apply()` 处理 `Value::Null`；新增测试 `deletion_commits_remove_folders_tags_and_their_links` |
| T1.3 双栏对齐串栏 + 段落合并 | 完成 | `nearestBlock` 加 X 轴同栏约束；`groupBlocks` 两遍合并 |
| T1.4 三个前端 Bug | 完成 | 查找高亮、批注取色、Inspector 误标脏 |
| T1.5 执行器拆分 + 原生 bigram + 网关 SSE/取消 | 完成 | 4+1+4 执行器；`han_bigrams` 标量函数；`chat_stream` + `ai_cancel` |

回归（全部实际执行）：

```text
core:  cargo test --release --locked      → 62 passed; 0 failed; 4 ignored
app:   npx tsc --noEmit                   → 0 error
app:   npx vitest run                     → 11 files / 44 tests passed
app:   node tests/run-node-tests.cjs       → 46 tests, 0 failed
app:   npm run build                      → ✓ built（Reader chunk 843 kB，体积警告为既有）
smoke: moonlight-core JSONL 直连           → ping / ai_cancel / list_jobs / shutdown 正常；
                                             import_pdfs 走本地写者、list_papers_page 走只读池，两个执行器互不阻塞
```

> 本机默认 Node 是 18，vitest/vite 5 需要 `node:util.styleText`（Node ≥20.12），所以前端验证用 `/tmp/node-v22.14.0-linux-x64/bin` 下的 Node 22 执行。这是本机环境问题，不动 `package.json`。

## 1. T1.1 版本关联与译文模型名（`core/src/library.rs`）

**问题**：`versions` 表已有 `source_version_id`，但 `paper_json()` 的 SELECT 漏选，前端拿到的译文版本该字段恒为 `undefined`，`Reader.tsx` 只能回退到“第一个源版本”，补充材料的译文因此挂到主文档下，切回补充材料看不到自己的译文。`attach_translation` 写 `model` 时也还在读环境变量，热更新网关后记录的是旧模型名。

**改动**：

- `paper_json()`：SELECT 追加 `source_version_id`（第 11 列），JSON 输出 `"source_version_id": r.get::<_, Option<String>>(11)?`，原列顺序不变。
- `attach_translation()`：`model` 先取当前网关 `self.gateway().map(|g| g.model)`，再回落 `MOONLIGHT_MODEL`；取值放在 `self.conn()` 加锁之前，网关互斥量只在 clone 时短暂持有，不引入锁序问题。

**测试**：`library::gateway_tests::paper_json_exposes_the_source_version_binding`——建 source 版本 + 带 `source_version_id` 的 translated 版本，断言 `get_paper()` 返回该字段且 source 版本为 null。

## 2. T1.2 目录/标签删除同步（`core/src/sync_model.rs`）

**问题**：`apply()` 对 `category:` / `tag:` 只处理 `!doc.is_null()` 的 upsert，删除提交（`Value::Null`）被静默吞掉；A 端删目录/标签，B 端不删，下一次同步还可能把已删条目推回。

**改动**：

- `tag:<name>` + null：按 name 查 tag id（`optional()`，查不到即 no-op），删 `paper_tags` 关联，再删 `tags` 行。
- `category:<id>` + null：先把该目录的直接子目录 `parent_id` 提升为被删目录的 `parent_id`（不留孤儿），再删 `paper_categories` 关联，最后删 `categories` 行。
- 非 null 的 upsert 行为保持不变（全局标签仍走 append-only 语义）。

**测试**：`deletion_commits_remove_folders_tags_and_their_links`——删除生效、重复 apply 幂等、子目录被提升到父级、`export()` 不再包含被删 key。

**已知语义边界**：`apply()` 本身不开事务，依赖调用方（`sync.rs` 的所有调用点都在事务里）。若未来有直接 `&Connection` 调用的新入口，需要自己包事务。

## 3. T1.3 双栏对齐串栏与段落粒度（`app/src/Reader.tsx`、`app/src/PdfPane.tsx`）

**对齐串栏**：`nearestBlock(blocks, targetY)` 只比较 Y 中心，双栏页左右两栏在同一 Y 区间，约一半概率高亮对侧栏。改为 `nearestBlock(blocks, targetY, sourceX?, pageWidth?)`：

- `sourceX` 为源块归一化 `[x0/w, x1/w]`；候选与源块水平重叠 > 50%，或两者中心距 < 0.22 页宽，即视为同栏；
- 同栏候选非空时只在其中取 Y 最近；为空退回原 Y-only（保持旧行为，不制造“找不到对齐”）。
- 两处调用（邻居页滚动同步、`alignPoint` 悬停/点击对齐）都传入源块归一化 x 与页宽。

**段落粒度**：`groupBlocks` 原来只在同一水平基线上拼碎片，`blocks` 表里是一堆单行。改为两遍：

1. 第一遍保持原“同行拼接”；
2. 第二遍按栏分桶（左 / 右 / 通栏 > 60% 页宽），相邻行满足“水平重叠 > 50%、左缘差 < h×2.5、行距 0 ≤ dy < h×1.65、同栏、行高不超中位行高 2.5 倍、且不是字母占比 < 45% 的公式碎片”才合并成自然段；bbox 取并集、text 空格连接，最终按 (y, x) 排序保证阅读顺序。

这同时改善 AI 证据检索的上下文完整性（检索按 block 取文本）。

## 4. T1.4 三个前端 Bug（`app/src/Reader.tsx`、`app/src/Inspector.tsx`）

1. **双栏滚动清空查找高亮**：清空 `findMatches` 的 effect 去掉 `activeSide` 依赖，只在原文/译文版本变化时清空；FindBar 关闭与 Esc 仍显式清空。
2. **写批注硬编码黄色**：新增 `draftColor`（默认 yellow）。批注态下点颜色圆点只切 `draftColor`（选中态有描边 + `aria-pressed`），「保存批注」用 `draftColor` 并复位；非批注态点圆点仍是“直接保存高亮”，行为不变。
3. **Inspector 自动补全误标脏**：`fill()` 先落盘用户未保存的编辑，拿到 `fresh` 后更新字段、`version.current++`、`setDirty(false)`、`setSaveState("saved")`，不再触发 900ms 后的二次写库与乐观锁冲突。

## 5. T1.5 后端并发、bigram 与网关流式

### 5.1 执行器拆分（`core/src/main.rs`）

原来一个 `sync_channel(16)` + 单 worker 消费所有重方法：一次 300s 的 AI 问答会把连接测试、引用量刷新、划词翻译全部堵死。现在三类：

| 执行器 | 线程 | 队列 | 方法 |
| --- | --- | --- | --- |
| AI/网络池 | 4 | 16 | `explain`、`translate_text`、`translation_probe`、`refresh_citations`、`refresh_metadata`、`check_babeldoc` |
| 本地单写者 | 1 | 8 | `import_pdfs`、`zotero_import`、`zotero_api_import`、`export`、`backup_create`、`backup_restore` |
| 只读池 | 4 | 32 | `list_papers_page`（每请求一个快照事务） |

队列都在 `recv` 时短暂持锁、请求本体在锁外执行，慢请求不占队列锁；队列满仍返回原错误文案，不丢请求。退出顺序：stdin EOF → 关闭三个发送端 → join 全部 worker（已入队请求执行完）→ `shutdown`，然后等 3s 活跃任务。

**语义变化（需要注意）**：跨执行器不再保证“先到先执行”。实测 smoke 里连续发 `import_pdfs` 与 `list_papers_page`，列表可能在导入完成前返回 0 条——这是拆并发池的必然结果。现有前端流程都是 `await` 写入结果后再刷新列表，不受影响；**新增调用方必须先等写操作返回再读**，不要依赖队列顺序。

### 5.2 原生 `han_bigrams`（`core/src/search.rs`）

触发器与回填 SQL 原来用 `WITH RECURSIVE pos(i) + substr(text,i,1)` 生成汉字二元组：SQLite 按字节定位第 i 个字符，长文本是 O(L²)，万篇导入/重建索引时写放大明显。

- 新增 `pub fn register(conn)`：以 `SQLITE_UTF8 | SQLITE_DETERMINISTIC` 注册 `han_bigrams(text)`，NULL 进 NULL 出，输出 `cjk::han_bigrams(text).join(" ")`（与旧 `group_concat` 输出一致）。
- 触发器与回填语句改为 `han_bigrams(<expr>)`，纯英文/空白行不写空串。
- **触发器升级**：旧库里的触发器是 `CREATE TRIGGER IF NOT EXISTS` 建的，改 SQL 不会生效；现在每次 `initialize` 对 6 个触发器 `DROP IF EXISTS` 后重建，幂等。
- 注册点：`Library::new` 的写连接、`main.rs` 的 4 条只读连接、`search::initialize` 自身兜底。

> 实现说明：`core/Cargo.toml` 的 rusqlite 只启用 `bundled` + `backup`，没有 `functions` feature，所以 `Connection::create_scalar_function` 不可用。为守住“只改 main.rs/search.rs”，注册走 `rusqlite::ffi::sqlite3_create_function_v2`（`SQLITE_TRANSIENT` 复制结果内存）。后续若愿意在 `Cargo.toml` 加 `features = ["functions"]`，可换成官方安全 API，行为一致（列为后续小项）。

### 5.3 网关优雅退出 + SSE 流式 + 可取消（`core/src/engine.rs`、`core/src/ai.rs`、`core/src/library.rs`、`core/src/main.rs`、`app/electron/ai-service.cjs`、`app/src/Reader.tsx`）

- **端口/线程泄漏**：`Gateway` 持有 `Arc<tiny_http::Server>`，`shutdown()` 调 `unblock()` 让监听循环退出；`Library::install_gateway` 在替换新网关时停掉旧的。之前每次保存设置都会泄漏一个永久阻塞在 `incoming_requests()` 的线程。
- **SSE 直通**：网关识别 `"stream": true`，把上游 `text/event-stream` 以 chunked `Response::new(...)` 直接转发，不再整段 `resp.text()` 等待；用量日志新增 `"stream": true`。
- **`chat_stream`**：逐行读 SSE `data:`，累加 delta 并回调；每块前检查 `AtomicBool`，取消即断开返回 `已停止生成`。
- **`ai::explain_with(..., stream: Option<&AiStream>)`**：有流时用 `chat_stream` 并通过 `lib.emit({"event":"ai_delta","request_id":...,"answer":<累计文本>})` 推送；`explain()` 保持原签名委托给 `explain_with(..., None)`，旧调用零改动。
- **取消登记**：`Library::begin_ai_request / end_ai_request / cancel_ai`，键名 `ai:<request_id>` 与翻译任务 id 共用同一张 `cancels` 表但命名空间隔离；新增同步 RPC `ai_cancel`（不进队列，立即生效）。
- **前端**：`main.rs` 只在 `explain` 且参数带合法 `request_id` 时开启流式；`ai-service.cjs` 的 API 模式也进入 busy/current 状态，停止时调 `ai_cancel`（老调用不传 `request_id` 仍走原来的缓冲路径，测试覆盖）；`Reader.tsx` 的「停止」按钮对 Codex 与 API 两种 provider 都渲染。

## 6. 变更文件

| 文件 | 改动 |
| --- | --- |
| `core/src/library.rs` | T1.1 版本关联；`begin/end/cancel_ai_request`；`install_gateway`；写连接注册 `han_bigrams`；2 个新测试 |
| `core/src/sync_model.rs` | T1.2 删除提交处理；1 个新测试 |
| `core/src/engine.rs` | Gateway 持有 server + `shutdown()`；SSE 直通；`chat_stream`；2 个流式测试 |
| `core/src/ai.rs` | `AiStream`、`explain_with`、`ai_delta` 推送 |
| `core/src/main.rs` | 执行器拆分；`ai_cancel`；`explain` 流式接线 |
| `core/src/search.rs` | `han_bigrams` 标量函数 + 触发器重建 + 3 个新测试 |
| `app/electron/ai-service.cjs` | API 模式流式/busy/停止 |
| `app/src/Reader.tsx` | 同栏对齐、查找高亮、批注取色、停止按钮 |
| `app/src/PdfPane.tsx` | 两遍 `groupBlocks` 段落合并 |
| `app/src/Inspector.tsx` | 补全后不再误标脏 |

## 7. 未验证 / 未做

- **真机**：vivo Pad 5 Pro 上的触屏选词、双指缩放、手写笔框选、自动裁白边属 Sprint 2（T2.1），本轮未做也未在真机验证；Sprint 1 只在组件/单元层面验证。
- **真实模型账号**：SSE 流式与取消用本地 mock 上游验证（`relay_streams_deltas_and_returns_the_full_answer`、`streamed_chat_stops_when_cancelled`），**未用真实 API Key 跑过端到端问答**。
- **Range 流式 PDF**（T2.3）、Schema v3 阅读位置（T2.2）、局域网 `--serve`（T2.3）都还没做。

## 8. 新发现（未在本轮修）

1. `zotero_local::import` 持有写连接 `MutexGuard` 贯穿整个导入循环，循环内做 `sha256_file`、`fs::copy` 等重 IO，期间所有 `get_paper`/`add_annotation` 被阻塞。属“粗粒度锁”问题，改动面比 Sprint 1 大，留到 Sprint 4 的重构批次。
2. `ai::load_evidence_detailed` 在纯读检索期间持锁（无网络），风险低。
3. 本次调试中发现的一个**测试自身**的死锁写法：测试先 `let conn = lib.conn()` 持写连接，又调 `f.page()` 内部再次 `lib.conn()`，std `Mutex` 不可重入 → 永挂。已改为作用域释放。后续新增测试要避免“持 `lib.conn()` 再调用任何 `lib.*` 方法”。
4. `reload_gateway` 现在会停掉旧网关：正在进行中的流式回答可能被中断。当前属可接受行为（保存配置是显式动作），但若要做“无感热更新”，需要等旧网关的活动请求结束（例如引用计数后再 `unblock`）。
