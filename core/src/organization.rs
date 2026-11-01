//! Library organization: folder hierarchy, additive bulk assignments and short notes.
use crate::library::{Library,now_ms};
use anyhow::{Result,anyhow,ensure};
use rusqlite::{params,OptionalExtension};
use serde_json::{json,Value};
use std::collections::{HashMap,HashSet};
pub fn initialize(conn:&rusqlite::Connection)->Result<()> {
    for (table,column,definition) in [
        ("categories","parent_id","TEXT"),("papers","short_note","TEXT NOT NULL DEFAULT ''"),
        ("papers","citation_count","INTEGER"),("papers","citation_source","TEXT"),
        ("papers","citation_updated_at","INTEGER"),("papers","citation_url","TEXT"),
    ] {
        let exists=conn.prepare(&format!("PRAGMA table_info({table})"))?.query_map([],|r|r.get::<_,String>(1))?.collect::<rusqlite::Result<Vec<_>>>()?.iter().any(|name|name==column);
        if !exists{conn.execute_batch(&format!("ALTER TABLE {table} ADD COLUMN {column} {definition}"))?;}
    }
    conn.execute_batch("CREATE INDEX IF NOT EXISTS idx_category_parent ON categories(parent_id,sort_order,name); CREATE INDEX IF NOT EXISTS idx_papers_citations ON papers(deleted_at,citation_count DESC,imported_at DESC,id DESC); CREATE TRIGGER IF NOT EXISTS citation_identity_changed AFTER UPDATE OF doi,arxiv ON papers WHEN OLD.doi IS NOT NEW.doi OR OLD.arxiv IS NOT NEW.arxiv BEGIN UPDATE papers SET citation_count=NULL,citation_source=NULL,citation_updated_at=NULL,citation_url=NULL WHERE id=NEW.id; END;")?;
    Ok(())
}
pub fn folder_save(lib:&Library,p:&Value)->Result<Value> {
    let name=p["name"].as_str().unwrap_or("").trim();ensure!(!name.is_empty()&&name.chars().count()<=100,"目录名应为 1–100 字");
    let id=p["id"].as_str().map(str::to_string).unwrap_or_else(||uuid::Uuid::new_v4().to_string());
    let parent=p["parent_id"].as_str().filter(|s|!s.is_empty());
    let conn=lib.conn();let tx=conn.unchecked_transaction()?;
    if p["id"].is_string(){ensure!(tx.query_row("SELECT EXISTS(SELECT 1 FROM categories WHERE id=?)",[&id],|r|r.get::<_,bool>(0))?,"目录不存在");}
    let mut seen=HashSet::from([id.clone()]);let mut cursor=parent.map(str::to_string);
    while let Some(ancestor)=cursor {
        ensure!(seen.insert(ancestor.clone()),"不能把目录移到自己或其子目录下面");ensure!(seen.len()<=32,"目录最多支持 32 层");
        cursor=tx.query_row("SELECT parent_id FROM categories WHERE id=?",[&ancestor],|r|r.get::<_,Option<String>>(0)).optional()?.ok_or_else(||anyhow!("上级目录不存在"))?;
    }
    let duplicate:bool=tx.query_row("SELECT EXISTS(SELECT 1 FROM categories WHERE parent_id IS ? AND name=? COLLATE NOCASE AND id!=?)",params![parent,name,id],|r|r.get(0))?;
    ensure!(!duplicate,"同一目录下已有这个名称");
    tx.execute("INSERT INTO categories(id,name,parent_id,sort_order) VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,parent_id=excluded.parent_id",params![id,name,parent,now_ms()])?;
    validate_tree(&tx)?;tx.commit()?;Ok(json!({"id":id,"name":name,"parent_id":parent}))
}
pub fn bulk_assign(lib:&Library,p:&Value)->Result<Value> {
    let ids=p["paper_ids"].as_array().ok_or_else(||anyhow!("请选择论文"))?;ensure!(!ids.is_empty()&&ids.len()<=200,"一次最多操作 200 篇论文");
    let folder=p["category_id"].as_str().filter(|s|!s.is_empty());
    let tags=p["tags"].as_array().cloned().unwrap_or_default();ensure!(tags.len()<=50,"一次最多添加 50 个标签");
    ensure!(folder.is_some()||!tags.is_empty(),"请选择目录或填写标签");
    let conn=lib.conn();let tx=conn.unchecked_transaction()?;
    if let Some(folder)=folder{ensure!(tx.query_row("SELECT EXISTS(SELECT 1 FROM categories WHERE id=?)",[folder],|r|r.get::<_,bool>(0))?,"目录不存在");}
    let mut tag_ids=vec![];
    for tag in tags {let name=tag.as_str().unwrap_or("").trim();ensure!(!name.is_empty()&&name.chars().count()<=100,"标签应为 1–100 字");let id=uuid::Uuid::new_v4().to_string();tx.execute("INSERT OR IGNORE INTO tags(id,name) VALUES(?,?)",params![id,name])?;tag_ids.push(tx.query_row("SELECT id FROM tags WHERE name=?",[name],|r|r.get::<_,String>(0))?);}
    let unique:HashSet<&str>=ids.iter().map(|id|id.as_str().ok_or_else(||anyhow!("无效论文 ID"))).collect::<Result<_>>()?;
    for id in &unique {
        ensure!(tx.query_row("SELECT EXISTS(SELECT 1 FROM papers WHERE id=? AND deleted_at IS NULL)",[id],|r|r.get::<_,bool>(0))?,"论文不存在或已移入回收站");
        if let Some(folder)=folder{tx.execute("INSERT OR IGNORE INTO paper_categories(paper_id,category_id) VALUES(?,?)",params![id,folder])?;}
        for tag in &tag_ids {tx.execute("INSERT OR IGNORE INTO paper_tags(paper_id,tag_id) VALUES(?,?)",params![id,tag])?;}
        tx.execute("UPDATE papers SET updated_at=max(updated_at+1,?) WHERE id=?",params![now_ms(),id])?;
    }
    tx.commit()?;Ok(json!({"updated":unique.len()}))
}
pub fn short_note(lib:&Library,p:&Value)->Result<Value> {
    let id=p["paper_id"].as_str().ok_or_else(||anyhow!("paper_id required"))?;
    let text=p["text"].as_str().unwrap_or("").trim();ensure!(text.chars().count()<=300,"一句话速记最多 300 字");
    let conn=lib.conn();let tx=conn.unchecked_transaction()?;
    let updated:i64=tx.query_row("SELECT updated_at FROM papers WHERE id=? AND deleted_at IS NULL",[id],|r|r.get(0))?;
    if let Some(expected)=p["expected_updated_at"].as_i64(){ensure!(expected==updated,"资料已修改，请刷新后重试");}
    tx.execute("UPDATE papers SET short_note=?,updated_at=max(updated_at+1,?) WHERE id=?",params![text,now_ms(),id])?;
    tx.commit()?;Ok(json!({"saved":true}))
}
// Safe flattening also tolerates malformed/orphaned parent links from older synced libraries.
pub fn validate_tree(conn:&rusqlite::Connection)->Result<()> {
    let mut stmt=conn.prepare("SELECT id,parent_id FROM categories")?;
    let parents=stmt.query_map([],|r|Ok((r.get::<_,String>(0)?,r.get::<_,Option<String>>(1)?)))?.collect::<rusqlite::Result<HashMap<_,_>>>()?;
    for start in parents.keys(){let mut cursor=Some(start.clone());let mut seen=HashSet::new();while let Some(id)=cursor{ensure!(seen.insert(id.clone()),"目录同步产生循环，请先调整目录层级");ensure!(seen.len()<=32,"目录层级超过限制");cursor=parents.get(&id).cloned().flatten();}}
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn folders_bulk_tags_notes_and_citation_sort_are_persistent_and_transactional(){
        let root=std::env::temp_dir().join(format!("moonlight-organization-{}",uuid::Uuid::new_v4()));let lib=Library::new(&root).unwrap();
        for id in ["a","b","c"] {lib.conn().execute("INSERT INTO papers(id,title,authors,imported_at,updated_at) VALUES(?,?,'',0,0)",params![id,id]).unwrap();}
        let parent=folder_save(&lib,&json!({"name":"My research"})).unwrap();let parent_id=parent["id"].as_str().unwrap();
        let child=folder_save(&lib,&json!({"name":"RLHF","parent_id":parent_id})).unwrap();let child_id=child["id"].as_str().unwrap();
        assert!(folder_save(&lib,&json!({"id":parent_id,"name":"My research","parent_id":child_id})).is_err());
        assert!(folder_save(&lib,&json!({"name":"RLHF","parent_id":parent_id})).is_err());
        bulk_assign(&lib,&json!({"paper_ids":["a","b"],"category_id":child_id,"tags":["reading","RL"]})).unwrap();
        let page=crate::search::list_page(&lib.conn(),&json!({"category":parent_id})).unwrap();assert_eq!(page["total"],2);
        assert!(bulk_assign(&lib,&json!({"paper_ids":["a","missing"],"tags":["must-rollback"]})).is_err());
        assert_eq!(crate::search::list_page(&lib.conn(),&json!({"tag":"must-rollback"})).unwrap()["total"],0);
        let fresh=lib.get_paper("a").unwrap();short_note(&lib,&json!({"paper_id":"a","text":"解决强化学习吞吐瓶颈","expected_updated_at":fresh["updated_at"]})).unwrap();
        assert!(short_note(&lib,&json!({"paper_id":"a","text":"stale edit","expected_updated_at":0})).is_err());
        assert_eq!(crate::search::list_page(&lib.conn(),&json!({"query":"吞吐瓶颈"})).unwrap()["total"],1);
        lib.conn().execute("UPDATE papers SET citation_count=0 WHERE id='a'",[]).unwrap();lib.conn().execute("UPDATE papers SET citation_count=100 WHERE id='b'",[]).unwrap();
        let page=crate::search::list_page(&lib.conn(),&json!({"sort":"citations"})).unwrap();assert_eq!(page["items"][0]["id"],"b");assert_eq!(page["items"][2]["id"],"c");
        drop(lib);let reopened=Library::new(&root).unwrap();assert_eq!(reopened.get_paper("a").unwrap()["short_note"],"解决强化学习吞吐瓶颈");assert_eq!(reopened.taxonomy().unwrap()["categories"].as_array().unwrap().iter().find(|c|c["id"]==child_id).unwrap()["parent_id"],parent_id);
        drop(reopened);std::fs::remove_dir_all(root).unwrap();
    }
}
