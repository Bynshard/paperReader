//! Portable sync documents and three-way merge. SQLite stays local; PDFs and
//! metadata commits travel independently, never a live database file.
use anyhow::{anyhow, Result};
use rusqlite::{params, params_from_iter, types::{Value as SqlValue,ValueRef}, Connection, OptionalExtension};
use serde_json::{json,Map,Value};
use std::{collections::{BTreeMap,BTreeSet}, path::{Component,Path}};

pub type Documents=BTreeMap<String,Value>;
const CHILDREN:&[&str]=&["versions","annotations","chats","zotero_files","zotero_items","zotero_annotation_map"];

pub fn safe_path(path:&str)->bool {
    !path.is_empty() && !path.contains('\\') && !path.contains(':') && Path::new(path).components().all(|c|matches!(c,Component::Normal(_)))
      && ["files/","derived/","imports/"].iter().any(|prefix|path.starts_with(prefix))
}
fn rows(conn:&Connection,sql:&str,args:&[&dyn rusqlite::ToSql])->Result<Vec<Value>> {
    let mut stmt=conn.prepare(sql)?;let names=stmt.column_names().iter().map(|s|s.to_string()).collect::<Vec<_>>();
    let mut cursor=stmt.query(args)?;let mut out=vec![];
    while let Some(row)=cursor.next()? {
        let mut item=Map::new();
        for (index,name) in names.iter().enumerate() {
            let value=match row.get_ref(index)? {
                ValueRef::Null=>Value::Null,ValueRef::Integer(v)=>json!(v),ValueRef::Real(v)=>json!(v),ValueRef::Text(v)=>json!(std::str::from_utf8(v)?),
                ValueRef::Blob(_)=>return Err(anyhow!("sync metadata contains an unsupported BLOB")),
            };item.insert(name.clone(),value);
        }out.push(Value::Object(item));
    }Ok(out)
}
fn child_key(table:&str,row:&Value)->String {
    match table {
        "zotero_items"=>json!([row["source_id"],row["library_id"],row["item_key"]]).to_string(),
        "zotero_annotation_map"=>row["annotation_id"].as_str().unwrap_or_default().into(),
        _=>row["id"].as_str().unwrap_or_default().into(),
    }
}
fn paper_doc(row:Value)->Value {
    let mut doc=json!({"paper":row,"categories":{},"tags":{}});
    for table in CHILDREN {doc[*table]=json!({});}doc
}
pub fn export(conn:&Connection)->Result<Documents> {
    let mut out=Documents::new();
    for row in rows(conn,"SELECT * FROM categories",&[])? {out.insert(format!("category:{}",row["id"].as_str().unwrap()),row);}
    for row in rows(conn,"SELECT name,color FROM tags",&[])? {out.insert(format!("tag:{}",row["name"].as_str().unwrap()),row);}
    for row in rows(conn,"SELECT * FROM papers",&[])? {out.insert(format!("paper:{}",row["id"].as_str().unwrap()),paper_doc(row));}
    // Read each table once, instead of querying every paper's relations.
    for table in CHILDREN {
        let sql=if *table=="zotero_annotation_map" {"SELECT m.*,a.paper_id AS owner FROM zotero_annotation_map m JOIN annotations a ON a.id=m.annotation_id".into()}else{format!("SELECT * FROM {table}")};
        for mut row in rows(conn,&sql,&[])? {
            let paper=row[if *table=="zotero_annotation_map" {"owner"}else{"paper_id"}].as_str().unwrap().to_string();
            if let Some(obj)=row.as_object_mut(){obj.remove("owner");}
            if let Some(doc)=out.get_mut(&format!("paper:{paper}")) {let key=child_key(table,&row);doc[*table][key]=row;}
        }
    }
    for row in rows(conn,"SELECT paper_id,category_id FROM paper_categories",&[])? {
        if let Some(doc)=out.get_mut(&format!("paper:{}",row["paper_id"].as_str().unwrap())) {doc["categories"][row["category_id"].as_str().unwrap()]=json!(true);}
    }
    for row in rows(conn,"SELECT r.paper_id,t.name FROM paper_tags r JOIN tags t ON t.id=r.tag_id",&[])? {
        if let Some(doc)=out.get_mut(&format!("paper:{}",row["paper_id"].as_str().unwrap())) {doc["tags"][row["name"].as_str().unwrap()]=json!(true);}
    }Ok(out)
}
pub fn load(conn:&Connection,key:&str)->Result<Value> {
    if let Some(id)=key.strip_prefix("category:") {return Ok(rows(conn,"SELECT * FROM categories WHERE id=?",&[&id])?.pop().unwrap_or(Value::Null));}
    if let Some(name)=key.strip_prefix("tag:") {return Ok(rows(conn,"SELECT name,color FROM tags WHERE name=?",&[&name])?.pop().unwrap_or(Value::Null));}
    let id=key.strip_prefix("paper:").ok_or_else(||anyhow!("unknown sync document type"))?;
    let Some(row)=rows(conn,"SELECT * FROM papers WHERE id=?",&[&id])?.pop() else {return Ok(Value::Null)};
    let mut doc=paper_doc(row);
    for table in CHILDREN {
        let sql=if *table=="zotero_annotation_map" {"SELECT m.* FROM zotero_annotation_map m JOIN annotations a ON a.id=m.annotation_id WHERE a.paper_id=?".into()}else{format!("SELECT * FROM {table} WHERE paper_id=?")};
        for row in rows(conn,&sql,&[&id])? {let key=child_key(table,&row);doc[*table][key]=row;}
    }
    for row in rows(conn,"SELECT category_id FROM paper_categories WHERE paper_id=?",&[&id])? {doc["categories"][row["category_id"].as_str().unwrap()]=json!(true);}
    for row in rows(conn,"SELECT t.name FROM paper_tags r JOIN tags t ON t.id=r.tag_id WHERE r.paper_id=?",&[&id])? {doc["tags"][row["name"].as_str().unwrap()]=json!(true);}
    Ok(doc)
}

/// Merge independent fields and independent keyed child records. A concurrent
/// deletion and edit conflicts as a whole; timestamps are bookkeeping only.
/// Reading position is a per-device cursor rather than document content: both
/// ends advance it independently, so the newest `last_read_at` wins and no
/// conflict is recorded. Without this, every sync after reading on either side
/// would add four conflict records (`/paper/last_read_*`).
fn unify_reading_position(local: &mut Value, remote: &mut Value) {
    let (Some(local_at), Some(remote_at)) = (
        local["paper"]["last_read_at"].as_i64(),
        remote["paper"]["last_read_at"].as_i64(),
    ) else { return };
    if local_at == remote_at { return; }
    let (from, into) = if local_at > remote_at { (local.clone(), remote) } else { (remote.clone(), local) };
    for key in ["last_read_page", "last_read_fraction", "last_read_mode", "last_read_at"] {
        if let Some(value) = from["paper"].get(key) {
            if let Some(paper) = into["paper"].as_object_mut() { paper.insert(key.into(), value.clone()); }
        }
    }
}

/// `generated_at` of a cached digest, or `None` when the TEXT column is NULL,
/// missing or no longer a JSON object with a numeric timestamp. Anything
/// unparseable is treated as "no digest": it can only be replaced, never
/// ordered against another generation.
fn digest_generated_at(raw: &Value) -> Option<i64> {
    let digest: Value = serde_json::from_str(raw.as_str()?).ok()?;
    let at = digest.get("generated_at")?;
    at.as_i64().or_else(|| at.as_f64().map(|value| value as i64))
}

/// The digest cache (`papers.digest_json`) is derived content refreshed
/// independently on each device, so it follows the same rule as the reading
/// cursor: the newest generation wins and is written into both documents
/// before `walk` runs. Without this, any digest generated on two devices would
/// surface as a `/paper/digest_json` conflict even though no user data differs.
///
/// A NULL/missing/malformed cache loses to a readable one; two readable caches
/// are ordered by `generated_at` and a tie keeps local, which also keeps the
/// merge deterministic for replayed commits. Only two different opaque values
/// are left untouched for `walk`, since neither can be dated.
fn unify_digest(local: &mut Value, remote: &mut Value) {
    fn read(doc: &Value) -> Option<Value> { doc.get("paper")?.get("digest_json").cloned() }
    fn present(raw: &Option<Value>) -> bool { raw.as_ref().is_some_and(|value| !value.is_null()) }
    let (local_raw, remote_raw) = (read(local), read(remote));
    let (local_at, remote_at) = (
        local_raw.as_ref().and_then(digest_generated_at),
        remote_raw.as_ref().and_then(digest_generated_at),
    );
    let winner = match (local_at, remote_at) {
        (Some(local_at), Some(remote_at)) => if remote_at > local_at { remote_raw.clone() } else { local_raw.clone() },
        (Some(_), None) => local_raw.clone(),
        (None, Some(_)) => remote_raw.clone(),
        (None, None) => match (present(&local_raw), present(&remote_raw)) {
            (true, false) => local_raw.clone(),
            (false, true) => remote_raw.clone(),
            _ => None,
        },
    };
    let Some(winner) = winner.filter(|value| !value.is_null()) else { return };
    for doc in [local, remote] {
        if let Some(paper) = doc.get_mut("paper").and_then(Value::as_object_mut) { paper.insert("digest_json".into(), winner.clone()); }
    }
}

pub fn merge(base:&Value,local:&Value,remote:&Value,prefer_remote:bool)->(Value,Vec<String>) {
    fn walk(b:&Value,l:&Value,r:&Value,path:&str,prefer:bool,conflicts:&mut Vec<String>)->Value {
        if l==r || r==b {return l.clone();} if l==b {return r.clone();}
        if path.ends_with("/updated_at") && l.is_number() && r.is_number() {return json!(l.as_i64().unwrap_or(0).max(r.as_i64().unwrap_or(0)));}
        if let (Some(local),Some(remote))=(l.as_object(),r.as_object()) {
            // A missing base permits independent creation only of containers,
            // not two different records with the same UUID.
            if b.is_object() || (b.is_null() && !local.contains_key("id") && !remote.contains_key("id")) {
                let keys: BTreeSet<_>=local.keys().chain(remote.keys()).chain(b.as_object().into_iter().flat_map(|o|o.keys())).collect();
                let mut out=Map::new();
                for key in keys {
                    let field=walk(&b[key],&l[key],&r[key],&format!("{path}/{}",key.replace('~',"~0").replace('/',"~1")),prefer,conflicts);
                    if !field.is_null() || local.get(key)==Some(&Value::Null) || remote.get(key)==Some(&Value::Null) {out.insert(key.clone(),field);}
                }return Value::Object(out);
            }
        }
        conflicts.push(path.into());if prefer {r.clone()}else{l.clone()}
    }
    // Normalise the reading cursor and the digest cache first so `walk` sees
    // identical values there and never reports them as conflicts.
    let (mut local_owned, mut remote_owned) = (local.clone(), remote.clone());
    unify_reading_position(&mut local_owned, &mut remote_owned);
    unify_digest(&mut local_owned, &mut remote_owned);
    let mut conflicts=vec![];let value=walk(base,&local_owned,&remote_owned,"",prefer_remote,&mut conflicts);(value,conflicts)
}
fn upsert(conn:&Connection,table:&str,row:&Value)->Result<()> {
    let object=row.as_object().ok_or_else(||anyhow!("invalid {table} row"))?;
    let mut schema=conn.prepare(&format!("PRAGMA table_info({table})"))?;
    let allowed=schema.query_map([],|r|r.get::<_,String>(1))?.collect::<rusqlite::Result<BTreeSet<_>>>()?;
    if object.is_empty() || object.keys().any(|key|!allowed.contains(key)) {return Err(anyhow!("unsupported {table} fields"));}
    let keys=object.keys().map(String::as_str).collect::<Vec<_>>();
    let values=object.values().map(|v|match v {Value::Null=>Ok(SqlValue::Null),Value::String(s)=>Ok(SqlValue::Text(s.clone())),Value::Number(n)=>n.as_i64().map(SqlValue::Integer).or_else(||n.as_f64().map(SqlValue::Real)).ok_or_else(||anyhow!("invalid number")),_=>Err(anyhow!("invalid SQLite scalar"))}).collect::<Result<Vec<_>>>()?;
    let sql=format!("INSERT INTO {table}({}) VALUES({}) ON CONFLICT DO UPDATE SET {}",keys.join(","),vec!["?";keys.len()].join(","),keys.iter().map(|k|format!("{k}=excluded.{k}")).collect::<Vec<_>>().join(","));
    conn.execute(&sql,params_from_iter(values))?;Ok(())
}
pub fn validate(key:&str,doc:&Value)->Result<()> {
    if doc.is_null() {return Ok(());}
    if let Some(id)=key.strip_prefix("paper:") {
        if doc["paper"]["id"]!=id || !doc["paper"]["title"].is_string() {return Err(anyhow!("invalid sync paper"));}
        for table in CHILDREN {
            let rows=doc[*table].as_object().ok_or_else(||anyhow!("missing sync table {table}"))?;
            for (row_key,row) in rows {
                if child_key(table,row)!=*row_key {return Err(anyhow!("invalid sync row key"));}
                if *table!="zotero_annotation_map" && row["paper_id"]!=id {return Err(anyhow!("sync row belongs to another paper"));}
                if *table=="versions" && !row["rel_path"].as_str().is_some_and(safe_path) {return Err(anyhow!("sync PDF path must be managed and relative"));}
                if *table=="zotero_files" && row["rel_path"].as_str().is_some_and(|s|!safe_path(s)) {return Err(anyhow!("invalid attachment path"));}
                if *table=="zotero_annotation_map" && doc["annotations"].get(row["annotation_id"].as_str().unwrap_or("")).is_none() {return Err(anyhow!("orphan annotation map"));}
            }
        }
        if !doc["categories"].is_object() || !doc["tags"].is_object() {return Err(anyhow!("invalid sync relations"));}
    } else if let Some(id)=key.strip_prefix("category:") {if doc["id"]!=id {return Err(anyhow!("invalid category"));}}
    else if let Some(name)=key.strip_prefix("tag:") {if doc["name"]!=name {return Err(anyhow!("invalid tag"));}}
    else {return Err(anyhow!("unsupported sync document"));}Ok(())
}
pub fn apply(conn:&Connection,key:&str,doc:&Value)->Result<()> {
    validate(key,doc)?;
    if let Some(name)=key.strip_prefix("tag:") {
        if doc.is_null() {
            // Deletion commit: the tag row and every paper membership vanish.
            // Look the id up first so a repeated (or already applied) delete is
            // a harmless no-op instead of a constraint error.
            let tag_id=conn.query_row("SELECT id FROM tags WHERE name=?",params![name],|r|r.get::<_,String>(0)).optional()?;
            if let Some(tag_id)=tag_id {
                conn.execute("DELETE FROM paper_tags WHERE tag_id=?",params![tag_id])?;
                conn.execute("DELETE FROM tags WHERE id=?",params![tag_id])?;
            }
            return Ok(());
        }
        // Additive taxonomy: a non-deleted commit only paints the colour.
        conn.execute("INSERT INTO tags(id,name,color) VALUES(?,?,?) ON CONFLICT(name) DO UPDATE SET color=excluded.color",params![super::sync::digest(&format!("tag:{name}")),name,doc["color"].as_str()])?;
        return Ok(());
    }
    if let Some(id)=key.strip_prefix("category:") {
        if doc.is_null() {
            // Mirror folder_delete: lift direct children to the deleted
            // folder's parent first so no folder becomes an orphan, then drop
            // the paper links and the folder itself.
            conn.execute("UPDATE categories SET parent_id=(SELECT parent_id FROM categories WHERE id=?) WHERE parent_id=?",params![id,id])?;
            conn.execute("DELETE FROM paper_categories WHERE category_id=?",params![id])?;
            conn.execute("DELETE FROM categories WHERE id=?",params![id])?;
            return Ok(());
        }
        upsert(conn,"categories",doc)?;
        return Ok(());
    }
    let id=key.strip_prefix("paper:").ok_or_else(||anyhow!("invalid document"))?;
    if doc.is_null() {
        conn.execute("DELETE FROM papers WHERE id=?",[id])?;return Ok(());
    }
    upsert(conn,"papers",&doc["paper"])?;
    for table in ["paper_categories","paper_tags","zotero_items","zotero_files","annotations","chats","versions"] {conn.execute(&format!("DELETE FROM {table} WHERE paper_id=?"),[id])?;}
    for table in CHILDREN {for row in doc[*table].as_object().unwrap().values(){upsert(conn,table,row)?;}}
    for category in doc["categories"].as_object().unwrap().keys(){conn.execute("INSERT INTO paper_categories(paper_id,category_id) VALUES(?,?)",params![id,category])?;}
    for tag in doc["tags"].as_object().unwrap().keys(){conn.execute("INSERT INTO paper_tags(paper_id,tag_id) SELECT ?,id FROM tags WHERE name=?",params![id,tag])?;}
    // Search geometry is a local cache; never replicate stale FTS tables.
    conn.execute("DELETE FROM blocks WHERE paper_id=? AND version_id NOT IN (SELECT id FROM versions WHERE paper_id=?)",params![id,id])?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test] fn merges_fields_and_independent_annotations() {
        let base=json!({"paper":{"title":"old","notes":"note","updated_at":0},"annotations":{}});
        let local=json!({"paper":{"title":"new","notes":"note","updated_at":1},"annotations":{"a":{"id":"a","comment":"local"}}});
        let remote=json!({"paper":{"title":"old","notes":"remote","updated_at":2},"annotations":{"b":{"id":"b","comment":"remote"}}});
        let(merged,conflicts)=merge(&base,&local,&remote,false);
        assert!(conflicts.is_empty());assert_eq!(merged["paper"]["title"],"new");assert_eq!(merged["paper"]["notes"],"remote");assert_eq!(merged["annotations"].as_object().unwrap().len(),2);
    }
    #[test] fn preserves_conflicting_notes_and_delete_edit() {
        let base=json!({"paper":{"notes":"old"}});let local=json!({"paper":{"notes":"mine"}});let remote=json!({"paper":{"notes":"theirs"}});
        assert_eq!(merge(&base,&local,&remote,false).0,local);assert_eq!(merge(&base,&local,&remote,false).1,vec!["/paper/notes"]);
        assert_eq!(merge(&base,&local,&Value::Null,false).0,local);assert!(!merge(&base,&local,&Value::Null,false).1.is_empty());
        assert_eq!(merge(&base,&local,&remote,true).0,remote);
    }
    #[test] fn reading_position_follows_the_newest_cursor_without_conflicts() {
        let base=json!({"paper":{"title":"t","last_read_page":1,"last_read_fraction":0.1,"last_read_mode":"source","last_read_at":100},"annotations":{}});
        let local=json!({"paper":{"title":"t","last_read_page":7,"last_read_fraction":0.7,"last_read_mode":"dual","last_read_at":200},"annotations":{}});
        let remote=json!({"paper":{"title":"t","last_read_page":3,"last_read_fraction":0.3,"last_read_mode":"translated","last_read_at":300},"annotations":{}});
        let(merged,conflicts)=merge(&base,&local,&remote,false);
        assert!(conflicts.is_empty(),"{conflicts:?}");
        assert_eq!(merged["paper"]["last_read_page"],json!(3));
        assert_eq!(merged["paper"]["last_read_mode"],json!("translated"));
        assert_eq!(merged["paper"]["last_read_at"],json!(300));
        // Ordinary fields still merge field-by-field and keep their conflicts.
        let local=json!({"paper":{"title":"mine","last_read_at":200},"annotations":{}});
        let remote=json!({"paper":{"title":"theirs","last_read_at":300},"annotations":{}});
        let(merged,conflicts)=merge(&base,&local,&remote,false);
        assert_eq!(merged["paper"]["title"],json!("mine"));
        assert_eq!(conflicts,vec!["/paper/title".to_string()],"only the edited field conflicts");
    }

    #[test] fn digest_cache_follows_the_newest_generation_without_conflicts() {
        let digest=|at:i64,body:&str|json!({"markdown":body,"generated_at":at,"model":"test"}).to_string();
        let base=json!({"paper":{"id":"p","title":"t","digest_json":digest(100,"old")},"annotations":{}});
        let local=json!({"paper":{"id":"p","title":"t","digest_json":digest(200,"mine")},"annotations":{}});
        let remote=json!({"paper":{"id":"p","title":"t","digest_json":digest(300,"theirs")},"annotations":{}});
        let(merged,conflicts)=merge(&base,&local,&remote,false);
        assert!(conflicts.is_empty(),"{conflicts:?}");
        assert_eq!(merged["paper"]["digest_json"],json!(digest(300,"theirs")));
        // Local is newer: it wins over an older remote generation.
        let local=json!({"paper":{"id":"p","title":"t","digest_json":digest(400,"mine")},"annotations":{}});
        let remote=json!({"paper":{"id":"p","title":"t","digest_json":digest(350,"theirs")},"annotations":{}});
        let(merged,conflicts)=merge(&base,&local,&remote,false);
        assert!(conflicts.is_empty(),"{conflicts:?}");
        assert_eq!(merged["paper"]["digest_json"],json!(digest(400,"mine")));
        // Equal `generated_at` keeps local deterministically, even when the
        // remote side is preferred for ordinary fields.
        let remote=json!({"paper":{"id":"p","title":"t","digest_json":digest(400,"theirs")},"annotations":{}});
        let(merged,conflicts)=merge(&base,&local,&remote,true);
        assert!(conflicts.is_empty(),"{conflicts:?}");
        assert_eq!(merged["paper"]["digest_json"],json!(digest(400,"mine")));
    }
    #[test] fn digest_cache_treats_null_and_malformed_values_as_absent() {
        let digest=|at:i64,body:&str|json!({"markdown":body,"generated_at":at,"model":"test"}).to_string();
        let base=json!({"paper":{"id":"p","title":"t","digest_json":digest(100,"old")},"annotations":{}});
        let remote=json!({"paper":{"id":"p","title":"t","digest_json":digest(200,"fresh")},"annotations":{}});
        // A cleared cache on one device must not erase the digest generated on
        // the other side.
        let local=json!({"paper":{"id":"p","title":"t","digest_json":Value::Null},"annotations":{}});
        let(merged,conflicts)=merge(&base,&local,&remote,false);
        assert!(conflicts.is_empty(),"{conflicts:?}");
        assert_eq!(merged["paper"]["digest_json"],json!(digest(200,"fresh")));
        // Malformed TEXT is "no digest" and loses to the readable remote one,
        // instead of surfacing a conflict the user cannot act on.
        let local=json!({"paper":{"id":"p","title":"t","digest_json":"{\"markdown\":"},"annotations":{}});
        let(merged,conflicts)=merge(&base,&local,&remote,false);
        assert!(conflicts.is_empty(),"{conflicts:?}");
        assert_eq!(merged["paper"]["digest_json"],json!(digest(200,"fresh")));
        // With neither side parseable, a present value still beats NULL.
        let remote=json!({"paper":{"id":"p","title":"t","digest_json":Value::Null},"annotations":{}});
        let(merged,conflicts)=merge(&base,&local,&remote,false);
        assert!(conflicts.is_empty(),"{conflicts:?}");
        assert_eq!(merged["paper"]["digest_json"],json!("{\"markdown\":"));
    }

    #[test] fn rejects_unsafe_paths() {for path in ["../library.db","files/../../outside",".sync/config","/tmp/x","files/C:\\x","files\\x"] {assert!(!safe_path(path));}assert!(safe_path("imports/zotero/a/file.pdf"));}
    #[test] fn incoming_upserts_update_the_journal_without_unique_conflicts() {
        let root=std::env::temp_dir().join(format!("moonlight-sync-journal-{}",uuid::Uuid::new_v4()));
        let lib=crate::library::Library::new(&root).unwrap();
        lib.conn().execute("INSERT INTO papers(id,title,authors,imported_at,updated_at) VALUES('p','Old','',0,0)",[]).unwrap();
        let before:i64=lib.conn().query_row("SELECT value FROM sync_revision WHERE id=1",[],|r|r.get(0)).unwrap();
        let mut doc=load(&lib.conn(),"paper:p").unwrap();doc["paper"]["title"]=json!("Updated");
        {let conn=lib.conn();let tx=conn.unchecked_transaction().unwrap();apply(&tx,"paper:p",&doc).unwrap();apply(&tx,"paper:p",&doc).unwrap();tx.commit().unwrap();}
        let revision:i64=lib.conn().query_row("SELECT revision FROM sync_dirty WHERE key='paper:p'",[],|r|r.get(0)).unwrap();
        assert!(revision>before);assert_eq!(load(&lib.conn(),"paper:p").unwrap()["paper"]["title"],"Updated");
        drop(lib);std::fs::remove_dir_all(root).unwrap();
    }
    #[test] fn deletion_commits_remove_folders_tags_and_their_links() {
        let root=std::env::temp_dir().join(format!("moonlight-sync-delete-{}",uuid::Uuid::new_v4()));
        let lib=crate::library::Library::new(&root).unwrap();
        {
            let conn=lib.conn();
            conn.execute("INSERT INTO papers(id,title,authors,imported_at,updated_at) VALUES('p','Paper','',0,0)",[]).unwrap();
            conn.execute("INSERT INTO categories(id,name,parent_id,sort_order) VALUES('top','Top',NULL,0)",[]).unwrap();
            conn.execute("INSERT INTO categories(id,name,parent_id,sort_order) VALUES('mid','Mid','top',0)",[]).unwrap();
            conn.execute("INSERT INTO categories(id,name,parent_id,sort_order) VALUES('leaf','Leaf','mid',0)",[]).unwrap();
            conn.execute("INSERT INTO paper_categories(paper_id,category_id) VALUES('p','mid')",[]).unwrap();
            conn.execute("INSERT INTO tags(id,name,color) VALUES('tag-1','ml',NULL)",[]).unwrap();
            conn.execute("INSERT INTO paper_tags(paper_id,tag_id) VALUES('p','tag-1')",[]).unwrap();
        }
        {
            let conn=lib.conn();let tx=conn.unchecked_transaction().unwrap();
            apply(&tx,"category:mid",&Value::Null).unwrap();
            apply(&tx,"tag:ml",&Value::Null).unwrap();
            // A replayed delete commit must stay a no-op instead of failing.
            apply(&tx,"category:mid",&Value::Null).unwrap();
            apply(&tx,"tag:ml",&Value::Null).unwrap();
            tx.commit().unwrap();
        }
        {
            let conn=lib.conn();
            assert_eq!(conn.query_row("SELECT COUNT(*) FROM categories WHERE id='mid'",[],|r|r.get::<_,i64>(0)).unwrap(),0);
            assert_eq!(conn.query_row("SELECT COUNT(*) FROM paper_categories WHERE category_id='mid'",[],|r|r.get::<_,i64>(0)).unwrap(),0);
            assert_eq!(conn.query_row("SELECT parent_id FROM categories WHERE id='leaf'",[],|r|r.get::<_,Option<String>>(0)).unwrap().as_deref(),Some("top"));
            assert_eq!(conn.query_row("SELECT COUNT(*) FROM tags WHERE name='ml'",[],|r|r.get::<_,i64>(0)).unwrap(),0);
            assert_eq!(conn.query_row("SELECT COUNT(*) FROM paper_tags WHERE tag_id='tag-1'",[],|r|r.get::<_,i64>(0)).unwrap(),0);
        }
        // A deleted taxonomy entry must not be exported back to peers.
        let exported=export(&lib.conn()).unwrap();
        assert!(!exported.contains_key("category:mid"));
        assert!(!exported.contains_key("tag:ml"));
        drop(lib);std::fs::remove_dir_all(root).unwrap();
    }
}
