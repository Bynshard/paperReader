use crate::{library::{Library,now_ms,sha256_file},sync_model as model,sync_transport::{Profile,Remote}};
use anyhow::{anyhow,Context,Result};
use rusqlite::{params,Connection,OptionalExtension};
use serde::{Deserialize,Serialize};
use serde_json::{json,Value};
use sha2::{Digest,Sha256};
use std::{collections::{BTreeMap,BTreeSet},fs,path::{Path,PathBuf},sync::{Arc,Mutex,atomic::{AtomicBool,Ordering}},thread,time::Duration};
use uuid::Uuid;

pub const SCHEMA:&str=r#"
CREATE TABLE IF NOT EXISTS sync_base(target TEXT,key TEXT,value TEXT NOT NULL,PRIMARY KEY(target,key));
CREATE TABLE IF NOT EXISTS sync_seen(target TEXT,id TEXT,device TEXT,sequence INTEGER,PRIMARY KEY(target,id));
CREATE TABLE IF NOT EXISTS sync_blob_base(target TEXT,path TEXT,hash TEXT,bytes INTEGER,PRIMARY KEY(target,path));
CREATE TABLE IF NOT EXISTS sync_file_cache(path TEXT PRIMARY KEY,bytes INTEGER,modified TEXT,hash TEXT);
CREATE TABLE IF NOT EXISTS sync_conflicts(id TEXT PRIMARY KEY,target TEXT,key TEXT,base TEXT,remote TEXT,paths TEXT,created_at INTEGER);
CREATE INDEX IF NOT EXISTS idx_sync_conflicts_target ON sync_conflicts(target,key);
CREATE INDEX IF NOT EXISTS idx_chats_paper ON chats(paper_id);
CREATE TABLE IF NOT EXISTS sync_revision(id INTEGER PRIMARY KEY,value INTEGER NOT NULL);
INSERT OR IGNORE INTO sync_revision VALUES(1,0);
CREATE TABLE IF NOT EXISTS sync_export_revision(target TEXT PRIMARY KEY,value INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS sync_dirty(key TEXT PRIMARY KEY,revision INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS idx_sync_dirty_revision ON sync_dirty(revision);
CREATE TABLE IF NOT EXISTS sync_schema(id INTEGER PRIMARY KEY,version INTEGER NOT NULL);
"#;
pub fn initialize(conn:&Connection)->Result<()> {
    conn.execute_batch(SCHEMA)?;
    let version:i64=conn.query_row("SELECT version FROM sync_schema WHERE id=1",[],|r|r.get(0)).optional()?.unwrap_or(0);
    if version>=3{return Ok(());}
    let tx=conn.unchecked_transaction()?;
    for table in ["papers","versions","categories","tags","paper_categories","paper_tags","annotations","chats","zotero_items","zotero_files","zotero_annotation_map"] {
        for operation in ["INSERT","UPDATE","DELETE"] {
            let reference=if operation=="DELETE"{"OLD"}else{"NEW"};
            let journal=|reference:&str|->String {
                let expression=match table {"zotero_annotation_map"=>format!("(SELECT 'paper:'||paper_id FROM annotations WHERE id={reference}.annotation_id)"),"papers"=>format!("'paper:'||{reference}.id"),"categories"=>format!("'category:'||{reference}.id"),"tags"=>format!("'tag:'||{reference}.name"),_=>format!("'paper:'||{reference}.paper_id")};
                // An outer UPSERT can override a trigger's OR REPLACE policy.
                // Update then insert-if-absent has no uniqueness violation to
                // inherit; SQLite serializes writers within this transaction.
                format!("UPDATE sync_dirty SET revision=(SELECT value FROM sync_revision WHERE id=1) WHERE key={expression}; INSERT INTO sync_dirty SELECT {expression},(SELECT value FROM sync_revision WHERE id=1) WHERE {expression} IS NOT NULL AND NOT EXISTS(SELECT 1 FROM sync_dirty WHERE key={expression});")
            };
            let mut body=journal(reference);
            if operation=="UPDATE" {body.push_str(&journal("OLD"));}
            if table=="tags" && operation=="UPDATE" {body.push_str("UPDATE sync_dirty SET revision=(SELECT value FROM sync_revision WHERE id=1) WHERE OLD.name!=NEW.name AND key IN (SELECT 'paper:'||paper_id FROM paper_tags WHERE tag_id=NEW.id); INSERT INTO sync_dirty SELECT 'paper:'||paper_id,(SELECT value FROM sync_revision WHERE id=1) FROM paper_tags WHERE tag_id=NEW.id AND OLD.name!=NEW.name AND NOT EXISTS(SELECT 1 FROM sync_dirty WHERE key='paper:'||paper_id);");}
            tx.execute_batch(&format!("DROP TRIGGER IF EXISTS sync_revision_{table}_{operation}; CREATE TRIGGER sync_revision_{table}_{operation} AFTER {operation} ON {table} BEGIN UPDATE sync_revision SET value=value+1 WHERE id=1; {body} END;"))?;
        }
    }
    tx.execute("INSERT OR REPLACE INTO sync_schema VALUES(1,3)",[])?;tx.commit()?;Ok(())
}
pub fn digest(text:&str)->String {format!("{:x}",Sha256::digest(text.as_bytes()))}
#[derive(Default)] pub struct Manager {
    profile:Mutex<Option<Profile>>,state:Mutex<Value>,running:AtomicBool,cancel:AtomicBool,
}
#[derive(Clone,Serialize,Deserialize)] struct Change {key:String,base:Value,value:Value}
#[derive(Clone,Serialize,Deserialize)] struct File {path:String,hash:String,bytes:u64}
#[derive(Serialize,Deserialize)] struct Commit {
    protocol:u32,device:String,sequence:i64,nonce:String,parents:Vec<String>,changes:Vec<Change>,files:Vec<File>,
}
fn private(root:&Path)->PathBuf {root.join(".sync")}
fn work(lib:&Library,p:&Profile)->Result<PathBuf> {let path=private(lib.root()).join(p.target_id());fs::create_dir_all(&path)?;Ok(path)}
fn check_cancel(lib:&Library)->Result<()> {if lib.sync.cancel.load(Ordering::SeqCst) {Err(anyhow!("同步已取消"))}else{Ok(())}}
fn phase(lib:&Library,value:&str){let mut state=lib.sync.state.lock().unwrap();state["phase"]=json!(value);}
fn seen(conn:&Connection,target:&str,id:&str)->Result<bool>{Ok(conn.query_row("SELECT EXISTS(SELECT 1 FROM sync_seen WHERE target=? AND id=?)",params![target,id],|r|r.get(0))?)}
fn record(lib:&Library,target:&str,id:&str,commit:&Commit)->Result<()> {
    let conn=lib.conn();let tx=conn.unchecked_transaction()?;
    for change in &commit.changes {tx.execute("INSERT INTO sync_base VALUES(?,?,?) ON CONFLICT(target,key) DO UPDATE SET value=excluded.value",params![target,change.key,change.value.to_string()])?;}
    for file in &commit.files {tx.execute("INSERT INTO sync_blob_base VALUES(?,?,?,?) ON CONFLICT(target,path) DO UPDATE SET hash=excluded.hash,bytes=excluded.bytes",params![target,file.path,file.hash,file.bytes as i64])?;}
    tx.execute("INSERT OR IGNORE INTO sync_seen VALUES(?,?,?,?)",params![target,id,commit.device,commit.sequence])?;tx.commit()?;Ok(())
}
fn save_conflict(conn:&Connection,target:&str,commit:&str,key:&str,base:&Value,remote:&Value,paths:&[String])->Result<()> {
    let id=digest(&format!("{target}:{commit}:{key}"));
    conn.execute("INSERT OR IGNORE INTO sync_conflicts VALUES(?,?,?,?,?,?,?)",params![id,target,key,base.to_string(),remote.to_string(),json!(paths).to_string(),now_ms()])?;Ok(())
}
pub fn configure(lib:&Library,input:&Value)->Result<Value> {
    if lib.sync.running.load(Ordering::SeqCst){return Err(anyhow!("请等待当前同步结束"));}
    let profile:Profile=serde_json::from_value(input.clone())?;profile.validate()?;
    *lib.sync.profile.lock().unwrap()=Some(profile);status(lib)
}
pub fn status(lib:&Library)->Result<Value> {
    let mut state=lib.sync.state.lock().unwrap().clone();if !state.is_object(){state=json!({"status":"idle"});}
    state["running"]=json!(lib.sync.running.load(Ordering::SeqCst));
    let profile=lib.sync.profile.lock().unwrap();state["configured"]=json!(profile.is_some());
    if let Some(p)=profile.as_ref(){state["conflicts"]=json!(lib.conn().query_row("SELECT COUNT(*) FROM sync_conflicts WHERE target=?",[p.target_id()],|r|r.get::<_,i64>(0))?);}
    Ok(state)
}
pub fn start(lib:&Arc<Library>,test:bool)->Result<Value> {
    let profile=lib.sync.profile.lock().unwrap().clone().ok_or_else(||anyhow!("请先配置云同步"))?;
    if lib.sync.running.compare_exchange(false,true,Ordering::SeqCst,Ordering::SeqCst).is_err(){return Err(anyhow!("同步正在进行"));}
    lib.sync.cancel.store(false,Ordering::SeqCst);
    let id=Uuid::new_v4().to_string();*lib.sync.state.lock().unwrap()=json!({"id":id,"status":"running","phase":"连接云存储","started_at":now_ms()});
    let worker=Arc::clone(lib);
    if let Err(error)=thread::Builder::new().name("cloud-sync".into()).spawn(move||{
        let result=if test {connection_test(&worker,&profile)} else {run(&worker,&profile)};
        let mut state=worker.sync.state.lock().unwrap();
        match result {Ok(report)=>{state["status"]=json!("completed");state["report"]=report;state["phase"]=json!(if test{"连接测试通过"}else{"同步完成"});},Err(error)=>{state["status"]=json!(if worker.sync.cancel.load(Ordering::SeqCst){"cancelled"}else{"failed"});state["error"]=json!(format!("{error:#}"));}}
        state["finished_at"]=json!(now_ms());worker.sync.running.store(false,Ordering::SeqCst);
    }) {lib.sync.running.store(false,Ordering::SeqCst);return Err(error.into());}
    Ok(json!({"id":id}))
}
pub fn cancel(lib:&Library)->Value {lib.sync.cancel.store(true,Ordering::SeqCst);json!({"ok":true})}
fn connection_test(lib:&Library,p:&Profile)->Result<Value>{
    let folder=work(lib,p)?;let remote=Remote::new(p,&folder)?;let cancel=&lib.sync.cancel;
    remote.mkdir("checks",cancel)?;
    let name=format!("checks/{}.txt",Uuid::new_v4());let source=folder.join("connection-check.txt");let downloaded=folder.join("connection-check.download");
    let text=Uuid::new_v4().to_string();fs::write(&source,&text)?;remote.upload(&source,&name,cancel)?;remote.download(&name,&downloaded,cancel)?;
    if fs::read_to_string(&downloaded)?!=text{return Err(anyhow!("云端校验失败"));}
    remote.run(&["deletefile".into(),remote.path(&name)],cancel)?;fs::remove_file(source)?;fs::remove_file(downloaded)?;Ok(json!({"read_write_verified":true}))
}
fn device(lib:&Library)->Result<String>{let path=private(lib.root()).join("device-id");if path.is_file(){return Ok(fs::read_to_string(path)?.trim().into());}fs::create_dir_all(private(lib.root()))?;let id=Uuid::new_v4().to_string();fs::write(path,&id)?;Ok(id)}
fn checked_path(root:&Path,path:&str)->Result<PathBuf>{
    if !model::safe_path(path){return Err(anyhow!("拒绝无效的同步文件路径"));}
    let mut current=root.to_path_buf();for component in Path::new(path).components(){current.push(component.as_os_str());if fs::symlink_metadata(&current).is_ok_and(|m|m.file_type().is_symlink()){return Err(anyhow!("同步文件不能通过符号链接指向库外"));}}
    Ok(current)
}
fn cached_hash(lib:&Library,path:&str)->Result<(String,u64)> {
    let old:Option<(u64,String,String)>=lib.conn().query_row("SELECT bytes,modified,hash FROM sync_file_cache WHERE path=?",[path],|r|Ok((r.get::<_,i64>(0)? as u64,r.get(1)?,r.get(2)?))).optional()?;
    let(hash,bytes,modified,changed)=inspect_file(lib.root(),path,old.as_ref())?;
    if changed {save_cache(lib,&[(path.to_string(),bytes,modified,hash.clone())])?;}Ok((hash,bytes))
}
fn inspect_file(root:&Path,path:&str,known:Option<&(u64,String,String)>)->Result<(String,u64,String,bool)> {
    let full=checked_path(root,path)?;let meta=fs::metadata(&full)?;let modified=format!("{:?}",meta.modified()?);
    if let Some((bytes,time,hash))=known {if *bytes==meta.len() && time==&modified {return Ok((hash.clone(),*bytes,modified,false));}}
    Ok((sha256_file(&full)?,meta.len(),modified,true))
}
fn save_cache(lib:&Library,rows:&[(String,u64,String,String)])->Result<()> {
    if rows.is_empty(){return Ok(());}let conn=lib.conn();let tx=conn.unchecked_transaction()?;
    for (path,bytes,modified,hash) in rows {tx.execute("INSERT INTO sync_file_cache VALUES(?,?,?,?) ON CONFLICT(path) DO UPDATE SET bytes=excluded.bytes,modified=excluded.modified,hash=excluded.hash",params![path,*bytes as i64,modified,hash])?;}
    tx.commit()?;Ok(())
}
fn paths(root:&Path,folder:&Path,out:&mut Vec<String>)->Result<()> {
    if !folder.exists(){return Ok(());}
    for entry in fs::read_dir(folder)? {let entry=entry?;let kind=entry.file_type()?;
        if kind.is_symlink(){return Err(anyhow!("同步目录包含符号链接，请改为普通文件"));}
        if kind.is_dir(){paths(root,&entry.path(),out)?;}else if kind.is_file(){let name=entry.file_name().to_string_lossy().to_string();if name.starts_with(".sync-") && name.ends_with(".tmp"){continue;}out.push(entry.path().strip_prefix(root)?.to_string_lossy().replace('\\',"/"));}
    }Ok(())
}
fn normalize_external(lib:&Library)->Result<()> {
    // A portable replica cannot point at another computer's absolute paths.
    // Copy linked attachments into the managed library before publishing.
    let items={let conn=lib.conn();let mut stmt=conn.prepare("SELECT id,rel_path FROM versions WHERE rel_path LIKE '/%' OR substr(rel_path,2,1)=':' OR substr(rel_path,1,1)=char(92)")?;let items=stmt.query_map([],|r|Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?)))?.collect::<rusqlite::Result<Vec<_>>>()?;items};
    for (id,path) in items {
        check_cancel(lib)?;
        if Path::new(&path).is_absolute(){
            let source=Path::new(&path);let sha=sha256_file(source).with_context(||format!("外链 PDF 不可用：{path}"))?;let rel=format!("files/{sha}.pdf");
            let dest=lib.root().join(&rel);if !dest.exists(){fs::copy(source,&dest)?;}
            let conn=lib.conn();let tx=conn.unchecked_transaction()?;
            tx.execute("UPDATE versions SET rel_path=? WHERE id=? AND rel_path=?",params![rel,id,path])?;
            tx.execute("UPDATE zotero_files SET rel_path=?,status='copied' WHERE version_id=? AND rel_path=?",params![rel,id,path])?;tx.commit()?;
        }else if !model::safe_path(&path){return Err(anyhow!("库中有无效 PDF 路径"));}
    }
    let items={let conn=lib.conn();let mut stmt=conn.prepare("SELECT id,rel_path FROM zotero_files WHERE rel_path LIKE '/%' OR substr(rel_path,2,1)=':' OR substr(rel_path,1,1)=char(92)")?;let items=stmt.query_map([],|r|Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?)))?.collect::<rusqlite::Result<Vec<_>>>()?;items};
    for (id,path) in items {if Path::new(&path).is_absolute(){check_cancel(lib)?;let source=Path::new(&path);let sha=sha256_file(source).with_context(||format!("外链附件不可用：{path}"))?;let name=source.file_name().ok_or_else(||anyhow!("invalid linked attachment"))?;
        let rel=PathBuf::from("files").join(&sha).join(name);let dest=lib.root().join(&rel);fs::create_dir_all(dest.parent().unwrap())?;if !dest.exists(){fs::copy(source,&dest)?;}
        lib.conn().execute("UPDATE zotero_files SET rel_path=?,status='copied' WHERE id=? AND rel_path=?",params![rel.to_string_lossy().replace('\\',"/"),id,path])?;
    }}Ok(())
}
fn stage_blob(lib:&Library,folder:&Path,file:&File)->Result<()> {
    if file.hash.len()!=64 || !file.hash.chars().all(|c|c.is_ascii_hexdigit()){return Err(anyhow!("无效的待上传文件哈希"));}
    let stage=folder.join("upload-objects").join(&file.hash[..2]);fs::create_dir_all(&stage)?;let dest=stage.join(&file.hash);
    if dest.is_file() && sha256_file(&dest)?==file.hash{return Ok(());}
    if dest.exists(){fs::remove_file(&dest)?;}
    let temporary=stage.join(format!("{}.part",Uuid::new_v4()));let source=checked_path(lib.root(),&file.path)?;fs::copy(source,&temporary)?;
    if sha256_file(&temporary)?!=file.hash {let _=fs::remove_file(temporary);return Err(anyhow!("文件在同步过程中发生变化，请重试"));}
    fs::rename(temporary,dest)?;Ok(())
}
fn ensure_blob(lib:&Library,remote:&Remote,folder:&Path,file:&File)->Result<PathBuf> {
    if file.hash.len()!=64 || !file.hash.chars().all(|c|c.is_ascii_hexdigit()) || !model::safe_path(&file.path){return Err(anyhow!("无效的远端文件清单"));}
    let cache=folder.join("objects");fs::create_dir_all(&cache)?;let dest=cache.join(&file.hash);
    if !dest.exists(){let tmp=cache.join(format!("{}.part",file.hash));remote.download(&format!("objects/{}/{}",&file.hash[..2],file.hash),&tmp,&lib.sync.cancel)?;
        if fs::metadata(&tmp)?.len()!=file.bytes || sha256_file(&tmp)?!=file.hash {let _=fs::remove_file(tmp);return Err(anyhow!("远端附件校验失败，未覆盖本地文件"));}fs::rename(tmp,&dest)?;
    }Ok(dest)
}
fn materialize(root:&Path,path:&str,blob:&Path)->Result<()> {
    let dest=checked_path(root,path)?;let parent=dest.parent().unwrap();fs::create_dir_all(parent)?;let temporary=parent.join(format!(".sync-{}.tmp",Uuid::new_v4()));
    fs::copy(blob,&temporary)?;
    #[cfg(windows)] if dest.exists(){fs::remove_file(&dest)?;}
    fs::rename(temporary,dest)?;Ok(())
}
fn pull_file(lib:&Library,p:&Profile,remote:&Remote,folder:&Path,id:&str,file:&File)->Result<()> {
    let blob=ensure_blob(lib,remote,folder,file)?;let target=p.target_id();let dest=checked_path(lib.root(),&file.path)?;
    let local=if dest.exists(){let(h,b)=cached_hash(lib,&file.path)?;json!({"hash":h,"bytes":b})}else{Value::Null};
    let baseline=lib.conn().query_row("SELECT hash,bytes FROM sync_blob_base WHERE target=? AND path=?",params![target,file.path],|r|Ok(json!({"hash":r.get::<_,String>(0)?,"bytes":r.get::<_,i64>(1)?}))).optional()?.unwrap_or(Value::Null);
    let incoming=json!({"hash":file.hash,"bytes":file.bytes});
    if local==incoming {return Ok(());}
    if !local.is_null() && local!=baseline {
        save_conflict(&lib.conn(),&target,id,&format!("file:{}",file.path),&baseline,&incoming,&[file.path.clone()])?;
    }else{materialize(lib.root(),&file.path,&blob)?;}
    Ok(())
}
fn pull_commit(lib:&Library,p:&Profile,remote:&Remote,folder:&Path,id:&str,commit:&Commit)->Result<()> {
    if commit.protocol!=1 || commit.device.is_empty() {return Err(anyhow!("不支持的云同步版本"));}
    for change in &commit.changes {model::validate(&change.key,&change.value)?;model::validate(&change.key,&change.base)?;}
    phase(lib,"下载与校验附件");
    for file in &commit.files {check_cancel(lib)?;pull_file(lib,p,remote,folder,id,file)?;}
    phase(lib,"合并论文和笔记");let target=p.target_id();
    // Taxonomy precedes papers, preserving foreign-key membership references.
    let mut changes=commit.changes.iter().collect::<Vec<_>>();changes.sort_by_key(|c|(c.key.starts_with("paper:"),c.key.clone()));
    // Apply all directory moves atomically: two valid coordinated moves may
    // temporarily form a cycle if their rows are split across batches.
    {
        let conn=lib.conn();let tx=conn.unchecked_transaction()?;
        for change in changes.iter().filter(|c|c.key.starts_with("category:")) {
            let local=model::load(&tx,&change.key)?;let(merged,paths)=model::merge(&change.base,&local,&change.value,false);
            if merged!=local{model::apply(&tx,&change.key,&merged)?;}
            if !paths.is_empty(){save_conflict(&tx,&target,id,&change.key,&change.base,&change.value,&paths)?;}
        }
        crate::organization::validate_tree(&tx)?;tx.commit()?;
    }
    changes.retain(|c|!c.key.starts_with("category:"));
    for group in changes.chunks(50) {
        check_cancel(lib)?;let conn=lib.conn();let tx=conn.unchecked_transaction()?;
        for change in group {
            let local=model::load(&tx,&change.key)?;let(merged,paths)=model::merge(&change.base,&local,&change.value,false);
            if merged!=local {model::apply(&tx,&change.key,&merged)?;}
            if !paths.is_empty(){save_conflict(&tx,&target,id,&change.key,&change.base,&change.value,&paths)?;}
        }tx.commit()?;
    }
    record(lib,&target,id,commit)
}
fn publish(lib:&Library,p:&Profile,remote:&Remote,folder:&Path,path:&Path)->Result<()> {
    let bytes=fs::read(path)?;let commit:Commit=serde_json::from_slice(&bytes)?;
    let name=path.file_name().unwrap().to_string_lossy();let group=format!("{:08}",(commit.sequence-1)/512);let id=format!("{}/{group}/{}",commit.device,name);
    // Recreate staging after a restart; an interrupted publish remains queued.
    for file in &commit.files {
        if file.hash.len()!=64 || !file.hash.chars().all(|c|c.is_ascii_hexdigit()){return Err(anyhow!("无效的待上传清单"));}
        let staging=folder.join("upload-objects").join(&file.hash[..2]).join(&file.hash);
        if !staging.exists(){stage_blob(lib,folder,file)?;}
    }
    if folder.join("upload-objects").exists(){phase(lib,"增量上传附件");remote.copy(&folder.join("upload-objects"),"objects",&lib.sync.cancel)?;}
    phase(lib,"发布元数据提交");remote.mkdir(&format!("commits/{}/{group}",commit.device),&lib.sync.cancel)?;
    remote.upload(path,&format!("commits/{id}"),&lib.sync.cancel)?;
    record(lib,&p.target_id(),&id,&commit)?;fs::remove_file(path)?;
    if folder.join("upload-objects").exists(){fs::remove_dir_all(folder.join("upload-objects"))?;}Ok(())
}
fn run(lib:&Library,p:&Profile)->Result<Value> {
    let folder=work(lib,p)?;let target=p.target_id();let remote=Remote::new(p,&folder)?;let device=device(lib)?;let cancel=&lib.sync.cancel;
    remote.mkdir("commits",cancel)?;remote.mkdir("objects",cancel)?;
    let outbox=folder.join("outbox");fs::create_dir_all(&outbox)?;
    // Finish immutable pending uploads before applying commits that depend on them.
    let mut queued=fs::read_dir(&outbox)?.map(|e|e.map(|e|e.path())).collect::<std::io::Result<Vec<_>>>()?;queued.sort();
    for path in queued.into_iter().filter(|p|p.extension().is_some_and(|s|s=="json")){publish(lib,p,&remote,&folder,&path)?;}
    phase(lib,"检查远端变更");let names=remote.list("commits",cancel)?;let inbox=folder.join("inbox");fs::create_dir_all(&inbox)?;
    let mut commits=BTreeMap::<String,Commit>::new();
    for id in names {
        check_cancel(lib)?;
        if id.split('/').count()!=3 || !id.ends_with(".json") || id.contains("..") || id.contains('\\'){return Err(anyhow!("无效的远端提交路径"));}
        if seen(&lib.conn(),&target,&id)?{continue;}
        let file=inbox.join(digest(&id));remote.download(&format!("commits/{id}"),&file,cancel)?;
        let bytes=fs::read(&file)?;let hash=id.rsplit('-').next().unwrap().trim_end_matches(".json");
        if digest(std::str::from_utf8(&bytes)?)!=hash{return Err(anyhow!("远端元数据提交校验失败"));}
        let commit:Commit=serde_json::from_slice(&bytes)?;
        if commit.sequence<1 || !id.starts_with(&format!("{}/{:08}/{:020}-",commit.device,(commit.sequence-1)/512,commit.sequence)){return Err(anyhow!("远端提交标识不一致"));}
        commits.insert(id,commit);
    }
    let mut pulled=0;
    while !commits.is_empty(){
        let ready=commits.iter().find_map(|(id,c)|if c.parents.iter().all(|parent|seen(&lib.conn(),&target,parent).unwrap_or(false)){Some(id.clone())}else{None});
        let Some(id)=ready else{return Err(anyhow!("远端提交依赖暂未完整，请稍后重试"))};
        let commit=commits.remove(&id).unwrap();pull_commit(lib,p,&remote,&folder,&id,&commit)?;pulled+=1;
    }
    phase(lib,"准备本地变更");normalize_external(lib)?;check_cancel(lib)?;
    // A separate read transaction gives a coherent WAL view without copying
    // the DB or holding the UI connection's mutex throughout export.
    let source=Connection::open_with_flags(lib.root().join("library.db"),rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)?;
    source.busy_timeout(Duration::from_secs(10))?;let view=source.unchecked_transaction()?;
    let revision:i64=view.query_row("SELECT value FROM sync_revision WHERE id=1",[],|r|r.get(0))?;
    let previous:Option<i64>=view.query_row("SELECT value FROM sync_export_revision WHERE target=?",[&target],|r|r.get(0)).optional()?;
    let metadata_scanned=previous!=Some(revision);
    let incremental=previous.is_some();
    let docs=if metadata_scanned {
        if let Some(previous)=previous {
            let mut stmt=view.prepare("SELECT key FROM sync_dirty WHERE revision>? ORDER BY key")?;
            let keys=stmt.query_map([previous],|r|r.get::<_,String>(0))?.collect::<rusqlite::Result<Vec<_>>>()?;
            let mut docs=BTreeMap::new();
            if keys.len()>500 {let mut full=model::export(&view)?;for key in keys {let value=full.remove(&key).unwrap_or(Value::Null);docs.insert(key,value);}}
            else {for key in keys {let value=model::load(&view,&key)?;docs.insert(key,value);}}docs
        }else{model::export(&view)?}
    }else{BTreeMap::new()};view.commit()?;
    let metadata_candidates=docs.len();
    let mut changes=vec![];
    if metadata_scanned {
        let read=|r:&rusqlite::Row<'_>|Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?));
        let baseline=if incremental {
            let mut stmt=source.prepare("SELECT key,value FROM sync_base WHERE target=? AND key IN (SELECT value FROM json_each(?))")?;
            let rows=stmt.query_map(params![target,json!(docs.keys().collect::<Vec<_>>()).to_string()],read)?.collect::<rusqlite::Result<BTreeMap<_,_>>>()?;rows
        }else{let mut stmt=source.prepare("SELECT key,value FROM sync_base WHERE target=?")?;let rows=stmt.query_map([&target],read)?.collect::<rusqlite::Result<BTreeMap<_,_>>>()?;rows};
        let mut stmt=source.prepare("SELECT DISTINCT key FROM sync_conflicts WHERE target=?")?;
        let blocked=stmt.query_map([&target],|r|r.get::<_,String>(0))?.collect::<rusqlite::Result<BTreeSet<_>>>()?;
        let keys=if incremental {docs.keys().cloned().collect::<BTreeSet<_>>()}else{baseline.keys().cloned().chain(docs.keys().cloned()).collect()};
        for key in keys {let value=docs.get(&key).cloned().unwrap_or(Value::Null);if value.is_null() && !key.starts_with("paper:"){continue;}if blocked.contains(&key){continue;}
            let text=value.to_string();if baseline.get(&key).map(String::as_str).unwrap_or("null")!=text {let base=baseline.get(&key).map(|s|serde_json::from_str(s)).transpose()?.unwrap_or(Value::Null);model::validate(&key,&value)?;changes.push(Change{key,base,value});}}
    }
    let mut local_paths=vec![];for directory in ["files","derived","imports"] {paths(lib.root(),&lib.root().join(directory),&mut local_paths)?;}
    let cache={let mut stmt=source.prepare("SELECT path,bytes,modified,hash FROM sync_file_cache")?;let rows=stmt.query_map([],|r|Ok((r.get::<_,String>(0)?,(r.get::<_,i64>(1)? as u64,r.get::<_,String>(2)?,r.get::<_,String>(3)?))))?.collect::<rusqlite::Result<BTreeMap<_,_>>>()?;rows};
    let prior_files={let mut stmt=source.prepare("SELECT path,hash FROM sync_blob_base WHERE target=?")?;let rows=stmt.query_map([&target],|r|Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?)))?.collect::<rusqlite::Result<BTreeMap<_,_>>>()?;rows};
    let blocked_files={let mut stmt=source.prepare("SELECT key FROM sync_conflicts WHERE target=? AND key LIKE 'file:%'")?;let rows=stmt.query_map([&target],|r|r.get::<_,String>(0))?.collect::<rusqlite::Result<BTreeSet<_>>>()?;rows};
    let mut cache_updates=vec![];
    let mut files=vec![];
    for path in local_paths {check_cancel(lib)?;if blocked_files.contains(&format!("file:{path}")){continue;}let(hash,bytes,modified,changed)=inspect_file(lib.root(),&path,cache.get(&path))?;
        if changed {cache_updates.push((path.clone(),bytes,modified,hash.clone()));if cache_updates.len()>=100{save_cache(lib,&cache_updates)?;cache_updates.clear();}}
        if prior_files.get(&path)!=Some(&hash){let file=File{path,hash,bytes};stage_blob(lib,&folder,&file)?;files.push(file);}
    }
    save_cache(lib,&cache_updates)?;
    let count_changes=changes.len();let count_files=files.len();
    let mut pushed=0;
    if !changes.is_empty() || !files.is_empty() {
        let (parents,sequence)={let conn=lib.conn();let mut stmt=conn.prepare("SELECT id FROM sync_seen WHERE target=? AND (device,sequence) IN (SELECT device,MAX(sequence) FROM sync_seen WHERE target=? GROUP BY device)")?;
            let parents=stmt.query_map(params![target,target],|r|r.get::<_,String>(0))?.collect::<rusqlite::Result<Vec<_>>>()?;
            let sequence:i64=conn.query_row("SELECT COALESCE(MAX(sequence),0)+1 FROM sync_seen WHERE target=? AND device=?",params![target,device],|r|r.get(0))?;(parents,sequence)};
        let commit=Commit{protocol:1,device:device.clone(),sequence,nonce:Uuid::new_v4().to_string(),parents,changes,files};
        let text=serde_json::to_string(&commit)?;let name=format!("{sequence:020}-{}.json",digest(&text));let path=outbox.join(&name);
        let temporary=outbox.join(format!("{name}.part"));fs::write(&temporary,text)?;fs::File::open(&temporary)?.sync_all()?;fs::rename(temporary,&path)?;
        publish(lib,p,&remote,&folder,&path)?;pushed=1;
    }
    lib.conn().execute("INSERT INTO sync_export_revision VALUES(?,?) ON CONFLICT(target) DO UPDATE SET value=excluded.value",params![target,revision])?;
    Ok(json!({"pulled":pulled,"pushed":pushed,"changed_documents":count_changes,"uploaded_files":count_files,"metadata_scanned":metadata_scanned,"metadata_candidates":metadata_candidates}))
}

pub fn conflicts(lib:&Library)->Result<Value> {
    let p=lib.sync.profile.lock().unwrap().clone().ok_or_else(||anyhow!("请先配置云同步"))?;let conn=lib.conn();
    let mut stmt=conn.prepare("SELECT id,key,base,remote,paths,created_at FROM sync_conflicts WHERE target=? ORDER BY created_at,id LIMIT 50")?;
    let rows=stmt.query_map([p.target_id()],|r|Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?,r.get::<_,String>(2)?,r.get::<_,String>(3)?,r.get::<_,String>(4)?,r.get::<_,i64>(5)?)))?.collect::<rusqlite::Result<Vec<_>>>()?;
    let mut out=vec![];
    for (id,key,base,remote,paths,created) in rows {
        let local=if key.starts_with("file:"){json!({"file":key.trim_start_matches("file:")})}else{model::load(&conn,&key)?};
        out.push(json!({"id":id,"key":key,"local":local,"remote":serde_json::from_str::<Value>(&remote)?,"base":serde_json::from_str::<Value>(&base)?,"paths":serde_json::from_str::<Value>(&paths)?,"created_at":created}));
    }Ok(json!(out))
}
pub fn resolve(lib:&Library,id:&str,choice:&str)->Result<Value> {
    if lib.sync.running.load(Ordering::SeqCst){return Err(anyhow!("请等待当前同步结束后处理冲突"));}
    if !["local","remote"].contains(&choice){return Err(anyhow!("invalid conflict resolution"));}
    let profile=lib.sync.profile.lock().unwrap().clone().ok_or_else(||anyhow!("请先配置云同步"))?;let target=profile.target_id();
    let (key,base,remote):(String,String,String)=lib.conn().query_row("SELECT key,base,remote FROM sync_conflicts WHERE id=? AND target=?",params![id,target],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?)))?;
    let base:Value=serde_json::from_str(&base)?;let incoming:Value=serde_json::from_str(&remote)?;
    if choice=="remote" {
        if let Some(path)=key.strip_prefix("file:") {
            let hash=incoming["hash"].as_str().ok_or_else(||anyhow!("invalid conflict blob"))?;
            let blob=work(lib,&profile)?.join("objects").join(hash);
            if sha256_file(&blob)?!=hash{return Err(anyhow!("冲突文件校验失败"));}
            materialize(lib.root(),path,&blob)?;
        }else{let conn=lib.conn();let tx=conn.unchecked_transaction()?;let current=model::load(&tx,&key)?;let(value,_)=model::merge(&base,&current,&incoming,true);model::apply(&tx,&key,&value)?;crate::organization::validate_tree(&tx)?;tx.commit()?;}
    }
    let conn=lib.conn();let tx=conn.unchecked_transaction()?;
    tx.execute("DELETE FROM sync_conflicts WHERE id=? AND target=?",params![id,target])?;
    // Keeping the local value changes no paper row, but must still schedule
    // its previously suppressed outbound change after the conflict is cleared.
    tx.execute("UPDATE sync_revision SET value=value+1 WHERE id=1",[])?;
    if !key.starts_with("file:"){tx.execute("INSERT OR REPLACE INTO sync_dirty SELECT ?,value FROM sync_revision WHERE id=1",[key])?;}
    tx.commit()?;Ok(json!({"ok":true}))
}
