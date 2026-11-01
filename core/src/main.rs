//! Moonlight native core — JSONL sidecar for the desktop app.
//!
//! One JSON object per line on stdin/stdout.  The renderer never sees a path,
//! a credential or a shell: it addresses papers, versions, pages and jobs by id
//! and this process resolves them inside the library root.
//!
//!   -> {"id":1,"method":"import_pdfs","params":{"paths":["/abs/x.pdf"]}}
//!   <- {"id":1,"ok":true,"result":[...]}
//!   <- {"event":"job","jobId":"...","status":"translating"}

mod ai;
mod organization;
mod citations;
mod backup;
mod engine;
mod library;
mod pdfmeta;
mod zotero;
mod zotero_local;
mod sync;
mod sync_model;
mod sync_transport;
mod search;

use anyhow::{anyhow, Result};
use library::Library;
use serde_json::{json, Value};
use std::io::{BufRead, Write};
use std::sync::{Arc, Mutex};

fn param_str(params: &Value, key: &str) -> Result<String> {
    params
        .get(key)
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
        .ok_or_else(|| anyhow!("missing {key}"))
}

fn main() {
    if std::env::args().nth(1).as_deref() == Some("--pdf-metadata-worker") {
        if let Err(error) = pdfmeta::worker_main() {
            eprintln!("PDF metadata worker: {error}");
            std::process::exit(1);
        }
        return;
    }
    let mut root = std::env::var("MOONLIGHT_LIBRARY").unwrap_or_else(|_| {
        let home = std::env::var("HOME").unwrap_or_else(|_| ".".into());
        format!("{home}/MoonlightLibrary")
    });
    let args: Vec<String> = std::env::args().collect();
    let mut i = 1;
    while i < args.len() {
        if args[i] == "--root" && i + 1 < args.len() {
            root = args[i + 1].clone();
            i += 1;
        } else if args[i] == "--version" {
            println!("moonlight-core 0.1.0");
            return;
        }
        i += 1;
    }

    let out = Arc::new(Mutex::new(std::io::stdout()));
    let emitter_out = Arc::clone(&out);
    let lib = match Library::new(std::path::Path::new(&root)) {
        Ok(lib) => lib,
        Err(err) => {
            eprintln!("fatal: cannot open library {root}: {err}");
            std::process::exit(1);
        }
    };
    lib.set_emitter(Arc::new(move |value: Value| {
        if let Ok(mut stdout) = emitter_out.lock() {
            let _ = writeln!(stdout, "{value}");
            let _ = stdout.flush();
        }
    }));
    if let Err(err) = lib.ensure_gateway() {
        eprintln!("model gateway not started: {err}");
    }

    emit(&out, json!({"protocol": 1, "event": "ready", "version": "0.1.0", "root": root, "engine": "rust"}));

    // A single bounded queue prevents unbounded threads and concurrent bulk
    // writers. The stdin thread remains available for interactive requests.
    let (heavy_tx, heavy_rx) = std::sync::mpsc::sync_channel::<Value>(16);
    let worker_lib = Arc::clone(&lib);
    let worker_out = Arc::clone(&out);
    let worker = std::thread::spawn(move || {
        for request in heavy_rx { respond(&worker_lib, &worker_out, &request); }
    });
    // Separate WAL readers keep expensive FTS requests off both the RPC loop
    // and the write connection. Two workers, a bounded queue, one snapshot per
    // request: counts and rows cannot describe different import moments.
    let (read_tx, read_rx) = std::sync::mpsc::sync_channel::<Value>(32);
    let read_rx = Arc::new(Mutex::new(read_rx));
    let mut readers = Vec::new();
    for _ in 0..2 {
        let input = Arc::clone(&read_rx);
        let output = Arc::clone(&out);
        let db = lib.root().join("library.db");
        readers.push(std::thread::spawn(move || {
            let mut conn = rusqlite::Connection::open_with_flags(db, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY);
            loop {
                let request = match input.lock().unwrap().recv() { Ok(r) => r, Err(_) => break };
                let result: Result<Value> = (|| {
                    let conn = conn.as_mut().map_err(|e| anyhow!("cannot open read connection: {e}"))?;
                    let tx = conn.transaction()?;
                    let value = search::list_page(&tx, &request["params"])?;
                    tx.commit()?;
                    Ok(value)
                })();
                let id = request.get("id").cloned().unwrap_or(Value::Null);
                match result {
                    Ok(value) => emit(&output, json!({"protocol":1,"id":id,"ok":true,"result":value})),
                    Err(error) => emit(&output, json!({"protocol":1,"id":id,"ok":false,"error":error.to_string()})),
                }
            }
        }));
    }

    let stdin = std::io::stdin();
    for line in stdin.lock().lines() {
        let Ok(line) = line else { break };
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let request: Value = match serde_json::from_str(line) {
            Ok(v) => v,
            Err(err) => {
                emit(&out, json!({"protocol": 1, "ok": false, "error": format!("invalid json: {err}")}));
                continue;
            }
        };
        let method = request.get("method").and_then(Value::as_str).unwrap_or("");
        if method == "list_papers_page" || matches!(method, "import_pdfs" | "zotero_import" | "zotero_api_import" | "explain" | "translate_text" | "export" | "backup_create" | "backup_restore" | "refresh_citations") {
            let queue = if method == "list_papers_page" { &read_tx } else { &heavy_tx };
            if let Err(error) = queue.try_send(request) {
                let request = match error {
                    std::sync::mpsc::TrySendError::Full(request) |
                    std::sync::mpsc::TrySendError::Disconnected(request) => request,
                };
                emit(&out, json!({"protocol": 1, "id": request.get("id"), "ok": false,
                    "error": "background task queue is full; retry after the current task"}));
            }
        } else {
            respond(&lib, &out, &request);
        }
    }
    let _=lib.shutdown();
    drop(heavy_tx);
    drop(read_tx);
    let _ = worker.join();
    for reader in readers { let _ = reader.join(); }
    let until=std::time::Instant::now()+std::time::Duration::from_secs(3);
    while std::time::Instant::now()<until {
        let active:i64=lib.conn().query_row("SELECT count(*) FROM jobs WHERE status NOT IN ('completed','failed','cancelled')",[],|r|r.get(0)).unwrap_or(0);
        if active==0{break;}std::thread::sleep(std::time::Duration::from_millis(30));
    }
}

fn respond(lib: &Arc<Library>, out: &Arc<Mutex<std::io::Stdout>>, request: &Value) {
        let id = request.get("id").cloned().unwrap_or(Value::Null);
        let method = request.get("method").and_then(|v| v.as_str()).unwrap_or("");
        let params = request.get("params").cloned().unwrap_or(json!({}));
        let result = dispatch(lib, method, &params);
        match result {
            Ok(value) => emit(&out, json!({"protocol": 1, "id": id, "ok": true, "result": value})),
            Err(err) => emit(&out, json!({"protocol": 1, "id": id, "ok": false, "error": err.to_string()})),
        }
}

fn emit(out: &Arc<Mutex<std::io::Stdout>>, value: Value) {
    if let Ok(mut stdout) = out.lock() {
        let _ = writeln!(stdout, "{value}");
        let _ = stdout.flush();
    }
}

fn dispatch(lib: &Arc<Library>, method: &str, params: &Value) -> Result<Value> {
    match method {
        "ping" => Ok(json!({"pong": true, "version": "0.1.0", "engine": "rust"})),
        "sync_configure" => sync::configure(lib,params),
        "sync_status" => sync::status(lib),
        "sync_start" => sync::start(lib,false),
        "sync_test" => sync::start(lib,true),
        "sync_cancel" => Ok(sync::cancel(lib)),
        "sync_conflicts" => sync::conflicts(lib),
        "sync_resolve" => sync::resolve(lib,&param_str(params,"id")?,&param_str(params,"choice")?),
        "import_pdfs" => {
            let paths = params
                .get("paths")
                .and_then(|v| v.as_array())
                .map(|a| a.iter().filter_map(|v| v.as_str().map(|s| s.to_string())).collect())
                .unwrap_or_default();
            Ok(Value::Array(lib.import_paths(paths)))
        }
        "list_papers" => Ok(Value::Array(lib.list_papers(
            params.get("query").and_then(|v| v.as_str()).unwrap_or(""),
            params.get("category").and_then(|v| v.as_str()),
            params.get("tag").and_then(|v| v.as_str()),
            params.get("trashed").and_then(|v| v.as_bool()).unwrap_or(false),
            params.get("status").and_then(|v| v.as_str()),
        )?)),
        "list_papers_page" => crate::search::list_page(&lib.conn(), params),
        "get_paper" => lib.get_paper(&param_str(params, "paper_id")?),
        "update_paper" => {
            let fields = params.get("fields").cloned().unwrap_or(json!({}));
            lib.update_paper(&param_str(params, "paper_id")?, &fields)
        }
        "trash_paper" => {
            lib.trash(&param_str(params, "paper_id")?)?;
            Ok(json!({"ok": true}))
        }
        "restore_paper" => {
            lib.restore(&param_str(params, "paper_id")?)?;
            Ok(json!({"ok": true}))
        }
        "purge_paper" => lib.purge(&param_str(params, "paper_id")?),
        "list_taxonomy" => lib.taxonomy(),
        "set_categories" => {
            let ids = params.get("category_ids").and_then(|v| v.as_array()).map(|a| a.iter().filter_map(|v| v.as_str().map(|s| s.to_string())).collect()).unwrap_or_default();
            lib.set_categories(&param_str(params, "paper_id")?, ids)?;
            Ok(json!({"ok": true}))
        }
        "set_tags" => {
            let tags = params.get("tags").and_then(|v| v.as_array()).map(|a| a.iter().filter_map(|v| v.as_str().map(|s| s.to_string())).collect()).unwrap_or_default();
            lib.set_tags(&param_str(params, "paper_id")?, tags)?;
            Ok(json!({"ok": true}))
        }
        "save_category" => organization::folder_save(lib,params),
        "bulk_assign" => organization::bulk_assign(lib,params),
        "set_short_note" => organization::short_note(lib,params),
        "refresh_citations" => citations::refresh(lib,params),
        "add_category" => lib.add_category(&param_str(params, "name")?),
        "list_annotations" => Ok(Value::Array(lib.list_annotations(&param_str(params, "paper_id")?)?)),
        "add_annotation" => lib.add_annotation(
            &param_str(params, "paper_id")?,
            params.get("page").and_then(|v| v.as_i64()).unwrap_or(0),
            params.get("rects").cloned().unwrap_or(json!([])),
            params.get("quote").and_then(|v| v.as_str()).unwrap_or(""),
            params.get("color").and_then(|v| v.as_str()).unwrap_or("yellow"),
            params.get("comment").and_then(|v| v.as_str()).unwrap_or(""),
            params.get("version_kind").and_then(|v| v.as_str()).unwrap_or("source"),
            params.get("version_id").and_then(|v| v.as_str()),
        ),
        "update_annotation" => {
            lib.update_annotation(&param_str(params, "annotation_id")?, params.get("fields").unwrap_or(&json!({})))?;
            Ok(json!({"ok": true}))
        }
        "delete_annotation" => {
            lib.delete_annotation(&param_str(params, "annotation_id")?)?;
            Ok(json!({"ok": true}))
        }
        "export" => {
            let ids = params.get("paper_ids").and_then(|v| v.as_array()).map(|a| a.iter().filter_map(|v| v.as_str().map(|s| s.to_string())).collect()).unwrap_or_default();
            let format = params.get("format").and_then(|v| v.as_str()).unwrap_or("bibtex");
            Ok(json!({"text": lib.export(ids, format)?}))
        }
        "start_translate" => lib.start_translation(
            &param_str(params, "paper_id")?,
            params.get("pages").and_then(|v| v.as_str()).map(|s| s.to_string()),
        ),
        "cancel_job" => {
            lib.cancel_job(&param_str(params, "job_id")?)?;
            Ok(json!({"ok": true}))
        }
        "save_paper" => lib.save_paper(params),
        "append_note" => lib.append_note(&param_str(params,"paper_id")?,&param_str(params,"text")?),
        "backup_create" => backup::create(lib,std::path::Path::new(&param_str(params,"parent")?)),
        "backup_restore" => backup::restore(std::path::Path::new(&param_str(params,"source")?),std::path::Path::new(&param_str(params,"parent")?)),
        "shutdown" => lib.shutdown(),
        "list_jobs" => lib.list_jobs(),
        "get_job" => lib.get_job(&param_str(params, "job_id")?),
        "paper_pdf" => lib.paper_pdf(&param_str(params, "paper_id")?, params.get("kind").and_then(|v| v.as_str()).unwrap_or("source"), params.get("version_id").and_then(Value::as_str)),
        "version_path" => Ok(json!({"path": lib.version_path(&param_str(params, "version_id")?)?.to_string_lossy()})),
        "set_blocks" => {
            lib.set_blocks(
                &param_str(params, "paper_id")?,
                &param_str(params, "version_id")?,
                params.get("page").and_then(|v| v.as_i64()).unwrap_or(0),
                params.get("blocks").and_then(|v| v.as_array()).cloned().unwrap_or_default(),
            )?;
            Ok(json!({"ok": true}))
        }
        "document_text_status" => {
            let paper=param_str(params,"paper_id")?;let version=param_str(params,"version_id")?;
            let conn=lib.conn();
            let pages:i64=conn.query_row("SELECT pages FROM versions WHERE id=? AND paper_id=?",rusqlite::params![version,paper],|r|r.get(0))?;
            let indexed:i64=conn.query_row("SELECT count(DISTINCT page) FROM blocks WHERE paper_id=? AND version_id=? AND length(trim(text))>0",rusqlite::params![paper,version],|r|r.get(0))?;
            Ok(json!({"pages":pages,"indexed_pages":indexed}))
        }
        "blocks" => Ok(Value::Array(lib.blocks(
            &param_str(params, "paper_id")?,
            &param_str(params, "version_id")?,
            params.get("page").and_then(|v| v.as_i64()).unwrap_or(0),
        )?)),
        "search_blocks" => Ok(Value::Array(lib.search_blocks(
            &param_str(params, "paper_id")?,
            &param_str(params, "query")?,
            params.get("limit").and_then(|v| v.as_i64()).unwrap_or(20),
        )?)),
        "zotero_probe" => Ok(zotero::probe(params.get("data_dir").and_then(|v| v.as_str()))),
        "zotero_files" => zotero_local::list_files(lib,&param_str(params,"paper_id")?),
        "zotero_attachment_path" => zotero_local::attachment_path(lib,&param_str(params,"paper_id")?,&param_str(params,"file_id")?),
        "zotero_import" => zotero::import(lib, params),
        "zotero_api_import" => zotero::api_import(lib, params),
        "ai_prepare" => ai::prepare(lib, params),
        "ai_history" => ai::history(lib, &param_str(params,"paper_id")?),
        "ai_save" => ai::save(lib, params),
        "explain" | "translate_text" => {
            if lib.gateway().is_none() {
                lib.ensure_gateway()?;
            }
            let gateway = lib.gateway().ok_or_else(|| anyhow!("model is not configured"))?;
            if method == "translate_text" {
                ai::translate_text(&gateway, &param_str(params, "text")?)
            } else {
                let block_ids = params.get("block_ids").and_then(|v| v.as_array()).map(|a| {
                    a.iter().filter_map(|v| v.as_str().map(|s| s.to_string())).collect::<Vec<_>>()
                });
                ai::explain(
                    lib,
                    &gateway,
                    &param_str(params, "paper_id")?,
                    params.get("question").and_then(|v| v.as_str()).unwrap_or(""),
                    block_ids,
                    params.get("page").and_then(|v| v.as_i64()),
                    params.get("kind").and_then(|v| v.as_str()).unwrap_or("explain"),
                    params.get("version_id").and_then(Value::as_str),
                    params.get("scope").and_then(Value::as_str).unwrap_or("related"),
                )
            }
        }
        other => Err(anyhow!("unknown method {other}")),
    }
}
