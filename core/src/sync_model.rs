//! Portable sync documents and three-way merge. SQLite stays local; PDFs and
//! metadata commits travel independently, never a live database file.
use anyhow::{anyhow, Result};
use rusqlite::{params, params_from_iter, types::{Value as SqlValue,ValueRef}, Connection};
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
    let mut conflicts=vec![];let value=walk(base,local,remote,"",prefer_remote,&mut conflicts);(value,conflicts)
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
        // Taxonomy is append-only; removing a paper's membership is synced in
        // that paper. There is no global taxonomy-delete UI yet.
        if !doc.is_null() {conn.execute("INSERT INTO tags(id,name,color) VALUES(?,?,?) ON CONFLICT(name) DO UPDATE SET color=excluded.color",params![super::sync::digest(&format!("tag:{name}")),name,doc["color"].as_str()])?;}return Ok(());
    }
    if key.starts_with("category:") {if !doc.is_null(){upsert(conn,"categories",doc)?;}return Ok(());}
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
}
