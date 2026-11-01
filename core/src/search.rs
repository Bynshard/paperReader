//! SQLite owns filtering, ordering and pagination. List rows never load PDF
//! versions, abstracts, notes or per-paper relationship queries.
use anyhow::Result;
use rusqlite::{params_from_iter, types::Value as SqlValue, Connection};
use serde_json::{json, Value};
use std::collections::HashMap;

pub fn initialize(conn: &Connection) -> Result<()> {
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
    Ok(())
}

pub fn list_page(conn: &Connection, p: &Value) -> Result<Value> {
    let offset = p["offset"].as_i64().unwrap_or(0).max(0);
    let limit = p["limit"].as_i64().unwrap_or(100).clamp(1, 200);
    let mut filters = vec![if p["trashed"].as_bool().unwrap_or(false) {
        "p.deleted_at IS NOT NULL".to_string()
    } else { "p.deleted_at IS NULL".to_string() }];
    let mut args: Vec<SqlValue> = vec![];
    if p["favorite"].as_bool().unwrap_or(false) { filters.push("p.favorite=1".into()); }
    for (key, predicate) in [
        ("status", "p.read_status=?"),
        ("category", "p.id IN (SELECT paper_id FROM paper_categories WHERE category_id=?)"),
        ("tag", "p.id IN (SELECT pt.paper_id FROM paper_tags pt JOIN tags t ON t.id=pt.tag_id WHERE t.name=?)"),
    ] {
        if let Some(value) = p[key].as_str().filter(|s| !s.is_empty()) {
            filters.push(predicate.into()); args.push(SqlValue::Text(value.into()));
        }
    }
    let query: String = p["query"].as_str().unwrap_or("").trim().chars().take(256).collect();
    if !query.is_empty() {
        // Quote FTS input as a literal phrase: punctuation cannot become query
        // operators. Trigram supports substring search, including Chinese.
        let quoted = format!("\"{}\"", query.replace('"', "\"\""));
        let matches: Vec<i64> = if query.chars().count() >= 3 {
            // Deduplicate body paper IDs BEFORE looking up papers, rather than
            // doing a primary-key lookup for every matching text fragment.
            let mut stmt = conn.prepare("SELECT rowid FROM papers_search WHERE papers_search MATCH ? UNION SELECT rowid FROM papers WHERE id IN (SELECT paper_id FROM blocks WHERE rowid IN (SELECT rowid FROM blocks_search WHERE blocks_search MATCH ?))")?;
            let rows = stmt.query_map([&quoted, &quoted], |r| r.get(0))?;
            rows.collect::<rusqlite::Result<Vec<_>>>()?
        } else {
            // Trigrams cannot index <3 characters. Bound the fallback to
            // metadata; body search uses the existing token-prefix index.
            let literal = query.replace('!', "!!").replace('%', "!%").replace('_', "!_");
            let like = format!("%{literal}%");
            let prefix = format!("{quoted}*");
            let mut stmt = conn.prepare("SELECT rowid FROM papers WHERE title LIKE ? ESCAPE '!' OR authors LIKE ? ESCAPE '!' OR doi LIKE ? ESCAPE '!' OR id IN (SELECT paper_id FROM blocks_fts WHERE blocks_fts MATCH ?)")?;
            let rows = stmt.query_map([&like, &like, &like, &prefix], |r| r.get(0))?;
            rows.collect::<rusqlite::Result<Vec<_>>>()?
        };
        // Count and page reuse this request's match set. JSON1 avoids SQLite's
        // bind-parameter limit; no cross-request cache can become stale.
        filters.push("p.rowid IN (SELECT value FROM json_each(?))".into());
        args.push(SqlValue::Text(serde_json::to_string(&matches)?));
    }
    let where_sql = filters.join(" AND ");
    let total: i64 = conn.query_row(&format!("SELECT COUNT(*) FROM papers p WHERE {where_sql}"), params_from_iter(args.iter()), |r| r.get(0))?;
    let order = match p["sort"].as_str().unwrap_or("recent") {
        "title" => "p.title COLLATE NOCASE ASC,p.id ASC",
        "year" => "p.year DESC,p.id DESC",
        _ => "p.imported_at DESC,p.id DESC",
    };
    let sql = format!("SELECT p.id,p.title,p.authors,p.year,p.venue,p.doi,p.arxiv,p.imported_at,p.updated_at,p.favorite,p.read_status,p.deleted_at IS NOT NULL,EXISTS(SELECT 1 FROM versions v WHERE v.paper_id=p.id AND v.kind='translated') FROM papers p WHERE {where_sql} ORDER BY {order} LIMIT ? OFFSET ?");
    args.extend([SqlValue::Integer(limit),SqlValue::Integer(offset)]);
    let mut stmt = conn.prepare(&sql)?;
    let mut items = stmt.query_map(params_from_iter(args.iter()), |r| Ok(json!({
        "id":r.get::<_,String>(0)?,"title":r.get::<_,String>(1)?,"authors":r.get::<_,String>(2)?,
        "year":r.get::<_,Option<String>>(3)?,"venue":r.get::<_,Option<String>>(4)?,
        "doi":r.get::<_,Option<String>>(5)?,"arxiv":r.get::<_,Option<String>>(6)?,
        "imported_at":r.get::<_,i64>(7)?,"updated_at":r.get::<_,i64>(8)?,
        "favorite":r.get::<_,bool>(9)?,"read_status":r.get::<_,String>(10)?,
        "deleted":r.get::<_,bool>(11)?,"has_translation":r.get::<_,bool>(12)?,
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
    }
    Ok(json!({"items":items,"total":total,"offset":offset,"limit":limit}))
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
    #[ignore = "explicit disk-backed 100k performance measurement"]
    fn benchmark_100k() {
        let start=std::time::Instant::now();let f=Fixture::new(100_000);
        eprintln!("seed_100k_ms={}",start.elapsed().as_millis());
        let mut results=serde_json::Map::new();
        for (label,opts) in [
            ("recent_first",json!({"limit":100})),
            ("recent_deep",json!({"limit":100,"offset":99900})),
            ("title",json!({"sort":"title","limit":100})),
            ("year",json!({"sort":"year","limit":100})),
            ("favorite",json!({"favorite":true,"limit":100})),
            ("substring_metadata",json!({"query":"099999","limit":100})),
            ("substring_body",json!({"query":"sparseneedle","limit":100})),
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
        let report=json!({"rows":100000,"storage":"temporary disk-backed SQLite WAL; warm OS cache","results":results});
        if let Ok(path)=std::env::var("MOONLIGHT_BENCH_REPORT") { std::fs::write(path,serde_json::to_string_pretty(&report).unwrap()).unwrap(); }
        eprintln!("{}",serde_json::to_string_pretty(&report).unwrap());
    }
}
