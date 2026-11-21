//! SQLite owns filtering, ordering and pagination. List rows never load PDF
//! versions, abstracts, notes or per-paper relationship queries.
//!
//! 检索分三套索引，都在 SQLite 内部与 `papers` 关联后排序分页，匹配集合
//! 不再被拉回 Rust 再通过 `json_each` 传回：
//! * `papers_search` / `blocks_search` / `short_notes_search`：trigram 外部内容
//!   表，负责 >= 3 个字符的子串检索（中英文都可以）；
//! * `blocks_bigram`：相邻汉字二元组 FTS5 索引，专门解决 trigram 查不到
//!   的二字词（“蒸馏/量化/微调”）与中文正文命中；
//! * `blocks_fts`：unicode61 前缀检索，兜住 1~2 个字符的拉丁缩写（“RL/LM”）
//!   和 1 个汉字的场景。
//!
//! 二元组的切分规则以 [`crate::cjk::han_bigrams`] 为唯一实现：`initialize`
//! 在连接上注册 `han_bigrams(text)` 标量函数，触发器与回填 SQL 直接调用它，
//! 不再用 `WITH RECURSIVE` + `substr()` 在 SQLite 里按字节定位字符（O(L^2)）。
use crate::cjk;
use anyhow::Result;
use rusqlite::{ffi, params, params_from_iter, types::Value as SqlValue, Connection, OptionalExtension};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Mutex;

/// Per-connection temporary table that materialises the FTS rowid match set once.
const MATCH_TABLE: &str = "tmp_match_papers";

/// 注册 `han_bigrams(text)` 标量函数（UTF-8、确定性、NULL 进 NULL 出）。
///
/// 二元组索引的触发器与回填 SQL 都调用这个函数，所以**任何可能写入
/// `papers`/`blocks` 的连接都必须先注册**；只读连接不会执行触发器，但注册
/// 本身幂等且无副作用，调用方不必区分读写。`initialize` 也会调用它，因此
/// 走正常初始化的写连接一定可用。
///
/// 说明：本 crate 的 `rusqlite` 只开了 `bundled` + `backup` 特性，
/// `Connection::create_scalar_function` 需要额外开启 `functions` 特性；为了
/// 不扩大改动面（只改 `search.rs`/`main.rs`），这里通过 `rusqlite::ffi`
/// 直接注册同一套 `SQLITE_UTF8 | SQLITE_DETERMINISTIC` 函数。
pub fn register(conn: &Connection) -> rusqlite::Result<()> {
    // SAFETY: `conn.handle()` 只在该连接存活期间使用；回调只读取 SQLite 传入的
    // 参数，并在返回前把结果交给 SQLite（SQLITE_TRANSIENT 会复制结果内存）。
    unsafe {
        let rc = ffi::sqlite3_create_function_v2(
            conn.handle(),
            b"han_bigrams\0".as_ptr().cast(),
            1,
            ffi::SQLITE_UTF8 | ffi::SQLITE_DETERMINISTIC,
            std::ptr::null_mut(),
            Some(han_bigrams_scalar),
            None,
            None,
            None,
        );
        if rc != ffi::SQLITE_OK {
            return Err(rusqlite::Error::SqliteFailure(
                ffi::Error::new(rc),
                Some("register scalar function han_bigrams".into()),
            ));
        }
    }
    Ok(())
}

/// `han_bigrams(text)` 的 C 实现：切分规则与 [`crate::cjk::han_bigrams`] 完全
/// 一致，二元组之间用空格连接（与旧 SQL `group_concat(...,' ')` 的输出一致）。
unsafe extern "C" fn han_bigrams_scalar(
    ctx: *mut ffi::sqlite3_context,
    _argc: i32,
    argv: *mut *mut ffi::sqlite3_value,
) {
    let value = *argv;
    if value.is_null() || ffi::sqlite3_value_type(value) == ffi::SQLITE_NULL {
        ffi::sqlite3_result_null(ctx);
        return;
    }
    let text = ffi::sqlite3_value_text(value);
    if text.is_null() {
        ffi::sqlite3_result_null(ctx);
        return;
    }
    let len = ffi::sqlite3_value_bytes(value).max(0) as usize;
    let bytes = std::slice::from_raw_parts(text, len);
    match std::str::from_utf8(bytes) {
        Ok(text) => {
            let joined = cjk::han_bigrams(text).join(" ");
            // SQLITE_TRANSIENT: SQLite 复制 joined 的字节，不依赖 Rust 的分配。
            ffi::sqlite3_result_text(
                ctx,
                joined.as_ptr().cast(),
                joined.len() as i32,
                ffi::SQLITE_TRANSIENT(),
            );
        }
        // SQLite 的 TEXT/MATCH 输入按约定都是 UTF-8，这里只做防御。
        Err(_) => ffi::sqlite3_result_error(
            ctx,
            b"han_bigrams: invalid utf-8\0".as_ptr().cast(),
            -1,
        ),
    }
}

pub fn initialize(conn: &Connection) -> Result<()> {
    // 触发器里会调用 han_bigrams()，必须先为这条连接注册函数。
    register(conn)?;
    let legacy_migrated: bool = conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE name='blocks_fts_insert_v2')", [], |r| r.get(0))?;
    if !legacy_migrated {
        conn.execute_batch(include_str!("../../moonlight/block_fts.sql"))?;
    }
    // External-content FTS indexes, maintained by triggers for *all* writers
    // (including Zotero import). Rebuild only when creating an index.
    for (index, table, fields) in [
        ("papers_search", "papers", "title,authors,doi,arxiv,abstract"),
        ("blocks_search", "blocks", "text"),
        ("short_notes_search", "papers", "short_note"),
    ] {
        let exists: bool = conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE name=?)", [index], |r| r.get(0))?;
        if exists { continue; }
        let columns: Vec<&str> = fields.split(',').collect();
        let new_values = columns.iter().map(|c| format!("new.{c}")).collect::<Vec<_>>().join(",");
        let old_values = columns.iter().map(|c| format!("old.{c}")).collect::<Vec<_>>().join(",");
        conn.execute_batch(&format!(r#"
            BEGIN;
            CREATE VIRTUAL TABLE {index} USING fts5({fields},content='{table}',content_rowid='rowid',tokenize='trigram');
            CREATE TRIGGER {index}_insert AFTER INSERT ON {table} BEGIN
                INSERT INTO {index}(rowid,{fields}) VALUES(new.rowid,{new_values});
            END;
            CREATE TRIGGER {index}_delete AFTER DELETE ON {table} BEGIN
                INSERT INTO {index}({index},rowid,{fields}) VALUES('delete',old.rowid,{old_values});
            END;
            CREATE TRIGGER {index}_update AFTER UPDATE OF {fields} ON {table} BEGIN
                INSERT INTO {index}({index},rowid,{fields}) VALUES('delete',old.rowid,{old_values});
                INSERT INTO {index}(rowid,{fields}) VALUES(new.rowid,{new_values});
            END;
            INSERT INTO {index}({index}) VALUES('rebuild');
            COMMIT;
        "#))?;
    }
    initialize_bigram(conn)?;
    Ok(())
}

fn initialize_bigram(conn: &Connection) -> Result<()> {
    // 正文块：二字词正文命中（“蒸馏/量化/微调”）。
    ensure_bigram_index(conn, "blocks_bigram", "blocks", "new.text", "b.text", "text")?;
    // 论文元数据：二字词标题/作者/速记命中，不再整表 LIKE。
    ensure_bigram_index(conn, "papers_bigram", "papers", PAPER_BIGRAM_NEW, PAPER_BIGRAM_ROW, "title,authors,doi,short_note")?;
    Ok(())
}

/// 二元组（bigram）索引：`trigram` 至少要 3 个字符才能命中，`unicode61` 又把
/// 整句中文当成一个 token，所以“蒸馏/量化/微调”这类二字词此前只能退化到
/// `papers`/`blocks` 全表 LIKE。这里为正文块和论文元数据各维护一份
/// “相邻汉字二元组”的 FTS5 索引。
///
/// 索引维护方式很关键：写入方不止一个（导入粗文本、逐页解析、Zotero、同步、
/// 元数据编辑、级联删除），所以二元组由 **SQL 触发器**生成，而不是在 Rust 里
/// 逐个写入点挂钩子。删除走“触发器删内容表行 + 内容表触发器同步 FTS”，
/// `ON DELETE CASCADE` 触发的行删除同样会命中，不会留下孤儿 token。
///
/// 触发器每次初始化都 `DROP` 后重建：旧库里的触发器是递归 CTE 版本，只有
/// 重建才能被 `han_bigrams()` 版本替换，且重建是幂等的。
fn ensure_bigram_index(
    conn: &Connection,
    index: &str,
    table: &str,
    new_text: &str,
    row_text: &str,
    watched_columns: &str,
) -> Result<()> {
    let existed: bool = conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE name=?)", [index], |r| r.get(0))?;
    let insert_rows = bigrams_insert_statement(index, new_text);
    conn.execute_batch(&format!(r#"
        BEGIN;
        CREATE TABLE IF NOT EXISTS {index}_src(rowid INTEGER PRIMARY KEY, bigrams TEXT NOT NULL);
        CREATE VIRTUAL TABLE IF NOT EXISTS {index} USING fts5(bigrams,content='{index}_src',content_rowid='rowid',tokenize='unicode61',detail=none);
        DROP TRIGGER IF EXISTS {index}_src_insert;
        DROP TRIGGER IF EXISTS {index}_src_delete;
        DROP TRIGGER IF EXISTS {index}_src_update;
        CREATE TRIGGER {index}_src_insert AFTER INSERT ON {index}_src BEGIN
            INSERT INTO {index}(rowid,bigrams) VALUES(new.rowid,new.bigrams);
        END;
        CREATE TRIGGER {index}_src_delete AFTER DELETE ON {index}_src BEGIN
            INSERT INTO {index}({index},rowid,bigrams) VALUES('delete',old.rowid,old.bigrams);
        END;
        CREATE TRIGGER {index}_src_update AFTER UPDATE OF bigrams ON {index}_src BEGIN
            INSERT INTO {index}({index},rowid,bigrams) VALUES('delete',old.rowid,old.bigrams);
            INSERT INTO {index}(rowid,bigrams) VALUES(new.rowid,new.bigrams);
        END;
        DROP TRIGGER IF EXISTS {index}_insert;
        DROP TRIGGER IF EXISTS {index}_delete;
        DROP TRIGGER IF EXISTS {index}_update;
        CREATE TRIGGER {index}_insert AFTER INSERT ON {table} BEGIN
            {insert_rows};
        END;
        CREATE TRIGGER {index}_delete AFTER DELETE ON {table} BEGIN
            DELETE FROM {index}_src WHERE rowid=old.rowid;
        END;
        CREATE TRIGGER {index}_update AFTER UPDATE OF {watched_columns} ON {table} BEGIN
            DELETE FROM {index}_src WHERE rowid=old.rowid;
            {insert_rows};
        END;
        COMMIT;
    "#))?;
    if !existed {
        // 迁移：为已存在的行一次性补建二元组（旧库首次启动/升级时执行一次）。
        conn.execute_batch(&format!("BEGIN; {}; COMMIT;", bigrams_backfill_statement(index, table, row_text)))?;
    }
    // 内容表与 FTS 索引必须一一对应。手动改动、异常退出或旧版本残留都会
    // 让两者不一致，此时按内容表重建即可（rebuild 只扫二元组内容表，很轻）。
    let content_rows: i64 = conn.query_row(&format!("SELECT count(*) FROM {index}_src"), [], |r| r.get(0))?;
    let index_rows: i64 = conn.query_row(&format!("SELECT count(*) FROM {index}"), [], |r| r.get(0))?;
    if content_rows != index_rows {
        conn.execute_batch(&format!("INSERT INTO {index}({index}) VALUES('rebuild')"))?;
    }
    Ok(())
}

/// 相邻汉字二元组标量表达式：直接调用连接上注册的 `han_bigrams()` 函数
/// （Rust 原生、一次线性扫描），与旧递归 CTE 的切分规则一致。
fn bigrams_expression(text: &str) -> String {
    format!("han_bigrams({text})")
}

/// 触发器里先算一次二元组，再由 `g IS NOT NULL AND g<>''` 过滤：纯英文、
/// 空白或没有相邻汉字的行不会往内容表写空串。旧实现还在派生表 WHERE 里用
/// `GLOB` 预判汉字、避免白跑递归；原生函数本身就是 O(L)，不再需要预判。
fn bigrams_insert_statement(index: &str, new_text: &str) -> String {
    format!(
        "INSERT INTO {index}_src(rowid,bigrams) SELECT new.rowid,g FROM (SELECT {} AS g) WHERE g IS NOT NULL AND g<>''",
        bigrams_expression(new_text))
}

fn bigrams_backfill_statement(index: &str, table: &str, row_text: &str) -> String {
    format!(
        "INSERT INTO {index}_src(rowid,bigrams) SELECT rowid,g FROM (SELECT b.rowid AS rowid, {} AS g FROM {table} b) WHERE g IS NOT NULL AND g<>''",
        bigrams_expression(row_text))
}

const PAPER_BIGRAM_NEW: &str =
    "new.title||' '||coalesce(new.authors,'')||' '||coalesce(new.doi,'')||' '||coalesce(new.short_note,'')";
const PAPER_BIGRAM_ROW: &str =
    "b.title||' '||coalesce(b.authors,'')||' '||coalesce(b.doi,'')||' '||coalesce(b.short_note,'')";

/// 一次检索把若干索引源 UNION 成一个 `papers.rowid` 集合的 CTE 主体。
///
/// 以 rowid（而不是 TEXT 主键）作为匹配集合的键是有意的：FTS5 的 rowid 本来就是
/// `papers.rowid`，整数集合的物化、去重与探测都远快于 36 字节的 UUID 文本，
/// 高命中查询（十万级）能省掉一半以上的时间。参数按出现顺序绑定。
fn match_sql(query: &str) -> (String, Vec<SqlValue>) {
    let quoted = format!("\"{}\"", query.replace('"', "\"\""));
    let tag_like = format!("%{}%", query.replace('!', "!!").replace('%', "!%").replace('_', "!_"));
    let tag_sql = "SELECT p.rowid FROM paper_tags pt JOIN tags t ON t.id=pt.tag_id JOIN papers p ON p.id=pt.paper_id WHERE t.name LIKE ? ESCAPE '!'";
    if query.chars().count() >= 3 {
        // Trigram 子串检索：标题/作者/摘要、正文、速记、标签。
        let sql = format!(r#"
            SELECT rowid FROM papers_search WHERE papers_search MATCH ?
            UNION SELECT p.rowid FROM blocks b JOIN papers p ON p.id=b.paper_id WHERE b.rowid IN (SELECT rowid FROM blocks_search WHERE blocks_search MATCH ?)
            UNION SELECT rowid FROM short_notes_search WHERE short_notes_search MATCH ?
            UNION {tag_sql}"#);
        (sql, vec![
            SqlValue::Text(quoted.clone()),
            SqlValue::Text(quoted.clone()),
            SqlValue::Text(quoted),
            SqlValue::Text(tag_like),
        ])
    } else if let Some(pair) = cjk::han_query(query) {
        // 汉字二字词：标题/作者/DOI/速记与正文都走二元组 FTS，不再整表 LIKE。
        // 词前缀 FTS 仍然保留，顺手兜住混合写法。
        let prefix = format!("{quoted}*");
        let sql = format!(r#"
            SELECT rowid FROM papers_bigram WHERE papers_bigram MATCH ?
            UNION {tag_sql}
            UNION SELECT p.rowid FROM blocks b JOIN papers p ON p.id=b.paper_id WHERE b.rowid IN (SELECT rowid FROM blocks_bigram WHERE blocks_bigram MATCH ?)
            UNION SELECT p.rowid FROM blocks b JOIN papers p ON p.id=b.paper_id WHERE b.rowid IN (SELECT rowid FROM blocks_fts WHERE blocks_fts MATCH ?)"#);
        let gram = SqlValue::Text(cjk::fts_phrase(pair));
        (sql, vec![gram.clone(), SqlValue::Text(tag_like), gram, SqlValue::Text(prefix)])
    } else {
        // 1~2 个拉丁字符（“RL/LM”）或单个汉字：元数据按 LIKE（很少这么查），
        // 正文走 unicode61 词前缀索引。
        let literal = query.replace('!', "!!").replace('%', "!%").replace('_', "!_");
        let like = format!("%{literal}%");
        let prefix = format!("{quoted}*");
        let sql = format!(r#"
            SELECT rowid FROM papers WHERE title LIKE ? ESCAPE '!' OR authors LIKE ? ESCAPE '!' OR doi LIKE ? ESCAPE '!' OR short_note LIKE ? ESCAPE '!'
            UNION {tag_sql}
            UNION SELECT p.rowid FROM blocks b JOIN papers p ON p.id=b.paper_id WHERE b.rowid IN (SELECT rowid FROM blocks_fts WHERE blocks_fts MATCH ?)"#);
        (sql, vec![
            SqlValue::Text(like.clone()),
            SqlValue::Text(like.clone()),
            SqlValue::Text(like.clone()),
            SqlValue::Text(like),
            SqlValue::Text(tag_like),
            SqlValue::Text(prefix),
        ])
    }
}

pub fn list_page(conn: &Connection, p: &Value) -> Result<Value> {
    let offset = p["offset"].as_i64().unwrap_or(0).max(0);
    let limit = p["limit"].as_i64().unwrap_or(100).clamp(1, 200);
    let mut filters = vec![if p["trashed"].as_bool().unwrap_or(false) {
        "p.deleted_at IS NOT NULL".to_string()
    } else { "p.deleted_at IS NULL".to_string() }];
    let mut filter_args: Vec<SqlValue> = vec![];
    if p["favorite"].as_bool().unwrap_or(false) { filters.push("p.favorite=1".into()); }
    for (key, predicate) in [
        ("status", "p.read_status=?"),
        ("category", "p.id IN (WITH RECURSIVE descendants(id) AS (SELECT id FROM categories WHERE id=? UNION SELECT c.id FROM categories c JOIN descendants d ON c.parent_id=d.id) SELECT pc.paper_id FROM paper_categories pc JOIN descendants d ON pc.category_id=d.id)"),
        ("tag", "p.id IN (SELECT pt.paper_id FROM paper_tags pt JOIN tags t ON t.id=pt.tag_id WHERE t.name=?)"),
    ] {
        if let Some(value) = p[key].as_str().filter(|s| !s.is_empty()) {
            filters.push(predicate.into()); filter_args.push(SqlValue::Text(value.into()));
        }
    }
    let query: String = p["query"].as_str().unwrap_or("").trim().chars().take(256).collect();
    // 匹配集合先落进本连接的临时表：FTS 只物化一次，随后计数与分页都读它。
    // 这样既没有“rowid 拉回 Rust 再 json_each 传回”的往返，也不像单条 CTE
    // 那样在两条语句里各跑一遍全文匹配（高命中查询的主要开销）。
    let from = if query.is_empty() {
        "papers p".to_string()
    } else {
        let (body, args) = match_sql(&query);
        conn.execute_batch(&format!(
            "CREATE TEMP TABLE IF NOT EXISTS {MATCH_TABLE}(rowid INTEGER PRIMARY KEY); DELETE FROM {MATCH_TABLE};"))?;
        conn.prepare(&format!("INSERT INTO {MATCH_TABLE}(rowid) {body}"))?
            .execute(params_from_iter(args.iter()))?;
        format!("papers p JOIN {MATCH_TABLE} m ON m.rowid=p.rowid")
    };
    let where_sql = filters.join(" AND ");
    let total: i64 = conn.query_row(
        &format!("SELECT COUNT(*) FROM {from} WHERE {where_sql}"),
        params_from_iter(filter_args.iter()), |r| r.get(0))?;
    let order = match p["sort"].as_str().unwrap_or("recent") {
        "title" => "p.title COLLATE NOCASE ASC,p.id ASC",
        "year" => "p.year DESC,p.id DESC",
        "citations" => "p.citation_count DESC,p.imported_at DESC,p.id DESC",
        _ => "p.imported_at DESC,p.id DESC",
    };
    let sql = format!("SELECT p.id,p.title,p.authors,p.year,p.venue,p.doi,p.arxiv,p.imported_at,p.updated_at,p.favorite,p.read_status,p.deleted_at IS NOT NULL,EXISTS(SELECT 1 FROM versions v WHERE v.paper_id=p.id AND v.kind='translated'),p.short_note,p.citation_count,p.citation_source,p.citation_updated_at,p.citation_url FROM {from} WHERE {where_sql} ORDER BY {order} LIMIT ? OFFSET ?");
    let mut args = filter_args;
    args.extend([SqlValue::Integer(limit), SqlValue::Integer(offset)]);
    let mut stmt = conn.prepare(&sql)?;
    let mut items = stmt.query_map(params_from_iter(args.iter()), |r| Ok(json!({
        "id":r.get::<_,String>(0)?,"title":r.get::<_,String>(1)?,"authors":r.get::<_,String>(2)?,
        "year":r.get::<_,Option<String>>(3)?,"venue":r.get::<_,Option<String>>(4)?,
        "doi":r.get::<_,Option<String>>(5)?,"arxiv":r.get::<_,Option<String>>(6)?,
        "imported_at":r.get::<_,i64>(7)?,"updated_at":r.get::<_,i64>(8)?,
        "favorite":r.get::<_,bool>(9)?,"read_status":r.get::<_,String>(10)?,
        "deleted":r.get::<_,bool>(11)?,"has_translation":r.get::<_,bool>(12)?,
        "short_note":r.get::<_,String>(13)?,"citation_count":r.get::<_,Option<i64>>(14)?,"citation_source":r.get::<_,Option<String>>(15)?,"citation_updated_at":r.get::<_,Option<i64>>(16)?,"citation_url":r.get::<_,Option<String>>(17)?,
        "categories":[],"tags":[]
    })))?.collect::<rusqlite::Result<Vec<_>>>()?;
    if !items.is_empty() {
        let ids: Vec<String> = items.iter().map(|i| i["id"].as_str().unwrap().into()).collect();
        let positions: HashMap<String,usize> = ids.iter().enumerate().map(|(i,id)|(id.clone(),i)).collect();
        let placeholders = vec!["?";ids.len()].join(",");
        for (field, relation, entity, fk) in [
            ("categories","paper_categories","categories","category_id"),
            ("tags","paper_tags","tags","tag_id"),
        ] {
            let sql = format!("SELECT r.paper_id,e.id,e.name,e.color FROM {relation} r JOIN {entity} e ON e.id=r.{fk} WHERE r.paper_id IN ({placeholders}) ORDER BY e.name,e.id");
            let mut stmt = conn.prepare(&sql)?;
            let rows = stmt.query_map(params_from_iter(ids.iter()), |r| Ok((r.get::<_,String>(0)?,json!({"id":r.get::<_,String>(1)?,"name":r.get::<_,String>(2)?,"color":r.get::<_,Option<String>>(3)?}))))?;
            for row in rows { let (id,value)=row?; if let Some(&i)=positions.get(&id) { items[i][field].as_array_mut().unwrap().push(value); } }
        }
        // Search hits: show the first body match (page + surrounding text) so a
        // reader can jump straight from the library to the paragraph. Only the
        // <=200 returned rows are queried, LIKE is literal-escaped, and the
        // candidate blocks are limited to the paper's current source PDF and
        // newest translation: blocks of superseded translations stay in the
        // table but must never become the jump target.
        if !query.is_empty() {
            let pattern = format!("%{}%", like_escape(&query));
            // Fallback tokens for phrases that a PDF wrapped across a newline:
            // `LIKE '%attention bottleneck%'` misses `attention\nbottleneck`,
            // yet every word is right there in the block.
            let tokens = query_tokens(&query);
            let mut source_stmt = conn.prepare("SELECT id FROM versions WHERE paper_id=? AND kind='source' ORDER BY created_at,id LIMIT 1")?;
            let mut translated_stmt = conn.prepare("SELECT id FROM versions WHERE paper_id=? AND kind='translated' ORDER BY created_at DESC,id DESC LIMIT 1")?;
            // 同一论文最多两个候选版本：主 source 版本优先，其次最新译文。
            let mut exact_stmt = conn.prepare("SELECT page,text,version_id FROM blocks WHERE paper_id=?1 AND version_id IN (?2,?3) AND text LIKE ?4 ESCAPE '\\' ORDER BY CASE version_id WHEN ?2 THEN 0 WHEN ?3 THEN 1 ELSE 2 END,page,block_index LIMIT 1")?;
            let mut token_stmt = if tokens.len() > 1 {
                let mut sql = String::from("SELECT page,text,version_id FROM blocks WHERE paper_id=?1 AND version_id IN (?2,?3)");
                for index in 0..tokens.len() {
                    sql.push_str(&format!(" AND text LIKE ?{} ESCAPE '\\'", index + 4));
                }
                sql.push_str(" ORDER BY CASE version_id WHEN ?2 THEN 0 WHEN ?3 THEN 1 ELSE 2 END,page,block_index LIMIT 1");
                Some(conn.prepare(&sql)?)
            } else {
                None
            };
            for item in items.iter_mut() {
                let paper_id = item["id"].as_str().unwrap().to_string();
                let source = source_stmt.query_row(params![&paper_id], |r| r.get::<_,String>(0)).optional()?.unwrap_or_default();
                let translated = translated_stmt.query_row(params![&paper_id], |r| r.get::<_,String>(0)).optional()?.unwrap_or_default();
                let exact = exact_stmt.query_row(params![&paper_id, &source, &translated, &pattern], |r| Ok((r.get::<_,i64>(0)?, r.get::<_,String>(1)?, r.get::<_,Option<String>>(2)?))).optional()?;
                let (hit, needle) = match (exact, token_stmt.as_mut()) {
                    (Some(hit), _) => (Some(hit), query.as_str()),
                    (None, Some(stmt)) => {
                        let mut args: Vec<SqlValue> = vec![SqlValue::Text(paper_id.clone()), SqlValue::Text(source.clone()), SqlValue::Text(translated.clone())];
                        args.extend(tokens.iter().map(|token| SqlValue::Text(format!("%{}%", like_escape(token)))));
                        let hit = stmt.query_row(params_from_iter(args.iter()), |r| Ok((r.get::<_,i64>(0)?, r.get::<_,String>(1)?, r.get::<_,Option<String>>(2)?))).optional()?;
                        (hit, tokens[0].as_str())
                    }
                    (None, None) => (None, query.as_str()),
                };
                if let Some((page,text,version_id)) = hit {
                    item["match_snippet"] = json!({
                        "page": page,
                        "text": snippet_around(&text, needle, 80),
                        "version_id": version_id,
                    });
                }
            }
        }
    }
    Ok(json!({"items":items,"total":total,"offset":offset,"limit":limit}))
}

/// Escape LIKE wildcards so a query containing `%` or `_` stays literal.
fn like_escape(query: &str) -> String {
    query.replace('\\', "\\\\").replace('%', "\\%").replace('_', "\\_")
}

/// Split a query for the snippet fallback: whitespace separates words, and a
/// CJK run is its own token (mixed input like `蒸馏 distillation` yields two
/// tokens). Edge punctuation is trimmed and duplicates are dropped
/// case-insensitively. Tokens are matched as case-insensitive substrings, so a
/// phrase split by a PDF line break is still found word by word.
fn query_tokens(query: &str) -> Vec<String> {
    let mut tokens: Vec<String> = Vec::new();
    let mut current = String::new();
    let mut current_han = false;
    for ch in query.chars() {
        if ch.is_whitespace() {
            push_token(&mut current, &mut tokens);
            current_han = false;
            continue;
        }
        let han = cjk::is_han(ch);
        if !current.is_empty() && han != current_han {
            push_token(&mut current, &mut tokens);
        }
        current_han = han;
        current.push(ch);
    }
    push_token(&mut current, &mut tokens);
    tokens
}

fn push_token(current: &mut String, tokens: &mut Vec<String>) {
    let trimmed = current.trim_matches(|c: char| !(c.is_alphanumeric() || cjk::is_han(c)));
    if !trimmed.is_empty() && !tokens.iter().any(|token| token.eq_ignore_ascii_case(trimmed)) {
        tokens.push(trimmed.to_string());
    }
    current.clear();
}

/// ±`radius` characters around the first case-insensitive match, newline-free.
fn snippet_around(text: &str, query: &str, radius: usize) -> String {
    let chars: Vec<char> = text.chars().collect();
    let needle: Vec<char> = query.to_lowercase().chars().collect();
    if needle.is_empty() || chars.is_empty() { return String::new(); }
    let lowered: Vec<char> = text.to_lowercase().chars().collect();
    let found = (0..=lowered.len().saturating_sub(needle.len()))
        .find(|&start| lowered[start..start + needle.len()] == needle[..]);
    let start = found.map(|index| index.saturating_sub(radius)).unwrap_or(0).min(chars.len());
    let end = found
        .map(|index| (index + needle.len() + radius).min(chars.len()))
        .unwrap_or_else(|| chars.len().min(radius * 2))
        .max(start);
    let mut snippet: String = chars[start..end].iter().collect::<String>().replace(['\n', '\r'], " ");
    if start > 0 { snippet.insert(0, '…'); }
    if end < chars.len() { snippet.push('…'); }
    snippet
}

/// 只读分页连接池：平板通过局域网 HTTP 搜索时**绝不占用写连接**。
///
/// 每次请求都是一条独立只读连接上的快照事务；连接用完后回到池里复用。
/// `max_idle` 只限制“闲置缓存”的大小，不限制并发：突发请求会临时多开连接，
/// HTTP 服务端的 `MAX_CONNECTIONS`（64）是并发上限，避免读请求排队等写锁。
///
/// 池里的连接各自持有 `tmp_match_papers` 临时表，因此并发搜索互不覆盖匹配
/// 集合（与 JSONL 只读池语义一致）。
pub struct ReadPool {
    db: PathBuf,
    idle: Mutex<Vec<Connection>>,
    max_idle: usize,
}

impl ReadPool {
    pub fn new(db: PathBuf, max_idle: usize) -> Self {
        Self { db, idle: Mutex::new(Vec::new()), max_idle: max_idle.max(1) }
    }

    fn open(&self) -> Result<Connection> {
        let conn = Connection::open_with_flags(&self.db, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)?;
        register(&conn)?;
        Ok(conn)
    }

    fn checkout(&self) -> Result<Connection> {
        if let Some(conn) = self.idle.lock().map_err(|_| anyhow::anyhow!("read pool poisoned"))?.pop() {
            return Ok(conn);
        }
        self.open()
    }

    fn release(&self, conn: Connection) {
        if let Ok(mut idle) = self.idle.lock() {
            if idle.len() < self.max_idle {
                idle.push(conn);
            }
        }
    }

    /// Run a read-only closure on a pooled connection. Used by the LAN server
    /// for light reads (`get_paper` / `list_annotations` / `list_taxonomy` /
    /// `ai_history`) so a long import or AI write cannot block the tablet.
    pub fn with_connection<T>(&self, f: impl FnOnce(&Connection) -> Result<T>) -> Result<T> {
        let conn = self.checkout()?;
        let value = f(&conn);
        self.release(conn);
        value
    }

    /// 与 [`list_page`] 相同的分页查询，但走只读连接池，不触碰 `Library::conn()`。
    pub fn list_page(&self, params: &Value) -> Result<Value> {
        let mut conn = self.checkout()?;
        let value = {
            let tx = conn.transaction()?;
            let value = list_page(&tx, params)?;
            tx.commit()?;
            value
        };
        self.release(conn);
        Ok(value)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::library::Library;
    use rusqlite::params;
    use std::sync::Arc;
    struct Fixture { lib: Option<Arc<Library>>, root: std::path::PathBuf }
    impl Fixture {
        fn new(n: usize) -> Self {
            let root=std::env::temp_dir().join(format!("moonlight-tests-{}",uuid::Uuid::new_v4()));
            let lib=Library::new(&root).unwrap();
            seed(&lib.conn(),n);
            Self { lib:Some(lib),root }
        }
        fn empty()->Self { Self::new(0) }
        fn lib(&self)->&Arc<Library> { self.lib.as_ref().unwrap() }
        fn page(&self, opts:Value)->Value { list_page(&self.lib().conn(),&opts).unwrap() }
    }
    impl Drop for Fixture {
        fn drop(&mut self) { self.lib.take(); let _=std::fs::remove_dir_all(&self.root); }
    }
    fn seed(conn:&Connection,n:usize) {
        let tx=conn.unchecked_transaction().unwrap();
        {
            let mut p=tx.prepare("INSERT INTO papers(id,title,authors,year,abstract,notes,imported_at,updated_at,favorite,read_status) VALUES(?,?,?,?,?,?,?,?,?,?)").unwrap();
            let mut v=tx.prepare("INSERT INTO versions(id,paper_id,kind,sha256,rel_path,pages,bytes,created_at) VALUES(?,?,?,?,?,2,1,0)").unwrap();
            let mut b=tx.prepare("INSERT INTO blocks(id,paper_id,version_id,page,block_index,kind,bbox,text) VALUES(?,?,?,1,0,'text','[]',?)").unwrap();
            for i in 0..n {
                let id=format!("p{i:06}");let vid=format!("v{i:06}");
                p.execute(params![id,format!("Paper {i:06} 中文研究"),"Author",format!("{}",2000+i%26),"Abstract deliberately excluded from list payload.","n".repeat(256),i as i64,i as i64,i%2,(if i%3==0 {"read"}else{"unread"})]).unwrap();
                v.execute(params![vid,id,"source",format!("hash{i}"),format!("files/{id}.pdf")]).unwrap();
                b.execute(params![format!("b{i}"),id,vid,if i%1000==0 {"sparseneedle body content"}else{"Ordinary paper body text used for benchmark indexing"}]).unwrap();
            }
        }
        tx.commit().unwrap();
    }
    /// 直接写库的小工具：验证“任何写入方”都能被触发器覆盖。
    fn insert_paper(conn:&Connection,id:&str,title:&str) {
        conn.execute("INSERT INTO papers(id,title,authors,imported_at,updated_at) VALUES(?,?,'',0,0)",params![id,title]).unwrap();
        conn.execute("INSERT INTO versions(id,paper_id,kind,sha256,rel_path,pages,bytes,created_at) VALUES(?,?,'source',?,'files/x.pdf',20,1,0)",params![format!("{id}-v"),id,id]).unwrap();
    }
    fn insert_block(conn:&Connection,paper:&str,page:i64,index:i64,text:&str) {
        conn.execute("INSERT INTO blocks(id,paper_id,version_id,page,block_index,kind,bbox,text) VALUES(?,?,?,?,?,'text','[]',?)",
            params![format!("{paper}-b{page}-{index}"),paper,format!("{paper}-v"),page,index,text]).unwrap();
    }
    fn bigram_rows(conn:&Connection,paper:&str)->i64 {
        conn.query_row("SELECT count(*) FROM blocks_bigram_src s JOIN blocks b ON b.rowid=s.rowid WHERE b.paper_id=?",params![paper],|r|r.get(0)).unwrap()
    }
    #[test]
    fn pagination_is_bounded_stable_and_lightweight() {
        let f=Fixture::new(250);
        let a=f.page(json!({"limit":100}));let b=f.page(json!({"limit":100,"offset":100}));
        assert_eq!(a["total"],250);assert_eq!(a["items"].as_array().unwrap().len(),100);
        assert_eq!(a["items"][0]["id"],"p000249");assert_eq!(b["items"][0]["id"],"p000149");
        assert!(a["items"][0].get("abstract").is_none());assert!(a["items"][0].get("versions").is_none());
        assert_eq!(f.page(json!({"limit":10000}))["items"].as_array().unwrap().len(),200);
        assert_eq!(f.page(json!({"offset":9999}))["total"],250);
    }
    #[test]
    fn read_pool_pages_without_the_write_connection() {
        let f=Fixture::new(12);
        let pool=ReadPool::new(f.root.join("library.db"),2);
        // 持有唯一的写连接（SQLite WAL 下写锁不影响读快照），池仍然能分页。
        let write=f.lib().conn();
        let page=pool.list_page(&json!({"limit":5})).unwrap();
        assert_eq!(page["total"],12);
        assert_eq!(page["items"].as_array().unwrap().len(),5);
        // 复用池里的连接执行第二次分页，行为与首次一致。
        let again=pool.list_page(&json!({"limit":5,"offset":5})).unwrap();
        assert_eq!(again["total"],12);
        assert_ne!(page["items"][0]["id"],again["items"][0]["id"]);
        let count=pool.with_connection(|conn| Ok(conn.query_row("SELECT count(*) FROM papers",[],|r|r.get::<_,i64>(0))?)).unwrap();
        assert_eq!(count,12,"generic read closure reuses a pooled connection");
        drop(write);
    }
    #[test]
    fn full_text_query_returns_the_first_matching_page_snippet() {
        let f=Fixture::new(2000);
        let page=f.page(json!({"query":"sparseneedle","limit":5}));
        assert_eq!(page["total"],2,"seed marks every 1000th paper with the needle");
        let item=&page["items"][0];
        let snippet=&item["match_snippet"];
        assert!(snippet.is_object(),"query result must carry a snippet: {item}");
        assert!(snippet["text"].as_str().unwrap().contains("sparseneedle"));
        assert!(snippet["page"].as_i64().unwrap()>=0);
        // Literal wildcards must not turn the LIKE fallback into a full scan.
        let percent=f.page(json!({"query":"100%"}));
        assert_eq!(percent["total"],0,"% is escaped as a literal, not a wildcard");
    }
    #[test]
    fn phrase_wrapped_across_a_newline_still_yields_a_body_snippet() {
        let f=Fixture::empty();
        {
            let conn=f.lib().conn();
            // 标题命中 trigram 索引，让论文出现在结果里；正文里两个词被 PDF
            // 换行拆开，连续子串 LIKE 查不到，必须靠分词回退定位到第 3 页。
            insert_paper(&conn,"wrapped-phrase","The attention bottleneck in transformers");
            insert_block(&conn,"wrapped-phrase",3,0,"We show that the attention\nbottleneck limits long-context recall.");
        }
        let page=f.page(json!({"query":"attention bottleneck"}));
        assert_eq!(page["total"],1);
        let item=&page["items"][0];
        let snippet=&item["match_snippet"];
        assert!(snippet.is_object(),"跨行短语也必须给出 match_snippet: {item}");
        assert_eq!(snippet["page"],3);
        let text=snippet["text"].as_str().unwrap();
        assert!(text.contains("attention")&&text.contains("bottleneck"),"摘要应围绕第一个词: {text}");
        assert_eq!(snippet["version_id"],"wrapped-phrase-v");
    }
    #[test]
    fn snippet_ignores_superseded_translations_and_uses_the_latest() {
        let f=Fixture::empty();
        {
            let conn=f.lib().conn();
            insert_paper(&conn,"retranslated","Retranslated paper with two translations");
            insert_block(&conn,"retranslated",0,0,"source body has no hit");
            // 旧译文仍留在 blocks 表里（页 2），但已经不是有效译文；若不按版本
            // 过滤，它会在 (page, block_index) 顺序下抢到 match_snippet。
            conn.execute("INSERT INTO versions(id,paper_id,kind,sha256,rel_path,pages,bytes,created_at) VALUES('trans-old','retranslated','translated','old','derived/old.pdf',5,1,100)",[]).unwrap();
            conn.execute("INSERT INTO blocks(id,paper_id,version_id,page,block_index,kind,bbox,text) VALUES('old-hint','retranslated','trans-old',2,0,'text','[]','过时译文里的 attention bottleneck 旧片段')",[]).unwrap();
            // 最新的重译版本（页 9）：摘要与页码都必须取自这一版。
            conn.execute("INSERT INTO versions(id,paper_id,kind,sha256,rel_path,pages,bytes,created_at) VALUES('trans-new','retranslated','translated','new','derived/new.pdf',9,1,200)",[]).unwrap();
            conn.execute("INSERT INTO blocks(id,paper_id,version_id,page,block_index,kind,bbox,text) VALUES('new-hint','retranslated','trans-new',9,0,'text','[]','最新译文里的 attention bottleneck 新片段')",[]).unwrap();
        }
        let page=f.page(json!({"query":"attention bottleneck"}));
        assert_eq!(page["total"],1);
        let item=&page["items"][0];
        let snippet=&item["match_snippet"];
        assert!(snippet.is_object(),"最新译文里命中就必须给出 match_snippet: {item}");
        assert_eq!(snippet["version_id"],"trans-new","淘汰的旧译文不能成为跳转目标");
        assert_eq!(snippet["page"],9);
        let text=snippet["text"].as_str().unwrap();
        assert!(text.contains("新片段")&&!text.contains("旧片段"),"{text}");
    }
    #[test]
    fn sort_and_filters_execute_before_pagination() {
        let f=Fixture::new(80);
        assert_eq!(f.page(json!({"sort":"title","limit":1}))["items"][0]["id"],"p000000");
        assert_eq!(f.page(json!({"sort":"year","limit":1}))["items"][0]["year"],"2025");
        assert_eq!(f.page(json!({"favorite":true}))["total"],40);
        assert_eq!(f.page(json!({"status":"read"}))["total"],27);
        let cat=f.lib().add_category("test-category").unwrap();
        f.lib().set_categories("p000001",vec![cat["id"].as_str().unwrap().into()]).unwrap();
        f.lib().set_tags("p000001",vec!["topic".into()]).unwrap();
        assert_eq!(f.page(json!({"category":cat["id"],"tag":"topic","favorite":true}))["total"],1);
        assert_eq!(f.page(json!({"tag":"topic"}))["items"][0]["tags"][0]["name"],"topic");
    }
    #[test]
    fn indexed_substring_search_handles_chinese_body_and_literal_syntax() {
        let f=Fixture::new(12);
        assert_eq!(f.page(json!({"query":"中文研"}))["total"],12);
        assert_eq!(f.page(json!({"query":"sparseneedle"}))["total"],1);
        assert_eq!(f.page(json!({"query":"000004"}))["items"][0]["id"],"p000004");
        assert_eq!(f.page(json!({"query":"\" OR * - %"}))["total"],0);
        assert_eq!(f.page(json!({"query":"%"}))["total"],0);
        assert_eq!(f.page(json!({"query":"不存在"}))["total"],0);
    }
    #[test]
    fn two_character_chinese_matches_body_and_title() {
        let f=Fixture::empty();
        {
            let conn=f.lib().conn();
            insert_paper(&conn,"title-only","知识蒸馏的工程实践");
            insert_paper(&conn,"body-only","An unrelated English title");
            insert_block(&conn,"body-only",0,0,"我们使用知识蒸馏把 70B 模型压缩到四分之一。");
            insert_paper(&conn,"nothing","Nothing here");
            insert_block(&conn,"nothing",0,0,"ordinary body text about graphics");
            // 二元组索引确实由触发器写入（正文命中不再依赖 LIKE 全表扫描）
            assert!(bigram_rows(&conn,"body-only")>=1);
        }
        assert_eq!(f.page(json!({"query":"蒸馏"}))["total"],2,"标题与正文都要能命中");
        assert_eq!(f.page(json!({"query":"量化"}))["total"],0);
        // 同一批数据换成长度 >=3 的查询走 trigram，行为保持一致。
        assert_eq!(f.page(json!({"query":"知识蒸"}))["total"],2);
    }
    #[test]
    fn two_letter_acronym_matches_body_text() {
        let f=Fixture::empty();
        {
            let conn=f.lib().conn();
            insert_paper(&conn,"rl-paper","Reinforcement learning for agents");
            insert_block(&conn,"rl-paper",0,0,"We train the agent with RL and compare against a PPO baseline.");
            insert_paper(&conn,"other","Graphics rendering");
            insert_block(&conn,"other",0,0,"ordinary body text about graphics");
        }
        assert_eq!(f.page(json!({"query":"RL"}))["total"],1);
        assert_eq!(f.page(json!({"query":"rl"}))["total"],1);
        assert_eq!(f.page(json!({"query":"LM"}))["total"],0);
    }
    #[test]
    fn two_character_query_counts_and_pages_inside_sqlite() {
        // 240 篇都在标题里含“中文”：匹配集合完全由 SQL 内部关联计数与分页。
        let f=Fixture::new(240);
        let a=f.page(json!({"query":"中文","limit":100}));
        let b=f.page(json!({"query":"中文","limit":100,"offset":100}));
        assert_eq!(a["total"],240);
        assert_eq!(a["items"].as_array().unwrap().len(),100);
        assert_eq!(a["items"][0]["id"],"p000239");
        assert_eq!(b["items"][0]["id"],"p000139");
        let beyond=f.page(json!({"query":"中文","offset":999}));
        assert_eq!(beyond["items"].as_array().unwrap().len(),0);
        assert_eq!(beyond["total"],240);
        // 排序与过滤仍然在分页之前生效。
        assert_eq!(f.page(json!({"query":"中文","sort":"title","limit":1}))["items"][0]["id"],"p000000");
        assert_eq!(f.page(json!({"query":"中文","favorite":true}))["total"],120);
    }
    #[test]
    fn query_paging_combines_filters_and_partial_matches() {
        let f=Fixture::new(120);
        // "sparseneedle" 只出现在 i%1000==0 的正文块里（这里是 p000000）。
        assert_eq!(f.page(json!({"query":"sparseneedle","limit":10}))["total"],1);
        let q=f.page(json!({"query":"中文研","sort":"title","limit":10}));
        assert_eq!(q["total"],120);
        assert_eq!(q["items"][0]["id"],"p000000");
        assert_eq!(f.page(json!({"query":"中文研","favorite":true}))["total"],60);
        assert_eq!(f.page(json!({"query":"中文研","status":"read"}))["total"],40);
        assert_eq!(f.page(json!({"query":"中文研","sort":"year","limit":1}))["items"][0]["year"],"2025");
    }
    #[test]
    fn bigram_index_tracks_set_blocks_updates_and_deletes() {
        let f=Fixture::new(1);
        let data=vec![json!({"text":"稀疏量化推理加速","bbox":[]})];
        f.lib().set_blocks("p000000","v000000",0,data).unwrap();
        assert_eq!(f.page(json!({"query":"量化"}))["total"],1);
        assert_eq!(bigram_rows(&f.lib().conn(),"p000000"),1);
        // 同页重写：旧二元组必须被触发器清掉，否则会命中已删除的文本。
        f.lib().set_blocks("p000000","v000000",0,vec![json!({"text":"完全不同的另一段话","bbox":[]})]).unwrap();
        assert_eq!(f.page(json!({"query":"量化"}))["total"],0);
        assert_eq!(f.page(json!({"query":"不同"}))["total"],1);
        assert_eq!(bigram_rows(&f.lib().conn(),"p000000"),1);
        // 级联删除（purge -> ON DELETE CASCADE）也要清掉二元组。
        f.lib().trash("p000000").unwrap();
        f.lib().purge("p000000").unwrap();
        let left:i64=f.lib().conn().query_row("SELECT count(*) FROM blocks_bigram_src",[],|r|r.get(0)).unwrap();
        assert_eq!(left,0);
        assert_eq!(f.page(json!({"query":"不同"}))["total"],0);
    }
    #[test]
    fn bigram_index_survives_migration_and_rebuild() {
        let mut f=Fixture::empty();
        {
            let conn=f.lib().conn();
            // 标题只含“稀疏”，正文只含“微调/量化”，两类命中分别验证两个索引。
            insert_paper(&conn,"cjk","稀疏量化推理");
            insert_block(&conn,"cjk",0,0,"我们提出一种新的微调与量化方案。");
        }
        assert_eq!(f.page(json!({"query":"微调"}))["total"],1,"正文二字词");
        assert_eq!(f.page(json!({"query":"稀疏"}))["total"],1,"标题二字词");
        {
            let conn=f.lib().conn();
            // 模拟旧版本库：二元组表与触发器都不存在，迁移要能自动补建索引。
            conn.execute_batch("DROP TRIGGER IF EXISTS blocks_bigram_insert; DROP TRIGGER IF EXISTS blocks_bigram_update; DROP TRIGGER IF EXISTS blocks_bigram_delete; DROP TABLE IF EXISTS blocks_bigram; DROP TABLE IF EXISTS blocks_bigram_src; DROP TRIGGER IF EXISTS papers_bigram_insert; DROP TRIGGER IF EXISTS papers_bigram_update; DROP TRIGGER IF EXISTS papers_bigram_delete; DROP TABLE IF EXISTS papers_bigram; DROP TABLE IF EXISTS papers_bigram_src;").unwrap();
            initialize(&conn).unwrap();
            let rebuilt_blocks:i64=conn.query_row("SELECT count(*) FROM blocks_bigram_src",[],|r|r.get(0)).unwrap();
            let rebuilt_papers:i64=conn.query_row("SELECT count(*) FROM papers_bigram_src",[],|r|r.get(0)).unwrap();
            assert_eq!(rebuilt_blocks,1,"迁移应为已存在的正文块补建二元组");
            assert_eq!(rebuilt_papers,1,"迁移应为已存在的论文元数据补建二元组");
            assert_eq!(list_page(&conn,&json!({"query":"微调"})).unwrap()["total"],1);
            assert_eq!(list_page(&conn,&json!({"query":"稀疏"})).unwrap()["total"],1);
            // 显式重建索引后依然可查。
            conn.execute_batch("INSERT INTO blocks_bigram(blocks_bigram) VALUES('rebuild'); INSERT INTO papers_bigram(papers_bigram) VALUES('rebuild')").unwrap();
            assert_eq!(list_page(&conn,&json!({"query":"量化"})).unwrap()["total"],1);
            // 索引与内容表行数一致时 initialize 不会反复重建。
            initialize(&conn).unwrap();
            assert_eq!(conn.query_row("SELECT count(*) FROM blocks_bigram",[],|r|r.get::<_,i64>(0)).unwrap(),1);
        }
        drop(f.lib.take());
        let reopened=Library::new(&f.root).unwrap();
        assert_eq!(list_page(&reopened.conn(),&json!({"query":"微调"})).unwrap()["total"],1);
    }
    #[test]
    fn han_bigrams_scalar_function_is_registered_and_null_safe() {
        let f=Fixture::empty();
        let conn=f.lib().conn();
        // initialize 已在写连接上注册函数，触发器用的就是这份实现。
        let grams:String=conn.query_row("SELECT han_bigrams('知识蒸馏模型')",[],|r|r.get(0)).unwrap();
        assert_eq!(grams,"知识 识蒸 蒸馏 馏模 模型");
        // 纯英文、空白、单个汉字没有相邻二元组：返回空串而不是 NULL。
        for text in ["plain english only","   \n\t","单"] {
            let grams:String=conn.query_row("SELECT han_bigrams(?)",params![text],|r|r.get(0)).unwrap();
            assert_eq!(grams,"", "{text:?}");
        }
        let null:Option<String>=conn.query_row("SELECT han_bigrams(NULL)",[],|r|r.get(0)).unwrap();
        assert!(null.is_none(),"NULL 进 NULL 出");
    }
    #[test]
    fn bigram_triggers_write_native_output_on_insert_update_and_blank() {
        let f=Fixture::empty();
        {
            let conn=f.lib().conn();
            insert_paper(&conn,"native","知识蒸馏模型");
            let papers:String=conn.query_row("SELECT s.bigrams FROM papers_bigram_src s JOIN papers p ON p.rowid=s.rowid WHERE p.id='native'",[],|r|r.get(0)).unwrap();
            assert_eq!(papers,"知识 识蒸 蒸馏 馏模 模型","INSERT 触发器必须写入 han_bigrams() 的输出");
            insert_block(&conn,"native",0,0,"我们使用知识蒸馏把模型压缩到四分之一");
            let blocks:String=conn.query_row("SELECT s.bigrams FROM blocks_bigram_src s JOIN blocks b ON b.rowid=s.rowid WHERE b.paper_id='native'",[],|r|r.get(0)).unwrap();
            assert!(blocks.split(' ').any(|g|g=="蒸馏"),"{blocks}");
            // UPDATE 标题：旧二元组被替换，新二元组立即可查。
            conn.execute("UPDATE papers SET title='稀疏量化推理' WHERE id='native'",[]).unwrap();
            let updated:String=conn.query_row("SELECT s.bigrams FROM papers_bigram_src s JOIN papers p ON p.rowid=s.rowid WHERE p.id='native'",[],|r|r.get(0)).unwrap();
            assert_eq!(updated,"稀疏 疏量 量化 化推 推理");
            // UPDATE 成纯英文：内容表不能留下空串行。
            conn.execute("UPDATE papers SET title='plain english only' WHERE id='native'",[]).unwrap();
            let rows:i64=conn.query_row("SELECT count(*) FROM papers_bigram_src s JOIN papers p ON p.rowid=s.rowid WHERE p.id='native'",[],|r|r.get(0)).unwrap();
            assert_eq!(rows,0,"纯英文行不应写入空二元组");
        }
        // 正文仍由触发器生成的二元组命中；标题里的“量化”已随更新消失。
        assert_eq!(f.page(json!({"query":"蒸馏"}))["total"],1);
        assert_eq!(f.page(json!({"query":"量化"}))["total"],0);
    }
    #[test]
    fn initialize_replaces_legacy_bigram_triggers_and_is_idempotent() {
        let f=Fixture::empty();
        {
            let conn=f.lib().conn();
            // 模拟旧库遗留的触发器：写入固定标记，而不是真实二元组。
            conn.execute_batch(r#"
                DROP TRIGGER papers_bigram_insert;
                CREATE TRIGGER papers_bigram_insert AFTER INSERT ON papers BEGIN
                    INSERT INTO papers_bigram_src(rowid,bigrams) VALUES(new.rowid,'LEGACY_RECURSIVE_CTE');
                END;
            "#).unwrap();
            // 连续两次初始化都不能报错，且必须把旧触发器替换成 han_bigrams 版本。
            initialize(&conn).unwrap();
            initialize(&conn).unwrap();
            let trigger:String=conn.query_row("SELECT sql FROM sqlite_master WHERE type='trigger' AND name='papers_bigram_insert'",[],|r|r.get(0)).unwrap();
            assert!(trigger.contains("han_bigrams("),"{trigger}");
            assert!(!trigger.contains("WITH RECURSIVE"),"{trigger}");
            insert_paper(&conn,"upgraded","知识蒸馏");
            let grams:String=conn.query_row("SELECT s.bigrams FROM papers_bigram_src s JOIN papers p ON p.rowid=s.rowid WHERE p.id='upgraded'",[],|r|r.get(0)).unwrap();
            assert_eq!(grams,"知识 识蒸 蒸馏");
        }
        // 释放写连接锁后再查询：std Mutex 不可重入，list_page 会自己取连接。
        assert_eq!(f.page(json!({"query":"蒸馏"}))["total"],1);
    }
    #[test]
    fn paper_bigram_tracks_metadata_edits_and_deletes() {
        let f=Fixture::empty();
        {
            let conn=f.lib().conn();
            insert_paper(&conn,"a","稀疏量化推理");
            insert_paper(&conn,"b","另一个题目");
        }
        assert_eq!(f.page(json!({"query":"量化"}))["total"],1);
        // 编辑标题：旧二元组必须被清掉，新二元组立即可查。
        f.lib().update_paper("a",&json!({"title":"完全改掉的题目"})).unwrap();
        assert_eq!(f.page(json!({"query":"量化"}))["total"],0);
        assert_eq!(f.page(json!({"query":"改掉"}))["total"],1);
        f.lib().trash("a").unwrap();
        f.lib().purge("a").unwrap();
        let left:i64=f.lib().conn().query_row("SELECT count(*) FROM papers_bigram_src WHERE rowid NOT IN (SELECT rowid FROM papers)",[],|r|r.get(0)).unwrap();
        assert_eq!(left,0,"级联删除不能留下孤儿二元组");
        assert_eq!(f.page(json!({"query":"改掉"}))["total"],0);
    }
    #[test]
    fn search_triggers_track_updates_deletes_and_reopen() {
        let mut f=Fixture::new(3);
        f.lib().update_paper("p000000",&json!({"title":"uniquechangedtitle"})).unwrap();
        assert_eq!(f.page(json!({"query":"uniquechanged"}))["total"],1);
        f.lib().trash("p000000").unwrap();
        assert_eq!(f.page(json!({"query":"uniquechanged"}))["total"],0);
        assert_eq!(f.page(json!({"trashed":true}))["total"],1);
        f.lib().purge("p000000").unwrap();
        assert_eq!(f.page(json!({"trashed":true}))["total"],0);
        // Reopening neither duplicates FTS content nor rebuilds on each launch.
        f.lib.take();
        let reopened=Library::new(&f.root).unwrap();
        assert_eq!(list_page(&reopened.conn(),&json!({})).unwrap()["total"],2);
    }
    #[test]
    fn translated_annotations_are_bound_to_the_actual_version() {
        let f=Fixture::new(1);
        f.lib().conn().execute("INSERT INTO versions(id,paper_id,kind,sha256,rel_path,pages,bytes,created_at) VALUES('translated-v1','p000000','translated','t','derived/t.pdf',2,1,0)",[]).unwrap();
        f.lib().add_annotation("p000000",1,json!([]),"译文","yellow","","translated",Some("translated-v1")).unwrap();
        let anns=f.lib().list_annotations("p000000").unwrap();
        assert_eq!(anns[0]["version_kind"],"translated");assert_eq!(anns[0]["version_id"],"translated-v1");
        assert!(f.lib().add_annotation("p000000",1,json!([]),"bad","yellow","","source",Some("translated-v1")).is_err());
        assert!(f.lib().add_annotation("p000000",5,json!([]),"bad","yellow","","translated",Some("translated-v1")).is_err());
    }
    #[test]
    fn per_page_blocks_keep_zero_based_pages_and_stable_ids() {
        let f=Fixture::new(1);
        let data=vec![json!({"text":"Actual text on PDF page one", "bbox":[1,2,30,40]})];
        f.lib().set_blocks("p000000","v000000",0,data.clone()).unwrap();
        let a=f.lib().blocks("p000000","v000000",0).unwrap();
        let changes=f.lib().conn().total_changes();
        f.lib().set_blocks("p000000","v000000",0,data).unwrap();
        assert_eq!(f.lib().conn().total_changes(),changes,"unchanged geometry must not rewrite FTS");
        let b=f.lib().blocks("p000000","v000000",0).unwrap();
        assert_eq!(a,b);assert_eq!(a[0]["page"],0);
        assert_eq!(f.lib().blocks("p000000","v000000",1).unwrap().len(),1);
    }
    #[test]
    fn legacy_fts_migration_aligns_rowids_and_cascade_removes_tokens() {
        let f=Fixture::new(7);
        {
            let conn=f.lib().conn();
            conn.execute_batch("DROP TRIGGER blocks_fts_insert_v2; DROP TRIGGER blocks_fts_delete_v2; DROP TRIGGER blocks_fts_update_v2; DELETE FROM blocks_fts; INSERT INTO blocks_fts(rowid,text,block_id,paper_id,page) SELECT rowid+500,text,id,paper_id,page FROM blocks; INSERT INTO blocks_fts(text,block_id,paper_id,page) VALUES('orphanword','orphan','missing',0);").unwrap();
            initialize(&conn).unwrap();
            let count:i64=conn.query_row("SELECT count(*) FROM blocks_fts f JOIN blocks b ON b.rowid=f.rowid AND b.id=f.block_id",[],|r|r.get(0)).unwrap();
            assert_eq!(count,7);
            let orphan:i64=conn.query_row("SELECT count(*) FROM blocks_fts WHERE blocks_fts MATCH 'orphanword'",[],|r|r.get(0)).unwrap();
            assert_eq!(orphan,0);
        }
        f.lib().trash("p000000").unwrap();
        f.lib().purge("p000000").unwrap();
        let count:i64=f.lib().conn().query_row("SELECT count(*) FROM blocks_fts",[],|r|r.get(0)).unwrap();
        assert_eq!(count,6);
    }
    #[test]
    fn sort_indexes_do_not_require_a_temporary_sort() {
        let f=Fixture::new(2);
        for order in ["imported_at DESC,id DESC","title COLLATE NOCASE,id","year DESC,id DESC"] {
            let conn=f.lib().conn();
            let mut stmt=conn.prepare(&format!("EXPLAIN QUERY PLAN SELECT id FROM papers WHERE deleted_at IS NULL ORDER BY {order} LIMIT 100")).unwrap();
            let plan=stmt.query_map([],|r|r.get::<_,String>(3)).unwrap().collect::<rusqlite::Result<Vec<_>>>().unwrap().join(";");
            assert!(!plan.contains("TEMP B-TREE"),"{plan}");
        }
    }
    #[test]
    fn query_matches_are_joined_inside_sqlite_without_a_temp_id_handoff() {
        let f=Fixture::new(30);
        let conn=f.lib().conn();
        // 匹配集合以 rowid 物化并与 papers 关联：计划里应出现 matched，
        // 且不再出现把 rowid 塞回 SQLite 的 json_each。
        let (body,args)=match_sql("中文研");
        let sql=format!("EXPLAIN QUERY PLAN WITH matched(rowid) AS MATERIALIZED ({body}) SELECT p.id FROM papers p JOIN matched m ON m.rowid=p.rowid WHERE p.deleted_at IS NULL ORDER BY p.imported_at DESC,p.id DESC LIMIT 100");
        let mut stmt=conn.prepare(&sql).unwrap();
        let plan=stmt.query_map(params_from_iter(args.iter()),|r|r.get::<_,String>(3)).unwrap().collect::<rusqlite::Result<Vec<_>>>().unwrap().join(";");
        assert!(plan.contains("matched"),"{plan}");
        assert!(!plan.contains("json_each"),"{plan}");
        // 匹配集合的键是 papers.rowid（整数），不是 UUID 文本。
        let (body,_)=match_sql("sparseneedle");
        assert!(body.contains("p.rowid")||body.contains("SELECT rowid"),"{body}");
    }
    #[test]
    #[ignore = "explicit bigram index measurement (20k Chinese blocks)"]
    fn benchmark_bigram_body_20k() {
        let f=Fixture::empty();
        let start=std::time::Instant::now();
        {
            let conn=f.lib().conn();
            let tx=conn.unchecked_transaction().unwrap();
            {
                let mut p=tx.prepare("INSERT INTO papers(id,title,authors,imported_at,updated_at) VALUES(?,?,'',0,0)").unwrap();
                let mut v=tx.prepare("INSERT INTO versions(id,paper_id,kind,sha256,rel_path,pages,bytes,created_at) VALUES(?,?,'source','h','f.pdf',10,1,0)").unwrap();
                let mut b=tx.prepare("INSERT INTO blocks(id,paper_id,version_id,page,block_index,kind,bbox,text) VALUES(?,?,?,?,?,'text','[]',?)").unwrap();
                for i in 0..2000 {
                    let id=format!("q{i:05}");
                    p.execute(params![id,format!("中文论文 {i:05}")]).unwrap();
                    v.execute(params![format!("{id}-v"),id]).unwrap();
                    for j in 0..10 {
                        let text=if i%50==0 && j==0 {"我们使用知识蒸馏与稀疏量化把模型压缩到四分之一，并分析显存瓶颈。"}
                            else {"这一段讨论背景、记号、数据集与实验设置，不包含目标术语。"};
                        b.execute(params![format!("{id}-b{j}"),id,format!("{id}-v"),j as i64,j as i64,text]).unwrap();
                    }
                }
            }
            tx.commit().unwrap();
        }
        let seed_ms=start.elapsed().as_secs_f64()*1000.0;
        let median=|mut values:Vec<f64>| { values.sort_by(f64::total_cmp); values[values.len()/2] };
        let mut indexed=Vec::new();
        let mut scanned=Vec::new();
        for _ in 0..30 {
            let begin=std::time::Instant::now();
            let page=f.page(json!({"query":"蒸馏","limit":100}));
            indexed.push(begin.elapsed().as_secs_f64()*1000.0);
            assert_eq!(page["total"],40);
            let begin=std::time::Instant::now();
            // 旧实现的退化路径：正文全表 LIKE 扫描。
            let hits:i64=f.lib().conn().query_row("SELECT count(*) FROM blocks WHERE text LIKE '%蒸馏%'",[],|r|r.get(0)).unwrap();
            scanned.push(begin.elapsed().as_secs_f64()*1000.0);
            assert_eq!(hits,40);
        }
        eprintln!("{}",serde_json::to_string_pretty(&json!({
            "blocks":20000,"papers":2000,"seed_with_bigram_triggers_ms":seed_ms,
            "two_char_bigram_index_median_ms":median(indexed),
            "two_char_full_table_like_median_ms":median(scanned),
        })).unwrap());
    }

    /// 旧实现（本次改动前）的检索路径：把全部匹配 rowid 拉回 Rust，序列化成
    /// JSON 再用 `json_each` 传回 SQLite，分别做计数与分页。仅用于基准对照。
    fn legacy_search_page(conn:&Connection, query:&str) -> (i64, usize) {
        let quoted=format!("\"{}\"",query.replace('"',"\"\""));
        let tag_like=format!("%{}%",query);
        let matches:Vec<i64>={let mut st=conn.prepare("SELECT rowid FROM papers_search WHERE papers_search MATCH ? UNION SELECT rowid FROM papers WHERE id IN (SELECT paper_id FROM blocks WHERE rowid IN (SELECT rowid FROM blocks_search WHERE blocks_search MATCH ?)) UNION SELECT rowid FROM short_notes_search WHERE short_notes_search MATCH ? UNION SELECT rowid FROM papers WHERE id IN (SELECT pt.paper_id FROM paper_tags pt JOIN tags t ON t.id=pt.tag_id WHERE t.name LIKE ? ESCAPE '!')").unwrap();
            st.query_map([&quoted,&quoted,&quoted,&tag_like],|r|r.get(0)).unwrap().collect::<rusqlite::Result<Vec<_>>>().unwrap()};
        let payload=serde_json::to_string(&matches).unwrap();
        let total:i64=conn.query_row("SELECT COUNT(*) FROM papers p WHERE p.deleted_at IS NULL AND p.rowid IN (SELECT value FROM json_each(?))",[&payload],|r|r.get(0)).unwrap();
        let mut st=conn.prepare("SELECT p.id,p.title,p.authors,p.year,p.venue,p.doi,p.arxiv,p.imported_at,p.updated_at,p.favorite,p.read_status,p.deleted_at IS NOT NULL,EXISTS(SELECT 1 FROM versions v WHERE v.paper_id=p.id AND v.kind='translated'),p.short_note,p.citation_count,p.citation_source,p.citation_updated_at,p.citation_url FROM papers p WHERE p.deleted_at IS NULL AND p.rowid IN (SELECT value FROM json_each(?)) ORDER BY p.imported_at DESC,p.id DESC LIMIT 100").unwrap();
        let rows=st.query_map([&payload],|r|r.get::<_,String>(0)).unwrap().collect::<rusqlite::Result<Vec<_>>>().unwrap();
        (total, rows.len())
    }
    fn benchmark_rows(rows:usize) -> Value {
        let start=std::time::Instant::now();let f=Fixture::new(rows);
        eprintln!("seed_{rows}_ms={}",start.elapsed().as_millis());
        let mut results=serde_json::Map::new();
        for (label,opts) in [
            ("recent_first",json!({"limit":100})),
            ("recent_deep",json!({"limit":100,"offset":rows.saturating_sub(100)})),
            ("title",json!({"sort":"title","limit":100})),
            ("year",json!({"sort":"year","limit":100})),
            ("favorite",json!({"favorite":true,"limit":100})),
            ("substring_metadata",json!({"query":"099999","limit":100})),
            ("substring_body",json!({"query":"sparseneedle","limit":100})),
            ("high_hit_title",json!({"query":"中文研","limit":100})),
            ("high_hit_two_char_title",json!({"query":"中文","limit":100})),
        ] {
            let mut ms=vec![];let mut bytes=0;let mut total=0;
            for _ in 0..30 {
                let begin=std::time::Instant::now();let page=f.page(opts.clone());
                bytes=serde_json::to_vec(&page).unwrap().len();total=page["total"].as_i64().unwrap();
                ms.push(begin.elapsed().as_secs_f64()*1000.0);
            }
            ms.sort_by(f64::total_cmp);
            results.insert(label.into(),json!({"median_ms":ms[15],"p95_ms":ms[28],"max_ms":ms[29],"response_bytes":bytes,"matching_papers":total,"runs":30}));
        }
        // 旧路径在同一份数据上的耗时（含 rowid 往返）。
        let mut legacy=vec![];
        for _ in 0..10 {
            let begin=std::time::Instant::now();
            let (total,page)=legacy_search_page(&f.lib().conn(),"中文研");
            assert_eq!(total,rows as i64);assert_eq!(page,100);
            legacy.push(begin.elapsed().as_secs_f64()*1000.0);
        }
        legacy.sort_by(f64::total_cmp);
        results.insert("legacy_path_high_hit".into(),json!({"median_ms":legacy[5],"max_ms":legacy[9],"matching_papers":rows,"runs":10}));
        json!({"rows":rows,"storage":"temporary disk-backed SQLite WAL; warm OS cache","results":results})
    }
    #[test]
    #[ignore = "explicit disk-backed 1k performance measurement"]
    fn benchmark_1k() { eprintln!("{}",serde_json::to_string_pretty(&benchmark_rows(1_000)).unwrap()); }
    #[test]
    #[ignore = "explicit disk-backed 10k performance measurement"]
    fn benchmark_10k() {
        let report=benchmark_rows(10_000);
        if let Ok(path)=std::env::var("MOONLIGHT_BENCH_REPORT_10K") { std::fs::write(path,serde_json::to_string_pretty(&report).unwrap()).unwrap(); }
        eprintln!("{}",serde_json::to_string_pretty(&report).unwrap());
    }
    #[test]
    #[ignore = "explicit disk-backed 100k performance measurement"]
    fn benchmark_100k() {
        let report=benchmark_rows(100_000);
        if let Ok(path)=std::env::var("MOONLIGHT_BENCH_REPORT") { std::fs::write(path,serde_json::to_string_pretty(&report).unwrap()).unwrap(); }
        eprintln!("{}",serde_json::to_string_pretty(&report).unwrap());
    }
}
