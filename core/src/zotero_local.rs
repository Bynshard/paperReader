//! Read-only Zotero SQLite migration. Original records remain in a consistent
//! SQLite archive; supported data is projected into the working library.
use crate::library::{now_ms, sha256_file, Library};
use anyhow::{anyhow, Context, Result};
use regex::Regex;
use rusqlite::{backup::Backup, params, Connection, OpenFlags, OptionalExtension};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{collections::HashMap, fs, ops::Deref, path::{Component, Path, PathBuf}, time::{Duration, Instant}};
use uuid::Uuid;

pub const SCHEMA: &str = r#"
CREATE TABLE IF NOT EXISTS zotero_items (
 source_id TEXT NOT NULL, library_id INTEGER NOT NULL, item_key TEXT NOT NULL,
 paper_id TEXT NOT NULL REFERENCES papers(id) ON DELETE CASCADE,
 metadata TEXT NOT NULL, notes_html TEXT NOT NULL, PRIMARY KEY(source_id,library_id,item_key));
CREATE INDEX IF NOT EXISTS idx_zotero_items_paper ON zotero_items(paper_id);
CREATE TABLE IF NOT EXISTS zotero_files (
 id TEXT PRIMARY KEY, paper_id TEXT NOT NULL REFERENCES papers(id) ON DELETE CASCADE,
 attachment_key TEXT NOT NULL, title TEXT NOT NULL, content_type TEXT NOT NULL,
 original_path TEXT, rel_path TEXT, version_id TEXT, status TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS idx_zotero_files_paper ON zotero_files(paper_id);
CREATE TABLE IF NOT EXISTS zotero_annotation_map (
 source_id TEXT NOT NULL, library_id INTEGER NOT NULL, item_key TEXT NOT NULL,
 annotation_id TEXT NOT NULL REFERENCES annotations(id) ON DELETE CASCADE,
 PRIMARY KEY(source_id,library_id,item_key));
CREATE INDEX IF NOT EXISTS idx_papers_doi_normalized ON papers(lower(doi));
"#;

fn hash(text: &str) -> String { format!("{:x}", Sha256::digest(text.as_bytes())) }
fn table(conn: &Connection, name: &str) -> bool {
    conn.query_row("SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE name=?)", [name], |r| r.get(0)).unwrap_or(false)
}
struct TempDir(PathBuf);
impl Drop for TempDir { fn drop(&mut self) { let _ = fs::remove_dir_all(&self.0); } }
struct Snapshot { conn: Connection, _dir: TempDir }
impl Deref for Snapshot { type Target=Connection; fn deref(&self)->&Connection { &self.conn } }
fn snapshot(dir: &Path) -> Result<Snapshot> {
    // SQLite's backup API takes a coherent WAL-aware snapshot. Copying the DB,
    // WAL and SHM independently can produce a mixed point in time.
    let source=Connection::open_with_flags(dir.join("zotero.sqlite"), OpenFlags::SQLITE_OPEN_READ_ONLY)?;
    source.busy_timeout(Duration::from_secs(10))?;
    let temp=TempDir(std::env::temp_dir().join(format!("moonlight-zotero-{}",Uuid::new_v4())));
    fs::create_dir_all(&temp.0)?;
    let mut conn=Connection::open(temp.0.join("snapshot.sqlite"))?;
    Backup::new(&source,&mut conn)?.run_to_completion(256,Duration::from_millis(5),None)?;
    conn.execute_batch("PRAGMA query_only=ON;")?;
    Ok(Snapshot {conn,_dir:temp})
}
fn find_dir(explicit: Option<&str>) -> Option<PathBuf> {
    let mut dirs=vec![];
    if let Some(p)=explicit {
        let path=PathBuf::from(p);
        dirs.push(if path.is_file() {path.parent()?.to_path_buf()} else {path});
    } else {
        if let Ok(p)=std::env::var("MOONLIGHT_ZOTERO_DIR") {dirs.push(p.into());}
        for var in ["HOME","USERPROFILE"] {
            if let Some(home)=std::env::var_os(var).map(PathBuf::from) {
                dirs.push(home.join("Zotero"));
                // Zotero keeps custom data directories in the profile prefs.
                for base in [home.join(".zotero/zotero"),home.join("Library/Application Support/Zotero/Profiles"),home.join("AppData/Roaming/Zotero/Zotero/Profiles")] {
                    dirs.push(base.clone());
                    if let Ok(entries)=fs::read_dir(base) {
                        for entry in entries.flatten() {
                            if let Ok(prefs)=fs::read_to_string(entry.path().join("prefs.js")) {
                                for line in prefs.lines().filter(|l|l.contains("extensions.zotero.dataDir")) {
                                    if let Some(value)=line.split_once(", ").map(|v|v.1.trim_end_matches(");")) {
                                        if let Ok(p)=serde_json::from_str::<String>(value) {dirs.push(p.into());}
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
    }
    dirs.into_iter().find(|p|p.join("zotero.sqlite").is_file())
}
#[derive(Clone)]
struct Collection { id:i64, key:String, path:String, library:i64, count:i64 }
fn collections(conn:&Connection)->Result<Vec<Collection>> {
    let mut stmt=conn.prepare("SELECT c.collectionID,c.key,c.collectionName,c.parentCollectionID,c.libraryID,COUNT(ci.itemID) FROM collections c LEFT JOIN collectionItems ci ON ci.collectionID=c.collectionID GROUP BY c.collectionID")?;
    let rows=stmt.query_map([],|r|Ok((r.get::<_,i64>(0)?,r.get::<_,String>(1)?,r.get::<_,String>(2)?,r.get::<_,Option<i64>>(3)?,r.get::<_,i64>(4)?,r.get::<_,i64>(5)?)))?.collect::<rusqlite::Result<Vec<_>>>()?;
    let names:HashMap<_,_>=rows.iter().map(|r|(r.0,(r.2.clone(),r.3))).collect();
    let mut groups=HashMap::<i64,String>::new();
    if table(conn,"groups") {
        let mut s=conn.prepare("SELECT libraryID,name FROM groups")?;
        for row in s.query_map([],|r|Ok((r.get(0)?,r.get(1)?)))? {let (id,name)=row?;groups.insert(id,name);}
    }
    let mut out=vec![];
    for (id,key,name,parent,library,count) in rows {
        let mut parts=vec![name]; let mut current=parent; let mut seen=vec![id];
        while let Some(p)=current {
            if seen.contains(&p) {return Err(anyhow!("Zotero collection cycle at {id}"));} seen.push(p);
            if let Some((name,parent))=names.get(&p) {parts.insert(0,name.clone());current=*parent;} else {break;}
        }
        if library!=1 {parts.insert(0,format!("{} [{}]",groups.get(&library).map(String::as_str).unwrap_or("Library"),library));}
        out.push(Collection{id,key,path:parts.join(" / "),library,count});
    }
    out.sort_by(|a,b|a.path.cmp(&b.path));Ok(out)
}
fn eligible_sql(conn:&Connection)->String {
    let deleted=if table(conn,"deletedItems") {"AND i.itemID NOT IN (SELECT itemID FROM deletedItems)"} else {""};
    format!("SELECT i.itemID,i.key,i.libraryID,t.typeName FROM items i JOIN itemTypes t ON t.itemTypeID=i.itemTypeID WHERE t.typeName!='annotation' {deleted} AND NOT EXISTS(SELECT 1 FROM itemAttachments a WHERE a.itemID=i.itemID AND a.parentItemID IS NOT NULL) AND NOT EXISTS(SELECT 1 FROM itemNotes n WHERE n.itemID=i.itemID AND n.parentItemID IS NOT NULL) ORDER BY i.itemID")
}
pub fn probe(explicit:Option<&str>)->Value {
    let Some(dir)=find_dir(explicit) else {return json!({"found":false,"collections":[],"error":"请选择包含 zotero.sqlite 的 Zotero 数据目录"})};
    match snapshot(&dir).and_then(|conn|{
        let cols=collections(&conn)?;
        let count:i64=conn.query_row(&format!("SELECT COUNT(*) FROM ({})",eligible_sql(&conn)),[],|r|r.get(0))?;
        let version:Option<i64>=conn.query_row("SELECT version FROM version WHERE schema='userdata'",[],|r|r.get(0)).optional().unwrap_or(None);
        Ok(json!({"found":true,"source":"sqlite","data_dir":dir,"db_version":version,"items":count,
          "collections":cols.iter().map(|c|json!({"id":c.id,"key":format!("{}:{}",c.library,c.key),"name":c.path,"items":c.count})).collect::<Vec<_>>() }))
    }) {Ok(v)=>v,Err(e)=>json!({"found":false,"data_dir":dir,"collections":[],"error":e.to_string()})}
}
fn fields(conn:&Connection,id:i64)->Result<HashMap<String,String>> {
    let mut stmt=conn.prepare("SELECT f.fieldName,v.value FROM itemData d JOIN fields f ON f.fieldID=d.fieldID JOIN itemDataValues v ON v.valueID=d.valueID WHERE d.itemID=?")?;
    let values=stmt.query_map([id],|r|Ok((r.get(0)?,r.get(1)?)))?.collect::<rusqlite::Result<HashMap<_,_>>>()?;
    Ok(values)
}
fn plain(html:&str)->String {
    let breaks=Regex::new(r"(?i)<(?:br\s*/?|/p|/div|/li)>").unwrap();
    let text=breaks.replace_all(html,"\n");
    let text=Regex::new(r"(?s)<[^>]+>").unwrap().replace_all(&text,"").into_owned();
    text.replace("&nbsp;"," ").replace("&lt;","<").replace("&gt;",">").replace("&quot;","\"").replace("&#39;","'").replace("&amp;","&").trim().to_string()
}
#[derive(Clone)]
struct Attachment { id:i64, key:String, title:String, mime:String, raw:Option<String>, path:Option<PathBuf> }
fn safe_join(base:&Path,relative:&str)->Option<PathBuf> {
    let path=Path::new(relative);
    if path.components().all(|c|matches!(c,Component::Normal(_))) {Some(base.join(path))} else {None}
}
fn attachments(conn:&Connection,dir:&Path,base:Option<&Path>,id:i64,standalone:bool)->Result<Vec<Attachment>> {
    let pred=if standalone {"a.itemID=?"} else {"a.parentItemID=?"};
    let deleted=if table(conn,"deletedItems") {"AND a.itemID NOT IN (SELECT itemID FROM deletedItems)"} else {""};
    let mut stmt=conn.prepare(&format!("SELECT a.itemID,i.key,COALESCE(a.contentType,''),a.path FROM itemAttachments a JOIN items i ON i.itemID=a.itemID WHERE {pred} {deleted} ORDER BY a.itemID"))?;
    let rows=stmt.query_map([id],|r|Ok((r.get::<_,i64>(0)?,r.get::<_,String>(1)?,r.get::<_,String>(2)?,r.get::<_,Option<String>>(3)?)))?.collect::<rusqlite::Result<Vec<_>>>()?;
    let mut out=vec![];
    for (id,key,mime,raw) in rows {
        let path=raw.as_deref().and_then(|p|{
            if let Some(rest)=p.strip_prefix("storage:") {safe_join(&dir.join("storage").join(&key),rest)}
            else if let Some(rest)=p.strip_prefix("attachments:") {base.and_then(|b|safe_join(b,rest))}
            else {let path=PathBuf::from(p);path.is_absolute().then_some(path)}
        }).filter(|p|p.is_file());
        let title=fields(conn,id)?.remove("title").or_else(||raw.clone()).unwrap_or_else(||key.clone());
        out.push(Attachment{id,key,title,mime,raw,path});
    } Ok(out)
}
fn copy_tree(source:&Path,dest:&Path)->Result<()> {
    fs::create_dir_all(dest)?;
    for entry in fs::read_dir(source)? {
        let entry=entry?;let kind=entry.file_type()?;
        if kind.is_symlink() {return Err(anyhow!("attachment snapshot contains a symlink: {}",entry.path().display()));}
        if kind.is_dir() {copy_tree(&entry.path(),&dest.join(entry.file_name()))?;}
        else if kind.is_file() {fs::copy(entry.path(),dest.join(entry.file_name()))?;}
    } Ok(())
}
fn normalized_doi(text:&str)->String {
    let text=text.trim().to_lowercase();
    text.strip_prefix("https://doi.org/").or_else(||text.strip_prefix("http://doi.org/")).or_else(||text.strip_prefix("doi:")).unwrap_or(&text).trim().to_string()
}

pub fn list_files(lib:&Library,paper:&str)->Result<Value> {
    let conn=lib.conn();let mut stmt=conn.prepare("SELECT id,title,content_type,status,version_id FROM zotero_files WHERE paper_id=? ORDER BY rowid")?;
    let rows=stmt.query_map([paper],|r|Ok(json!({"id":r.get::<_,String>(0)?,"title":r.get::<_,String>(1)?,"content_type":r.get::<_,String>(2)?,"status":r.get::<_,String>(3)?,"version_id":r.get::<_,Option<String>>(4)?})))?.collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(json!(rows))
}
pub fn attachment_path(lib:&Library,paper:&str,file:&str)->Result<Value> {
    let rel:Option<String>=lib.conn().query_row("SELECT rel_path FROM zotero_files WHERE id=? AND paper_id=?",params![file,paper],|r|r.get(0))?;
    let path=PathBuf::from(rel.ok_or_else(||anyhow!("附件尚未下载或路径缺失"))?);
    let path=if path.is_absolute(){path}else{lib.root().join(path)};
    if !path.is_file() {return Err(anyhow!("附件文件已不存在"));}
    Ok(json!({"path":path}))
}

struct ContextData<'a> {
    lib:&'a Library, source:&'a Connection, dir:&'a Path, source_id:String,
    cols:Vec<Collection>, item_cols:HashMap<i64,Vec<i64>>, base:Option<PathBuf>,
    copy:bool, notes:bool, annotations:bool,
}
impl ContextData<'_> {
    fn import_item(&self,batch:&mut rusqlite::Transaction<'_>,id:i64,key:&str,library:i64,kind:&str)->Result<Value> {
        let data=fields(self.source,id)?;
        let atts=attachments(self.source,self.dir,self.base.as_deref(),id,kind=="attachment")?;
        let mut notes_html=Vec::<String>::new();
        if self.notes {
            let deleted=if table(self.source,"deletedItems") {"AND itemID NOT IN (SELECT itemID FROM deletedItems)"} else {""};
            let mut stmt=self.source.prepare(&format!("SELECT note FROM itemNotes WHERE (parentItemID=? OR itemID=?) {deleted} ORDER BY itemID"))?;
            notes_html=stmt.query_map(params![id,id],|r|r.get::<_,String>(0))?.collect::<rusqlite::Result<_>>()?;
        }
        let notes=notes_html.iter().map(|s|plain(s)).collect::<Vec<_>>().join("\n\n");
        let mut creators=self.source.prepare("SELECT COALESCE(c.firstName,''),COALESCE(c.lastName,'') FROM itemCreators ic JOIN creators c ON c.creatorID=ic.creatorID WHERE ic.itemID=? ORDER BY ic.orderIndex")?;
        let authors=creators.query_map([id],|r|Ok(format!("{} {}",r.get::<_,String>(0)?,r.get::<_,String>(1)?).trim().to_string()))?.collect::<rusqlite::Result<Vec<_>>>()?.join(", ");
        let title=data.get("title").filter(|s|!s.is_empty()).cloned().unwrap_or_else(||{
            if kind=="note" {plain(&notes_html.join("\n")).chars().take(100).collect()} else {atts.first().map(|a|a.title.clone()).unwrap_or_else(||"Untitled".into())}
        });
        let doi=data.get("DOI").map(|s|normalized_doi(s)).filter(|s|!s.is_empty());
        let year=data.get("date").and_then(|s|Regex::new(r"\b(?:19|20)\d{2}\b").unwrap().find(s).map(|m|m.as_str().to_string()));
        let venue=["publicationTitle","conferenceName","proceedingsTitle","bookTitle"].iter().find_map(|k|data.get(*k)).cloned().unwrap_or_default();
        let arxiv=data.get("archiveID").cloned().or_else(||data.get("extra").and_then(|s|Regex::new(r"(?i)arxiv:\s*([\w./-]+)").unwrap().captures(s).map(|c|c[1].to_string())));
        // Isolate each record with SQLite's savepoint implementation, while
        // committing batches to avoid an fsync for every metadata-only item.
        let tx=batch.savepoint()?;
        let projection=json!({"title":title,"authors":authors,"year":year,"venue":venue,"doi":doi,"arxiv":arxiv,"abstract":data.get("abstractNote")});
        let mapped:Option<(String,String,String)>=tx.query_row("SELECT z.paper_id,z.notes_html,z.metadata FROM zotero_items z JOIN papers p ON p.id=z.paper_id WHERE source_id=? AND library_id=? AND item_key=?",params![self.source_id,library,key],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?))).optional()?;
        let mut existing=mapped.as_ref().map(|v|v.0.clone());
        if existing.is_none() {
            if let Some(doi)=&doi {existing=tx.query_row("SELECT id FROM papers WHERE lower(doi)=? AND deleted_at IS NULL",[doi],|r|r.get(0)).optional()?;}
        }
        let mut hashes=HashMap::<i64,String>::new();
        let mut first_pdf=true;
        for a in &atts {
            if let Some(path)=&a.path {
                let sha=sha256_file(path)?;
                let is_pdf=a.mime.contains("pdf") || path.extension().is_some_and(|s|s.eq_ignore_ascii_case("pdf"));
                if existing.is_none() && first_pdf && is_pdf {
                    existing=tx.query_row("SELECT p.id FROM versions v JOIN papers p ON p.id=v.paper_id WHERE v.sha256=? AND v.kind='source' AND p.deleted_at IS NULL AND (? IS NULL OR p.doi IS NULL OR p.doi='' OR lower(p.doi)=?)",params![sha,doi,doi],|r|r.get(0)).optional()?;
                }
                if is_pdf {first_pdf=false;}
                hashes.insert(a.id,sha);
            }
        }
        let is_new=existing.is_none();let paper=existing.unwrap_or_else(||Uuid::new_v4().to_string());
        if is_new {
            tx.execute("INSERT INTO papers(id,title,authors,year,venue,doi,arxiv,abstract,notes,imported_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)",params![paper,title,authors,year,venue,doi,arxiv,data.get("abstractNote"),notes,now_ms(),now_ms()])?;
        } else if let Some((_,old_html,old_metadata))=&mapped {
            let old:Value=serde_json::from_str(old_metadata)?;
            for field in ["title","authors","year","venue","doi","arxiv","abstract"] {
                if old["projection"].get(field).is_some() {
                    tx.execute(&format!("UPDATE papers SET {field}=?,updated_at=? WHERE id=? AND {field} IS ?"),params![projection[field].as_str(),now_ms(),paper,old["projection"][field].as_str()])?;
                }
            }
            // Replace only an unchanged migrated note, preserving local edits.
            if self.notes {
                let old_html:Vec<String>=serde_json::from_str(old_html).unwrap_or_default();
                let old=old_html.iter().map(|s|plain(s)).collect::<Vec<_>>().join("\n\n");
                tx.execute("UPDATE papers SET notes=?,updated_at=? WHERE id=? AND notes=?",params![notes,now_ms(),paper,old])?;
            }
        } else if self.notes && !notes.is_empty() {
            tx.execute("UPDATE papers SET notes=CASE WHEN notes='' THEN ? ELSE notes||char(10)||char(10)||? END WHERE id=?",params![notes,notes,paper])?;
        }
        tx.execute("INSERT INTO zotero_items(source_id,library_id,item_key,paper_id,metadata,notes_html) VALUES(?,?,?,?,?,?) ON CONFLICT(source_id,library_id,item_key) DO UPDATE SET metadata=excluded.metadata,notes_html=excluded.notes_html",params![self.source_id,library,key,paper,json!({"fields":data,"projection":projection}).to_string(),serde_json::to_string(&notes_html)?])?;
        for c in self.cols.iter().filter(|c|self.item_cols.get(&id).is_some_and(|ids|ids.contains(&c.id))) {
            let cid=hash(&format!("{}:{}:{}",self.source_id,c.library,c.key));
            tx.execute("INSERT INTO categories(id,name,sort_order) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name",params![cid,c.path,c.id])?;
            tx.execute("INSERT OR IGNORE INTO paper_categories(paper_id,category_id) VALUES(?,?)",params![paper,cid])?;
        }
        let mut tags=self.source.prepare("SELECT t.name FROM itemTags it JOIN tags t ON t.tagID=it.tagID WHERE it.itemID=?")?;
        for name in tags.query_map([id],|r|r.get::<_,String>(0))? {
            let name=name?;let tid=hash(&format!("tag:{name}"));
            tx.execute("INSERT OR IGNORE INTO tags(id,name) VALUES(?,?)",params![tid,name])?;
            tx.execute("INSERT OR IGNORE INTO paper_tags(paper_id,tag_id) SELECT ?,id FROM tags WHERE name=?",params![paper,name])?;
        }
        let mut missing=vec![];let mut warnings=vec![];let mut files=0;let mut ann_count=0;let mut pdf_count=0;
        for a in &atts {
            let file_id=hash(&format!("{}:{library}:{}",self.source_id,a.key));
            let mut rel=None;let mut version=None;let mut status="missing";
            if let Some(path)=&a.path {
                let sha=&hashes[&a.id];
                let is_pdf=a.mime.contains("pdf") || path.extension().is_some_and(|s|s.eq_ignore_ascii_case("pdf"));
                let stored=if self.copy {
                    if is_pdf {
                        let rel=format!("files/{sha}.pdf");let dest=self.lib.root().join(&rel);
                        if !dest.exists() {let temp=self.lib.root().join("tmp").join(Uuid::new_v4().to_string());fs::copy(path,&temp)?;fs::rename(temp,&dest)?;} rel
                    } else {
                        let base=PathBuf::from("imports/zotero").join(&self.source_id).join("attachments").join(&file_id).join(sha);
                        let dest=self.lib.root().join(&base);fs::create_dir_all(&dest)?;
                        if a.raw.as_deref().is_some_and(|s|s.starts_with("storage:")) {
                            // Preserve HTML snapshot resources alongside the main file.
                            let storage=self.dir.join("storage").join(&a.key);
                            copy_tree(&storage,&dest)?;
                            safe_join(&base,a.raw.as_deref().unwrap().strip_prefix("storage:").unwrap()).ok_or_else(||anyhow!("invalid stored attachment path"))?.to_string_lossy().to_string()
                        } else {let name=path.file_name().ok_or_else(||anyhow!("invalid filename"))?;fs::copy(path,dest.join(name))?;base.join(name).to_string_lossy().to_string()}
                    }
                } else {path.canonicalize()?.to_string_lossy().to_string()};
                if is_pdf {
                    let pages=crate::pdfmeta::page_count(path).with_context(||format!("invalid PDF {}",path.display()))?;
                    let vid:Option<String>=tx.query_row("SELECT id FROM versions WHERE paper_id=? AND kind='source' AND sha256=?",params![paper,sha],|r|r.get(0)).optional()?;
                    let vid=vid.unwrap_or_else(||Uuid::new_v4().to_string());
                    tx.execute("INSERT INTO versions(id,paper_id,kind,sha256,rel_path,pages,bytes,lang,engine,created_at) VALUES(?,?,'source',?,?,?,?,'','zotero',?) ON CONFLICT(id) DO UPDATE SET rel_path=excluded.rel_path",params![vid,paper,sha,stored,pages,fs::metadata(path)?.len() as i64,now_ms()])?;
                    version=Some(vid.clone());pdf_count+=1;
                    if self.annotations {ann_count+=self.import_annotations(&tx,a,&paper,&vid,path,&mut warnings)?;}
                }
                rel=Some(stored);status=if self.copy {"copied"} else {"linked"};files+=1;
            } else {missing.push(json!({"item":key,"attachment":a.key,"path":a.raw,"reason":if a.raw.as_deref().is_some_and(|s|s.starts_with("attachments:")) && self.base.is_none(){"linked_base_directory_required"}else{"not_available_locally"}}));}
            tx.execute("INSERT INTO zotero_files(id,paper_id,attachment_key,title,content_type,original_path,rel_path,version_id,status) VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET title=excluded.title,rel_path=excluded.rel_path,version_id=excluded.version_id,status=excluded.status",params![file_id,paper,a.key,a.title,a.mime,a.raw,rel,version,status])?;
        }
        tx.commit()?;
        Ok(json!({"paper_id":paper,"status":if is_new {"imported"} else if mapped.is_some(){"updated"}else{"duplicate"},"without_pdf":pdf_count==0,"attachments":files,"annotations":ann_count,"missing_attachments":missing,"warnings":warnings}))
    }

    fn import_annotations(&self,dest:&Connection,a:&Attachment,paper:&str,version:&str,pdf:&Path,warnings:&mut Vec<Value>)->Result<usize> {
        if !table(self.source,"itemAnnotations") {return Ok(0);}
        let mut stmt=self.source.prepare("SELECT i.key,i.libraryID,CAST(a.type AS TEXT),COALESCE(a.text,''),COALESCE(a.comment,''),COALESCE(a.color,'#ffd400'),a.position FROM itemAnnotations a JOIN items i ON i.itemID=a.itemID WHERE a.parentItemID=? AND i.itemID NOT IN (SELECT itemID FROM deletedItems)")?;
        let mut rows=stmt.query([a.id])?;let mut count=0;
        // One document parse per annotated attachment, never once per highlight.
        let mut geometry=None;
        while let Some(row)=rows.next()? {
            let key:String=row.get(0)?;let library:i64=row.get(1)?;let kind:String=row.get(2)?;
            if !["1","2","3","5","highlight","note","image","underline"].contains(&kind.as_str()) {
                warnings.push(json!({"annotation":key,"reason":"annotation_type_archived_only","type":kind}));continue;
            }
            let position:String=row.get(6)?;
            let Ok(pos)=serde_json::from_str::<Value>(&position) else {warnings.push(json!({"annotation":key,"reason":"invalid_position_json"}));continue;};
            let Some(page)=pos["pageIndex"].as_i64().filter(|p|*p>=0) else {warnings.push(json!({"annotation":key,"reason":"invalid_page_index"}));continue;};
            if geometry.is_none() {geometry=Some(lopdf::Document::load(pdf)?);}
            let rects=match normalized_rects(geometry.as_ref().unwrap(),page,&pos) {Ok(r)=>r,Err(e)=>{warnings.push(json!({"annotation":key,"reason":e.to_string()}));continue;}};
            if rects.is_empty() {warnings.push(json!({"annotation":key,"reason":"annotation_geometry_archived_only"}));continue;}
            let old:Option<String>=dest.query_row("SELECT annotation_id FROM zotero_annotation_map WHERE source_id=? AND library_id=? AND item_key=?",params![self.source_id,library,key],|r|r.get(0)).optional()?;
            let annotation=old.unwrap_or_else(||Uuid::new_v4().to_string());
            let color=match row.get::<_,String>(5)?.to_lowercase().as_str(){"#5fb236"=>"green","#2ea8e5"=>"blue",_=>"yellow"};
            dest.execute("INSERT INTO annotations(id,paper_id,version_kind,version_id,page,rects,quote,color,comment,created_at,updated_at) VALUES(?,?,'source',?,?,?,?,?,?,?,?) ON CONFLICT(id) DO NOTHING",params![annotation,paper,version,page,json!(rects).to_string(),row.get::<_,String>(3)?,color,row.get::<_,String>(4)?,now_ms(),now_ms()])?;
            dest.execute("INSERT OR IGNORE INTO zotero_annotation_map(source_id,library_id,item_key,annotation_id) VALUES(?,?,?,?)",params![self.source_id,library,key,annotation])?;count+=1;
        } Ok(count)
    }
}

// PDF.js viewport equivalent for crop origins and page rotation. Geometry is
// normalized to the displayed page, rather than guessing a US-letter MediaBox.
fn normalized_rects(doc:&lopdf::Document,page:i64,pos:&Value)->Result<Vec<Value>> {
    use lopdf::Object;
    let page_id=*doc.get_pages().get(&((page+1) as u32)).ok_or_else(||anyhow!("invalid annotation page {page}"))?;
    let inherited=|key:&[u8]|->Option<Object>{
        let mut current=page_id;
        for _ in 0..64 {
            let dict=doc.get_dictionary(current).ok()?;
            if let Ok(value)=dict.get(key) {return Some(doc.dereference(value).ok()?.1.clone());}
            current=dict.get(b"Parent").ok()?.as_reference().ok()?;
        } None
    };
    let nums=|o:Object|->Option<Vec<f64>>{o.as_array().ok()?.iter().map(|v|v.as_float().ok().map(|v|v as f64)).collect()};
    let media=inherited(b"MediaBox").and_then(nums).filter(|a|a.len()==4).ok_or_else(||anyhow!("missing PDF page box"))?;
    let mut view=media.clone();
    if let Some(crop)=inherited(b"CropBox").and_then(nums).filter(|a|a.len()==4) {
        let v=vec![media[0].max(crop[0]),media[1].max(crop[1]),media[2].min(crop[2]),media[3].min(crop[3])];
        if v[2]>v[0] && v[3]>v[1] {view=v;}
    }
    let rotation=inherited(b"Rotate").and_then(|v|v.as_i64().ok()).unwrap_or(0).rem_euclid(360);
    let w=view[2]-view[0];let h=view[3]-view[1];
    if w<=0.0 || h<=0.0 {return Err(anyhow!("invalid PDF page dimensions"));}
    let transform=|x:f64,y:f64|->(f64,f64){let x=(x-view[0])/w;let y=(y-view[1])/h;match rotation {90=>(y,x),180=>(1.0-x,y),270=>(1.0-y,1.0-x),_=>(x,1.0-y)}};
    let mut out=vec![];
    if let Some(rects)=pos["rects"].as_array() {
        for rect in rects {
            let Some(v)=rect.as_array().filter(|v|v.len()==4) else {continue};
            let Some(v)=v.iter().map(Value::as_f64).collect::<Option<Vec<_>>>() else {continue};
            let (x0,y0)=transform(v[0],v[1]);let(x1,y1)=transform(v[2],v[3]);
            let (left,top,right,bottom)=(x0.min(x1).clamp(0.,1.),y0.min(y1).clamp(0.,1.),x0.max(x1).clamp(0.,1.),y0.max(y1).clamp(0.,1.));
            if right>left && bottom>top {out.push(json!({"x":left,"y":top,"w":right-left,"h":bottom-top}));}
        }
    } Ok(out)
}

pub fn import(lib:&Library,opts:&Value)->Result<Value> {
    let start=Instant::now();
    let dir=find_dir(opts["data_dir"].as_str()).ok_or_else(||anyhow!("请选择 Zotero 数据目录"))?.canonicalize()?;
    let source=snapshot(&dir)?;let cols=collections(&source)?;
    let mut item_cols=HashMap::<i64,Vec<i64>>::new();
    let mut stmt=source.prepare("SELECT itemID,collectionID FROM collectionItems")?;
    for row in stmt.query_map([],|r|Ok((r.get::<_,i64>(0)?,r.get::<_,i64>(1)?)))? {let(i,c)=row?;item_cols.entry(i).or_default().push(c);}
    let wanted=opts["collections"].as_array().map(|v|v.iter().filter_map(Value::as_str).collect::<Vec<_>>()).filter(|v|!v.is_empty());
    let mut selected=vec![];
    if let Some(wanted)=&wanted {
        for c in &cols {
            if wanted.iter().any(|s|*s==c.path || *s==c.key || *s==format!("{}:{}",c.library,c.key)) {
                for child in &cols {if child.library==c.library && (child.path==c.path || child.path.starts_with(&format!("{} / ",c.path))) {selected.push(child.id);}}
            }
        }
        if selected.is_empty() {return Err(anyhow!("所选分类不存在；未导入任何条目"));}
    }
    let source_id=hash(&dir.to_string_lossy());
    let copy=opts["copy_attachments"].as_bool().unwrap_or(true);
    let archive=lib.root().join("imports/zotero").join(&source_id);
    fs::create_dir_all(&archive)?;
    let archive_tmp=archive.join("snapshot.tmp");
    // Archive all original fields, rich notes, relations and unsupported types.
    // This is a data archive, not a claim that all Zotero features are native.
    fs::copy(source._dir.0.join("snapshot.sqlite"),&archive_tmp)?;
    #[cfg(windows)]
    if archive.join("zotero.sqlite").exists() {fs::remove_file(archive.join("zotero.sqlite"))?;}
    fs::rename(archive_tmp,archive.join("zotero.sqlite"))?;
    let context=ContextData{lib,source:&source,dir:&dir,source_id,cols,item_cols,base:opts["linked_base_dir"].as_str().filter(|s|!s.is_empty()).map(PathBuf::from),copy,notes:opts["include_notes"].as_bool().unwrap_or(true),annotations:opts["include_annotations"].as_bool().unwrap_or(true)};
    let mut stmt=source.prepare(&eligible_sql(&source))?;
    let mut rows=stmt.query([])?;
    let mut report=json!({"source":"sqlite","data_dir":dir,"archive":archive,"items":0,"imported":0,"updated":0,"duplicates":0,"without_pdf":0,"attachments":0,"annotations":0,"collections":context.cols.len(),"missing_attachments":[],"warnings":[],"errors":[]});
    let limit=opts["limit"].as_u64().unwrap_or(0);let mut processed=0;
    let mut dest=lib.conn();
    let mut batch=dest.transaction()?;
    while let Some(row)=rows.next()? {
        let(id,key,library,kind):(i64,String,i64,String)=(row.get(0)?,row.get(1)?,row.get(2)?,row.get(3)?);
        if wanted.is_some() && !context.item_cols.get(&id).is_some_and(|ids|ids.iter().any(|i|selected.contains(i))) {continue;}
        if limit>0 && processed>=limit {break;} processed+=1;
        match context.import_item(&mut batch,id,&key,library,&kind) {
            Ok(item)=>{
                report["items"]=json!(report["items"].as_u64().unwrap()+1);
                let field=match item["status"].as_str().unwrap(){"imported"=>"imported","updated"=>"updated",_=>"duplicates"};
                report[field]=json!(report[field].as_u64().unwrap()+1);
                if item["without_pdf"]==true {report["without_pdf"]=json!(report["without_pdf"].as_u64().unwrap()+1);}
                for k in ["attachments","annotations"] {report[k]=json!(report[k].as_u64().unwrap()+item[k].as_u64().unwrap());}
                for k in ["missing_attachments","warnings"] {report[k].as_array_mut().unwrap().extend(item[k].as_array().unwrap().iter().cloned());}
            }
            Err(e)=>report["errors"].as_array_mut().unwrap().push(json!({"item":key,"library":library,"error":format!("{e:#}")})),
        }
        if processed%100==0 {batch.commit()?;batch=dest.transaction()?;}
    }
    batch.commit()?;
    report["duration_ms"]=json!(start.elapsed().as_millis());
    fs::write(archive.join("last-report.json"),serde_json::to_vec_pretty(&report)?)?;
    Ok(report)
}
