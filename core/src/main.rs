//! Moonlight native core — JSONL sidecar for the desktop app.
//!
//! One JSON object per line on stdin/stdout.  The renderer never sees a path,
//! a credential or a shell: it addresses papers, versions, pages and jobs by id
//! and this process resolves them inside the library root.
//!
//!   -> {"id":1,"method":"import_pdfs","params":{"paths":["/abs/x.pdf"]}}
//!   <- {"id":1,"ok":true,"result":[...]}
//!   <- {"event":"job","jobId":"...","status":"translating"}

mod agent_plan;
mod ai;
mod cjk;
mod organization;
mod bibliography;
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
mod server;
mod synthesis;
mod mcp;

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

/// A persisted pairing token is exactly 32 ASCII hex characters (16 bytes).
/// Validation is shared with `server::valid_token`; the token itself is never
/// printed (only the fact that it was rejected).
fn parse_serve_token(value: &str) -> Option<String> {
    let value = value.trim();
    if server::valid_token(value) {
        Some(value.to_ascii_lowercase())
    } else {
        None
    }
}

/// Strict LAN RPC policy (BUG-05 §1).
///
/// Only tablet-safe methods are exposed over `POST /api/rpc`; anything that
/// reads host paths, spawns processes, touches credentials/backups, rewrites
/// the gateway or shuts the process down is answered with
/// `403 {"ok":false,"error":"forbidden over LAN"}` before `dispatch` runs.
/// New RPCs are private by default: they must be added here explicitly.
fn allowed_lan_method(method: &str) -> bool {
    matches!(
        method,
        "app_info"
            | "list_papers_page"
            | "list_papers"
            | "get_paper"
            | "list_annotations"
            | "add_annotation"
            | "update_annotation"
            | "delete_annotation"
            | "list_taxonomy"
            | "set_reading_position"
            | "paper_pdf"
            | "blocks"
            | "set_blocks"
            | "document_text_status"
            | "search_blocks"
            | "list_jobs"
            | "get_job"
            | "start_translate"
            | "cancel_job"
            | "ai_prepare"
            | "ai_preview"
            | "ai_digest"
            | "ai_history"
            | "ai_save"
            | "ai_delete"
            | "ai_clear"
            | "ai_cancel"
            | "claim_verify"
            | "synthesis_matrix"
            | "organize_plan"
            | "explain"
            | "translate_text"
            | "update_paper"
            | "save_paper"
            | "append_note"
            | "set_short_note"
            | "export"
            | "zotero_files"
            | "trash_paper"
            | "restore_paper"
            | "bulk_assign"
            | "bulk_unassign"
            | "bulk_set_status"
            | "bulk_trash"
            | "bulk_restore"
    )
}

/// Build the HTTP handler used by `--serve`: the tablet-first read pool routes
/// its five hot read methods, then the whitelist is enforced, and only an
/// allowed method reaches `dispatch`.
fn lan_handler(lib: Arc<Library>, read_pool: Arc<search::ReadPool>) -> server::Handler {
    Arc::new(move |method: &str, params: &Value| match method {
        "list_papers_page" => read_pool.list_page(params),
        "get_paper" => {
            let paper_id = param_str(params, "paper_id")?;
            read_pool.with_connection(|conn| Library::get_paper_on(conn, &paper_id))
        }
        "list_annotations" => {
            let paper_id = param_str(params, "paper_id")?;
            read_pool.with_connection(|conn| Ok(Value::Array(Library::list_annotations_on(conn, &paper_id)?)))
        }
        "list_taxonomy" => read_pool.with_connection(Library::taxonomy_on),
        "ai_history" => {
            let paper_id = param_str(params, "paper_id")?;
            read_pool.with_connection(|conn| ai::history_on(conn, &paper_id))
        }
        // The whitelist runs before `dispatch`: dangerous/unknown methods never
        // execute any library code and are mapped to HTTP 403 by the server.
        _ if allowed_lan_method(method) => dispatch(&lib, method, params),
        _ => Err(server::LanForbidden.into()),
    })
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
    // `--serve <addr>` starts the LAN/PWA endpoint the vivo Pad talks to;
    // `--static <dir>` serves a built frontend from that same origin;
    // `--serve-token <32hex>` reuses the token persisted by the desktop so an
    // installed PWA keeps working across restarts (never logged).
    let mut serve_addr: Option<String> = None;
    let mut static_dir: Option<std::path::PathBuf> = None;
    let mut serve_token: Option<String> = None;
    let mut i = 1;
    while i < args.len() {
        if args[i] == "--root" && i + 1 < args.len() {
            root = args[i + 1].clone();
            i += 1;
        } else if args[i] == "--serve" && i + 1 < args.len() {
            serve_addr = Some(args[i + 1].clone());
            i += 1;
        } else if args[i] == "--serve-token" && i + 1 < args.len() {
            serve_token = parse_serve_token(&args[i + 1]);
            if serve_token.is_none() {
                eprintln!("[server] --serve-token 需为 32 位十六进制，已忽略并将在启动时随机生成配对令牌");
            }
            i += 1;
        } else if args[i] == "--static" && i + 1 < args.len() {
            static_dir = Some(std::path::PathBuf::from(&args[i + 1]));
            i += 1;
        } else if args[i] == "--version" {
            println!("moonlight-core 0.1.0");
            return;
        }
        i += 1;
    }
    // The desktop normally passes `--serve-token`; the environment variable is
    // the supported fallback for launchers that prefer not to put a credential
    // in argv (BUG-05 §2).
    if serve_token.is_none() {
        if let Ok(value) = std::env::var("MOONLIGHT_SERVE_TOKEN") {
            serve_token = parse_serve_token(&value);
        }
    }

    let out = Arc::new(Mutex::new(std::io::stdout()));
    let emitter_out = Arc::clone(&out);
    // Events go to the JSONL consumer (Electron) and, when serving, to every
    // connected EventSource; both see the same stream.
    let hub = server::EventHub::default();
    let emitter_hub = hub.clone();
    let is_mcp = args.iter().any(|arg| arg == "--mcp");
    let lib = match if is_mcp {
        Library::open_for_mcp(std::path::Path::new(&root))
    } else {
        Library::new(std::path::Path::new(&root))
    } {
        Ok(lib) => lib,
        Err(err) => {
            eprintln!("fatal: cannot open library {root}: {err}");
            std::process::exit(1);
        }
    };
    // MCP stdio mode (FEAT-AI-03) must own stdout exclusively: no JSONL ready
    // line, no library event emitter, no gateway. Read-only tools only.
    if is_mcp {
        if let Err(error) = mcp::serve_stdio(&lib) {
            eprintln!("mcp: {error}");
            std::process::exit(1);
        }
        return;
    }
    lib.set_emitter(Arc::new(move |value: Value| {
        emitter_hub.publish(value.clone());
        if let Ok(mut stdout) = emitter_out.lock() {
            let _ = writeln!(stdout, "{value}");
            let _ = stdout.flush();
        }
    }));
    if let Err(err) = lib.ensure_gateway() {
        eprintln!("model gateway not started: {err}");
    }

    emit(&out, json!({"protocol": 1, "event": "ready", "version": "0.1.0", "root": root, "engine": "rust"}));

    // The LAN endpoint reuses `dispatch` verbatim, so the Pad speaks the same
    // protocol as Electron instead of a second implementation.
    // 平板 HTTP 端的分页检索走独立的只读连接池，不抢唯一的写连接
    // （`dispatch` 的 `list_papers_page` 分支依赖 `lib.conn()` 互斥锁）。
    let read_pool = std::sync::Arc::new(search::ReadPool::new(
        lib.root().join("library.db"),
        READ_WORKERS,
    ));
    let serve_handle = match serve_addr {
        Some(bind) => {
            let handler = lan_handler(Arc::clone(&lib), Arc::clone(&read_pool));
            let static_dir = static_dir.or_else(|| {
                std::env::var("MOONLIGHT_ROOT").ok()
                    .map(|root| std::path::PathBuf::from(root).join("app").join("dist"))
                    .filter(|dir| dir.exists())
            });
            match server::serve(Arc::clone(&lib), &bind, handler, hub.clone(), static_dir, serve_token) {
                Ok(handle) => {
                    emit(&out, json!({
                        "event": "serve_ready",
                        "addr": handle.addr,
                        "token": handle.token,
                        "url": format!("http://{}/", handle.addr),
                    }));
                    Some(handle)
                }
                Err(error) => {
                    eprintln!("serve failed: {error}");
                    None
                }
            }
        }
        None => None,
    };

    // 三类独立执行器，互不阻塞：
    // * AI/网络池：4 个 worker + 容量 16 的有界队列，慢问答不再堵住设置页探测、
    //   引用量刷新或划词翻译；
    // * 本地单写者：1 个 worker + 容量 8 的有界队列，导入/导出/备份保持串行，
    //   避免并发写库与重磁盘 IO；
    // * 只读池：4 条独立只读连接接 `list_papers_page`，不占写连接。
    // 所有队列都有界：满了回清晰错误，不丢请求，也不会无限建线程。
    const NETWORK_WORKERS: usize = 4;
    const NETWORK_QUEUE: usize = 16;
    const LOCAL_QUEUE: usize = 8;
    const READ_WORKERS: usize = 4;
    const READ_QUEUE: usize = 32;
    let (network_tx, network_rx) = std::sync::mpsc::sync_channel::<Value>(NETWORK_QUEUE);
    let (local_tx, local_rx) = std::sync::mpsc::sync_channel::<Value>(LOCAL_QUEUE);
    let (read_tx, read_rx) = std::sync::mpsc::sync_channel::<Value>(READ_QUEUE);
    let mut workers = spawn_responders("ai-network", NETWORK_WORKERS, network_rx, &lib, &out);
    workers.extend(spawn_responders("local-writer", 1, local_rx, &lib, &out));
    workers.extend(spawn_readers(READ_WORKERS, read_rx, &lib, &out));

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
        if let Some(executor) = executor_for(method) {
            let queue = match executor {
                Executor::Network => &network_tx,
                Executor::LocalWrite => &local_tx,
                Executor::Read => &read_tx,
            };
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
    // stdin EOF：先关闭三个队列（已入队的请求会被 worker 执行完），再 join，
    // 避免 worker 永远阻塞在 recv 上导致 join 死锁；最后才 shutdown，
    // 不会打断已经受理的请求。
    if let Some(handle) = serve_handle.as_ref() { handle.shutdown(); }
    drop(network_tx);
    drop(local_tx);
    drop(read_tx);
    for worker in workers { let _ = worker.join(); }
    let _=lib.shutdown();
    let until=std::time::Instant::now()+std::time::Duration::from_secs(3);
    while std::time::Instant::now()<until {
        let active:i64=lib.conn().query_row("SELECT count(*) FROM jobs WHERE status NOT IN ('completed','failed','cancelled')",[],|r|r.get(0)).unwrap_or(0);
        if active==0{break;}std::thread::sleep(std::time::Duration::from_millis(30));
    }
}

/// 请求该由哪类执行器处理；`None` 表示直接在 RPC 线程同步执行（瞬时方法）。
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Executor {
    /// AI 问答与纯网络只读调用：彼此并发，慢请求不互相拖累。
    Network,
    /// 批量导入/导出/备份：单写者串行，避免并发写库与重 IO。
    LocalWrite,
    /// 分页检索：独立只读连接，绝不占用写连接。
    Read,
}

/// 方法到执行器的路由。分类刻意保持窄：只有耗时、可并发的调用才离开 RPC
/// 线程，其余方法仍同步执行，行为与旧版一致。
fn executor_for(method: &str) -> Option<Executor> {
    match method {
        // 网络往返为主、不写本地库（`explain` 只把问答结果追加进 chats）。
        "explain" | "translate_text" | "ai_digest" | "claim_verify" | "organize_plan" | "synthesis_matrix" | "translation_probe" | "refresh_citations"
        | "refresh_metadata" | "check_babeldoc" => Some(Executor::Network),
        // 会批量写库或搬运大文件的本地重任务，必须串行。
        "import_pdfs" | "zotero_import" | "zotero_api_import" | "export"
        | "backup_create" | "backup_restore" => Some(Executor::LocalWrite),
        // FEAT-UX-02/03/04: merging rewrites many rows, bibliography import
        // writes a batch of papers and saving the glossary replaces a table —
        // all three belong on the single local writer, never the RPC thread.
        "merge_papers" | "import_bibliography" | "save_glossary" => Some(Executor::LocalWrite),
        // 只读分页检索。
        "list_papers_page" => Some(Executor::Read),
        _ => None,
    }
}

/// 为 `respond` 型执行器起 `count` 个 worker，共享同一个有界队列。
///
/// 队列锁只在 `recv` 时持有；请求本体（可能是 300s 的 AI 调用或整盘导入）
/// 在锁外执行，所以同池的多个 worker 是真正并发。
fn spawn_responders(
    name: &str,
    count: usize,
    queue: std::sync::mpsc::Receiver<Value>,
    lib: &Arc<Library>,
    out: &Arc<Mutex<std::io::Stdout>>,
) -> Vec<std::thread::JoinHandle<()>> {
    let queue = Arc::new(Mutex::new(queue));
    (0..count).map(|index| {
        let queue = Arc::clone(&queue);
        let lib = Arc::clone(lib);
        let out = Arc::clone(out);
        std::thread::Builder::new()
            .name(format!("{name}-{index}"))
            .spawn(move || loop {
                // 单独一条语句取任务：MutexGuard 在语句结束即释放，慢请求不占锁。
                let received = { queue.lock().unwrap().recv() };
                let request = match received {
                    Ok(request) => request,
                    Err(_) => break, // 发送端已关闭且队列已排空
                };
                respond(&lib, &out, &request);
            })
            .expect("spawn background worker")
    }).collect()
}

/// 只读池：每个 worker 一条独立只读连接，一条请求一个快照。
///
/// 连接打开后先注册 `han_bigrams`（幂等、无副作用）：只读连接目前不会执行
/// 二元组触发器，但这样任何复用该连接执行写路径的代码都不会因缺函数而失败。
fn spawn_readers(
    count: usize,
    queue: std::sync::mpsc::Receiver<Value>,
    lib: &Arc<Library>,
    out: &Arc<Mutex<std::io::Stdout>>,
) -> Vec<std::thread::JoinHandle<()>> {
    let queue = Arc::new(Mutex::new(queue));
    (0..count).map(|index| {
        let queue = Arc::clone(&queue);
        let output = Arc::clone(out);
        let db = lib.root().join("library.db");
        std::thread::Builder::new()
            .name(format!("read-page-{index}"))
            .spawn(move || {
                let mut conn = rusqlite::Connection::open_with_flags(db, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)
                    .and_then(|conn| -> rusqlite::Result<rusqlite::Connection> {
                        search::register(&conn)?;
                        Ok(conn)
                    });
                loop {
                    let received = { queue.lock().unwrap().recv() };
                    let request = match received { Ok(request) => request, Err(_) => break };
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
            })
            .expect("spawn read worker")
    }).collect()
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
        // 平板 PWA 的首屏信息：桌面端由 preload 的 `app:info` 提供，浏览器端
        // 走同一套 RPC，避免 HTTP 桥在启动时因缺少方法而白屏。
        "app_info" => Ok(json!({
            "version": "0.1.0",
            "library": lib.root().to_string_lossy(),
            "headless": true,
            "model": std::env::var("MOONLIGHT_MODEL").unwrap_or_default(),
            "credentialConfigured": lib.gateway().is_some(),
        })),
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
        // Reading progress is a tiny synchronous write on purpose: it must not
        // queue behind an import, and it does not touch `papers.updated_at`.
        "set_reading_position" => lib.set_reading_position(
            &param_str(params, "paper_id")?,
            params.get("page").and_then(Value::as_i64).unwrap_or(0),
            params.get("fraction").and_then(Value::as_f64).unwrap_or(0.0),
            params.get("mode").and_then(Value::as_str).unwrap_or("source"),
        ),
        "trash_paper" => {
            lib.trash(&param_str(params, "paper_id")?)?;
            Ok(json!({"ok": true}))
        }
        "restore_paper" => {
            lib.restore(&param_str(params, "paper_id")?)?;
            Ok(json!({"ok": true}))
        }
        "purge_paper" => lib.purge(&param_str(params, "paper_id")?),
        "bulk_set_status" => lib.bulk_set_status(params),
        "bulk_trash" => lib.bulk_trash(params),
        "bulk_restore" => lib.bulk_restore(params),
        "bulk_purge" => lib.bulk_purge(params),
        "empty_trash" => lib.empty_trash(),
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
        "folder_delete" => organization::folder_delete(lib,params),
        "folder_move" => organization::folder_move(lib,params),
        "folder_merge" => organization::folder_merge(lib,params),
        "tag_rename" => organization::tag_rename(lib,params),
        "tag_set_color" => organization::tag_set_color(lib,params),
        "tag_delete" => organization::tag_delete(lib,params),
        "bulk_assign" => organization::bulk_assign(lib,params),
        "bulk_unassign" => organization::bulk_unassign(lib,params),
        "list_duplicates" => organization::list_duplicates(lib,params),
        // FEAT-UX-02: transactional duplicate merge (metadata + every related row).
        "merge_papers" => organization::merge_papers(lib,params),
        // FEAT-UX-04: metadata-only .bib/.ris import.
        "import_bibliography" => bibliography::import_bibliography(lib,params),
        // FEAT-UX-03: global terminology table (SQLite is the source of truth;
        // the live gateway is hot-updated on save).
        "list_glossary" => lib.list_glossary(),
        "save_glossary" => lib.save_glossary(params),
        "set_short_note" => organization::short_note(lib,params),
        "refresh_citations" => citations::refresh(lib,params),
        "refresh_metadata" => lib.refresh_metadata(params),
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
            params.get("version_id").and_then(Value::as_str).map(str::to_string),
        ),
        "cancel_job" => {
            lib.cancel_job(&param_str(params, "job_id")?)?;
            Ok(json!({"ok": true}))
        }
        // Hot reload of the translation configuration; diagnostics for the
        // settings dialog. Both never require a restart.
        "reload_gateway" => lib.reload_gateway(params),
        "translation_probe" => lib.translation_probe(params),
        "check_babeldoc" => lib.check_babeldoc(params),
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
        "ai_preview" => ai::preview(lib, params),
        "ai_digest" => ai::digest(lib, params),
        "claim_verify" => ai::claim_verify(lib, params),
        "organize_plan" => agent_plan::organize_plan(lib, params),
        "synthesis_matrix" => synthesis::matrix(lib, params),
        "ai_history" => ai::history(lib, &param_str(params,"paper_id")?),
        "ai_save" => ai::save(lib, params),
        "ai_delete" => ai::delete(lib, &param_str(params,"chat_id")?),
        "ai_clear" => ai::clear(lib, &param_str(params,"paper_id")?),
        // Chat-only model from 「设置 → AI 阅读助手」.  Electron keeps its own
        // `ai-settings.json`; the library copy makes the pick visible to the
        // headless transports (quick explain, digest, LAN tablet bridge) that
        // call `explain`/`ai_digest` without going through the AI service.
        "set_chat_model" => lib.set_chat_model(params["model"].as_str().unwrap_or("")),
        "ai_cancel" => {
            let request_id = param_str(params, "request_id")?;
            Ok(json!({"ok": true, "cancelled": lib.cancel_ai(&request_id)}))
        }
        "explain" | "translate_text" => {
            if lib.gateway().is_none() {
                lib.ensure_gateway()?;
            }
            let mut gateway = lib.gateway().ok_or_else(|| anyhow!("model is not configured"))?;
            // Precedence: per-request `model`, then the chat model persisted by
            // the AI settings dialog, then the configured gateway default.
            // Translation keeps the configured model, so the persisted fallback
            // only applies to chat (`explain`).
            let requested = params
                .get("model")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|model| !model.is_empty() && model.len() <= 200)
                .map(str::to_string);
            let selected = requested.or_else(|| if method == "explain" { lib.chat_model() } else { None });
            if let Some(model) = selected {
                gateway.model = model;
            }
            if method == "translate_text" {
                ai::translate_text(lib, &gateway, &param_str(params, "text")?)
            } else {
                let block_ids = params.get("block_ids").and_then(|v| v.as_array()).map(|a| {
                    a.iter().filter_map(|v| v.as_str().map(|s| s.to_string())).collect::<Vec<_>>()
                });
                // A `request_id` opts this turn into SSE streaming: the answer is
                // pushed as `ai_delta` events and `ai_cancel` flips the flag the
                // stream polls between chunks.
                let stream = params
                    .get("request_id")
                    .and_then(Value::as_str)
                    .filter(|id| !id.is_empty() && id.len() <= 80 && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_'))
                    .map(|id| ai::AiStream { request_id: id.to_string(), cancel: lib.begin_ai_request(id) });
                let result = ai::explain_with(
                    lib,
                    &gateway,
                    &param_str(params, "paper_id")?,
                    params.get("question").and_then(|v| v.as_str()).unwrap_or(""),
                    block_ids,
                    params.get("page").and_then(|v| v.as_i64()),
                    params.get("kind").and_then(|v| v.as_str()).unwrap_or("explain"),
                    params.get("version_id").and_then(Value::as_str),
                    params.get("scope").and_then(Value::as_str).unwrap_or("related"),
                    // 前端“带入最近 6 轮对话”开关（默认开启以保持旧行为）。
                    params.get("include_history").and_then(Value::as_bool).unwrap_or(true),
                    // 阅读器划词气泡使用 `ephemeral: true`，不写入 chats 历史。
                    !params.get("ephemeral").and_then(Value::as_bool).unwrap_or(false),
                    stream.as_ref(),
                    // §3.4.3 画布框选裁剪出的 `data:image/...` DataURL；缺省为纯文字问答。
                    params.get("image_data_url").and_then(Value::as_str),
                );
                if let Some(stream) = stream.as_ref() { lib.end_ai_request(&stream.request_id); }
                result
            }
        }
        other => Err(anyhow!("unknown method {other}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A loopback upstream that records the body of every chat request, so a
    /// test can assert which model the gateway actually sent.
    fn recording_upstream(reply: &str) -> (String, Arc<Mutex<Vec<Value>>>) {
        let server = tiny_http::Server::http("127.0.0.1:0").unwrap();
        let port = match server.server_addr() {
            tiny_http::ListenAddr::IP(addr) => addr.port(),
            _ => panic!("the fake upstream must listen on an IP address"),
        };
        let seen = Arc::new(Mutex::new(Vec::new()));
        let recorded = Arc::clone(&seen);
        let reply = reply.to_string();
        std::thread::spawn(move || {
            for mut request in server.incoming_requests() {
                let mut body = String::new();
                let _ = std::io::Read::read_to_string(request.as_reader(), &mut body);
                recorded.lock().unwrap().push(serde_json::from_str(&body).unwrap_or(Value::Null));
                let payload = json!({"choices":[{"message":{"role":"assistant","content":reply}}], "usage":{"total_tokens":3}});
                let mut response = tiny_http::Response::from_string(payload.to_string()).with_status_code(200);
                response.add_header(tiny_http::Header::from_bytes(&b"Content-Type"[..], &b"application/json"[..]).unwrap());
                let _ = request.respond(response);
            }
        });
        (format!("http://127.0.0.1:{port}/v1"), seen)
    }

    /// `chat_model` persists through the sidecar RPC and is the fallback for
    /// quick explain / digest (the LAN tablet bridge calls the same dispatch),
    /// while an explicit per-request `model` still wins.
    #[test]
    fn persisted_chat_model_is_the_fallback_for_explain_and_digest() {
        let stamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|value| value.as_nanos())
            .unwrap_or(0);
        let root = std::env::temp_dir().join(format!("moonlight-main-chat-model-{}-{stamp}", std::process::id()));
        let lib = Library::new(&root).unwrap();
        let (base_url, seen) = recording_upstream("导读内容");
        lib.reload_gateway(&json!({"base_url": base_url, "model": "translation-model", "api_key": "fixture-key"}))
            .unwrap();
        lib.conn().execute("INSERT INTO papers(id,title,authors,imported_at,updated_at) VALUES('p','Paper','',0,0)", []).unwrap();
        lib.conn().execute("INSERT INTO versions(id,paper_id,kind,sha256,rel_path,pages,bytes,created_at) VALUES('v','p','source','hash','paper.pdf',1,1,0)", []).unwrap();
        lib.set_blocks("p","v",0,vec![json!({"text":"Grounded evidence sentence for the digest","bbox":[1,1,10,10]})]).unwrap();

        let saved = dispatch(&lib, "set_chat_model", &json!({"model":"chat-model"})).unwrap();
        assert_eq!(saved, json!({"ok": true, "chat_model": "chat-model"}));
        assert_eq!(lib.chat_model().as_deref(), Some("chat-model"), "the sidecar mirrors the Electron setting");

        let digest = dispatch(&lib, "ai_digest", &json!({"paper_id":"p","version_id":"v","force":true})).unwrap();
        assert_eq!(digest["model"], json!("chat-model"), "digest must use the persisted chat model: {digest}");
        assert_eq!(seen.lock().unwrap().last().unwrap()["model"], json!("chat-model"));

        let answer = dispatch(&lib, "explain", &json!({"paper_id":"p","version_id":"v","page":0,"question":"解释","kind":"ask"})).unwrap();
        assert_eq!(answer["answer"], json!("导读内容"));
        assert_eq!(seen.lock().unwrap().last().unwrap()["model"], json!("chat-model"));

        // A per-request model keeps precedence over the persisted fallback.
        dispatch(&lib, "explain", &json!({"paper_id":"p","version_id":"v","page":0,"question":"解释","kind":"ask","model":"request-model"})).unwrap();
        assert_eq!(seen.lock().unwrap().last().unwrap()["model"], json!("request-model"));

        // Clearing the override falls back to the configured gateway model.
        assert_eq!(dispatch(&lib, "set_chat_model", &json!({})).unwrap(), json!({"ok": true, "chat_model": null}));
        dispatch(&lib, "ai_digest", &json!({"paper_id":"p","version_id":"v","force":true})).unwrap();
        assert_eq!(seen.lock().unwrap().last().unwrap()["model"], json!("translation-model"));

        drop(lib);
        std::fs::remove_dir_all(root).unwrap();
    }

    /// The reader's first paint must be free: a cached digest is served through
    /// the same RPC even when the machine has no model credentials at all.
    #[test]
    fn ai_digest_serves_the_cached_digest_without_a_gateway() {
        let stamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|value| value.as_nanos())
            .unwrap_or(0);
        let root = std::env::temp_dir().join(format!("moonlight-main-digest-{}-{stamp}", std::process::id()));
        let lib = Library::new(&root).unwrap();
        lib.conn().execute("INSERT INTO papers(id,title,authors,imported_at,updated_at) VALUES('p','Paper','',0,0)", []).unwrap();
        assert!(lib.gateway().is_none(), "a test library starts without model credentials");
        let digest = json!({
            "markdown": "## ① 研究痛点\n缓存导读无需模型。",
            "generated_at": 123i64,
            "model": "test-model",
            "version_id": "v",
        });
        lib.save_digest("p", &digest).unwrap();
        let served = dispatch(&lib, "ai_digest", &json!({"paper_id":"p"})).unwrap();
        assert_eq!(served, digest, "ai_digest must return the cached object verbatim");
        assert!(lib.gateway().is_none(), "serving the cache must not start a gateway");
        if std::env::var("MOONLIGHT_UPSTREAM_KEY").map_or(true, |value| value.trim().is_empty()) {
            let error = dispatch(&lib, "ai_digest", &json!({"paper_id":"p","force":true}))
                .err()
                .expect("a forced regeneration without credentials must fail")
                .to_string();
            assert!(error.contains("模型凭据"), "forced digest needs an actionable error: {error}");
        }
        // Digest generation is network-bound: keep it off the single writer.
        assert!(matches!(executor_for("ai_digest"), Some(Executor::Network)));
        drop(lib);
        std::fs::remove_dir_all(root).unwrap();
    }

    /// The LAN policy is an allowlist: a new RPC is private until it is added,
    /// and every host-path/process/credential/backup method stays host-only.
    #[test]
    fn lan_whitelist_allows_only_tablet_safe_methods() {
        let allowed = [
            "app_info", "list_papers_page", "list_papers", "get_paper", "list_annotations",
            "add_annotation", "update_annotation", "delete_annotation", "list_taxonomy",
            "set_reading_position", "paper_pdf", "blocks", "set_blocks", "document_text_status",
            "search_blocks", "list_jobs", "get_job", "start_translate", "cancel_job", "ai_prepare",
            "ai_preview", "ai_digest", "ai_history", "ai_save", "ai_delete", "ai_clear",
            "ai_cancel", "explain", "translate_text", "update_paper", "save_paper", "append_note",
            "set_short_note", "export", "zotero_files", "trash_paper", "restore_paper",
            "bulk_assign", "bulk_unassign", "bulk_set_status", "bulk_trash", "bulk_restore",
        ];
        for method in allowed {
            assert!(allowed_lan_method(method), "{method} must be reachable from the tablet");
        }
        let host_only = [
            "import_pdfs", "backup_create", "backup_restore", "zotero_import", "zotero_api_import",
            "zotero_probe", "zotero_attachment_path", "version_path", "reload_gateway",
            "translation_probe", "check_babeldoc", "sync_configure", "sync_start", "sync_status",
            "sync_cancel", "sync_conflicts", "sync_resolve", "shutdown", "purge_paper",
            "empty_trash", "bulk_purge", "set_categories", "set_tags", "set_chat_model",
            "refresh_metadata", "refresh_citations", "ping", "",
        ];
        for method in host_only {
            assert!(!allowed_lan_method(method), "{method} must stay host-only over LAN");
        }
        assert!(!allowed_lan_method("some_future_rpc"), "unknown methods are denied by default");
    }

    #[test]
    fn serve_token_validation_accepts_32_hex_and_rejects_everything_else() {
        assert_eq!(
            parse_serve_token(" 0123456789ABCDEF0123456789ABCDEF "),
            Some("0123456789abcdef0123456789abcdef".to_string())
        );
        assert_eq!(parse_serve_token("0123456789abcdef0123456789abcde"), None);
        assert_eq!(parse_serve_token("zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz"), None);
        assert_eq!(parse_serve_token(""), None);
    }

    /// The HTTP handler gate must reject a dangerous method with the marker the
    /// server turns into 403, while a whitelisted method still dispatches.
    #[test]
    fn lan_handler_never_dispatches_dangerous_methods() {
        let stamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|value| value.as_nanos())
            .unwrap_or(0);
        let root = std::env::temp_dir().join(format!("moonlight-main-lan-{}-{stamp}", std::process::id()));
        let lib = Library::new(&root).unwrap();
        let read_pool = Arc::new(search::ReadPool::new(lib.root().join("library.db"), 1));
        let handler = lan_handler(Arc::clone(&lib), read_pool);

        for method in ["shutdown", "import_pdfs", "version_path", "reload_gateway", "sync_start"] {
            let error = handler(method, &json!({}))
                .expect_err("a host-only method must be rejected over LAN");
            assert!(
                error.downcast_ref::<server::LanForbidden>().is_some(),
                "{method} must carry the LanForbidden marker, got: {error}"
            );
            assert_eq!(error.to_string(), "forbidden over LAN");
        }
        // `shutdown` above must not have taken the library down: a whitelisted
        // method still dispatches through the same handler.
        let info = handler("app_info", &json!({})).unwrap();
        assert_eq!(info["headless"], true);

        drop(lib);
        std::fs::remove_dir_all(root).unwrap();
    }

    /// Batch E wiring: the three RPCs keep the renderer's exact names/shapes,
    /// the write methods run on the single local writer, and citation export
    /// reaches the new GB/T 7714 formatter.
    #[test]
    fn batch_e_rpcs_dispatch_with_the_expected_contract() {
        let stamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|value| value.as_nanos())
            .unwrap_or(0);
        let root = std::env::temp_dir().join(format!("moonlight-main-batch-e-{}-{stamp}", std::process::id()));
        let lib = Library::new(&root).unwrap();

        for method in ["merge_papers", "import_bibliography", "save_glossary"] {
            assert_eq!(executor_for(method), Some(Executor::LocalWrite), "{method} must stay off the RPC thread");
        }

        assert_eq!(
            dispatch(&lib, "save_glossary", &json!({"terms":[{"source":"Attention","target":"注意力"}]})).unwrap(),
            json!({"ok": true, "count": 1})
        );
        assert_eq!(
            dispatch(&lib, "list_glossary", &json!({})).unwrap(),
            json!({"terms":[{"source":"Attention","target":"注意力","domain":"","enabled":true}]})
        );

        let imported = dispatch(&lib, "import_bibliography", &json!({
            "format":"bibtex",
            "text":"@article{x, title={Unique Imported Paper Title}, author={Ada Lovelace}, year={2024}}"
        })).unwrap();
        assert_eq!(imported["imported"], json!(1), "{imported}");
        assert_eq!(imported["duplicates"], json!(0));
        assert_eq!(imported["failed"], json!(0));
        assert_eq!(imported["errors"], json!([]));

        lib.conn().execute("INSERT INTO papers(id,title,authors,imported_at,updated_at) VALUES('a','Batch E Primary','',0,0)", []).unwrap();
        lib.conn().execute("INSERT INTO papers(id,title,authors,imported_at,updated_at) VALUES('b','Batch E Secondary','',0,0)", []).unwrap();
        let merged = dispatch(&lib, "merge_papers", &json!({"primary_id":"a","secondary_ids":["b"]})).unwrap();
        assert_eq!(merged["merged"], json!(1));
        assert_eq!(merged["primary"]["id"], json!("a"));
        assert!(lib.get_paper("b").is_err());

        let export = dispatch(&lib, "export", &json!({"paper_ids":["a"],"format":"gbt7714"})).unwrap();
        assert_eq!(export["text"], json!("[1] Batch E Primary[J/OL]."));

        drop(lib);
        std::fs::remove_dir_all(root).unwrap();
    }
}
