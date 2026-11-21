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
struct Collection { id:i64, key:String, name:String, parent:Option<i64>, path:String, library:i64, count:i64 }
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
        let mut parts=vec![name.clone()]; let mut current=parent; let mut seen=vec![id];
        while let Some(p)=current {
            if seen.contains(&p) {return Err(anyhow!("Zotero collection cycle at {id}"));} seen.push(p);
            if let Some((name,parent))=names.get(&p) {parts.insert(0,name.clone());current=*parent;} else {break;}
        }
        if library!=1 {parts.insert(0,format!("{} [{}]",groups.get(&library).map(String::as_str).unwrap_or("Library"),library));}
        out.push(Collection{id,key,name,parent,path:parts.join(" / "),library,count});
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
    cols:Vec<Collection>, category_ids:HashMap<i64,String>, item_cols:HashMap<i64,Vec<i64>>, base:Option<PathBuf>,
    copy:bool, notes:bool, annotations:bool,
}
/// A Zotero annotation whose PDF geometry is already resolved.  The lopdf parse
/// that produced `rects` happens in the lock-free prepare phase.
struct PreparedAnnotation {
    key: String, library: i64, page: i64, rects: Vec<Value>,
    quote: String, comment: String, color: String,
}

/// One attachment after hashing/copying/page-counting.  `created` lists the
/// filesystem paths this item created, so a later commit failure can remove
/// them instead of leaving orphan copies behind.
struct PreparedFile {
    key: String, title: String, mime: String, raw: Option<String>,
    sha: Option<String>, is_pdf: bool, stored: Option<String>, status: &'static str,
    pages: Option<i64>, bytes: Option<i64>, annotations: Vec<PreparedAnnotation>,
    created: Vec<PathBuf>,
}

/// One fully prepared Zotero item: metadata, tags, copied attachments and
/// annotation geometry, all computed without holding `Library::conn()`.
struct PreparedItem {
    key: String, library: i64,
    data: HashMap<String, String>, notes_html: Vec<String>, notes: String,
    title: String, authors: String, year: Option<String>, venue: String,
    doi: Option<String>, arxiv: Option<String>, projection: Value,
    tags: Vec<String>, collections: Vec<i64>,
    files: Vec<PreparedFile>, missing: Vec<Value>, warnings: Vec<Value>,
    first_pdf_sha: Option<String>, without_pdf: bool,
}

impl ContextData<'_> {
    fn file_id(&self,library:i64,key:&str)->String {hash(&format!("{}:{library}:{}",self.source_id,key))}

    /// Phase 1 — every expensive read: Zotero snapshot queries, file hashing,
    /// attachment copies and PDF parsing.  This never touches `Library::conn()`.
    fn prepare_item(&self,id:i64,key:&str,library:i64,kind:&str)->Result<PreparedItem> {
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
        let projection=json!({"title":title,"authors":authors,"year":year,"venue":venue,"doi":doi,"arxiv":arxiv,"abstract":data.get("abstractNote")});
        let mut tags=Vec::<String>::new();
        let mut tag_stmt=self.source.prepare("SELECT t.name FROM itemTags it JOIN tags t ON t.tagID=it.tagID WHERE it.itemID=?")?;
        for name in tag_stmt.query_map([id],|r|r.get::<_,String>(0))? {tags.push(name?);}
        let mut files=Vec::<PreparedFile>::new();
        let mut missing=Vec::<Value>::new();
        let mut warnings=Vec::<Value>::new();
        let mut first_pdf_sha=None;
        let mut first_pdf=true;
        let mut pdf_count=0usize;
        for a in &atts {
            let mut file=PreparedFile{key:a.key.clone(),title:a.title.clone(),mime:a.mime.clone(),raw:a.raw.clone(),
                sha:None,is_pdf:false,stored:None,status:"missing",pages:None,bytes:None,annotations:vec![],created:vec![]};
            if let Some(path)=&a.path {
                let sha=sha256_file(path)?;
                let is_pdf=a.mime.contains("pdf") || path.extension().is_some_and(|s|s.eq_ignore_ascii_case("pdf"));
                file.sha=Some(sha.clone());file.is_pdf=is_pdf;
                if is_pdf {pdf_count+=1;if first_pdf {first_pdf_sha=Some(sha.clone());first_pdf=false;}}
                let stored=if self.copy {
                    if is_pdf {self.store_pdf(path,&sha,&mut file.created)?}
                    else {self.store_attachment(library,a,path,&sha,&mut file.created)?}
                } else {path.canonicalize()?.to_string_lossy().to_string()};
                file.status=if self.copy {"copied"} else {"linked"};file.stored=Some(stored);
                if is_pdf {
                    file.pages=Some(crate::pdfmeta::page_count(path).with_context(||format!("invalid PDF {}",path.display()))?);
                    file.bytes=Some(fs::metadata(path)?.len() as i64);
                    if self.annotations {file.annotations=self.prepare_annotations(a,path,&mut warnings)?;}
                }
            } else {
                missing.push(json!({"item":key,"attachment":a.key,"path":a.raw,"reason":if a.raw.as_deref().is_some_and(|s|s.starts_with("attachments:")) && self.base.is_none(){"linked_base_directory_required"}else{"not_available_locally"}}));
            }
            files.push(file);
        }
        let item=PreparedItem{key:key.to_string(),library,data,notes_html,notes,title,authors,year,venue,doi,arxiv,projection,tags,
            collections:self.item_cols.get(&id).cloned().unwrap_or_default(),
            files,missing,warnings,first_pdf_sha,without_pdf:pdf_count==0};
        #[cfg(test)]
        test_hooks::prepared_item(key);
        Ok(item)
    }

    /// Copy the shared content-addressed PDF.  A `tmp` copy plus rename keeps a
    /// half-written file from ever becoming a version.
    fn store_pdf(&self,path:&Path,sha:&str,created:&mut Vec<PathBuf>)->Result<String> {
        let rel=format!("files/{sha}.pdf");let dest=self.lib.root().join(&rel);
        if !dest.exists() {
            let temp=self.lib.root().join("tmp").join(Uuid::new_v4().to_string());
            if let Err(e)=fs::copy(path,&temp) {let _=fs::remove_file(&temp);return Err(e.into());}
            if let Err(e)=fs::rename(&temp,&dest) {let _=fs::remove_file(&temp);return Err(e.into());}
            created.push(dest);
        }
        Ok(rel)
    }

    /// Copy a non-PDF attachment (an HTML snapshot keeps its resource folder).
    fn store_attachment(&self,library:i64,a:&Attachment,path:&Path,sha:&str,created:&mut Vec<PathBuf>)->Result<String> {
        let base=PathBuf::from("imports/zotero").join(&self.source_id).join("attachments").join(self.file_id(library,&a.key)).join(sha);
        let dest=self.lib.root().join(&base);
        if !dest.exists() {created.push(dest.clone());}
        fs::create_dir_all(&dest)?;
        if a.raw.as_deref().is_some_and(|s|s.starts_with("storage:")) {
            // Preserve HTML snapshot resources alongside the main file.
            let storage=self.dir.join("storage").join(&a.key);
            copy_tree(&storage,&dest)?;
            safe_join(&base,a.raw.as_deref().unwrap().strip_prefix("storage:").unwrap()).ok_or_else(||anyhow!("invalid stored attachment path")).map(|p|p.to_string_lossy().to_string())
        } else {
            let name=path.file_name().ok_or_else(||anyhow!("invalid filename"))?;
            fs::copy(path,dest.join(name))?;
            Ok(base.join(name).to_string_lossy().to_string())
        }
    }

    /// Resolve annotation rectangles against the PDF while the write lock is
    /// free.  One parse per annotated attachment, never once per highlight.
    fn prepare_annotations(&self,a:&Attachment,pdf:&Path,warnings:&mut Vec<Value>)->Result<Vec<PreparedAnnotation>> {
        if !table(self.source,"itemAnnotations") {return Ok(vec![]);}
        let mut stmt=self.source.prepare("SELECT i.key,i.libraryID,CAST(a.type AS TEXT),COALESCE(a.text,''),COALESCE(a.comment,''),COALESCE(a.color,'#ffd400'),a.position FROM itemAnnotations a JOIN items i ON i.itemID=a.itemID WHERE a.parentItemID=? AND i.itemID NOT IN (SELECT itemID FROM deletedItems)")?;
        let mut rows=stmt.query([a.id])?;
        let mut out=Vec::new();
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
            let color=match row.get::<_,String>(5)?.to_lowercase().as_str(){"#5fb236"=>"green","#2ea8e5"=>"blue",_=>"yellow"}.to_string();
            out.push(PreparedAnnotation{key,library,page,rects,quote:row.get::<_,String>(3)?,comment:row.get::<_,String>(4)?,color});
        }
        Ok(out)
    }

    /// Phase 2 — pure SQLite writes.  `batch` is the short-lived write
    /// transaction; each item keeps a savepoint so one bad record never rolls
    /// back its neighbours.
    fn commit_item(&self,batch:&mut rusqlite::Transaction<'_>,item:&PreparedItem)->Result<Value> {
        let tx=batch.savepoint()?;
        let projection=&item.projection;
        let mapped:Option<(String,String,String)>=tx.query_row("SELECT z.paper_id,z.notes_html,z.metadata FROM zotero_items z JOIN papers p ON p.id=z.paper_id WHERE source_id=? AND library_id=? AND item_key=?",params![self.source_id,item.library,item.key],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?))).optional()?;
        let mut existing=mapped.as_ref().map(|v|v.0.clone());
        if existing.is_none() {
            if let Some(doi)=&item.doi {existing=tx.query_row("SELECT id FROM papers WHERE lower(doi)=? AND deleted_at IS NULL",[doi],|r|r.get(0)).optional()?;}
        }
        if existing.is_none() {
            // The first PDF is the identity used to spot an already imported copy.
            if let Some(sha)=&item.first_pdf_sha {
                existing=tx.query_row("SELECT p.id FROM versions v JOIN papers p ON p.id=v.paper_id WHERE v.sha256=? AND v.kind='source' AND p.deleted_at IS NULL AND (? IS NULL OR p.doi IS NULL OR p.doi='' OR lower(p.doi)=?)",params![sha,item.doi,item.doi],|r|r.get(0)).optional()?;
            }
        }
        let is_new=existing.is_none();let paper=existing.unwrap_or_else(||Uuid::new_v4().to_string());
        if is_new {
            tx.execute("INSERT INTO papers(id,title,authors,year,venue,doi,arxiv,abstract,notes,imported_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)",params![paper,item.title,item.authors,item.year,item.venue,item.doi,item.arxiv,item.data.get("abstractNote"),item.notes,now_ms(),now_ms()])?;
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
                tx.execute("UPDATE papers SET notes=?,updated_at=? WHERE id=? AND notes=?",params![item.notes,now_ms(),paper,old])?;
            }
        } else if self.notes && !item.notes.is_empty() {
            tx.execute("UPDATE papers SET notes=CASE WHEN notes='' THEN ? ELSE notes||char(10)||char(10)||? END WHERE id=?",params![item.notes,item.notes,paper])?;
        }
        tx.execute("INSERT INTO zotero_items(source_id,library_id,item_key,paper_id,metadata,notes_html) VALUES(?,?,?,?,?,?) ON CONFLICT(source_id,library_id,item_key) DO UPDATE SET metadata=excluded.metadata,notes_html=excluded.notes_html",params![self.source_id,item.library,item.key,paper,json!({"fields":&item.data,"projection":projection}).to_string(),serde_json::to_string(&item.notes_html)?])?;
        for collection in &item.collections {
            if let Some(cid)=self.category_ids.get(collection){tx.execute("INSERT OR IGNORE INTO paper_categories(paper_id,category_id) VALUES(?,?)",params![paper,cid])?;}
        }
        for name in &item.tags {
            let tid=hash(&format!("tag:{name}"));
            tx.execute("INSERT OR IGNORE INTO tags(id,name) VALUES(?,?)",params![tid,name])?;
            tx.execute("INSERT OR IGNORE INTO paper_tags(paper_id,tag_id) SELECT ?,id FROM tags WHERE name=?",params![paper,name])?;
        }
        let mut ann_count=0usize;
        for f in &item.files {
            let file_id=self.file_id(item.library,&f.key);
            let mut version=None;
            if let Some(sha)=&f.sha {
                if f.is_pdf {
                    let stored=f.stored.as_deref().ok_or_else(||anyhow!("prepared attachment is missing its stored path"))?;
                    let vid:Option<String>=tx.query_row("SELECT id FROM versions WHERE paper_id=? AND kind='source' AND sha256=?",params![paper,sha],|r|r.get(0)).optional()?;
                    let vid=vid.unwrap_or_else(||Uuid::new_v4().to_string());
                    tx.execute("INSERT INTO versions(id,paper_id,kind,sha256,rel_path,pages,bytes,lang,engine,created_at) VALUES(?,?,'source',?,?,?,?,'','zotero',?) ON CONFLICT(id) DO UPDATE SET rel_path=excluded.rel_path",params![vid,paper,sha,stored,f.pages.unwrap_or(0),f.bytes.unwrap_or(0),now_ms()])?;
                    version=Some(vid.clone());
                    if self.annotations {ann_count+=self.commit_annotations(&tx,&paper,&vid,&f.annotations)?;}
                }
            }
            tx.execute("INSERT INTO zotero_files(id,paper_id,attachment_key,title,content_type,original_path,rel_path,version_id,status) VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET title=excluded.title,rel_path=excluded.rel_path,version_id=excluded.version_id,status=excluded.status",params![file_id,paper,f.key,f.title,f.mime,f.raw,f.stored,version,f.status])?;
        }
        tx.commit()?;
        Ok(json!({"paper_id":paper,"status":if is_new {"imported"} else if mapped.is_some(){"updated"}else{"duplicate"},"without_pdf":item.without_pdf,"attachments":item.files.iter().filter(|f|f.sha.is_some()).count(),"annotations":ann_count,"missing_attachments":&item.missing,"warnings":&item.warnings}))
    }

    fn commit_annotations(&self,tx:&Connection,paper:&str,version:&str,annotations:&[PreparedAnnotation])->Result<usize> {
        let mut count=0;
        for a in annotations {
            let old:Option<String>=tx.query_row("SELECT annotation_id FROM zotero_annotation_map WHERE source_id=? AND library_id=? AND item_key=?",params![self.source_id,a.library,a.key],|r|r.get(0)).optional()?;
            let annotation=old.unwrap_or_else(||Uuid::new_v4().to_string());
            tx.execute("INSERT INTO annotations(id,paper_id,version_kind,version_id,page,rects,quote,color,comment,created_at,updated_at) VALUES(?,?,'source',?,?,?,?,?,?,?,?) ON CONFLICT(id) DO NOTHING",params![annotation,paper,version,a.page,json!(a.rects).to_string(),a.quote,a.color,a.comment,now_ms(),now_ms()])?;
            tx.execute("INSERT OR IGNORE INTO zotero_annotation_map(source_id,library_id,item_key,annotation_id) VALUES(?,?,?,?)",params![self.source_id,a.library,a.key,annotation])?;
            count+=1;
        }
        Ok(count)
    }
}

/// Prepared items committed per write transaction.  Small enough that the
/// global write connection is held for milliseconds, large enough to amortise
/// SQLite's commit fsync.
const IMPORT_BATCH:usize=25;

/// Fold one item's outcome into the migration report.
fn absorb(report:&mut Value,item:&Value) {
    report["items"]=json!(report["items"].as_u64().unwrap()+1);
    let field=match item["status"].as_str().unwrap(){"imported"=>"imported","updated"=>"updated",_=>"duplicates"};
    report[field]=json!(report[field].as_u64().unwrap()+1);
    if item["without_pdf"]==true {report["without_pdf"]=json!(report["without_pdf"].as_u64().unwrap()+1);}
    for k in ["attachments","annotations"] {report[k]=json!(report[k].as_u64().unwrap()+item[k].as_u64().unwrap());}
    for k in ["missing_attachments","warnings"] {report[k].as_array_mut().unwrap().extend(item[k].as_array().unwrap().iter().cloned());}
}

/// Remove files this item copied but never referenced, because its commit
/// failed (or the whole batch could not be committed).
fn drop_created(item:&PreparedItem) {
    for file in &item.files {
        for path in file.created.iter().rev() {
            if path.is_dir() {let _=fs::remove_dir_all(path);} else {let _=fs::remove_file(path);}
        }
    }
}

/// Commit a prepared batch and release the write connection immediately.  The
/// filesystem work already happened, so the guard is held only for SQLite.
fn commit_batch(ctx:&ContextData,lib:&Library,pending:&mut Vec<PreparedItem>,report:&mut Value)->Result<()> {
    if pending.is_empty() {return Ok(());}
    let mut errors=Vec::new();
    let mut failed=Vec::new();
    {
        let conn=lib.conn();
        let mut tx=match conn.unchecked_transaction() {
            Ok(tx)=>tx,
            Err(e)=>{for item in pending.iter() {drop_created(item);} return Err(e.into());}
        };
        for item in pending.iter() {
            match ctx.commit_item(&mut tx,item) {
                Ok(done)=>absorb(report,&done),
                Err(e)=>{errors.push(json!({"item":item.key,"library":item.library,"error":format!("{e:#}")}));failed.push(item);}
            }
        }
        if let Err(e)=tx.commit() {
            // Nothing in this batch was persisted: the copies are orphans.
            for item in pending.iter() {drop_created(item);}
            return Err(e.into());
        }
    }
    for item in failed {drop_created(item);}
    report["errors"].as_array_mut().unwrap().extend(errors);
    pending.clear();
    Ok(())
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
    let category_ids:HashMap<i64,String>=cols.iter().map(|c|(c.id,hash(&format!("{}:{}:{}",source_id,c.library,c.key)))).collect();
    {
        let conn=lib.conn();let tx=conn.unchecked_transaction()?;
        for c in &cols {
            let group_id=if c.library!=1 {Some(hash(&format!("{}:library-root:{}",source_id,c.library)))}else{None};
            if let Some(group)=&group_id {tx.execute("INSERT INTO categories(id,name,sort_order) VALUES(?,?,?) ON CONFLICT(id) DO NOTHING",params![group,c.path.split(" / ").next().unwrap_or("Zotero library"),c.library])?;}
            let parent=c.parent.and_then(|parent|category_ids.get(&parent)).cloned().or(group_id);
            tx.execute("INSERT INTO categories(id,name,parent_id,sort_order) VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,parent_id=excluded.parent_id",params![category_ids[&c.id],c.name,parent,c.id])?;
        }
        crate::organization::validate_tree(&tx)?;tx.commit()?;
    }
    let context=ContextData{lib,source:&source,dir:&dir,source_id,cols,category_ids,item_cols,base:opts["linked_base_dir"].as_str().filter(|s|!s.is_empty()).map(PathBuf::from),copy,notes:opts["include_notes"].as_bool().unwrap_or(true),annotations:opts["include_annotations"].as_bool().unwrap_or(true)};
    let mut stmt=source.prepare(&eligible_sql(&source))?;
    let mut rows=stmt.query([])?;
    let mut report=json!({"source":"sqlite","data_dir":dir,"archive":archive,"items":0,"imported":0,"updated":0,"duplicates":0,"without_pdf":0,"attachments":0,"annotations":0,"collections":context.cols.len(),"missing_attachments":[],"warnings":[],"errors":[]});
    let limit=opts["limit"].as_u64().unwrap_or(0);let mut processed=0;
    let mut pending=Vec::<PreparedItem>::new();
    while let Some(row)=rows.next()? {
        let(id,key,library,kind):(i64,String,i64,String)=(row.get(0)?,row.get(1)?,row.get(2)?,row.get(3)?);
        if wanted.is_some() && !context.item_cols.get(&id).is_some_and(|ids|ids.iter().any(|i|selected.contains(i))) {continue;}
        if limit>0 && processed>=limit {break;} processed+=1;
        // Hash, copy and parse first — with no write connection held — so a slow
        // PDF can never block a reader that needs `lib.conn()`.
        match context.prepare_item(id,&key,library,&kind) {
            Ok(item)=>pending.push(item),
            Err(e)=>report["errors"].as_array_mut().unwrap().push(json!({"item":key,"library":library,"error":format!("{e:#}")})),
        }
        if pending.len()>=IMPORT_BATCH {commit_batch(&context,lib,&mut pending,&mut report)?;}
    }
    commit_batch(&context,lib,&mut pending,&mut report)?;
    report["duration_ms"]=json!(start.elapsed().as_millis());
    fs::write(archive.join("last-report.json"),serde_json::to_vec_pretty(&report)?)?;
    Ok(report)
}

/// Test-only observation point: fires after one item is fully prepared and
/// before any row of it is committed.
#[cfg(test)]
pub(crate) mod test_hooks {
    use std::sync::Mutex;
    pub(crate) type Hook=Box<dyn Fn(&str)+Send+'static>;
    static PREPARED:Mutex<Option<Hook>>=Mutex::new(None);
    pub(crate) fn set(hook:Hook) {*PREPARED.lock().unwrap()=Some(hook);}
    pub(crate) fn clear() {*PREPARED.lock().unwrap()=None;}
    pub(crate) fn prepared_item(key:&str) {
        let guard=PREPARED.lock().unwrap();
        if let Some(hook)=guard.as_ref() {hook(key);}
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::library::{sha256_file, Library};
    use std::sync::mpsc;
    use std::sync::{Arc, Mutex as StdMutex};
    use std::time::{Duration, Instant};

    /// The prepare hook is process-global, so the two migration tests run one
    /// at a time even though `cargo test` uses several threads.
    static SERIAL:StdMutex<()>=StdMutex::new(());
    fn serial()->std::sync::MutexGuard<'static,()> {SERIAL.lock().unwrap_or_else(|e|e.into_inner())}

    fn temp(name:&str)->PathBuf {
        let dir=std::env::temp_dir().join(format!("moonlight-zotero-{name}-{}",Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// Build a one-page PDF with the same library that parses it, so the test
    /// never depends on an external fixture file.
    fn write_pdf(path:&Path) {
        use lopdf::Object;
        let mut doc=lopdf::Document::with_version("1.5");
        let pages_id=doc.new_object_id();
        let page_id=doc.add_object(lopdf::dictionary!{
            "Type"=>"Page","Parent"=>pages_id,
            "MediaBox"=>Object::Array(vec![Object::Integer(0),Object::Integer(0),Object::Integer(612),Object::Integer(792)])});
        let pages=lopdf::dictionary!{"Type"=>"Pages","Kids"=>Object::Array(vec![Object::Reference(page_id)]),"Count"=>Object::Integer(1)};
        doc.objects.insert(pages_id,Object::Dictionary(pages));
        let catalog_id=doc.add_object(lopdf::dictionary!{"Type"=>"Catalog","Pages"=>Object::Reference(pages_id)});
        doc.trailer.set("Root",Object::Reference(catalog_id));
        doc.save(path).unwrap();
    }

    /// A minimal read-only Zotero data directory: one journal article with one
    /// stored PDF, one note, one tag, one collection and one highlight.
    fn zotero_fixture(dir:&Path) {
        fs::create_dir_all(dir.join("storage/ATT1")).unwrap();
        write_pdf(&dir.join("storage/ATT1/paper.pdf"));
        let conn=Connection::open(dir.join("zotero.sqlite")).unwrap();
        conn.execute_batch(r#"
CREATE TABLE items(itemID INTEGER PRIMARY KEY,key TEXT NOT NULL,libraryID INTEGER,itemTypeID INTEGER);
CREATE TABLE itemTypes(itemTypeID INTEGER PRIMARY KEY,typeName TEXT NOT NULL);
CREATE TABLE fields(fieldID INTEGER PRIMARY KEY,fieldName TEXT NOT NULL);
CREATE TABLE itemDataValues(valueID INTEGER PRIMARY KEY,value TEXT NOT NULL);
CREATE TABLE itemData(itemID INTEGER,fieldID INTEGER,valueID INTEGER);
CREATE TABLE creators(creatorID INTEGER PRIMARY KEY,firstName TEXT,lastName TEXT);
CREATE TABLE itemCreators(itemID INTEGER,creatorID INTEGER,orderIndex INTEGER);
CREATE TABLE tags(tagID INTEGER PRIMARY KEY,name TEXT NOT NULL);
CREATE TABLE itemTags(itemID INTEGER,tagID INTEGER);
CREATE TABLE collections(collectionID INTEGER PRIMARY KEY,key TEXT,collectionName TEXT,parentCollectionID INTEGER,libraryID INTEGER);
CREATE TABLE collectionItems(collectionID INTEGER,itemID INTEGER);
CREATE TABLE itemAttachments(itemID INTEGER PRIMARY KEY,parentItemID INTEGER,contentType TEXT,path TEXT);
CREATE TABLE itemNotes(itemID INTEGER PRIMARY KEY,parentItemID INTEGER,note TEXT);
CREATE TABLE itemAnnotations(itemID INTEGER PRIMARY KEY,parentItemID INTEGER,type INTEGER,text TEXT,comment TEXT,color TEXT,position TEXT);
CREATE TABLE deletedItems(itemID INTEGER);
"#).unwrap();
        conn.execute_batch(r#"
INSERT INTO itemTypes VALUES(1,'journalArticle'),(2,'attachment'),(3,'note'),(4,'annotation');
INSERT INTO items VALUES(1,'PAPER1',1,1),(2,'ATT1',1,2),(3,'ANN1',1,4);
INSERT INTO fields VALUES(1,'title'),(2,'DOI'),(3,'date'),(4,'publicationTitle'),(5,'abstractNote');
INSERT INTO itemDataValues VALUES(1,'Throughput & Latency'),(2,'10.1000/XYZ.1'),(3,'2024-09-30'),(4,'NeurIPS'),(5,'A batching study.'),(6,'Full Text PDF');
INSERT INTO itemData VALUES(1,1,1),(1,2,2),(1,3,3),(1,4,4),(1,5,5),(2,1,6);
INSERT INTO creators VALUES(1,'Ada','Lovelace');
INSERT INTO itemCreators VALUES(1,1,0);
INSERT INTO tags VALUES(1,'machine learning');
INSERT INTO itemTags VALUES(1,1);
INSERT INTO collections VALUES(1,'COL1','Reading',NULL,1);
INSERT INTO collectionItems VALUES(1,1);
INSERT INTO itemAttachments VALUES(2,1,'application/pdf','storage:paper.pdf');
INSERT INTO itemNotes VALUES(4,1,'<p>First note</p>');
INSERT INTO itemAnnotations VALUES(3,2,1,'quoted text','a comment','#5fb236','{"pageIndex":0,"rects":[[10,20,110,60]]}');
"#).unwrap();
    }

    fn options(dir:&Path)->Value {
        json!({"data_dir":dir,"copy_attachments":true,"include_notes":true,"include_annotations":true})
    }

    #[test]
    fn import_migrates_metadata_files_annotations_and_reimport_is_idempotent() {
        let _serial=serial();
        let root=temp("lib");let dir=temp("data");
        zotero_fixture(&dir);
        let lib=Library::new(&root).unwrap();
        let first=import(&lib,&options(&dir)).unwrap();
        assert_eq!(first["items"],json!(1),"{first}");
        assert_eq!(first["imported"],json!(1),"{first}");
        assert_eq!(first["attachments"],json!(1),"{first}");
        assert_eq!(first["annotations"],json!(1),"{first}");
        assert_eq!(first["without_pdf"],json!(0),"{first}");
        assert_eq!(first["errors"].as_array().unwrap().len(),0,"{first}");
        assert_eq!(first["warnings"].as_array().unwrap().len(),0,"{first}");
        let conn=lib.conn();
        let (paper,title,doi,authors,year,venue,notes):(String,String,String,String,String,String,String)=conn.query_row("SELECT id,title,doi,authors,year,venue,notes FROM papers",[],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?,r.get(4)?,r.get(5)?,r.get(6)?))).unwrap();
        assert_eq!(title,"Throughput & Latency");
        assert_eq!(doi,"10.1000/xyz.1","DOIs are normalised on the way in");
        assert_eq!(authors,"Ada Lovelace");
        assert_eq!(year,"2024");
        assert_eq!(venue,"NeurIPS");
        assert_eq!(notes,"First note");
        let (kind,sha,pages,engine,rel):(String,String,i64,String,String)=conn.query_row("SELECT kind,sha256,pages,engine,rel_path FROM versions WHERE paper_id=?",[&paper],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?,r.get(4)?))).unwrap();
        assert_eq!(kind,"source");assert_eq!(pages,1);assert_eq!(engine,"zotero");
        assert_eq!(rel,format!("files/{sha}.pdf"));
        assert!(root.join(&rel).is_file(),"copied PDF must exist at {rel}");
        assert_eq!(sha256_file(&root.join(&rel)).unwrap(),sha,"the copy is byte-identical to the source");
        let (status,original,version):(String,String,String)=conn.query_row("SELECT status,original_path,version_id FROM zotero_files WHERE paper_id=?",[&paper],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?))).unwrap();
        assert_eq!(status,"copied");assert_eq!(original,"storage:paper.pdf");
        let vid:String=conn.query_row("SELECT id FROM versions WHERE paper_id=?",[&paper],|r|r.get(0)).unwrap();
        assert_eq!(version,vid);
        let (page,rects,quote,color,comment):(i64,String,String,String,String)=conn.query_row("SELECT page,rects,quote,color,comment FROM annotations",[],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?,r.get(4)?))).unwrap();
        assert_eq!(page,0);assert_eq!(quote,"quoted text");assert_eq!(color,"green");assert_eq!(comment,"a comment");
        let rects:Value=serde_json::from_str(&rects).unwrap();
        assert_eq!(rects.as_array().unwrap().len(),1,"{rects}");
        let rect=&rects[0];
        // (10,20)-(110,60) on a 612x792 page with a bottom-left origin.
        assert!((rect["x"].as_f64().unwrap()-10.0/612.0).abs()<1e-6,"{rects}");
        assert!((rect["w"].as_f64().unwrap()-100.0/612.0).abs()<1e-6,"{rects}");
        assert!((rect["y"].as_f64().unwrap()-(1.0-60.0/792.0)).abs()<1e-6,"{rects}");
        assert!((rect["h"].as_f64().unwrap()-40.0/792.0).abs()<1e-6,"{rects}");
        let links:i64=conn.query_row("SELECT COUNT(*) FROM paper_categories WHERE paper_id=?",[&paper],|r|r.get(0)).unwrap();
        assert_eq!(links,1);
        let tagged:i64=conn.query_row("SELECT COUNT(*) FROM paper_tags pt JOIN tags t ON t.id=pt.tag_id WHERE pt.paper_id=? AND t.name='machine learning'",[&paper],|r|r.get(0)).unwrap();
        assert_eq!(tagged,1);
        drop(conn);
        // The second migration is an update, never a second copy of the paper.
        let second=import(&lib,&options(&dir)).unwrap();
        assert_eq!(second["items"],json!(1),"{second}");
        assert_eq!(second["updated"],json!(1),"{second}");
        assert_eq!(second["duplicates"],json!(0),"{second}");
        assert_eq!(second["imported"],json!(0),"{second}");
        assert_eq!(second["errors"].as_array().unwrap().len(),0,"{second}");
        assert_eq!(second["attachments"],json!(1),"{second}");
        let conn=lib.conn();
        for table in ["papers","versions","annotations","zotero_files","zotero_items","zotero_annotation_map"] {
            let count:i64=conn.query_row(&format!("SELECT COUNT(*) FROM {table}"),[],|r|r.get(0)).unwrap();
            assert_eq!(count,1,"re-import must not duplicate rows in {table}");
        }
        drop(conn);
    }

    #[test]
    fn prepare_runs_without_holding_the_write_connection() {
        let _serial=serial();
        let root=temp("lib");let dir=temp("data");
        zotero_fixture(&dir);
        let lib=Library::new(&root).unwrap();
        // (item key, reader finished, wait ms, papers visible to the reader)
        let seen=Arc::new(StdMutex::new(Vec::<(String,bool,u64,i64)>::new()));
        let readers=Arc::new(StdMutex::new(Vec::new()));
        {
            let lib=Arc::clone(&lib);
            let seen=Arc::clone(&seen);
            let readers=Arc::clone(&readers);
            test_hooks::set(Box::new(move |key:&str|{
                let lib=Arc::clone(&lib);let seen=Arc::clone(&seen);let readers=Arc::clone(&readers);
                let key=key.to_string();
                let (tx,rx)=mpsc::channel::<i64>();
                let started=Instant::now();
                let reader=std::thread::spawn(move||{
                    // With the old code this blocked until the whole migration ended.
                    let conn=lib.conn();
                    let count:i64=conn.query_row("SELECT COUNT(*) FROM papers",[],|r|r.get(0)).unwrap();
                    drop(conn);
                    let _=tx.send(count);
                });
                let got=rx.recv_timeout(Duration::from_secs(5));
                let visible=got.unwrap_or(-1);
                seen.lock().unwrap().push((key,got.is_ok(),started.elapsed().as_millis() as u64,visible));
                readers.lock().unwrap().push(reader);
            }));
        }
        let report=import(&lib,&options(&dir)).unwrap();
        test_hooks::clear();
        assert_eq!(report["imported"],json!(1),"{report}");
        for reader in readers.lock().unwrap().drain(..) {reader.join().unwrap();}
        let seen=seen.lock().unwrap().clone();
        assert_eq!(seen.len(),1,"the hook fires once per prepared item: {seen:?}");
        assert_eq!(seen[0].0,"PAPER1");
        assert!(seen[0].1,"a reader must acquire lib.conn() while the item is being prepared (waited {}ms)",seen[0].2);
        assert_eq!(seen[0].3,0,"the reader must run before the item is committed");
        // Nothing is left behind as an orphan after a successful batch commit.
        let leftovers:Vec<String>=fs::read_dir(root.join("tmp")).unwrap().filter_map(|e|e.ok()).map(|e|e.file_name().to_string_lossy().to_string()).collect();
        assert!(leftovers.is_empty(),"temporary files must be gone: {leftovers:?}");
        let report=import(&lib,&options(&dir)).unwrap();
        assert_eq!(report["updated"],json!(1),"{report}");
    }

    #[test]
    fn a_second_data_dir_with_the_same_pdf_is_a_duplicate_not_a_new_paper() {
        let _serial=serial();
        let root=temp("lib");
        let first_dir=temp("data");let second_dir=temp("data");
        zotero_fixture(&first_dir);zotero_fixture(&second_dir);
        // The copy has identical PDF bytes but no DOI, so only the attachment
        // hash — prepared before the write lock is taken — can identify it.
        let source=Connection::open(second_dir.join("zotero.sqlite")).unwrap();
        source.execute("DELETE FROM itemData WHERE fieldID=2",[]).unwrap();
        source.execute("DELETE FROM itemDataValues WHERE valueID=2",[]).unwrap();
        drop(source);
        let lib=Library::new(&root).unwrap();
        let first=import(&lib,&options(&first_dir)).unwrap();
        assert_eq!(first["imported"],json!(1),"{first}");
        let second=import(&lib,&options(&second_dir)).unwrap();
        assert_eq!(second["duplicates"],json!(1),"{second}");
        assert_eq!(second["imported"],json!(0),"{second}");
        assert_eq!(second["errors"].as_array().unwrap().len(),0,"{second}");
        let conn=lib.conn();
        let papers:i64=conn.query_row("SELECT COUNT(*) FROM papers",[],|r|r.get(0)).unwrap();
        assert_eq!(papers,1,"the identical PDF must not become a second paper");
        let versions:i64=conn.query_row("SELECT COUNT(*) FROM versions",[],|r|r.get(0)).unwrap();
        assert_eq!(versions,1);
        let files:i64=conn.query_row("SELECT COUNT(*) FROM zotero_files",[],|r|r.get(0)).unwrap();
        assert_eq!(files,2,"each Zotero source keeps its own attachment row");
        let mapped:i64=conn.query_row("SELECT COUNT(*) FROM zotero_items",[],|r|r.get(0)).unwrap();
        assert_eq!(mapped,2);
        // Annotation maps are per source, so both highlights stay attached to
        // the same paper version instead of being dropped.
        let annotations:i64=conn.query_row("SELECT COUNT(*) FROM annotations",[],|r|r.get(0)).unwrap();
        assert_eq!(annotations,2);
        drop(conn);
    }
}
