//! WAL-aware immutable backup with checksums. Restore always targets a NEW library.
use crate::library::{Library,sha256_file};
use anyhow::{Result,anyhow,ensure};
use rusqlite::{Connection,backup::Backup,params};
use serde_json::{json,Value};
use std::{fs,path::{Path,Component},time::Duration};
use uuid::Uuid;
fn safe_path(p:&str)->bool{!p.is_empty()&&Path::new(p).components().all(|c|matches!(c,Component::Normal(_)))}
fn copy_tree(source:&Path,dest:&Path)->Result<()> {
    fs::create_dir_all(dest)?;
    for item in fs::read_dir(source)?{let item=item?;let ty=item.file_type()?;
        ensure!(!ty.is_symlink(),"备份目录含符号链接");
        if ty.is_dir(){copy_tree(&item.path(),&dest.join(item.file_name()))?;}
        else if ty.is_file(){fs::copy(item.path(),dest.join(item.file_name()))?;}
    }Ok(())
}
fn manifest(root:&Path,dir:&Path,files:&mut Vec<Value>)->Result<()> {
    for item in fs::read_dir(dir)?{let item=item?;let ty=item.file_type()?;ensure!(!ty.is_symlink(),"备份中不允许符号链接");
        if ty.is_dir(){manifest(root,&item.path(),files)?;}else if ty.is_file(){
            let p=item.path();let rel=p.strip_prefix(root)?.to_string_lossy().replace('\\',"/");
            if rel=="manifest.json"{continue;}
            files.push(json!({"path":rel,"sha256":sha256_file(&p)?,"bytes":p.metadata()?.len()}));
        }
    }Ok(())
}
pub fn create(lib:&Library,parent:&Path)->Result<Value>{
    let _pin=lib.maintenance.lock().unwrap();
    fs::create_dir_all(parent)?;
    ensure!(!parent.canonicalize()?.starts_with(lib.root().canonicalize()?),"请选择论文库以外的备份目录");
    let id=Uuid::new_v4().to_string();let temp=parent.join(format!(".moonlight-backup-{id}.partial"));let dest=parent.join(format!("MoonlightBackup-{id}"));
    fs::create_dir(&temp)?;
    let result=(||->Result<Value>{
        let mut snapshot=Connection::open(temp.join("library.db"))?;
        {let source=Connection::open_with_flags(lib.root().join("library.db"),rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)?;Backup::new(&source,&mut snapshot)?.run_to_completion(256,Duration::from_millis(2),None)?;}
        let active:i64=snapshot.query_row("SELECT count(*) FROM jobs WHERE status NOT IN ('completed','failed','cancelled')",[],|r|r.get(0))?;
        ensure!(active==0,"请先停止或等待翻译任务完成后备份");
        let paths:Vec<String>={let mut st=snapshot.prepare("SELECT rel_path FROM versions UNION SELECT rel_path FROM zotero_files WHERE rel_path IS NOT NULL AND status IN ('copied','linked')")?;let rows=st.query_map([],|r|r.get(0))?.collect::<rusqlite::Result<Vec<_>>>()?;rows};
        for rel in paths{
            let source=if Path::new(&rel).is_absolute(){Path::new(&rel).to_path_buf()}else{ensure!(safe_path(&rel),"非法附件路径");lib.root().join(&rel)};
            ensure!(source.is_file(),"备份失败，缺少附件：{}",source.display());
            let new_rel=if Path::new(&rel).is_absolute(){format!("files/linked-{}.{}",sha256_file(&source)?,source.extension().and_then(|e|e.to_str()).filter(|e|e.len()<=12&&e.chars().all(|c|c.is_ascii_alphanumeric())).unwrap_or("bin"))}else{rel.clone()};
            let target=temp.join(&new_rel);fs::create_dir_all(target.parent().unwrap())?;
            // HTML snapshots include sibling resources. Copy the entire managed snapshot directory.
            if rel.starts_with("files/")&&source.extension().is_some_and(|e|e=="html"){
                copy_tree(source.parent().unwrap(),target.parent().unwrap())?;
            }else{fs::copy(&source,&target)?;}
            if new_rel!=rel{
                snapshot.execute("UPDATE versions SET rel_path=? WHERE rel_path=?",params![new_rel,rel])?;
                snapshot.execute("UPDATE zotero_files SET rel_path=?,status='copied' WHERE rel_path=?",params![new_rel,rel])?;
            }
        }
        let archives=lib.root().join("imports");if archives.exists(){copy_tree(&archives,&temp.join("imports"))?;}
        snapshot.execute_batch("PRAGMA wal_checkpoint(TRUNCATE); PRAGMA journal_mode=DELETE;")?;drop(snapshot);
        let mut files=vec![];manifest(&temp,&temp,&mut files)?;
        let count=files.len();fs::write(temp.join("manifest.json"),serde_json::to_vec_pretty(&json!({"format":"moonlight-backup-v1","files":files}))?)?;
        fs::rename(&temp,&dest)?;Ok(json!({"path":dest,"files":count}))
    })();
    if result.is_err(){let _=fs::remove_dir_all(&temp);}result
}
pub fn restore(source:&Path,parent:&Path)->Result<Value>{
    let data:Value=serde_json::from_slice(&fs::read(source.join("manifest.json"))?)?;
    ensure!(data["format"]=="moonlight-backup-v1","不支持的备份格式");
    let files=data["files"].as_array().ok_or_else(||anyhow!("备份清单缺失"))?;
    ensure!(files.iter().any(|r|r["path"]=="library.db"),"备份数据库缺失");
    fs::create_dir_all(parent)?;
    let id=Uuid::new_v4().to_string();let temp=parent.join(format!(".moonlight-restore-{id}.partial"));let dest=parent.join(format!("MoonlightRestored-{id}"));fs::create_dir(&temp)?;
    let result=(||->Result<Value>{
        for row in files{
            let rel=row["path"].as_str().ok_or_else(||anyhow!("非法备份路径"))?;ensure!(safe_path(rel),"备份路径越界");
            let src=source.join(rel);ensure!(src.canonicalize()?.starts_with(source.canonicalize()?),"备份文件链接越界");
            ensure!(sha256_file(&src)?==row["sha256"].as_str().unwrap_or(""),"备份文件校验失败：{rel}");
            let target=temp.join(rel);fs::create_dir_all(target.parent().unwrap())?;fs::copy(src,&target)?;
            ensure!(sha256_file(&target)?==row["sha256"].as_str().unwrap_or(""),"恢复文件校验失败：{rel}");
        }
        let conn=Connection::open(temp.join("library.db"))?;
        let check:String=conn.query_row("PRAGMA integrity_check",[],|r|r.get(0))?;ensure!(check=="ok","数据库完整性校验失败");
        let fk=conn.prepare("PRAGMA foreign_key_check")?.exists([])?;ensure!(!fk,"数据库关系校验失败");
        {let mut st=conn.prepare("SELECT rel_path FROM versions UNION SELECT rel_path FROM zotero_files WHERE rel_path IS NOT NULL AND status IN ('copied','linked')")?;
        let paths=st.query_map([],|r|r.get::<_,String>(0))?.collect::<rusqlite::Result<Vec<_>>>()?;
        for rel in paths{ensure!(safe_path(&rel)&&temp.join(&rel).is_file(),"恢复备份缺少附件或路径非法：{rel}");}}
        drop(conn);
        // Run normal migrations before exposing the restored library.
        let library=Library::new(&temp)?;drop(library);
        fs::rename(&temp,&dest)?;Ok(json!({"path":dest}))
    })();if result.is_err(){let _=fs::remove_dir_all(&temp);}result
}
