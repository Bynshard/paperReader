//! LAN HTTP + SSE server: `moonlight-core --serve 0.0.0.0:8765`.
//!
//! The desktop process stays the single owner of the library.  A tablet browser
//! (vivo Pad 5 Pro / PWA) talks to the very same handler as the JSONL sidecar:
//!
//! * `POST /api/rpc`            — bearer-token JSON-RPC bridge; 200 + JSON for
//!   handler results, 401 without a valid token, 403 when the LAN method policy
//!   rejects a host-only/dangerous method (the request never reaches dispatch)
//! * `GET  /api/events?token=`  — `text/event-stream` fan-out of library events
//! * `GET  /api/pdf/<version>`  — range-capable PDF streaming (200/206/416)
//! * `GET  /`                   — embedded web UI, safe static hosting + SPA fallback
//! * `GET  /healthz`            — liveness probe
//!
//! Design constraints: same origin only (no CORS), one thread per connection with
//! a hard cap, credentials never logged, and `shutdown()` makes both the accept
//! loop and every SSE stream exit.

use crate::library::Library;
use anyhow::anyhow;
use serde_json::{json, Value};
use std::fs::File;
use std::io::{self, Read, Seek, SeekFrom, Write};
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::mpsc::{self, Sender};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tiny_http::{Header, Method, Request, Response, Server, StatusCode};

/// Turns one `dispatch`-level call into its result.  The closure is shared by
/// every connection (and by the JSONL transport if the caller reuses it).
pub type Handler = std::sync::Arc<dyn Fn(&str, &serde_json::Value) -> anyhow::Result<serde_json::Value> + Send + Sync>;

/// Marker error returned by a [`Handler`] when the LAN method policy refuses a
/// call (host-only/path/process/credential RPCs).  `handle_rpc` maps it to
/// HTTP 403 `{"ok":false,"error":"forbidden over LAN"}`, so a dangerous method
/// never reaches `dispatch`, while ordinary handler failures stay 200/ok:false.
#[derive(Debug)]
pub struct LanForbidden;

impl std::fmt::Display for LanForbidden {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("forbidden over LAN")
    }
}

impl std::error::Error for LanForbidden {}

/// Upper bound on the request body accepted by `/api/rpc`.
const MAX_RPC_BODY: usize = 8 * 1024 * 1024;

/// Concurrent request budget.  Each accepted request owns one thread; beyond
/// this the server answers 503 instead of letting a tablet starve the desktop.
/// Raised to 128 so a dual-pane PDF (64 KiB Range requests) plus the SSE stream
/// can coexist with a burst of lightweight RPCs without a spurious 503.
const MAX_CONNECTIONS: usize = 128;

/// A pairing token is exactly 32 ASCII hex characters (16 random bytes).
pub fn valid_token(candidate: &str) -> bool {
    candidate.len() == 32 && candidate.bytes().all(|byte| byte.is_ascii_hexdigit())
}

/// Streaming granularity for PDF bodies.
const PDF_CHUNK: usize = 64 * 1024;

/// SSE keep-alive interval.
const SSE_PING: Duration = Duration::from_secs(25);

/// Poll granularity of the accept loop, selected so `shutdown()` can join it
/// quickly even when `unblock()` only wakes one waiter.
const ACCEPT_POLL: Duration = Duration::from_millis(200);

// ---------------------------------------------------------------------------
// Event hub
// ---------------------------------------------------------------------------

/// Fan-out broker shared by `Library::emit` and the SSE endpoint.
///
/// Publishing never blocks: each subscriber has its own unbounded channel and
/// dead receivers are dropped on the next publish.
#[derive(Clone, Default)]
pub struct EventHub {
    subscribers: Arc<Mutex<Vec<Sender<Value>>>>,
}

impl EventHub {
    /// Broadcast one event to every current subscriber.
    pub fn publish(&self, value: serde_json::Value) {
        let mut subscribers = lock_unpoisoned(&self.subscribers);
        subscribers.retain(|sender| sender.send(value.clone()).is_ok());
    }

    /// Register a subscriber.  Dropping the receiver unsubscribes it.
    pub fn subscribe(&self) -> std::sync::mpsc::Receiver<serde_json::Value> {
        let (sender, receiver) = mpsc::channel();
        lock_unpoisoned(&self.subscribers).push(sender);
        receiver
    }
}

fn lock_unpoisoned<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    match mutex.lock() {
        Ok(guard) => guard,
        Err(poisoned) => poisoned.into_inner(),
    }
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/// Non-blocking server handle.  Dropping it shuts the server down.
pub struct ServeHandle {
    /// Actual bound address (`127.0.0.1:54321` when `:0` was requested).
    pub addr: String,
    /// 32 hex characters; the pairing secret for the tablet.
    pub token: String,
    stop: Arc<AtomicBool>,
    server: Arc<Server>,
    accept: Mutex<Option<std::thread::JoinHandle<()>>>,
}

impl ServeHandle {
    /// Stop accepting connections and terminate every live SSE stream.
    pub fn shutdown(&self) {
        self.stop.store(true, Ordering::SeqCst);
        // Wake the accept loop if it happens to be parked in recv().
        self.server.unblock();
        let accept = lock_unpoisoned(&self.accept).take();
        if let Some(handle) = accept {
            if handle.thread().id() != std::thread::current().id() {
                let _ = handle.join();
            }
        }
    }
}

impl Drop for ServeHandle {
    fn drop(&mut self) {
        self.shutdown();
    }
}

/// Start the HTTP server on a background thread and return immediately.
///
/// `bind` accepts anything `tiny_http` understands (`127.0.0.1:0`,
/// `0.0.0.0:8765`, `[::1]:0`, …).  `token` is an optional persisted pairing
/// secret supplied by the desktop (`--serve-token`); a missing or malformed
/// value falls back to a freshly generated one so the tablet still pairs.  The
/// token is returned in the handle (never logged) so the caller can show it as
/// a pairing code.
pub fn serve(
    lib: std::sync::Arc<crate::library::Library>,
    bind: &str,
    handler: Handler,
    hub: EventHub,
    static_dir: Option<std::path::PathBuf>,
    token: Option<String>,
) -> anyhow::Result<ServeHandle> {
    let server = Server::http(bind).map_err(|error| anyhow!("无法在 {bind} 启动 HTTP 服务：{error}"))?;
    let addr = server
        .server_addr()
        .to_ip()
        .map(|bound| bound.to_string())
        .unwrap_or_else(|| bind.to_string());
    let token = match token {
        Some(candidate) if valid_token(&candidate) => candidate.to_ascii_lowercase(),
        Some(_) => {
            // Never echo the rejected value: it is a credential.
            eprintln!("[server] --serve-token 不是 32 位十六进制，已改为随机生成配对令牌");
            uuid::Uuid::new_v4().simple().to_string()
        }
        None => uuid::Uuid::new_v4().simple().to_string(),
    };
    let static_root = static_dir.and_then(|dir| match dir.canonicalize() {
        Ok(root) => Some(root),
        Err(error) => {
            eprintln!("[server] 静态目录不可用 {}：{error}", dir.display());
            None
        }
    });
    let context = Arc::new(Context { token: token.clone(), handler, hub, lib, static_root });
    let stop = Arc::new(AtomicBool::new(false));
    let server = Arc::new(server);
    let active = Arc::new(AtomicUsize::new(0));
    let accept = {
        let server = server.clone();
        let context = context.clone();
        let stop = stop.clone();
        std::thread::Builder::new()
            .name("moonlight-http".into())
            .spawn(move || accept_loop(server, context, stop, active))
            .map_err(|error| anyhow!("无法启动 HTTP 线程：{error}"))?
    };
    // Never print the token: it is a credential, not a log line.
    eprintln!("[server] listening on http://{addr}");
    Ok(ServeHandle { addr, token, stop, server, accept: Mutex::new(Some(accept)) })
}

/// Everything a connection thread needs, shared behind one `Arc`.
struct Context {
    token: String,
    handler: Handler,
    hub: EventHub,
    lib: Arc<Library>,
    static_root: Option<PathBuf>,
}

fn accept_loop(server: Arc<Server>, context: Arc<Context>, stop: Arc<AtomicBool>, active: Arc<AtomicUsize>) {
    while !stop.load(Ordering::SeqCst) {
        let request = match server.recv_timeout(ACCEPT_POLL) {
            Ok(Some(request)) => request,
            // Timeout: re-check the stop flag.
            Ok(None) => continue,
            // `unblock()` and transient accept errors both land here.
            Err(_) => continue,
        };
        if active.fetch_add(1, Ordering::SeqCst) >= MAX_CONNECTIONS {
            active.fetch_sub(1, Ordering::SeqCst);
            eprintln!("[server] connection limit reached, replying 503");
            let _ = request.respond(
                Response::from_data(br#"{"ok":false,"error":"server busy"}"#.to_vec())
                    .with_status_code(StatusCode(503))
                    .with_chunked_threshold(usize::MAX)
                    .with_header(header("Content-Type", "application/json; charset=utf-8"))
                    .with_header(header("Retry-After", "1")),
            );
            continue;
        }
        let connection_context = context.clone();
        let connection_stop = stop.clone();
        // The guard is moved into the closure; if spawning fails the closure is
        // dropped and the counter is released with it.
        let guard = ActiveGuard(active.clone());
        let spawned = std::thread::Builder::new()
            .name("moonlight-http-conn".into())
            .spawn(move || {
                let _guard = guard;
                // A panic in the bridge or in a handler must never take the
                // whole process (or the accept loop) down.
                let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                    handle_request(&connection_context, request, &connection_stop);
                }));
            });
        if let Err(error) = spawned {
            eprintln!("[server] 无法创建连接线程：{error}");
        }
    }
}

/// Decrements the in-flight counter however the connection thread ends.
struct ActiveGuard(Arc<AtomicUsize>);

impl Drop for ActiveGuard {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::SeqCst);
    }
}

// ---------------------------------------------------------------------------
// Routing
// ---------------------------------------------------------------------------

fn handle_request(context: &Context, request: Request, stop: &Arc<AtomicBool>) {
    let method = request.method().clone();
    let target = request.url().to_string();
    let (path, query) = split_target(&target);
    // `path` never contains the query string, so a `?token=` never reaches stderr.
    eprintln!("[server] {method} {path}");

    let token_ok = authorized(&request, query, &context.token);

    match path {
        "/healthz" => respond_json(request, 200, &json!({"ok": true})),
        "/api/rpc" => {
            if method != Method::Post {
                respond_json(request, 405, &json!({"ok": false, "error": "method not allowed"}));
            } else {
                handle_rpc(context, request, token_ok);
            }
        }
        "/api/events" => {
            if method != Method::Get {
                respond_json(request, 405, &json!({"ok": false, "error": "method not allowed"}));
            } else if !token_ok {
                respond_json(request, 401, &json!({"ok": false, "error": "unauthorized"}));
            } else {
                handle_events(context, request, stop);
            }
        }
        _ if path.starts_with("/api/pdf/") => {
            if method != Method::Get && method != Method::Head {
                respond_json(request, 405, &json!({"ok": false, "error": "method not allowed"}));
            } else if !token_ok {
                // PDFs are the papers themselves: never stream them to an
                // unpaired client. `?token=` exists because <embed>/pdf.js on
                // a plain URL cannot attach an Authorization header.
                respond_json(request, 401, &json!({"ok": false, "error": "unauthorized"}));
            } else {
                handle_pdf(context, request, path);
            }
        }
        _ if path.starts_with("/api/") => {
            respond_json(request, 404, &json!({"ok": false, "error": "not found"}))
        }
        _ => {
            if method != Method::Get && method != Method::Head {
                respond_json(request, 405, &json!({"ok": false, "error": "method not allowed"}));
            } else {
                handle_static(context, request, path);
            }
        }
    }
}

fn split_target(target: &str) -> (&str, &str) {
    match target.split_once('?') {
        Some((path, query)) => (path, query),
        None => (target, ""),
    }
}

// ---------------------------------------------------------------------------
// Authentication
// ---------------------------------------------------------------------------

/// `Authorization: Bearer <token>` or `?token=<token>`.
fn authorized(request: &Request, query: &str, token: &str) -> bool {
    if let Some(value) = header_value(request, "Authorization") {
        if let Some(candidate) = value.strip_prefix("Bearer ").or_else(|| value.strip_prefix("bearer ")) {
            if constant_time_eq(candidate.trim(), token) {
                return true;
            }
        }
    }
    match query_param(query, "token") {
        Some(candidate) => constant_time_eq(&candidate, token),
        None => false,
    }
}

/// Whether the caller attempted to authenticate at all.
fn token_present(request: &Request, query: &str) -> bool {
    header_value(request, "Authorization").is_some() || query_param(query, "token").is_some()
}

fn constant_time_eq(left: &str, right: &str) -> bool {
    let left = left.as_bytes();
    let right = right.as_bytes();
    if left.len() != right.len() {
        return false;
    }
    let mut difference = 0u8;
    for (a, b) in left.iter().zip(right.iter()) {
        difference |= a ^ b;
    }
    difference == 0
}

fn header_value(request: &Request, name: &'static str) -> Option<String> {
    request
        .headers()
        .iter()
        .find(|header| header.field.equiv(name))
        .map(|header| header.value.as_str().to_string())
}

fn query_param(query: &str, key: &str) -> Option<String> {
    query.split('&').find_map(|pair| {
        let (name, value) = pair.split_once('=').unwrap_or((pair, ""));
        if name == key {
            Some(percent_decode(value, true))
        } else {
            None
        }
    })
}

fn percent_decode(input: &str, plus_as_space: bool) -> String {
    let bytes = input.as_bytes();
    let mut decoded = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        match bytes[index] {
            b'%' if index + 2 < bytes.len() => match (hex_value(bytes[index + 1]), hex_value(bytes[index + 2])) {
                (Some(high), Some(low)) => {
                    decoded.push(high * 16 + low);
                    index += 3;
                }
                _ => {
                    decoded.push(b'%');
                    index += 1;
                }
            },
            b'+' if plus_as_space => {
                decoded.push(b' ');
                index += 1;
            }
            byte => {
                decoded.push(byte);
                index += 1;
            }
        }
    }
    String::from_utf8_lossy(&decoded).into_owned()
}

fn hex_value(byte: u8) -> Option<u8> {
    match byte {
        b'0'..=b'9' => Some(byte - b'0'),
        b'a'..=b'f' => Some(byte - b'a' + 10),
        b'A'..=b'F' => Some(byte - b'A' + 10),
        _ => None,
    }
}

// ---------------------------------------------------------------------------
// JSON-RPC bridge
// ---------------------------------------------------------------------------

fn handle_rpc(context: &Context, mut request: Request, token_ok: bool) {
    if !token_ok {
        respond_json(request, 401, &json!({"ok": false, "error": "unauthorized"}));
        return;
    }
    let mut body = Vec::new();
    let read = {
        let mut limited = request.as_reader().take(MAX_RPC_BODY as u64 + 1);
        limited.read_to_end(&mut body)
    };
    if let Err(error) = read {
        respond_json(request, 200, &json!({"ok": false, "error": format!("read request failed: {error}")}));
        return;
    }
    if body.len() > MAX_RPC_BODY {
        respond_json(request, 200, &json!({"ok": false, "error": "request body too large"}));
        return;
    }
    let payload: Value = match serde_json::from_slice(&body) {
        Ok(payload) => payload,
        Err(error) => {
            respond_json(request, 200, &json!({"ok": false, "error": format!("invalid json: {error}")}));
            return;
        }
    };
    let method = match payload.get("method").and_then(Value::as_str) {
        Some(method) => method.to_string(),
        None => {
            respond_json(request, 200, &json!({"ok": false, "error": "missing method"}));
            return;
        }
    };
    let params = payload.get("params").cloned().unwrap_or(Value::Null);
    let handler = context.handler.clone();
    let outcome = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| handler(&method, &params)));
    // A LAN policy rejection is not a handler failure: surface it as an explicit
    // 403 so the tablet can show "forbidden over LAN" instead of a generic
    // 200/ok:false error string. Everything else (including business errors)
    // keeps the historical 200 + ok:false contract.
    if let Ok(Err(error)) = &outcome {
        if error.downcast_ref::<LanForbidden>().is_some() {
            respond_json(request, 403, &json!({"ok": false, "error": error.to_string()}));
            return;
        }
    }
    let response = match outcome {
        Ok(Ok(result)) => json!({"ok": true, "result": result}),
        Ok(Err(error)) => json!({"ok": false, "error": error.to_string()}),
        Err(_) => json!({"ok": false, "error": "handler panicked"}),
    };
    respond_json(request, 200, &response);
}

// ---------------------------------------------------------------------------
// SSE
// ---------------------------------------------------------------------------

fn handle_events(context: &Context, request: Request, stop: &Arc<AtomicBool>) {
    let receiver = context.hub.subscribe();
    // `Request::respond()` would choose chunked encoding for us, but tiny_http
    // buffers writes behind a 1 KiB `BufWriter` and only flushes when the
    // response ends.  For SSE that means a tablet would not see a single delta
    // until ~1 KiB had accumulated, so this endpoint writes the chunked HTTP
    // framing itself and flushes after every event.
    let mut writer = request.into_writer();
    let head = "HTTP/1.1 200 OK\r\n\
                Content-Type: text/event-stream; charset=utf-8\r\n\
                Cache-Control: no-cache, no-transform\r\n\
                X-Accel-Buffering: no\r\n\
                Transfer-Encoding: chunked\r\n\
                \r\n";
    if writer.write_all(head.as_bytes()).and_then(|_| writer.flush()).is_err() {
        return;
    }
    let mut last_write = Instant::now();
    loop {
        if stop.load(Ordering::SeqCst) {
            break;
        }
        let frame = match receiver.recv_timeout(ACCEPT_POLL) {
            Ok(event) => {
                last_write = Instant::now();
                format!("data: {event}\n\n")
            }
            Err(mpsc::RecvTimeoutError::Disconnected) => break,
            Err(mpsc::RecvTimeoutError::Timeout) => {
                if last_write.elapsed() < SSE_PING {
                    continue;
                }
                last_write = Instant::now();
                ": ping\n\n".to_string()
            }
        };
        // A failed write means the tablet closed the tab: end this connection.
        if write_sse_frame(writer.as_mut(), &frame).is_err() {
            break;
        }
    }
    let _ = writer.write_all(b"0\r\n\r\n");
    let _ = writer.flush();
}

fn write_sse_frame(writer: &mut dyn Write, frame: &str) -> io::Result<()> {
    write!(writer, "{:x}\r\n{frame}\r\n", frame.len())?;
    writer.flush()
}

// ---------------------------------------------------------------------------
// PDF streaming
// ---------------------------------------------------------------------------

fn handle_pdf(context: &Context, request: Request, path: &str) {
    let encoded = &path["/api/pdf/".len()..];
    let version_id = percent_decode(encoded, false);
    if version_id.is_empty() || version_id.contains('/') || version_id.contains('\\') {
        respond_text(request, 404, "not found");
        return;
    }
    let library_root = match context.lib.root().canonicalize() {
        Ok(root) => root,
        Err(_) => {
            respond_text(request, 404, "not found");
            return;
        }
    };
    let resolved = match context.lib.version_path(&version_id) {
        Ok(path) => path,
        Err(_) => {
            respond_text(request, 404, "not found");
            return;
        }
    };
    let file_path = match resolved.canonicalize() {
        Ok(path) => path,
        Err(_) => {
            respond_text(request, 404, "not found");
            return;
        }
    };
    // `version_path` is allowed to return absolute legacy paths; the file must
    // still live inside this library, otherwise a version row would become an
    // arbitrary-file-read primitive.
    if !file_path.starts_with(&library_root) || !file_path.is_file() {
        respond_text(request, 403, "forbidden");
        return;
    }
    let mut file = match File::open(&file_path) {
        Ok(file) => file,
        Err(_) => {
            respond_text(request, 404, "not found");
            return;
        }
    };
    let length = match file.metadata() {
        Ok(metadata) => metadata.len() as usize,
        Err(_) => {
            respond_text(request, 404, "not found");
            return;
        }
    };
    let range = header_value(&request, "Range")
        .map(|value| parse_range(&value, length))
        .unwrap_or(RangeRequest::Full);
    match range {
        RangeRequest::Full => {
            let _ = file.seek(SeekFrom::Start(0));
            let response = Response::new(
                StatusCode(200),
                pdf_headers(None),
                ChunkedFile::new(file),
                Some(length),
                None,
            )
            // Force `Content-Length`; chunked 206 responses confuse PDF.js.
            .with_chunked_threshold(usize::MAX);
            let _ = request.respond(response);
        }
        RangeRequest::Partial(start, end) => {
            let partial_length = end - start + 1;
            let _ = file.seek(SeekFrom::Start(start as u64));
            let content_range = format!("bytes {start}-{end}/{length}");
            let response = Response::new(
                StatusCode(206),
                pdf_headers(Some(&content_range)),
                ChunkedFile::new(file.take(partial_length as u64)),
                Some(partial_length),
                None,
            )
            .with_chunked_threshold(usize::MAX);
            let _ = request.respond(response);
        }
        RangeRequest::Unsatisfiable => {
            let content_range = format!("bytes */{length}");
            let response = Response::from_data(b"range not satisfiable".to_vec())
                .with_status_code(StatusCode(416))
                .with_chunked_threshold(usize::MAX)
                .with_header(header("Content-Type", "text/plain; charset=utf-8"))
                .with_header(header("Accept-Ranges", "bytes"))
                .with_header(header("Content-Range", &content_range));
            let _ = request.respond(response);
        }
    }
}

fn pdf_headers(content_range: Option<&str>) -> Vec<Header> {
    let mut headers = vec![
        header("Content-Type", "application/pdf"),
        header("Accept-Ranges", "bytes"),
        header("Content-Disposition", "inline"),
        header("Cache-Control", "no-store"),
    ];
    if let Some(value) = content_range {
        headers.push(header("Content-Range", value));
    }
    headers
}

enum RangeRequest {
    Full,
    Partial(usize, usize),
    Unsatisfiable,
}

/// RFC 7233 single-range parser.  Malformed headers fall back to the full
/// entity; syntactically valid but unreachable ranges become 416.
fn parse_range(value: &str, length: usize) -> RangeRequest {
    let spec = match value.trim().strip_prefix("bytes=") {
        Some(rest) => rest.split(',').next().unwrap_or("").trim(),
        None => return RangeRequest::Full,
    };
    if spec.is_empty() || length == 0 {
        return RangeRequest::Unsatisfiable;
    }
    let (start_raw, end_raw) = match spec.split_once('-') {
        Some(parts) => (parts.0.trim(), parts.1.trim()),
        None => return RangeRequest::Full,
    };
    let (start, end);
    if start_raw.is_empty() {
        // Suffix form: `bytes=-500` = last 500 bytes.
        match end_raw.parse::<usize>() {
            Ok(0) | Err(_) => return RangeRequest::Unsatisfiable,
            Ok(suffix) => {
                let suffix = suffix.min(length);
                start = length - suffix;
                end = length - 1;
            }
        }
    } else {
        match start_raw.parse::<usize>() {
            Ok(value) if value < length => start = value,
            Ok(_) => return RangeRequest::Unsatisfiable,
            Err(_) => return RangeRequest::Full,
        }
        if end_raw.is_empty() {
            end = length - 1;
        } else {
            match end_raw.parse::<usize>() {
                Ok(value) if value >= start => end = value.min(length - 1),
                Ok(_) => return RangeRequest::Unsatisfiable,
                Err(_) => return RangeRequest::Full,
            }
        }
    }
    RangeRequest::Partial(start, end)
}

/// Caps every `Read` call at 64 KiB so a large PDF is never slurped into RAM.
struct ChunkedFile<R> {
    inner: R,
}

impl<R: Read> ChunkedFile<R> {
    fn new(inner: R) -> Self {
        Self { inner }
    }
}

impl<R: Read> Read for ChunkedFile<R> {
    fn read(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
        if buffer.len() <= PDF_CHUNK {
            self.inner.read(buffer)
        } else {
            self.inner.read(&mut buffer[..PDF_CHUNK])
        }
    }
}

// ---------------------------------------------------------------------------
// Static assets
// ---------------------------------------------------------------------------

fn handle_static(context: &Context, request: Request, path: &str) {
    let root = match context.static_root.as_ref() {
        Some(root) => root,
        None => {
            respond_json(request, 404, &json!({"ok": false, "error": "static assets not configured"}));
            return;
        }
    };
    let relative = match safe_relative(path) {
        Ok(relative) => relative,
        Err(()) => {
            // Directory traversal never reaches the filesystem.
            respond_text(request, 404, "not found");
            return;
        }
    };
    let candidate = if relative.as_os_str().is_empty() {
        root.join("index.html")
    } else {
        root.join(&relative)
    };
    let mut file_path = None;
    match candidate.canonicalize() {
        Ok(canonical) => {
            if !canonical.starts_with(root) {
                // A symlink pointing outside the bundle.
                respond_text(request, 404, "not found");
                return;
            }
            if canonical.is_file() {
                file_path = Some(canonical);
            }
        }
        // Unknown route: fall through to the SPA entry point below.
        Err(_) => {}
    }
    let file_path = file_path.unwrap_or_else(|| root.join("index.html"));
    let canonical = match file_path.canonicalize() {
        Ok(canonical) if canonical.starts_with(root) && canonical.is_file() => canonical,
        _ => {
            respond_text(request, 404, "not found");
            return;
        }
    };
    let file = match File::open(&canonical) {
        Ok(file) => file,
        Err(_) => {
            respond_text(request, 404, "not found");
            return;
        }
    };
    let length = match file.metadata() {
        Ok(metadata) => metadata.len() as usize,
        Err(_) => {
            respond_text(request, 404, "not found");
            return;
        }
    };
    let mime = mime_for(&canonical);
    let cache = if mime.starts_with("text/html") { "no-cache" } else { "public, max-age=3600" };
    let response = Response::new(
        StatusCode(200),
        vec![
            header("Content-Type", mime),
            header("Cache-Control", cache),
        ],
        file,
        Some(length),
        None,
    )
    .with_chunked_threshold(usize::MAX);
    let _ = request.respond(response);
}

/// Percent-decodes a request path and accepts only plain path segments.
fn safe_relative(path: &str) -> Result<PathBuf, ()> {
    let decoded = percent_decode(path, false);
    if decoded.contains('\0') || decoded.contains('\\') {
        return Err(());
    }
    let mut relative = PathBuf::new();
    for component in Path::new(&decoded).components() {
        match component {
            Component::Normal(part) => relative.push(part),
            Component::RootDir | Component::CurDir => {}
            Component::ParentDir | Component::Prefix(_) => return Err(()),
        }
    }
    Ok(relative)
}

fn mime_for(path: &Path) -> &'static str {
    match path.extension().and_then(|extension| extension.to_str()).map(|extension| extension.to_ascii_lowercase()).as_deref() {
        Some("html") | Some("htm") => "text/html; charset=utf-8",
        Some("js") | Some("mjs") => "text/javascript; charset=utf-8",
        Some("css") => "text/css; charset=utf-8",
        Some("json") | Some("map") => "application/json; charset=utf-8",
        Some("webmanifest") => "application/manifest+json; charset=utf-8",
        Some("wasm") => "application/wasm",
        Some("png") => "image/png",
        Some("jpg") | Some("jpeg") => "image/jpeg",
        Some("svg") => "image/svg+xml",
        Some("gif") => "image/gif",
        Some("webp") => "image/webp",
        Some("ico") => "image/x-icon",
        Some("woff") => "font/woff",
        Some("woff2") => "font/woff2",
        Some("ttf") => "font/ttf",
        Some("otf") => "font/otf",
        Some("txt") => "text/plain; charset=utf-8",
        _ => "application/octet-stream",
    }
}

// ---------------------------------------------------------------------------
// Response helpers
// ---------------------------------------------------------------------------

fn header(name: &'static str, value: &str) -> Header {
    Header::from_bytes(name.as_bytes(), value.as_bytes()).expect("static header names/values are ASCII")
}

fn respond_json(request: Request, status: u16, value: &Value) {
    let body = serde_json::to_vec(value).unwrap_or_else(|_| br#"{"ok":false,"error":"serialize failed"}"#.to_vec());
    let response = Response::from_data(body)
        .with_status_code(StatusCode(status))
        .with_chunked_threshold(usize::MAX)
        .with_header(header("Content-Type", "application/json; charset=utf-8"))
        .with_header(header("Cache-Control", "no-store"));
    let _ = request.respond(response);
}

fn respond_text(request: Request, status: u16, text: &str) {
    let response = Response::from_data(text.as_bytes().to_vec())
        .with_status_code(StatusCode(status))
        .with_chunked_threshold(usize::MAX)
        .with_header(header("Content-Type", "text/plain; charset=utf-8"))
        .with_header(header("Cache-Control", "no-store"));
    let _ = request.respond(response);
}

// ---------------------------------------------------------------------------
// Tests
//
// They live here so the module carries its own contract.  The lead must add
// `mod server;` to main.rs (and pass the real dispatch closure) for these to be
// compiled by `cargo test`.
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::{serve, valid_token, EventHub, Handler, LanForbidden};
    use crate::library::Library;
    use serde_json::{json, Value};
    use std::fs;
    use std::io::{Read, Write};
    use std::net::TcpStream;
    use std::path::{Path, PathBuf};
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;
    use std::time::{Duration, Instant};

    fn temp_root(tag: &str) -> PathBuf {
        let root = std::env::temp_dir().join(format!("moonlight-server-{tag}-{}", uuid::Uuid::new_v4()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).expect("create temp root");
        root
    }

    fn test_library(tag: &str) -> (Arc<Library>, PathBuf) {
        let root = temp_root(tag);
        let library = Library::new(&root).expect("create library");
        (library, root)
    }

    fn cleanup(root: &Path) {
        for _ in 0..20 {
            if fs::remove_dir_all(root).is_ok() {
                return;
            }
            std::thread::sleep(Duration::from_millis(50));
        }
    }

    fn find_bytes(haystack: &[u8], needle: &[u8]) -> Option<usize> {
        haystack.windows(needle.len()).position(|window| window == needle)
    }

    fn header<'a>(headers: &'a [(String, String)], name: &str) -> &'a str {
        headers
            .iter()
            .find(|(key, _)| key == name)
            .map(|(_, value)| value.as_str())
            .unwrap_or("")
    }

    fn read_response(stream: &mut TcpStream) -> (u16, Vec<(String, String)>, Vec<u8>) {
        stream.set_read_timeout(Some(Duration::from_secs(10))).unwrap();
        let mut buffer = Vec::new();
        let mut chunk = [0u8; 8192];
        let header_end = loop {
            if let Some(position) = find_bytes(&buffer, b"\r\n\r\n") {
                break position + 4;
            }
            let read = stream.read(&mut chunk).expect("read response headers");
            assert!(read > 0, "connection closed before response headers");
            buffer.extend_from_slice(&chunk[..read]);
        };
        let head = String::from_utf8_lossy(&buffer[..header_end]).to_string();
        let mut lines = head.split("\r\n");
        let status: u16 = lines
            .next()
            .expect("status line")
            .split_whitespace()
            .nth(1)
            .expect("status code")
            .parse()
            .expect("numeric status");
        let mut headers = Vec::new();
        for line in lines {
            if let Some((name, value)) = line.split_once(": ") {
                headers.push((name.to_ascii_lowercase(), value.to_string()));
            }
        }
        let transfer = header(&headers, "transfer-encoding").to_ascii_lowercase();
        let body = if transfer.contains("chunked") {
            let mut body = Vec::new();
            let mut position = header_end;
            loop {
                let line_end = loop {
                    if let Some(offset) = find_bytes(&buffer[position..], b"\r\n") {
                        break position + offset;
                    }
                    let read = stream.read(&mut chunk).expect("read chunk size");
                    assert!(read > 0, "connection closed in chunk header");
                    buffer.extend_from_slice(&chunk[..read]);
                };
                let size_line = String::from_utf8_lossy(&buffer[position..line_end]).to_string();
                let size = usize::from_str_radix(size_line.split(';').next().unwrap_or("0").trim(), 16)
                    .expect("hex chunk size");
                position = line_end + 2;
                if size == 0 {
                    break;
                }
                while buffer.len() < position + size + 2 {
                    let read = stream.read(&mut chunk).expect("read chunk body");
                    assert!(read > 0, "connection closed in chunk body");
                    buffer.extend_from_slice(&chunk[..read]);
                }
                body.extend_from_slice(&buffer[position..position + size]);
                position += size + 2;
            }
            body
        } else {
            let length: usize = header(&headers, "content-length").parse().unwrap_or(0);
            while buffer.len() < header_end + length {
                let read = stream.read(&mut chunk).expect("read response body");
                assert!(read > 0, "connection closed before response body");
                buffer.extend_from_slice(&chunk[..read]);
            }
            buffer[header_end..header_end + length].to_vec()
        };
        (status, headers, body)
    }

    fn get(addr: &str, path: &str, extra: &[(&str, &str)]) -> (u16, Vec<(String, String)>, Vec<u8>) {
        let mut stream = TcpStream::connect(addr).expect("connect");
        let mut request = format!("GET {path} HTTP/1.1\r\nHost: {addr}\r\nConnection: close\r\n");
        for (name, value) in extra {
            request.push_str(&format!("{name}: {value}\r\n"));
        }
        request.push_str("\r\n");
        stream.write_all(request.as_bytes()).expect("write request");
        read_response(&mut stream)
    }

    fn post(addr: &str, path: &str, token: Option<&str>, body: &str) -> (u16, Vec<(String, String)>, Vec<u8>) {
        let mut stream = TcpStream::connect(addr).expect("connect");
        let mut request = format!(
            "POST {path} HTTP/1.1\r\nHost: {addr}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n",
            body.len()
        );
        if let Some(token) = token {
            request.push_str(&format!("Authorization: Bearer {token}\r\n"));
        }
        request.push_str("\r\n");
        request.push_str(body);
        stream.write_all(request.as_bytes()).expect("write request");
        read_response(&mut stream)
    }

    fn null_handler() -> Handler {
        Arc::new(|_: &str, _: &Value| -> anyhow::Result<Value> { Ok(Value::Null) })
    }

    #[test]
    fn rpc_requires_token_and_returns_handler_result() {
        let (library, root) = test_library("rpc");
        let handler: Handler = Arc::new(|method: &str, params: &Value| -> anyhow::Result<Value> {
            if method == "boom" {
                anyhow::bail!("boom");
            }
            Ok(json!({"method": method, "params": params}))
        });
        let server = serve(library.clone(), "127.0.0.1:0", handler, EventHub::default(), None, None).expect("serve");
        assert_eq!(server.token.len(), 32, "token must be 32 hex chars");
        assert!(server.token.chars().all(|character| character.is_ascii_hexdigit()));
        let body = r#"{"method":"ping","params":{"echo":7}}"#;

        let (status, _, _) = post(&server.addr, "/api/rpc", None, body);
        assert_eq!(status, 401, "anonymous rpc must be rejected");
        let (status, _, _) = post(&server.addr, "/api/rpc", Some("deadbeef"), body);
        assert_eq!(status, 401, "wrong token must be rejected");

        let (status, _, payload) = post(&server.addr, "/api/rpc", Some(&server.token), body);
        assert_eq!(status, 200);
        let value: Value = serde_json::from_slice(&payload).expect("json response");
        assert_eq!(value["ok"], true);
        assert_eq!(value["result"]["method"], "ping");
        assert_eq!(value["result"]["params"]["echo"], 7);

        let (status, _, _) = post(&server.addr, "/api/rpc?token=wrong", None, body);
        assert_eq!(status, 401, "wrong query token must be rejected");
        let (status, _, payload) = post(&server.addr, &format!("/api/rpc?token={}", server.token), None, body);
        assert_eq!(status, 200, "query token must be accepted");
        let value: Value = serde_json::from_slice(&payload).expect("json response");
        assert_eq!(value["ok"], true);

        let (status, _, payload) = post(&server.addr, "/api/rpc", Some(&server.token), r#"{"method":"boom"}"#);
        assert_eq!(status, 200, "handler failures stay 200 + ok:false");
        let value: Value = serde_json::from_slice(&payload).expect("json response");
        assert_eq!(value["ok"], false);
        assert!(value["error"].as_str().expect("error string").contains("boom"));

        let (status, _, payload) = get(&server.addr, "/healthz", &[]);
        assert_eq!(status, 200);
        assert_eq!(serde_json::from_slice::<Value>(&payload).expect("json")["ok"], true);

        server.shutdown();
        drop(server);
        drop(library);
        cleanup(&root);
    }

    /// A token persisted by the desktop survives a sidecar restart; only a
    /// malformed value is replaced by a random one (and never echoed).
    #[test]
    fn supplied_pairing_token_is_reused_and_malformed_values_fall_back() {
        assert!(valid_token("0123456789abcdef0123456789abcdef"));
        assert!(valid_token("0123456789ABCDEF0123456789ABCDEF"), "hex digits may be upper case");
        assert!(!valid_token("0123456789abcdef"), "short tokens are invalid");
        assert!(!valid_token("0123456789abcdef0123456789abcdeZ"), "non-hex tokens are invalid");
        assert!(!valid_token(&"a".repeat(33)), "long tokens are invalid");

        let (library, root) = test_library("token");
        let supplied = "0123456789abcdef0123456789abcdef";
        let server = serve(
            library.clone(),
            "127.0.0.1:0",
            null_handler(),
            EventHub::default(),
            None,
            Some(supplied.to_string()),
        )
        .expect("serve");
        assert_eq!(server.token, supplied, "the supplied token must be authoritative");

        let body = r#"{"method":"ping"}"#;
        let (status, _, payload) = post(&server.addr, "/api/rpc", Some(supplied), body);
        assert_eq!(status, 200);
        assert_eq!(serde_json::from_slice::<Value>(&payload).expect("json")["ok"], true);
        let (status, _, _) = post(&server.addr, "/api/rpc", Some("0123456789abcdef0123456789abcdee"), body);
        assert_eq!(status, 401, "a different token must not authenticate");
        server.shutdown();
        drop(server);
        drop(library);
        cleanup(&root);

        let (library, root) = test_library("token-invalid");
        let server = serve(
            library.clone(),
            "127.0.0.1:0",
            null_handler(),
            EventHub::default(),
            None,
            Some("stale-token".to_string()),
        )
        .expect("serve");
        assert_ne!(server.token, "stale-token");
        assert!(valid_token(&server.token), "a malformed --serve-token must fall back to a random token");
        server.shutdown();
        drop(server);
        drop(library);
        cleanup(&root);
    }

    /// The LAN policy must short-circuit before `dispatch`: the server maps the
    /// handler's `LanForbidden` marker to an explicit 403 and the handler is
    /// never asked to run the dangerous method.
    #[test]
    fn lan_policy_rejection_returns_403_without_dispatching() {
        let (library, root) = test_library("forbidden");
        let dispatched = Arc::new(AtomicUsize::new(0));
        let handler: Handler = {
            let dispatched = Arc::clone(&dispatched);
            Arc::new(move |method: &str, _: &Value| -> anyhow::Result<Value> {
                match method {
                    "forbidden" => Err(LanForbidden.into()),
                    "allowed" => Ok(json!({"method": method})),
                    _ => {
                        dispatched.fetch_add(1, Ordering::SeqCst);
                        Ok(Value::Null)
                    }
                }
            })
        };
        let server = serve(library.clone(), "127.0.0.1:0", handler, EventHub::default(), None, None).expect("serve");
        let body = r#"{"method":"forbidden","params":{}}"#;
        let (status, headers, payload) = post(&server.addr, "/api/rpc", Some(&server.token), body);
        assert_eq!(status, 403, "policy rejections must be HTTP 403");
        assert!(header(&headers, "content-type").contains("application/json"));
        let value: Value = serde_json::from_slice(&payload).expect("json response");
        assert_eq!(value["ok"], false);
        assert_eq!(value["error"], "forbidden over LAN");
        assert_eq!(dispatched.load(Ordering::SeqCst), 0, "a forbidden method must never reach the real dispatch");

        let (status, _, payload) = post(&server.addr, "/api/rpc", Some(&server.token), r#"{"method":"allowed"}"#);
        assert_eq!(status, 200);
        assert_eq!(serde_json::from_slice::<Value>(&payload).expect("json")["result"]["method"], "allowed");

        server.shutdown();
        drop(server);
        drop(library);
        cleanup(&root);
    }

    #[test]
    fn pdf_range_requests_return_partial_content() {
        let (library, root) = test_library("range");
        let bytes: Vec<u8> = (0u8..=255u8).collect();
        fs::write(root.join("files").join("range.pdf"), &bytes).expect("write pdf");
        {
            let connection = library.conn();
            connection
                .execute("INSERT INTO papers(id,title,imported_at,updated_at) VALUES('paper-range','Range',1,1)", [])
                .expect("insert paper");
            connection
                .execute(
                    "INSERT INTO versions(id,paper_id,kind,sha256,rel_path,pages,bytes,lang,created_at) VALUES('version-range','paper-range','source','sha','files/range.pdf',1,?1,'',1)",
                    rusqlite::params![bytes.len() as i64],
                )
                .expect("insert version");
        }
        let server = serve(library.clone(), "127.0.0.1:0", null_handler(), EventHub::default(), None, None).expect("serve");

        let authorized = format!("token={}", server.token);
        let pdf_path = format!("/api/pdf/version-range?{authorized}");
        let (status, headers, body) = get(&server.addr, &pdf_path, &[("Range", "bytes=10-19")]);
        assert_eq!(status, 206);
        assert_eq!(header(&headers, "content-range"), "bytes 10-19/256");
        assert_eq!(header(&headers, "accept-ranges"), "bytes");
        assert_eq!(header(&headers, "content-length"), "10");
        assert_eq!(body.as_slice(), &bytes[10..20], "206 body must be the requested slice");

        let (status, headers, body) = get(&server.addr, &pdf_path, &[]);
        assert_eq!(status, 200);
        assert_eq!(header(&headers, "accept-ranges"), "bytes");
        assert_eq!(header(&headers, "content-length"), "256");
        assert_eq!(body, bytes);

        let (status, headers, _) = get(&server.addr, &pdf_path, &[("Range", "bytes=1024-")]);
        assert_eq!(status, 416, "out-of-range request must be 416");
        assert_eq!(header(&headers, "content-range"), "bytes */256");

        // Papers themselves are never served to an unpaired client.
        let (status, _, _) = get(&server.addr, "/api/pdf/version-range", &[]);
        assert_eq!(status, 401, "unauthenticated PDF fetch must be rejected");

        server.shutdown();
        drop(server);
        drop(library);
        cleanup(&root);
    }

    #[test]
    fn sse_stream_delivers_published_events() {
        let (library, root) = test_library("sse");
        let hub = EventHub::default();
        let server = serve(library.clone(), "127.0.0.1:0", null_handler(), hub.clone(), None, None).expect("serve");
        let mut stream = TcpStream::connect(&server.addr).expect("connect sse");
        stream.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
        let request = format!(
            "GET /api/events?token={} HTTP/1.1\r\nHost: {}\r\nAccept: text/event-stream\r\n\r\n",
            server.token, server.addr
        );
        stream.write_all(request.as_bytes()).expect("write sse request");

        let mut received = Vec::new();
        let mut chunk = [0u8; 1024];
        loop {
            if find_bytes(&received, b"\r\n\r\n").is_some() {
                break;
            }
            let read = stream.read(&mut chunk).expect("read sse headers");
            assert!(read > 0, "stream closed before sse headers");
            received.extend_from_slice(&chunk[..read]);
        }
        let head = String::from_utf8_lossy(&received).to_ascii_lowercase();
        assert!(head.contains("text/event-stream"), "unexpected sse headers: {head}");

        hub.publish(json!({"kind": "translation", "progress": 42}));
        let deadline = Instant::now() + Duration::from_secs(5);
        let event = loop {
            if let Some(position) = find_bytes(&received, b"data: ") {
                let tail = &received[position + b"data: ".len()..];
                if let Some(end) = tail.iter().position(|byte| *byte == b'\n') {
                    break String::from_utf8_lossy(&tail[..end]).to_string();
                }
            }
            if Instant::now() > deadline {
                panic!("no sse data line: {:?}", String::from_utf8_lossy(&received));
            }
            match stream.read(&mut chunk) {
                Ok(0) => panic!("stream closed before the sse event"),
                Ok(read) => received.extend_from_slice(&chunk[..read]),
                Err(error)
                    if error.kind() == std::io::ErrorKind::WouldBlock || error.kind() == std::io::ErrorKind::TimedOut => {}
                Err(error) => panic!("sse read failed: {error}"),
            }
        };
        let value: Value = serde_json::from_str(&event).expect("sse payload json");
        assert_eq!(value["kind"], "translation");
        assert_eq!(value["progress"], 42);

        drop(stream);
        server.shutdown();
        drop(server);
        drop(library);
        cleanup(&root);
    }

    #[test]
    fn static_files_are_served_safely_with_spa_fallback() {
        let (library, root) = test_library("static");
        let assets = temp_root("static-assets");
        fs::write(assets.join("index.html"), b"<!doctype html><title>moonlight</title>").expect("index");
        fs::create_dir_all(assets.join("assets")).expect("assets dir");
        fs::write(assets.join("assets/app.js"), b"console.log('moonlight');").expect("app.js");
        fs::write(assets.join("manifest.webmanifest"), br#"{"name":"Moonlight"}"#).expect("manifest");
        let server = serve(
            library.clone(),
            "127.0.0.1:0",
            null_handler(),
            EventHub::default(),
            Some(assets.clone()),
            None,
        )
        .expect("serve");

        let (status, headers, body) = get(&server.addr, "/", &[]);
        assert_eq!(status, 200);
        assert_eq!(header(&headers, "content-type"), "text/html; charset=utf-8");
        assert!(String::from_utf8_lossy(&body).contains("moonlight"));

        let (status, headers, body) = get(&server.addr, "/assets/app.js", &[]);
        assert_eq!(status, 200);
        assert!(header(&headers, "content-type").starts_with("text/javascript"));
        assert_eq!(body.as_slice(), b"console.log('moonlight');".as_slice());

        let (status, headers, _) = get(&server.addr, "/manifest.webmanifest", &[]);
        assert_eq!(status, 200);
        assert!(header(&headers, "content-type").contains("manifest+json"));

        let (status, _, body) = get(&server.addr, "/reader/42", &[]);
        assert_eq!(status, 200, "unknown routes fall back to the SPA entry point");
        assert!(String::from_utf8_lossy(&body).contains("<title>moonlight</title>"));

        for path in ["/../etc/passwd", "/%2e%2e/etc/passwd", "/assets/../../etc/passwd"] {
            let (status, _, body) = get(&server.addr, path, &[]);
            assert!(status == 400 || status == 404, "{path} must be rejected, got {status}");
            assert!(!String::from_utf8_lossy(&body).contains("root:"), "{path} leaked host content");
        }

        server.shutdown();
        drop(server);
        drop(library);
        cleanup(&assets);
        cleanup(&root);
    }
}
