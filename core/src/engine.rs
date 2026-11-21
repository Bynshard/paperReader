//! Translation engine + loopback model gateway.
//!
//! BabelDOC remains the layout-preserving translation kernel (python CLI).  It
//! speaks plain OpenAI, while the configured provider needs a routing header
//! and a flat `reasoning_effort` field; the loopback gateway performs that
//! translation and keeps the upstream credential out of BabelDOC's argv.

use crate::library::Library;
use anyhow::{anyhow, Result};
use serde_json::{json, Value};
use std::io::{BufRead, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use regex::Regex;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, OnceLock, RwLock};
use std::time::{Duration, Instant};
use tiny_http::{Header, Method, Response, Server};

/// Mutable half of a running gateway.  BUG-06 hot reload swaps only these
/// while the TCP listener, its loopback address and its token stay the same,
/// so BabelDOC and in-flight SSE answers never lose their connection.
#[derive(Clone, Debug)]
struct GatewayInner {
    upstream: String,
    model: String,
    api_key: String,
}

#[derive(Clone)]
pub struct Gateway {
    pub base_url: String,
    pub token: String,
    /// Default model for clients that do not send `x-moonlight-model`.  Kept
    /// public (and mutable) because callers build a per-request clone and swap
    /// only the model; the loopback server always lets that header win.
    pub model: String,
    inner: Arc<RwLock<GatewayInner>>,
    server: Arc<Server>,
    /// FEAT-UX-03 glossary state.  Terms live here (not in `GatewayInner`) so a
    /// credential hot-update cannot clear them and so `set_glossary` stays a
    /// cheap independent lock.  `glossary_fallback` is flipped by
    /// `run_translation` only when the BabelDOC build cannot take a glossary
    /// CSV; chat requests that already carry the marker are never touched.
    glossary: Arc<RwLock<Vec<(String, String)>>>,
    glossary_fallback: Arc<AtomicBool>,
}

impl Gateway {
    /// Swap upstream/model/key in place.  Callers that already started a
    /// request keep the snapshot they read when it began.
    pub fn update(&mut self, upstream: String, model: String, key: String) {
        let upstream = upstream.trim_end_matches('/').to_string();
        {
            let mut inner = self.inner.write().unwrap_or_else(|poisoned| poisoned.into_inner());
            *inner = GatewayInner { upstream, model: model.clone(), api_key: key };
        }
        self.model = model;
    }

    /// Replace the enabled glossary snapshot (called on `save_glossary`,
    /// `ensure_gateway` and `reload_gateway`).
    pub fn set_glossary(&self, terms: Vec<(String, String)>) {
        *self.glossary.write().unwrap_or_else(|poisoned| poisoned.into_inner()) = terms;
    }

    pub fn glossary_terms(&self) -> Vec<(String, String)> {
        self.glossary.read().unwrap_or_else(|poisoned| poisoned.into_inner()).clone()
    }

    /// Enable/disable system-message glossary injection.  Only the
    /// whole-document fallback path enables it for the duration of one job.
    pub fn set_glossary_fallback(&self, enabled: bool) {
        self.glossary_fallback.store(enabled, Ordering::SeqCst);
    }
    /// Stop the loopback listener. In-flight requests finish; `incoming_requests`
    /// returns `None` so the gateway thread exits instead of leaking.
    pub fn shutdown(&self) {
        self.server.unblock();
    }
}

fn header(name: &str, value: &str) -> Header {
    Header::from_bytes(name.as_bytes(), value.as_bytes()).unwrap()
}

pub fn start_gateway(upstream: String, model: String, key: String, usage_log: PathBuf) -> Result<Gateway> {
    let server = Arc::new(Server::http("127.0.0.1:0").map_err(|e| anyhow!("gateway bind: {e}"))?);
    let port = match server.server_addr() {
        tiny_http::ListenAddr::IP(addr) => addr.port(),
        _ => return Err(anyhow!("gateway is not listening on IP")),
    };
    let token = uuid::Uuid::new_v4().to_string();
    let inner = Arc::new(RwLock::new(GatewayInner {
        upstream: upstream.trim_end_matches('/').to_string(),
        model: model.clone(),
        api_key: key,
    }));
    let gateway = Gateway {
        base_url: format!("http://127.0.0.1:{port}/v1"),
        token: token.clone(),
        model: model.clone(),
        inner: Arc::clone(&inner),
        server: Arc::clone(&server),
        glossary: Arc::new(RwLock::new(Vec::new())),
        glossary_fallback: Arc::new(AtomicBool::new(false)),
    };
    let session = uuid::Uuid::new_v4().to_string();
    let log_path = usage_log.clone();
    let glossary = Arc::clone(&gateway.glossary);
    let glossary_fallback = Arc::clone(&gateway.glossary_fallback);
    std::thread::Builder::new()
        .name("model-gateway".into())
        .spawn(move || {
            let client = reqwest::blocking::Client::builder()
                .timeout(Duration::from_secs(600))
                .build()
                .expect("http client");
            // `shutdown()` calls `unblock()`, which ends this iterator.
            for request in server.incoming_requests() {
                let client = client.clone();
                let config = Arc::clone(&inner);
                let token = token.clone();
                let session = session.clone();
                let log_path = log_path.clone();
                let glossary = Arc::clone(&glossary);
                let glossary_fallback = Arc::clone(&glossary_fallback);
                std::thread::spawn(move || {
                    // Snapshot once per request: a concurrent `reload_gateway`
                    // only affects requests that start after it, never a stream
                    // that is already relaying.
                    let snapshot = config.read().unwrap_or_else(|poisoned| poisoned.into_inner()).clone();
                    // Glossary is only injected when a translation job opted
                    // into the fallback; AI callers already build their own
                    // matched prompt (and carry the shared marker).
                    let terms = if glossary_fallback.load(Ordering::SeqCst) {
                        glossary.read().unwrap_or_else(|poisoned| poisoned.into_inner()).clone()
                    } else {
                        Vec::new()
                    };
                    let _ = handle(request, &client, &snapshot.upstream, &snapshot.api_key, &token, &snapshot.model, &session, &log_path, &terms);
                });
            }
        })?;
    Ok(gateway)
}

fn handle(
    mut request: tiny_http::Request,
    client: &reqwest::blocking::Client,
    upstream: &str,
    upstream_key: &str,
    token: &str,
    model: &str,
    session: &str,
    log_path: &Path,
    glossary: &[(String, String)],
) -> Result<()> {
    let url = request.url().to_string();
    if request.method() == &Method::Get {
        if url.starts_with("/health") {
            let body = json!({"ok": true}).to_string();
            let mut resp = Response::from_string(body).with_status_code(200);
            resp.add_header(header("Content-Type", "application/json"));
            let _ = request.respond(resp);
            return Ok(());
        }
        let _ = request.respond(Response::from_string("not found").with_status_code(404));
        return Ok(());
    }
    if !url.starts_with("/v1/chat/completions") && !url.starts_with("/chat/completions") {
        let _ = request.respond(Response::from_string("not found").with_status_code(404));
        return Ok(());
    }
    let auth = request
        .headers()
        .iter()
        .find(|h| h.field.equiv("Authorization"))
        .map(|h| h.value.as_str().to_string())
        .unwrap_or_default();
    if auth != format!("Bearer {token}") {
        let _ = request.respond(
            Response::from_string(json!({"error": {"message": "invalid local gateway token"}}).to_string())
                .with_status_code(401),
        );
        return Ok(());
    }
    let mut body = String::new();
    request.as_reader().take(16 * 1024 * 1024).read_to_string(&mut body)?;
    // A per-request `x-moonlight-model` lets the AI panel use a stronger chat
    // model than the translation configuration without spawning a second
    // loopback gateway. The header is only reachable with the loopback token.
    let requested_model = request
        .headers()
        .iter()
        .find(|h| h.field.equiv("X-Moonlight-Model"))
        .map(|h| h.value.as_str().trim().to_string())
        .filter(|m| !m.is_empty() && m.len() <= 200);
    let mut payload: Value = serde_json::from_str(&body).unwrap_or_else(|_| json!({"error": "invalid json"}));
    let routed=reqwest::Url::parse(upstream).ok().and_then(|url|url.host_str().map(str::to_string)).as_deref()==Some("opencode.ai");
    if let Value::Object(ref mut map) = payload {
        map.insert("model".into(), Value::String(requested_model.unwrap_or_else(|| model.to_string())));
        if let Some(reasoning) = map.remove("reasoning") {
            let effort = reasoning
                .get("effort")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string())
                .or_else(|| reasoning.as_str().map(|s| s.to_string()));
            if let Some(effort) = effort {
                map.entry("reasoning_effort").or_insert(Value::String(effort));
            }
        }
        // BabelDOC uses "none" as a local switch; generic providers may reject
        // it as an unknown/unsupported reasoning parameter.
        if !routed && map.get("reasoning_effort").and_then(Value::as_str)==Some("none") {map.remove("reasoning_effort");}
    }
    // FEAT-UX-03 fallback: BabelDOC builds that reject a glossary CSV receive
    // the same constraints through their system prompt instead.  Requests that
    // already carry the marker (ai::translate_text / explain_with) are skipped.
    inject_glossary(&mut payload, glossary);
    let started = Instant::now();
    let wants_stream = payload.get("stream").and_then(Value::as_bool).unwrap_or(false);
    let mut upstream_request = client
        .post(format!("{upstream}/chat/completions"))
        .bearer_auth(upstream_key)
        .header("Content-Type", "application/json")
        .json(&payload);
    if routed {upstream_request=upstream_request.header("x-opencode-session",session);}
    if wants_stream {upstream_request=upstream_request.header("Accept","text/event-stream");}
    let response=upstream_request.send();
    if wants_stream {
        return relay_stream(request, response, started, log_path);
    }
    let (status, text, usage) = match response {
        Ok(resp) => {
            let status = resp.status().as_u16();
            let text = resp.text().unwrap_or_default();
            let usage = serde_json::from_str::<Value>(&text)
                .ok()
                .and_then(|v| v.get("usage").cloned())
                .unwrap_or(Value::Null);
            (status, text, usage)
        }
        Err(err) => (
            502,
            json!({"error": {"message": format!("upstream error: {err}"), "type": "upstream_error"}}).to_string(),
            Value::Null,
        ),
    };
    if let Ok(mut fh) = std::fs::OpenOptions::new().create(true).append(true).open(log_path) {
        let record = json!({
            "ts": chrono_stamp(),
            "event": "chat",
            "status": status,
            "stream": false,
            "elapsed_ms": started.elapsed().as_millis() as u64,
            "reasoning_effort": payload.get("reasoning_effort"),
            "usage": usage,
        });
        let _ = writeln!(fh, "{record}");
    }
    let mut resp = Response::from_string(text).with_status_code(status);
    resp.add_header(header("Content-Type", "application/json"));
    let _ = request.respond(resp);
    Ok(())
}

/// Append glossary constraints to a chat-completions payload (FEAT-UX-03).
///
/// * The shared marker [`crate::library::GLOSSARY_MARKER`] makes injection
///   idempotent: a message that already carries the term table is returned
///   untouched, so an AI call cannot receive the same rules twice.
/// * A payload without a system message gets one prepended; a vision-style
///   system `content` array is left alone and a separate system message is
///   added instead, so structured content is never corrupted.
fn inject_glossary(payload: &mut Value, terms: &[(String, String)]) {
    if terms.is_empty() {
        return;
    }
    let segment = crate::library::glossary_system_segment(terms, GLOSSARY_FALLBACK_LIMIT);
    if segment.is_empty() {
        return;
    }
    let Some(messages) = payload.get_mut("messages").and_then(Value::as_array_mut) else {
        return;
    };
    let system_index = messages.iter().position(|message| message["role"].as_str() == Some("system"));
    match system_index {
        Some(index) => {
            let existing = messages[index]["content"].as_str().map(str::to_string);
            match existing {
                Some(content) => {
                    if !content.contains(crate::library::GLOSSARY_MARKER) {
                        messages[index]["content"] = json!(format!("{content}\n\n{segment}"));
                    }
                }
                None => messages.insert(0, json!({"role": "system", "content": segment})),
            }
        }
        None => messages.insert(0, json!({"role": "system", "content": segment})),
    }
}

/// Maximum terms attached to one fallback prompt (keeps the system message small).
const GLOSSARY_FALLBACK_LIMIT: usize = 40;

/// BabelDOC option that accepts a glossary CSV, detected from `--help`.
///
/// BabelDOC 0.6.2 (the bundled build) exposes `--glossary-files`; older or
/// third-party builds may expose `--glossary`/`--term`.  A build that shows no
/// glossary switch at all takes the gateway system-prompt fallback instead.
pub fn glossary_option(binary: &Path) -> Option<&'static str> {
    let help = run_capture(binary, &["--help"], Duration::from_secs(10)).ok()?;
    let listed = |option: &str| {
        let spaced = format!("{option} ");
        let equals = format!("{option}=");
        help.contains(&spaced) || help.contains(&equals) || help.contains(&format!("{option}\n")) || help.contains(&format!("{option}]"))
    };
    // Order matters: `--glossary-files` must not be mistaken for `--glossary`,
    // and `--term` must not match BabelDOC's `--term-pool-max-workers`.
    for option in ["--glossary-files", "--glossary", "--term"] {
        if listed(option) {
            return Some(option);
        }
    }
    None
}

/// Render the `source,target` CSV BabelDOC's glossary loader expects.
pub(crate) fn glossary_csv(terms: &[(String, String)]) -> String {
    fn column(value: &str) -> String {
        if value.contains([',', '"', '\n', '\r']) {
            format!("\"{}\"", value.replace('"', "\"\""))
        } else {
            value.to_string()
        }
    }
    let mut out = String::from("source,target\n");
    for (source, target) in terms {
        out.push_str(&column(source));
        out.push(',');
        out.push_str(&column(target));
        out.push('\n');
    }
    out
}

/// Keep the gateway fallback flag scoped to exactly one translation job.
struct GlossaryFallbackGuard(Option<Gateway>);

impl GlossaryFallbackGuard {
    fn new(gateway: Gateway, active: bool) -> Self {
        if active {
            gateway.set_glossary_fallback(true);
            Self(Some(gateway))
        } else {
            Self(None)
        }
    }
}

impl Drop for GlossaryFallbackGuard {
    fn drop(&mut self) {
        if let Some(gateway) = &self.0 {
            gateway.set_glossary_fallback(false);
        }
    }
}

fn chrono_stamp() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let secs = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
    format!("{secs}")
}

/// Relay an upstream `text/event-stream` body to the local caller unchanged.
///
/// tiny_http cannot know the final length, so the response is chunked and the
/// consumer keeps receiving deltas while the model is still generating.
fn relay_stream(
    request: tiny_http::Request,
    response: reqwest::Result<reqwest::blocking::Response>,
    started: Instant,
    log_path: &Path,
) -> Result<()> {
    match response {
        Ok(upstream) => {
            let status = upstream.status().as_u16();
            // tiny_http wraps every socket in a 1 KiB BufWriter, so a chunked
            // `Response` would hold small deltas until the buffer fills — the
            // answer would arrive in bursts instead of streaming. Write the
            // headers and each chunk by hand and flush after every delta.
            let mut writer = request.into_writer();
            write!(writer, "HTTP/1.1 {status} OK\r\n")?;
            write!(writer, "content-type: text/event-stream; charset=utf-8\r\n")?;
            write!(writer, "cache-control: no-cache\r\n")?;
            write!(writer, "x-accel-buffering: no\r\n")?;
            write!(writer, "transfer-encoding: chunked\r\n\r\n")?;
            writer.flush()?;
            let mut upstream = upstream;
            let mut buffer = [0u8; 8192];
            let relay = (|| -> Result<()> {
                loop {
                    let read = upstream.read(&mut buffer)?;
                    if read == 0 { break; }
                    write!(writer, "{read:x}\r\n")?;
                    writer.write_all(&buffer[..read])?;
                    writer.write_all(b"\r\n")?;
                    writer.flush()?;
                }
                writer.write_all(b"0\r\n\r\n")?;
                writer.flush()?;
                Ok(())
            })();
            log_chat(log_path, status, started, Value::Null, true);
            relay.map_err(|err| anyhow!("stream relay failed: {err}"))?;
            Ok(())
        }
        Err(err) => {
            let payload = json!({"error": {"message": format!("upstream error: {err}"), "type": "upstream_error"}}).to_string();
            let mut resp = Response::from_string(payload).with_status_code(502);
            resp.add_header(header("Content-Type", "application/json"));
            let _ = request.respond(resp);
            Ok(())
        }
    }
}

fn log_chat(log_path: &Path, status: u16, started: Instant, usage: Value, stream: bool) {
    if let Ok(mut fh) = std::fs::OpenOptions::new().create(true).append(true).open(log_path) {
        let record = json!({
            "ts": chrono_stamp(),
            "event": "chat",
            "status": status,
            "stream": stream,
            "elapsed_ms": started.elapsed().as_millis() as u64,
            "usage": usage,
        });
        let _ = writeln!(fh, "{record}");
    }
}

/// Chat completion through the gateway (used by the AI panel).
pub fn chat(gateway: &Gateway, messages: Vec<Value>, temperature: f64) -> Result<String> {
    let client = reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(300))
        .build()?;
    let resp = client
        .post(format!("{}/chat/completions", gateway.base_url.trim_end_matches('/')))
        .bearer_auth(&gateway.token)
        // Per-request model override (AI panel can use a stronger chat model
        // than the translation model). The loopback gateway honours it.
        .header("x-moonlight-model", &gateway.model)
        .json(&json!({
            "model": gateway.model,
            "messages": messages,
            "temperature": temperature,
        }))
        .send()?;
    let status = resp.status();
    let value: Value = resp.json().unwrap_or(Value::Null);
    if !status.is_success() {
        return Err(anyhow!("model error {}: {}", status, value));
    }
    Ok(value["choices"][0]["message"]["content"]
        .as_str()
        .unwrap_or_default()
        .to_string())
}

/// Streaming chat completion through the gateway.
///
/// `on_delta` receives the cumulative answer after every chunk so the renderer
/// can replace its live bubble; `cancel` is polled between chunks and aborts the
/// HTTP body read instead of waiting for the full generation.
pub fn chat_stream(
    gateway: &Gateway,
    messages: Vec<Value>,
    temperature: f64,
    cancel: &AtomicBool,
    mut on_delta: impl FnMut(&str),
) -> Result<String> {
    let client = reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(600))
        .build()?;
    let resp = client
        .post(format!("{}/chat/completions", gateway.base_url.trim_end_matches('/')))
        .bearer_auth(&gateway.token)
        // Per-request model override (AI panel can use a stronger chat model
        // than the translation model). The loopback gateway honours it.
        .header("x-moonlight-model", &gateway.model)
        .json(&json!({
            "model": gateway.model,
            "messages": messages,
            "temperature": temperature,
            "stream": true,
        }))
        .send()?;
    let status = resp.status();
    if !status.is_success() {
        let text = resp.text().unwrap_or_default();
        return Err(anyhow!("model error {}: {}", status, text));
    }
    let mut answer = String::new();
    for line in BufReader::new(resp).lines() {
        if cancel.load(Ordering::SeqCst) {
            return Err(anyhow!("已停止生成"));
        }
        let line = line?;
        let Some(data) = line.trim().strip_prefix("data:") else { continue };
        let data = data.trim();
        if data.is_empty() {
            continue;
        }
        if data == "[DONE]" {
            break;
        }
        let Ok(chunk) = serde_json::from_str::<Value>(data) else { continue };
        let Some(delta) = chunk["choices"][0]["delta"]["content"].as_str() else { continue };
        if delta.is_empty() {
            continue;
        }
        answer.push_str(delta);
        on_delta(&answer);
    }
    Ok(answer)
}

// ---- connection diagnostics ------------------------------------------------

/// Normalize a user supplied OpenAI compatible Base URL.
///
/// A saved address must name the API root (`.../v1`): trailing slashes and an
/// accidentally pasted `/chat/completions` suffix are removed, credentials,
/// query strings and fragments are rejected so the stored value can never hide
/// a different host than the one shown in the settings dialog.
pub fn normalize_upstream(raw: &str) -> Result<String> {
    let trimmed = raw.trim().trim_end_matches('/');
    if trimmed.is_empty() {
        return Err(anyhow!("API 地址为空"));
    }
    let suffix = "/chat/completions";
    let mut value = trimmed;
    if value.to_ascii_lowercase().ends_with(suffix) {
        // The suffix is ASCII, so this slice is always on a char boundary.
        value = value[..value.len() - suffix.len()].trim_end_matches('/');
    }
    let url = reqwest::Url::parse(value).map_err(|_| anyhow!("API 地址不是有效的 URL：{value}"))?;
    if !matches!(url.scheme(), "http" | "https") {
        return Err(anyhow!("API 地址必须是 http(s) 地址"));
    }
    if url.host_str().unwrap_or_default().is_empty() {
        return Err(anyhow!("API 地址缺少主机名"));
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err(anyhow!("API 地址不能包含账号密码"));
    }
    if url.query().is_some() || url.fragment().is_some() {
        return Err(anyhow!("API 地址不能包含查询参数或片段"));
    }
    Ok(value.to_string())
}

/// One minimal chat/completions round trip through a gateway.
///
/// Never panics: every failure is folded into `{ok:false,error}` so the
/// settings dialog can show the concrete reason instead of a stack of anyhow
/// context.
pub fn probe_gateway(gateway: &Gateway, timeout: Duration) -> Value {
    probe_url(&gateway.base_url, &gateway.token, &gateway.model, timeout)
}

pub fn probe_url(base_url: &str, bearer: &str, model: &str, timeout: Duration) -> Value {
    let url = format!("{}/chat/completions", base_url.trim_end_matches('/'));
    let payload = json!({
        "model": model,
        "messages": [{"role": "user", "content": "ping"}],
        "max_tokens": 8,
        "temperature": 0.0,
        "stream": false,
    });
    let client = match reqwest::blocking::Client::builder().timeout(timeout).build() {
        Ok(client) => client,
        Err(err) => return probe_failure(format!("网络错误：无法创建 HTTP 客户端（{err}）")),
    };
    let started = Instant::now();
    let response = client
        .post(&url)
        .bearer_auth(bearer)
        .header("Content-Type", "application/json")
        .json(&payload)
        .send();
    let response = match response {
        Ok(response) => response,
        Err(err) => return probe_failure(describe_request_error(&err, timeout)),
    };
    let latency = started.elapsed().as_millis() as u64;
    let status = response.status();
    let text = response.text().unwrap_or_default();
    let parsed: Option<Value> = serde_json::from_str(&text).ok();
    if !status.is_success() {
        return probe_failure(describe_probe_status(status.as_u16(), &text, parsed.as_ref()));
    }
    match parsed {
        None => probe_failure("返回内容不是 JSON，该地址可能不是 OpenAI 兼容接口".to_string()),
        Some(value) => {
            if let Some(error) = value.get("error").filter(|error| !error.is_null()) {
                return probe_failure(format!("上游返回错误：{}", error_text(error)));
            }
            let choices = value.get("choices").and_then(Value::as_array).map_or(0, Vec::len);
            let mut out = json!({
                "ok": true,
                "latency_ms": latency,
                "model": model,
                "status": status.as_u16(),
            });
            if choices == 0 {
                out["warning"] = json!("响应缺少 choices 字段，可能并非 OpenAI 兼容的 chat/completions 接口");
            }
            out
        }
    }
}

fn probe_failure(error: String) -> Value {
    json!({"ok": false, "error": error})
}

fn describe_request_error(err: &reqwest::Error, timeout: Duration) -> String {
    if err.is_timeout() {
        let window = if timeout.as_secs() >= 1 {
            format!("{} 秒", timeout.as_secs())
        } else {
            format!("{} 毫秒", timeout.as_millis())
        };
        format!("超时：{window}内未收到响应，请检查地址、网络或代理")
    } else if err.is_connect() {
        format!("网络错误：无法连接服务地址（{err}）")
    } else {
        format!("网络错误：{err}")
    }
}

fn describe_probe_status(status: u16, text: &str, parsed: Option<&Value>) -> String {
    let detail = parsed
        .and_then(|value| value.get("error"))
        .map(error_text)
        .filter(|detail| !detail.is_empty())
        .unwrap_or_else(|| snippet(text));
    let suffix = if detail.is_empty() { String::new() } else { format!("（{detail}）") };
    match status {
        401 => format!("401 Key 无效{suffix}"),
        403 => format!("403 无权限：Key 无效或无权访问该模型{suffix}"),
        404 => format!("404 模型不存在：请核对模型 ID 与 Base URL{suffix}"),
        400 | 422 => format!("400 请求被拒绝{suffix}"),
        429 => format!("429 请求过于频繁或额度不足{suffix}"),
        other => format!("上游返回 {other}{suffix}"),
    }
}

/// Pull a human readable message out of `{"error":{"message":...}}` shapes.
fn error_text(value: &Value) -> String {
    match value {
        Value::String(text) => snippet(text),
        other => other
            .get("message")
            .and_then(Value::as_str)
            .map(snippet)
            .or_else(|| other.get("error").and_then(Value::as_str).map(snippet))
            .unwrap_or_else(|| snippet(&other.to_string())),
    }
}

/// Collapse an upstream body into one short line for the settings dialog.
fn snippet(text: &str) -> String {
    let flat = text.split_whitespace().collect::<Vec<_>>().join(" ");
    let mut out: String = flat.chars().take(200).collect();
    if flat.chars().count() > 200 {
        out.push('…');
    }
    out
}

/// Resolve the BabelDOC executable for an actual translation run.
///
/// `configured` is the path saved in settings (empty/none means "look in the
/// bundled venv, `MOONLIGHT_BABELDOC_BIN` and PATH").  A missing binary becomes
/// an actionable Chinese error instead of a raw `program not found`.
pub fn babeldoc_executable(configured: Option<&str>) -> Result<PathBuf> {
    let explicit = configured
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(PathBuf::from);
    let mut candidates: Vec<PathBuf> = Vec::new();
    if let Some(path) = explicit.clone() {
        candidates.push(path);
    } else {
        if let Ok(from_env) = std::env::var("MOONLIGHT_BABELDOC_BIN") {
            let from_env = from_env.trim();
            if !from_env.is_empty() {
                candidates.push(PathBuf::from(from_env));
            }
        }
        candidates.push(babeldoc_bin());
    }
    for candidate in &candidates {
        if let Some(found) = resolve_babeldoc(candidate) {
            return Ok(found);
        }
    }
    let message = match explicit.as_deref() {
        Some(path) if !looks_like_babeldoc(path) => format!(
            "{} 不像是 BabelDOC 可执行文件（文件名需包含 babeldoc）",
            path.display()
        ),
        Some(path) if !path.exists() => format!(
            "未找到 BabelDOC 可执行文件：{}。请在 设置 → 翻译引擎 中选择 babeldoc.exe，或安装后加入 PATH",
            path.display()
        ),
        Some(path) => format!("BabelDOC 不可执行：{}（请检查文件权限）", path.display()),
        None => "未找到 BabelDOC，无法进行全文翻译：当前安装包缺少内置 BabelDOC 运行时，请重新下载完整安装包；或在 设置 → 翻译引擎 指定外部 babeldoc 可执行文件。".to_string(),
    };
    Err(anyhow!(message))
}

/// Locate the BabelDOC executable.
///
/// Priority: `MOONLIGHT_BABELDOC_BIN` > bundled portable runtime (packaged
/// `resources/bin/babeldoc` or a repo `tools/windows/babeldoc` build) > the
/// development `.venv` > `PATH`.
pub fn babeldoc_bin() -> PathBuf {
    if let Ok(p) = std::env::var("MOONLIGHT_BABELDOC_BIN") {
        let value = PathBuf::from(p);
        if value.exists() {
            return value;
        }
    }
    let root = std::env::var("MOONLIGHT_ROOT").unwrap_or_else(|_| ".".into());
    if let Some(found) = bundled_babeldoc(Path::new(&root)) {
        return found;
    }
    PathBuf::from("babeldoc")
}

fn bundled_babeldoc(root: &Path) -> Option<PathBuf> {
    let binary = if cfg!(windows) { "babeldoc.exe" } else { "babeldoc" };
    let candidates = [
        root.join("bin").join("babeldoc").join(binary),
        root.join("tools").join("windows").join("babeldoc").join(binary),
        root.join(if cfg!(windows) { ".venv/Scripts/babeldoc.exe" } else { ".venv/bin/babeldoc" }),
    ];
    candidates.into_iter().find(|candidate| candidate.exists())
}

// ---- BabelDOC environment diagnostics --------------------------------------

/// Check whether a BabelDOC executable can be found, optionally probing
/// `--version`.  Only files whose name contains "babeldoc" are ever executed, so
/// a renderer cannot turn this diagnostic into a generic process launcher.
pub fn check_babeldoc(requested: Option<&str>) -> Value {
    let explicit = requested
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(PathBuf::from);
    let mut candidates: Vec<PathBuf> = Vec::new();
    if let Some(path) = explicit.clone() {
        candidates.push(path);
    } else {
        if let Ok(from_env) = std::env::var("MOONLIGHT_BABELDOC_BIN") {
            let from_env = from_env.trim();
            if !from_env.is_empty() {
                candidates.push(PathBuf::from(from_env));
            }
        }
        candidates.push(babeldoc_bin());
    }
    for candidate in &candidates {
        let Some(found) = resolve_babeldoc(candidate) else { continue };
        let mut out = json!({"ok": true, "path": found.to_string_lossy()});
        if let Some(version) = babeldoc_version(&found) {
            out["version"] = json!(version);
        }
        return out;
    }
    let error = match explicit.as_deref() {
        Some(path) if !looks_like_babeldoc(path) => format!(
            "{} 不像是 BabelDOC 可执行文件（文件名需包含 babeldoc）",
            path.display()
        ),
        Some(path) if !path.exists() => format!("未找到 BabelDOC 可执行文件：{}", path.display()),
        Some(path) => format!("BabelDOC 不可执行：{}（请检查执行权限）", path.display()),
        None => "未找到 BabelDOC：当前安装包缺少内置运行时，请重新下载完整安装包；或在设置中指定外部 babeldoc 可执行文件".to_string(),
    };
    json!({"ok": false, "error": error})
}

fn resolve_babeldoc(candidate: &Path) -> Option<PathBuf> {
    if candidate.as_os_str().is_empty() || !looks_like_babeldoc(candidate) {
        return None;
    }
    // A bare file name is a PATH lookup; anything with a separator is a path.
    if candidate.is_absolute() || candidate.components().count() > 1 {
        if is_executable_file(candidate) {
            return Some(candidate.to_path_buf());
        }
        return None;
    }
    find_in_path(&candidate.to_string_lossy())
}

fn find_in_path(name: &str) -> Option<PathBuf> {
    let extensions: &[&str] = if cfg!(windows) { &["", ".exe", ".cmd", ".bat"] } else { &[""] };
    let dirs = std::env::var_os("PATH")
        .map(|value| std::env::split_paths(&value).collect::<Vec<_>>())
        .unwrap_or_default();
    for dir in dirs {
        if dir.as_os_str().is_empty() {
            continue;
        }
        for extension in extensions {
            let candidate = dir.join(format!("{name}{extension}"));
            if looks_like_babeldoc(&candidate) && is_executable_file(&candidate) {
                return Some(candidate);
            }
        }
    }
    None
}

fn looks_like_babeldoc(path: &Path) -> bool {
    path.file_name()
        .map(|name| name.to_string_lossy().to_ascii_lowercase().contains("babeldoc"))
        .unwrap_or(false)
}

fn is_executable_file(path: &Path) -> bool {
    let metadata = match std::fs::metadata(path) {
        Ok(metadata) => metadata,
        Err(_) => return false,
    };
    if !metadata.is_file() {
        return false;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if metadata.permissions().mode() & 0o111 == 0 {
            return false;
        }
    }
    true
}

fn babeldoc_version(binary: &Path) -> Option<String> {
    let output = run_capture(binary, &["--version"], Duration::from_secs(15)).ok()?;
    let line = output
        .lines()
        .map(str::trim)
        .find(|line| !line.is_empty())?
        .chars()
        .take(120)
        .collect::<String>();
    if line.is_empty() {
        None
    } else {
        Some(line)
    }
}

/// Run a short command and capture stdout, killing it after `timeout`.
fn run_capture(binary: &Path, args: &[&str], timeout: Duration) -> Result<String> {
    let mut command = Command::new(binary);
    command
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }
    let mut child = command
        .spawn()
        .map_err(|err| anyhow!("无法执行 {}：{err}", binary.display()))?;
    let deadline = Instant::now() + timeout;
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) => {
                if Instant::now() >= deadline {
                    let _ = child.kill();
                    let _ = child.wait();
                    return Err(anyhow!("超时"));
                }
                std::thread::sleep(Duration::from_millis(20));
            }
            Err(err) => return Err(anyhow!("{err}")),
        }
    }
    let mut text = String::new();
    if let Some(mut stdout) = child.stdout.take() {
        let _ = stdout.read_to_string(&mut text);
    }
    Ok(text)
}

// --- Real engine progress ---------------------------------------------------
// BabelDOC is a Python/rich CLI: its stdout is line oriented, colourised with
// ANSI CSI codes and it rewrites rich progress bars with `\r`.  The helpers
// below turn one log line into a percentage plus a short human readable detail
// so the reader can render a real progress bar (percent, page, elapsed time)
// instead of an indeterminate animation.  They are pure — no clock, no I/O —
// and therefore unit tested.

/// Upper bound on the `detail` carried by a progress event (characters).
const MAX_DETAIL_CHARS: usize = 160;
/// Progress events are coalesced to at most one per second; a phase change
/// (parsing -> translating -> typesetting -> validating) bypasses the throttle
/// so the UI reacts immediately.
const MIN_EMIT_INTERVAL: Duration = Duration::from_secs(1);

/// Lazily compiled ANSI escape sequence matcher (CSI colours/cursor moves, OSC
/// titles and the remaining two byte escapes rich terminals emit).
fn ansi_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(r"\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]")
            .expect("ANSI escape pattern is valid")
    })
}

/// `\b(\d{1,3})\s*%`, tolerating a decimal fraction: without it "87.5%" would
/// be read as "5%", which would regress the bar.
fn percent_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(r"\b(\d{1,3}(?:[.,]\d{1,2})?)\s*%").expect("percent pattern is valid")
    })
}

/// `(\d+)\s*/\s*(\d+)\s*(页|页数|pages?)`, case-insensitive, plus the mirrored
/// `页 12/30` / `Page 7/10` wording.
fn ratio_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(
            r"(?i)(?:(\d+)\s*/\s*(\d+)\s*(?:页数?|pages?)|(?:页数?|pages?)\s*[:：]?\s*(\d+)\s*/\s*(\d+))",
        )
        .expect("page-ratio pattern is valid")
    })
}

/// Remove ANSI escape sequences from one engine log line.
fn strip_ansi(line: &str) -> String {
    ansi_re().replace_all(line, "").into_owned()
}

/// Turn a raw engine line into a display string: the last `\r` rewrite wins
/// (that is how rich redraws a progress bar), ANSI is stripped, surrounding
/// whitespace is trimmed, control characters are dropped and runs of
/// whitespace collapse to one space.
fn clean_line(line: &str) -> String {
    let stripped = strip_ansi(line);
    let last = stripped
        .split('\r')
        .map(str::trim)
        .filter(|part| !part.is_empty())
        .last()
        .unwrap_or("");
    let mut out = String::with_capacity(last.len());
    for ch in last.chars() {
        if ch.is_whitespace() {
            if !out.is_empty() && !out.ends_with(' ') {
                out.push(' ');
            }
        } else if !ch.is_control() {
            out.push(ch);
        }
    }
    while out.ends_with(' ') {
        out.pop();
    }
    out
}

/// Cap `detail` at [`MAX_DETAIL_CHARS`] characters (ellipsis included) without
/// splitting a multi byte character.
fn truncate_detail(text: &str) -> String {
    if text.chars().count() <= MAX_DETAIL_CHARS {
        return text.to_string();
    }
    let mut out: String = text.chars().take(MAX_DETAIL_CHARS - 1).collect();
    out.push('…');
    out
}

fn parse_percent(text: &str) -> Option<u8> {
    let caps = percent_re().captures(text)?;
    let raw = caps.get(1)?.as_str().replace(',', ".");
    let value: f64 = raw.parse().ok()?;
    if !value.is_finite() {
        return None;
    }
    Some(value.round().clamp(0.0, 100.0) as u8)
}

fn parse_page_ratio(text: &str) -> Option<u8> {
    let caps = ratio_re().captures(text)?;
    let (done, total) = if caps.get(1).is_some() {
        (caps.get(1)?.as_str(), caps.get(2)?.as_str())
    } else {
        (caps.get(3)?.as_str(), caps.get(4)?.as_str())
    };
    let done: u64 = done.parse().ok()?;
    let total: u64 = total.parse().ok()?;
    if total == 0 {
        return None;
    }
    Some(done.saturating_mul(100).saturating_div(total).min(100) as u8)
}

/// Parse one engine log line into `(percent, detail)`.
///
/// `percent` is `0..=100` (clamped) and `detail` is the ANSI free, trimmed line
/// capped at [`MAX_DETAIL_CHARS`] characters.  Lines without a recognisable
/// number return `None`, so log chatter never moves the progress bar.
fn parse_progress_line(line: &str) -> Option<(u8, String)> {
    let detail = clean_line(line);
    if detail.is_empty() {
        return None;
    }
    let percent = parse_percent(&detail).or_else(|| parse_page_ratio(&detail))?;
    Some((percent, truncate_detail(&detail)))
}

/// One progress step that is allowed to reach the UI.
struct ProgressUpdate {
    percent: u8,
    detail: String,
    elapsed_ms: u64,
}

/// Coalesces engine log lines into progress updates: the percentage never
/// regresses inside one run (`max` is kept) and events are throttled to one per
/// second, while phase changes always emit immediately.
struct ProgressTracker {
    started: Instant,
    max_percent: u8,
    last_detail: String,
    last_phase: String,
    last_emit: Option<Instant>,
}

impl ProgressTracker {
    fn new(started: Instant) -> Self {
        Self {
            started,
            max_percent: 0,
            last_detail: String::new(),
            last_phase: String::new(),
            last_emit: None,
        }
    }

    fn elapsed_ms(&self, now: Instant) -> u64 {
        now.saturating_duration_since(self.started)
            .as_millis()
            .min(u64::MAX as u128) as u64
    }

    /// Feed one log line and return the update to emit, if any.  `phase` is the
    /// current job phase (`""` when the engine has not named one yet).
    fn observe(&mut self, line: &str, phase: &str, now: Instant) -> Option<ProgressUpdate> {
        let parsed = parse_progress_line(line);
        if let Some((percent, detail)) = parsed.as_ref() {
            self.max_percent = self.max_percent.max(*percent);
            self.last_detail = detail.clone();
        }
        let phase_changed = !phase.is_empty() && phase != self.last_phase;
        if phase_changed {
            self.last_phase = phase.to_string();
        }
        let due = self
            .last_emit
            .map(|at| now.saturating_duration_since(at) >= MIN_EMIT_INTERVAL)
            .unwrap_or(true);
        if !phase_changed && !(parsed.is_some() && due) {
            return None;
        }
        self.last_emit = Some(now);
        Some(ProgressUpdate {
            percent: self.max_percent,
            detail: self.last_detail.clone(),
            elapsed_ms: self.elapsed_ms(now),
        })
    }
}

/// Wire shape of a progress event.  `status` mirrors `phase` so the existing
/// job-status consumers and the newer phase-aware UI can share one payload.
fn progress_event(job_id: &str, phase: &str, update: &ProgressUpdate) -> Value {
    json!({
        "event": "job",
        "jobId": job_id,
        "status": phase,
        "phase": phase,
        "progress": update.percent,
        "detail": update.detail,
        "elapsed_ms": update.elapsed_ms,
    })
}

/// Keep at most this many characters of the engine log in a failed job's error.
const MAX_ERROR_LOG_TAIL: usize = 2000;

/// Read the tail of `<run_dir>/babeldoc.log` without loading a huge log.
///
/// Must run *before* [`cleanup_run_dir`]: BUG-06 removes the whole working
/// directory (including the full-size `.mono.pdf`), so the only diagnostics
/// that survive a failure are the ones folded into the job error here.
fn read_log_tail(path: &Path, max_chars: usize) -> Option<String> {
    use std::io::{Seek, SeekFrom};
    let mut file = std::fs::File::open(path).ok()?;
    let length = file.metadata().ok()?.len();
    // UTF-8 is at most 4 bytes per character; one extra byte keeps the start
    // from splitting the leading character of the tail.
    let start = length.saturating_sub(max_chars as u64 * 4 + 1);
    file.seek(SeekFrom::Start(start)).ok()?;
    let mut bytes = Vec::new();
    file.read_to_end(&mut bytes).ok()?;
    let text = String::from_utf8_lossy(&bytes);
    let tail: String = text.chars().rev().take(max_chars).collect::<Vec<_>>().into_iter().rev().collect();
    let tail = tail.trim();
    if tail.is_empty() {
        None
    } else {
        Some(tail.to_string())
    }
}

/// Best-effort removal of a translation run directory.
fn cleanup_run_dir(run_dir: &Path) {
    let _ = std::fs::remove_dir_all(run_dir);
}

/// Run one translation job.  Called on a background thread.
pub fn run_translation(library: Arc<Library>, job_id: String, paper_id: String, source_path: PathBuf, pages: Option<String>, source_version_id: Option<String>) {
    let cancel = library.cancel_flag(&job_id);
    let run_dir = library.root().join("tmp").join(format!("job-{job_id}"));
    let result = (|| -> Result<PathBuf> {
        if cancel.load(Ordering::SeqCst){return Err(anyhow!("cancelled"));}
        let gateway = library.gateway().ok_or_else(|| anyhow!("model is not configured"))?;
        std::fs::create_dir_all(&run_dir)?;
        // Hot-reloaded settings win: a saved configuration must change the
        // engine arguments without restarting the app.
        let model = gateway.model.clone();
        let (qps, babeldoc) = library.translation_engine_options();
        let babeldoc = babeldoc_executable(Some(&babeldoc.to_string_lossy()))?;
        let mut cmd = Command::new(&babeldoc);
        cmd.arg("--files")
            .arg(&source_path)
            .arg("--lang-in")
            .arg("en")
            .arg("--lang-out")
            .arg("zh-CN")
            .arg("--openai")
            .arg("--openai-model")
            .arg(&model)
            .arg("--openai-base-url")
            .arg(&gateway.base_url)
            .arg("--openai-api-key")
            .arg(&gateway.token)
            .arg("--openai-reasoning")
            .arg("none")
            .arg("--openai-term-extraction-reasoning")
            .arg("none")
            .arg("--no-dual")
            .arg("--watermark-output-mode")
            .arg("no_watermark")
            .arg("--qps")
            .arg(qps.to_string())
            .arg("--report-interval")
            .arg("5")
            .arg("--output")
            .arg(&run_dir);
        // FEAT-UX-03: BabelDOC 0.6.2 takes `--glossary-files <csv>`; write the
        // saved table into this job's private run directory (removed together
        // with the job).  A build without a glossary switch keeps the job
        // working and receives the constraints through the gateway instead.
        let glossary_terms = library.enabled_glossary_pairs().unwrap_or_default();
        if !glossary_terms.is_empty() {
            gateway.set_glossary(glossary_terms.clone());
        }
        let mut glossary_fallback = false;
        if !glossary_terms.is_empty() {
            match glossary_option(&babeldoc) {
                Some(option) => {
                    let csv = run_dir.join("glossary.csv");
                    match std::fs::write(&csv, glossary_csv(&glossary_terms)) {
                        Ok(()) => {
                            cmd.arg(option).arg(&csv);
                        }
                        Err(_) => glossary_fallback = true,
                    }
                }
                None => glossary_fallback = true,
            }
        }
        let _glossary_guard = GlossaryFallbackGuard::new(gateway.clone(), glossary_fallback);
        if let Some(p) = pages.as_deref() {
            cmd.arg("--pages").arg(p);
        }
        #[cfg(windows)]
        {use std::os::windows::process::CommandExt;cmd.creation_flags(0x08000000);}
        let log_path = run_dir.join("babeldoc.log");
        let log = std::fs::File::create(&log_path)?;
        cmd.stdout(Stdio::piped()).stderr(Stdio::from(log.try_clone()?));
        #[cfg(unix)]
        unsafe {
            use std::os::unix::process::CommandExt;
            cmd.pre_exec(|| {
                libc::setsid();
                #[cfg(target_os="linux")]
                {
                    if libc::prctl(libc::PR_SET_PDEATHSIG,libc::SIGKILL)<0{return Err(std::io::Error::last_os_error());}
                    if libc::getppid()==1{libc::_exit(1);}
                }
                Ok(())
            });
        }
        library.set_job_status(&job_id, "parsing", None, None);
        // The job timer starts when the engine process starts, not when the
        // first log line arrives.
        let started = Instant::now();
        let mut child = cmd.spawn().map_err(|err| anyhow!(
            "无法启动 BabelDOC（{}）：{err}。请在 设置 → 翻译引擎 检查可执行文件路径",
            babeldoc.display()
        ))?;
        let stdout = child.stdout.take().ok_or_else(|| anyhow!("no stdout"))?;
        let mut log_file = log;
        let mut last_phase = String::new();
        let mut progress = ProgressTracker::new(started);
        let status = wait_for_engine(&mut child, stdout, &cancel, |line| {
            let _ = writeln!(log_file, "{line}");
            let phase = if line.contains("Translating") || line.contains("Translate paragraph") {
                "translating"
            } else if line.contains("Typesetting") || line.contains("typeset") {
                "typesetting"
            } else if line.contains("Save PDF") || line.contains("saving") {
                "validating"
            } else { "" };
            if !phase.is_empty() && phase != last_phase {
                last_phase = phase.to_string();
                library.set_job_status(&job_id, phase, None, None);
            }
            // Real BabelDOC percentages reach the desktop event bridge and the
            // tablet SSE stream; at most one event per second (phase changes
            // excepted) so the log noise cannot flood the channel.
            if let Some(update) = progress.observe(&line, &last_phase, Instant::now()) {
                let phase = if last_phase.is_empty() { "parsing" } else { last_phase.as_str() };
                library.emit(progress_event(&job_id, phase, &update));
            }
        })?;
        if cancel.load(Ordering::SeqCst) {
            return Err(anyhow!("cancelled"));
        }
        if !status.success() {
            return Err(anyhow!("engine exited with {status}"));
        }
        let output = std::fs::read_dir(&run_dir)?
            .filter_map(|e| e.ok())
            .map(|e| e.path())
            .find(|p| p.extension().map(|x| x == "pdf").unwrap_or(false) && p.file_name().map(|n| n.to_string_lossy().contains(".mono.")).unwrap_or(false))
            .ok_or_else(|| anyhow!("engine produced no PDF"))?;
        Ok(output)
    })();

    match result {
        Ok(output) => {
            // The output PDF lives inside `run_dir`, but that directory must be
            // gone by the time the job row says "completed" (BUG-06).  Move it
            // to a sibling temp file inside the library first, remove the run
            // directory, then attach it.  A rename on the same filesystem is
            // cheap even for a large PDF; the fallback keeps the old order if
            // the rename is refused.
            let staged = library.root().join("tmp").join(format!("job-{job_id}.mono.pdf"));
            let (prepared, staged_ok) = match std::fs::rename(&output, &staged) {
                Ok(()) => (staged.clone(), true),
                Err(_) => (output.clone(), false),
            };
            cleanup_run_dir(&run_dir);
            let attached = library.attach_translation(&paper_id, &prepared, &job_id, source_version_id.as_deref());
            if staged_ok {
                let _ = std::fs::remove_file(&prepared);
            }
            match attached {
                Ok(_) => {},
                Err(err) if cancel.load(Ordering::SeqCst)||err.to_string()=="cancelled" => library.set_job_status(&job_id,"cancelled",None,None),
                Err(err) => library.set_job_status(&job_id, "failed", Some(&err.to_string()), None),
            }
        }
        Err(err) if cancel.load(Ordering::SeqCst)||err.to_string() == "cancelled" => {
            cleanup_run_dir(&run_dir);
            library.set_job_status(&job_id, "cancelled", None, None)
        }
        Err(err) => {
            // BUG-06: fold the useful tail of babeldoc.log into the error, then
            // remove the whole directory so no full-size PDF is left behind.
            let detail = read_log_tail(&run_dir.join("babeldoc.log"), MAX_ERROR_LOG_TAIL)
                .map(|tail| format!("{err}\n\nBabelDOC 日志（截断）：\n{tail}"))
                .unwrap_or_else(|| err.to_string());
            cleanup_run_dir(&run_dir);
            library.set_job_status(&job_id, "failed", Some(&detail), None)
        }
    }
    library.clear_cancel(&job_id);
}

// Monitor cancellation independently of log output. Engines may be silent or
// buffer rich progress for minutes; blocking read_line must not block cancel.
fn wait_for_engine(
    child: &mut std::process::Child,
    stdout: std::process::ChildStdout,
    cancel: &AtomicBool,
    mut on_line: impl FnMut(String),
) -> Result<std::process::ExitStatus> {
    let (send, recv) = std::sync::mpsc::sync_channel(128);
    std::thread::spawn(move || {
        for line in BufReader::new(stdout).lines().map_while(Result::ok) {
            if send.send(line).is_err() { break; }
        }
    });
    let mut cancelling_since: Option<Instant> = None;
    loop {
        if cancel.load(Ordering::SeqCst) {
            let first = cancelling_since.is_none();
            let since = cancelling_since.get_or_insert_with(Instant::now);
            #[cfg(unix)]
            if first || since.elapsed() >= Duration::from_secs(2) {
                unsafe { libc::killpg(child.id() as i32, if first { libc::SIGTERM } else { libc::SIGKILL }); }
            }
            #[cfg(windows)]
            if first {
                use std::os::windows::process::CommandExt;
                let _=Command::new("taskkill.exe").args(["/PID",&child.id().to_string(),"/T","/F"]).creation_flags(0x08000000).stdout(Stdio::null()).stderr(Stdio::null()).status();
                let _=child.kill();
            }
            #[cfg(not(any(unix,windows)))]
            {let _=(first,since);let _=child.kill();}
        }
        match recv.recv_timeout(Duration::from_millis(50)) {
            Ok(line) => on_line(line),
            Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {},
            Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => break,
        }
        if child.try_wait()?.is_some() { break; }
    }
    Ok(child.wait()?)
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    #[test]
    fn cancels_a_silent_engine_without_waiting_for_a_log_line() {
        use std::os::unix::process::CommandExt;
        let mut command=Command::new("sh");
        command.args(["-c", "sleep 30"]).stdout(Stdio::piped());
        unsafe { command.pre_exec(|| { libc::setsid(); Ok(()) }); }
        let mut child=command.spawn().unwrap();
        let stdout=child.stdout.take().unwrap();
        let cancel=AtomicBool::new(true);
        let started=Instant::now();
        assert!(!wait_for_engine(&mut child,stdout,&cancel, |_|{}).unwrap().success());
        assert!(started.elapsed()<Duration::from_secs(3));
    }
}

#[cfg(test)]
mod diagnostic_tests {
    use super::*;

    #[test]
    fn normalizes_base_urls_and_rejects_unsafe_addresses() {
        assert_eq!(
            normalize_upstream("https://provider.example/v1/").unwrap(),
            "https://provider.example/v1"
        );
        assert_eq!(
            normalize_upstream("  https://provider.example/v1/chat/completions  ").unwrap(),
            "https://provider.example/v1"
        );
        for bad in [
            "",
            "   ",
            "file:///tmp/socket",
            "https://user:password@example.test/v1",
            "https://example.test/v1?key=leak",
            "https://example.test/v1#fragment",
            "provider.example/v1",
        ] {
            assert!(normalize_upstream(bad).is_err(), "{bad} 应被拒绝");
        }
    }

    #[cfg(unix)]
    #[test]
    fn check_babeldoc_finds_an_executable_and_reports_its_version() {
        use std::os::unix::fs::PermissionsExt;
        let root = std::env::temp_dir().join(format!("moonlight-babeldoc-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let binary = root.join("babeldoc");
        std::fs::write(&binary, "#!/bin/sh\necho 'babeldoc, version 0.5.5'\n").unwrap();
        std::fs::set_permissions(&binary, std::fs::Permissions::from_mode(0o755)).unwrap();
        let binary_text = binary.to_string_lossy().to_string();
        let result = check_babeldoc(Some(&binary_text));
        assert_eq!(result["ok"], json!(true), "{result}");
        assert_eq!(result["path"].as_str().unwrap(), binary_text);
        assert_eq!(result["version"], json!("babeldoc, version 0.5.5"));
        // A file that is not named like BabelDOC is never executed.
        let impostor = root.join("not-a-launcher");
        std::fs::write(&impostor, "#!/bin/sh\necho nope\n").unwrap();
        std::fs::set_permissions(&impostor, std::fs::Permissions::from_mode(0o755)).unwrap();
        let impostor_text = impostor.to_string_lossy().to_string();
        let rejected = check_babeldoc(Some(&impostor_text));
        assert_eq!(rejected["ok"], json!(false), "{rejected}");
        assert!(rejected["error"].as_str().unwrap().contains("babeldoc"));
        std::fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn bundled_babeldoc_prefers_packaged_bin_then_repository_tools() {
        let root = std::env::temp_dir().join(format!("moonlight-bundled-{}", uuid::Uuid::new_v4()));
        let binary = if cfg!(windows) { "babeldoc.exe" } else { "babeldoc" };
        let packaged = root.join("bin").join("babeldoc").join(binary);
        std::fs::create_dir_all(packaged.parent().unwrap()).unwrap();
        std::fs::write(&packaged, b"fixture").unwrap();
        assert_eq!(bundled_babeldoc(&root), Some(packaged.clone()));
        std::fs::remove_dir_all(root.join("bin")).unwrap();
        let repo_tools = root.join("tools").join("windows").join("babeldoc").join(binary);
        std::fs::create_dir_all(repo_tools.parent().unwrap()).unwrap();
        std::fs::write(&repo_tools, b"fixture").unwrap();
        assert_eq!(bundled_babeldoc(&root), Some(repo_tools));
        std::fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn check_babeldoc_reports_a_missing_binary() {
        let missing = std::env::temp_dir()
            .join(format!("moonlight-missing-{}", uuid::Uuid::new_v4()))
            .join("babeldoc");
        let missing_text = missing.to_string_lossy().to_string();
        let result = check_babeldoc(Some(&missing_text));
        assert_eq!(result["ok"], json!(false), "{result}");
        assert!(result["error"].as_str().unwrap().contains("未找到"), "{result}");
    }

    /// BUG-06: `Gateway::update` swaps upstream/model/key without touching the
    /// loopback address or token, so every client already pointed at this port
    /// keeps working across a settings save.
    #[test]
    fn gateway_update_reuses_the_listener_and_token() {
        let log = std::env::temp_dir().join(format!("moonlight-usage-{}.jsonl", uuid::Uuid::new_v4()));
        let (upstream_a, seen_a) = mock_capturing_upstream("{\"choices\":[{\"message\":{\"content\":\"A\"}}]}");
        let (upstream_b, seen_b) = mock_capturing_upstream("{\"choices\":[{\"message\":{\"content\":\"B\"}}]}");
        let mut gateway = start_gateway(upstream_a, "model-a".into(), "key-a".into(), log.clone()).unwrap();
        let base_url = gateway.base_url.clone();
        let token = gateway.token.clone();
        assert_eq!(chat(&gateway, vec![json!({"role":"user","content":"hi"})], 0.0).unwrap(), "A");
        assert!(seen_a.lock().unwrap().contains("\"model\":\"model-a\""), "the first upstream receives the configured model");

        gateway.update(upstream_b, "model-b".into(), "key-b".into());
        assert_eq!(gateway.base_url, base_url, "the listener address must not change");
        assert_eq!(gateway.token, token, "the token must not rotate");
        assert_eq!(gateway.model, "model-b");
        assert_eq!(chat(&gateway, vec![json!({"role":"user","content":"hi"})], 0.0).unwrap(), "B");
        assert!(seen_b.lock().unwrap().contains("\"model\":\"model-b\""), "the new model must reach the new upstream");
        gateway.shutdown();
        let _ = std::fs::remove_file(&log);
    }

    #[test]
    fn run_dir_cleanup_keeps_a_bounded_log_tail_for_diagnostics() {
        let root = std::env::temp_dir().join(format!("moonlight-clean-{}", uuid::Uuid::new_v4()));
        let run_dir = root.join("job-x");
        std::fs::create_dir_all(run_dir.join("nested")).unwrap();
        std::fs::write(run_dir.join("result.mono.pdf"), b"%PDF-full-size").unwrap();
        let log = run_dir.join("babeldoc.log");
        std::fs::write(&log, format!("{}FINAL ENGINE ERROR\n", "x".repeat(10_000))).unwrap();
        let tail = read_log_tail(&log, 256).expect("the tail must survive for the error message");
        assert!(tail.chars().count() <= 256, "the tail is truncated: {}", tail.len());
        assert!(tail.contains("FINAL ENGINE ERROR"), "{tail}");
        cleanup_run_dir(&run_dir);
        assert!(!run_dir.exists(), "the whole working directory is removed");
        assert!(read_log_tail(&log, 256).is_none(), "no log is left behind");
        let _ = std::fs::remove_dir_all(root);
    }

    #[cfg(unix)]
    #[test]
    fn failed_translation_cleans_the_run_dir_after_reading_the_log_tail() {
        use rusqlite::params;
        use std::os::unix::fs::PermissionsExt;
        let root = std::env::temp_dir().join(format!("moonlight-jobclean-{}", uuid::Uuid::new_v4()));
        let lib = Library::new(&root).unwrap();
        lib.conn().execute("INSERT INTO papers(id,title,authors,imported_at,updated_at) VALUES('p','Tmp','',0,0)", []).unwrap();
        lib.conn().execute("INSERT INTO versions(id,paper_id,kind,sha256,rel_path,pages,bytes,created_at) VALUES('v','p','source','h','files/s.pdf',1,1,0)", []).unwrap();
        let fake = root.join("fake-babeldoc");
        std::fs::write(
            &fake,
            "#!/bin/sh\nout=\"\"\nwhile [ $# -gt 0 ]; do case \"$1\" in --output) out=\"$2\"; shift 2;; *) shift;; esac; done\nmkdir -p \"$out\"\necho 'INFO starting engine' >&2\necho 'FATAL engine blew up: token budget exceeded' >&2\nexit 3\n",
        ).unwrap();
        std::fs::set_permissions(&fake, std::fs::Permissions::from_mode(0o755)).unwrap();
        lib.reload_gateway(&json!({
            "base_url": "http://127.0.0.1:1/v1",
            "model": "m",
            "api_key": "k",
            "babeldoc": fake.to_string_lossy(),
        })).unwrap();
        let job_id = "job-cleanup".to_string();
        lib.conn().execute("INSERT INTO jobs(id,paper_id,status,pages,created_at,updated_at) VALUES(?,'p','queued',NULL,0,0)", params![job_id]).unwrap();
        let source = Path::new(env!("CARGO_MANIFEST_DIR")).join("../samples/generated/narrow-column.pdf");
        run_translation(lib.clone(), job_id.clone(), "p".into(), source, None, None);
        let job = lib.get_job(&job_id).unwrap();
        assert_eq!(job["status"], json!("failed"), "{job}");
        let error = job["error"].as_str().unwrap_or_default();
        assert!(error.contains(" blew up"), "the log tail must reach the job error: {error}");
        assert!(error.contains("BabelDOC 日志（截断）"), "{error}");
        let run_dir = root.join("tmp").join(format!("job-{job_id}"));
        assert!(!run_dir.exists(), "no run directory or full-size PDF may be left behind");
        drop(lib);
        std::fs::remove_dir_all(root).unwrap();
    }

    fn mock_sse_upstream(body: &'static str) -> String {
        mock_capturing_upstream(body).0
    }

    /// SSE upstream that also records the request body (for header assertions).
    fn mock_capturing_upstream(body: &'static str) -> (String, Arc<std::sync::Mutex<String>>) {
        let server = Server::http("127.0.0.1:0").unwrap();
        let port = match server.server_addr() {
            tiny_http::ListenAddr::IP(addr) => addr.port(),
            _ => panic!("mock upstream is not listening on IP"),
        };
        let captured = Arc::new(std::sync::Mutex::new(String::new()));
        let sink = captured.clone();
        std::thread::spawn(move || {
            for mut request in server.incoming_requests() {
                let mut text = String::new();
                let _ = request.as_reader().read_to_string(&mut text);
                *sink.lock().unwrap() = text;
                let response = Response::from_string(body)
                    .with_header(header("Content-Type", "text/event-stream"));
                let _ = request.respond(response);
            }
        });
        (format!("http://127.0.0.1:{port}/v1"), captured)
    }

    #[test]
    fn gateway_honours_a_per_request_chat_model_override() {
        let (upstream, captured) = mock_capturing_upstream("data: [DONE]\n\n");
        let log = std::env::temp_dir().join(format!("moonlight-usage-{}.jsonl", uuid::Uuid::new_v4()));
        let mut gateway = start_gateway(upstream, "translation-model".into(), "sk-test".into(), log.clone()).unwrap();
        // The AI panel clones the gateway and swaps only the chat model.
        gateway.model = "chat-model".into();
        let cancel = AtomicBool::new(false);
        chat_stream(&gateway, vec![json!({"role":"user","content":"hi"})], 0.1, &cancel, |_| {}).unwrap();
        let deadline = Instant::now() + Duration::from_secs(2);
        let body = loop {
            let text = captured.lock().unwrap().clone();
            if !text.is_empty() { break text; }
            assert!(Instant::now() < deadline, "upstream never received the request");
            std::thread::sleep(Duration::from_millis(20));
        };
        assert!(body.contains("\"model\":\"chat-model\""), "per-request model must reach upstream: {body}");
        gateway.shutdown();
        let _ = std::fs::remove_file(&log);
    }

    #[test]
    fn relay_streams_deltas_and_returns_the_full_answer() {
        let upstream = mock_sse_upstream(
            "data: {\"choices\":[{\"delta\":{\"content\":\"你\"}}]}\n\n\
             data: {\"choices\":[{\"delta\":{\"content\":\"好\"}}]}\n\n\
             data: [DONE]\n\n",
        );
        let log = std::env::temp_dir().join(format!("moonlight-usage-{}.jsonl", uuid::Uuid::new_v4()));
        let gateway = start_gateway(upstream, "test-model".into(), "sk-test".into(), log.clone()).unwrap();
        let cancel = AtomicBool::new(false);
        let mut seen = Vec::new();
        let answer = chat_stream(
            &gateway,
            vec![json!({"role":"user","content":"hi"})],
            0.1,
            &cancel,
            |text| seen.push(text.to_string()),
        )
        .unwrap();
        assert_eq!(answer, "你好");
        assert_eq!(seen, vec!["你".to_string(), "你好".to_string()]);
        // The usage log is appended right after the relay finishes, which can be
        // a scheduling tick after the caller returns: poll briefly instead of
        // racing the gateway thread (this test used to flake in parallel runs).
        let deadline = Instant::now() + Duration::from_secs(2);
        let mut log_text = String::new();
        while Instant::now() < deadline {
            log_text = std::fs::read_to_string(&log).unwrap_or_default();
            if log_text.contains("\"stream\":true") { break; }
            std::thread::sleep(Duration::from_millis(20));
        }
        assert!(log_text.contains("\"stream\":true"), "{log_text}");
        gateway.shutdown();
        let _ = std::fs::remove_file(&log);
    }

    #[test]
    fn streamed_chat_stops_when_cancelled() {
        let upstream = mock_sse_upstream(
            "data: {\"choices\":[{\"delta\":{\"content\":\"部分\"}}]}\n\ndata: [DONE]\n\n",
        );
        let log = std::env::temp_dir().join(format!("moonlight-usage-{}.jsonl", uuid::Uuid::new_v4()));
        let gateway = start_gateway(upstream, "test-model".into(), "sk-test".into(), log.clone()).unwrap();
        let cancel = AtomicBool::new(true);
        let error = chat_stream(&gateway, vec![json!({"role":"user","content":"hi"})], 0.1, &cancel, |_| {})
            .unwrap_err()
            .to_string();
        assert!(error.contains("已停止生成"), "{error}");
        gateway.shutdown();
        let _ = std::fs::remove_file(&log);
    }

    // ---- FEAT-UX-03 glossary -------------------------------------------

    #[test]
    fn glossary_csv_quotes_and_scales() {
        let csv = glossary_csv(&[
            ("Attention".into(), "注意力".into()),
            ("Machine, Learning".into(), "机器学习".into()),
            ("say \"hi\"".into(), "说“嗨”".into()),
        ]);
        assert_eq!(
            csv,
            "source,target\nAttention,注意力\n\"Machine, Learning\",机器学习\n\"say \"\"hi\"\"\",说“嗨”\n"
        );
        assert_eq!(glossary_csv(&[]), "source,target\n");
    }

    #[cfg(unix)]
    fn script_with(body: &str) -> std::path::PathBuf {
        use std::os::unix::fs::PermissionsExt;
        let path = std::env::temp_dir().join(format!("moonlight-babeldoc-fixture-{}", uuid::Uuid::new_v4()));
        std::fs::write(&path, body).unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
        path
    }

    #[cfg(unix)]
    #[test]
    fn glossary_option_is_detected_from_babeldoc_help_without_false_positives() {
        let modern = script_with("#!/bin/sh\nif [ \"$1\" = \"--help\" ]; then\n  echo 'usage: babeldoc [--glossary-files GLOSSARY_FILES] [--term-pool-max-workers N]'\n  exit 0\nfi\nexit 0\n");
        assert_eq!(glossary_option(&modern), Some("--glossary-files"));
        let legacy = script_with("#!/bin/sh\nif [ \"$1\" = \"--help\" ]; then\n  echo 'usage: babeldoc [--glossary GLOSSARY]'\n  exit 0\nfi\nexit 0\n");
        assert_eq!(glossary_option(&legacy), Some("--glossary"));
        let term = script_with("#!/bin/sh\nif [ \"$1\" = \"--help\" ]; then\n  echo 'usage: babeldoc [--term TERM]'\n  exit 0\nfi\nexit 0\n");
        assert_eq!(glossary_option(&term), Some("--term"));
        // `--term-pool-max-workers` must never be mistaken for a glossary switch.
        let pool_only = script_with("#!/bin/sh\nif [ \"$1\" = \"--help\" ]; then\n  echo 'usage: babeldoc [--term-pool-max-workers N]'\n  exit 0\nfi\nexit 0\n");
        assert_eq!(glossary_option(&pool_only), None);
        let no_help = script_with("#!/bin/sh\nexit 7\n");
        assert_eq!(glossary_option(&no_help), None);
        for path in [modern, legacy, term, pool_only, no_help] {
            let _ = std::fs::remove_file(path);
        }
    }

    #[test]
    fn gateway_injects_glossary_only_for_the_fallback_window_and_is_idempotent() {
        let (upstream, captured) = mock_capturing_upstream("{\"choices\":[{\"message\":{\"content\":\"ok\"}}]}");
        let log = std::env::temp_dir().join(format!("moonlight-usage-{}.jsonl", uuid::Uuid::new_v4()));
        let gateway = start_gateway(upstream, "test-model".into(), "sk-test".into(), log.clone()).unwrap();
        gateway.set_glossary(vec![("Rollout".into(), "轨迹采样".into())]);
        let wait_body = |predicate: &dyn Fn(&str) -> bool| {
            let deadline = Instant::now() + Duration::from_secs(2);
            loop {
                let body = captured.lock().unwrap().clone();
                if predicate(&body) {
                    return body;
                }
                assert!(Instant::now() < deadline, "upstream never received the expected body: {body}");
                std::thread::sleep(Duration::from_millis(20));
            }
        };

        chat(&gateway, vec![json!({"role":"system","content":"base prompt"})], 0.0).unwrap();
        let plain = wait_body(&|body| body.contains("base prompt"));
        assert!(!plain.contains(crate::library::GLOSSARY_MARKER), "no injection outside the fallback window: {plain}");

        gateway.set_glossary_fallback(true);
        chat(&gateway, vec![json!({"role":"system","content":"babeldoc-style prompt"})], 0.0).unwrap();
        let injected = wait_body(&|body| body.contains("babeldoc-style prompt"));
        assert!(injected.contains(crate::library::GLOSSARY_MARKER), "{injected}");
        assert!(injected.contains("Rollout -> 轨迹采样"), "{injected}");
        assert_eq!(
            injected.matches(crate::library::GLOSSARY_MARKER).count(),
            1,
            "the marker appears once: {injected}"
        );

        // An AI prompt that already carries the table is untouched.
        chat(&gateway, vec![json!({"role":"system","content":format!("{} ai prompt", crate::library::GLOSSARY_MARKER)})], 0.0).unwrap();
        let untouched = wait_body(&|body| body.contains("ai prompt"));
        assert_eq!(untouched.matches(crate::library::GLOSSARY_MARKER).count(), 1, "{untouched}");

        // A request without a system message gets one prepended.
        chat(&gateway, vec![json!({"role":"user","content":"hi"})], 0.0).unwrap();
        let prepended = wait_body(&|body| body.contains("\"content\":\"hi\""));
        assert!(prepended.contains("\"role\":\"system\""), "{prepended}");
        assert!(prepended.contains(crate::library::GLOSSARY_MARKER), "{prepended}");

        gateway.set_glossary_fallback(false);
        chat(&gateway, vec![json!({"role":"system","content":"after window"})], 0.0).unwrap();
        let after = wait_body(&|body| body.contains("after window"));
        assert!(!after.contains(crate::library::GLOSSARY_MARKER), "{after}");
        gateway.shutdown();
        let _ = std::fs::remove_file(&log);
    }

    #[cfg(unix)]
    #[test]
    fn run_translation_passes_a_glossary_csv_when_babeldoc_supports_it() {
        use rusqlite::params;
        let root = std::env::temp_dir().join(format!("moonlight-glossary-job-{}", uuid::Uuid::new_v4()));
        let lib = Library::new(&root).unwrap();
        lib.conn().execute("INSERT INTO papers(id,title,authors,imported_at,updated_at) VALUES('p','Paper','',0,0)", []).unwrap();
        lib.conn().execute("INSERT INTO versions(id,paper_id,kind,sha256,rel_path,pages,bytes,created_at) VALUES('v','p','source','h','files/s.pdf',1,1,0)", []).unwrap();
        lib.save_glossary(&json!({"terms":[{"source":"Attention","target":"注意力"}]})).unwrap();
        let args_file = root.join("args.txt");
        let fake = script_with(&format!(
            "#!/bin/sh\nif [ \"$1\" = \"--help\" ]; then\n  echo 'usage: babeldoc [--glossary-files GLOSSARY_FILES]'\n  exit 0\nfi\nprintf '%s\\n' \"$@\" > '{}'\necho 'FATAL fake engine' >&2\nexit 3\n",
            args_file.display()
        ));
        lib.reload_gateway(&json!({
            "base_url":"http://127.0.0.1:1/v1","model":"m","api_key":"k","babeldoc":fake.to_string_lossy()
        })).unwrap();
        let job_id = "job-glossary".to_string();
        lib.conn().execute("INSERT INTO jobs(id,paper_id,status,pages,created_at,updated_at) VALUES(?,'p','queued',NULL,0,0)", params![job_id]).unwrap();
        let source = Path::new(env!("CARGO_MANIFEST_DIR")).join("../samples/generated/narrow-column.pdf");
        run_translation(lib.clone(), job_id.clone(), "p".into(), source, None, None);
        let args = std::fs::read_to_string(&args_file).unwrap();
        assert!(args.contains("--glossary-files"), "glossary switch must be forwarded: {args}");
        assert!(args.contains("glossary.csv"), "the temp CSV path must be forwarded: {args}");
        assert_eq!(lib.get_job(&job_id).unwrap()["status"], json!("failed"));
        // The fallback flag is scoped to the job and must be off afterwards.
        let gateway = lib.gateway().unwrap();
        assert!(!gateway.glossary_fallback.load(Ordering::SeqCst), "fallback is reset after the job");
        gateway.shutdown();
        let _ = std::fs::remove_file(fake);
        drop(lib);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn run_translation_uses_the_gateway_fallback_when_no_glossary_switch_exists() {
        use rusqlite::params;
        let root = std::env::temp_dir().join(format!("moonlight-glossary-fallback-{}", uuid::Uuid::new_v4()));
        let lib = Library::new(&root).unwrap();
        lib.conn().execute("INSERT INTO papers(id,title,authors,imported_at,updated_at) VALUES('p','Paper','',0,0)", []).unwrap();
        lib.conn().execute("INSERT INTO versions(id,paper_id,kind,sha256,rel_path,pages,bytes,created_at) VALUES('v','p','source','h','files/s.pdf',1,1,0)", []).unwrap();
        lib.save_glossary(&json!({"terms":[{"source":"Attention","target":"注意力"}]})).unwrap();
        let args_file = root.join("args.txt");
        let fake = script_with(&format!(
            "#!/bin/sh\nif [ \"$1\" = \"--help\" ]; then\n  echo 'usage: babeldoc [--term-pool-max-workers N]'\n  exit 0\nfi\nprintf '%s\\n' \"$@\" > '{}'\necho 'FATAL fake engine' >&2\nexit 3\n",
            args_file.display()
        ));
        lib.reload_gateway(&json!({
            "base_url":"http://127.0.0.1:1/v1","model":"m","api_key":"k","babeldoc":fake.to_string_lossy()
        })).unwrap();
        let job_id = "job-glossary-fallback".to_string();
        lib.conn().execute("INSERT INTO jobs(id,paper_id,status,pages,created_at,updated_at) VALUES(?,'p','queued',NULL,0,0)", params![job_id]).unwrap();
        let source = Path::new(env!("CARGO_MANIFEST_DIR")).join("../samples/generated/narrow-column.pdf");
        run_translation(lib.clone(), job_id.clone(), "p".into(), source, None, None);
        let args = std::fs::read_to_string(&args_file).unwrap();
        assert!(!args.contains("--glossary"), "unsupported builds must not receive a glossary flag: {args}");
        let gateway = lib.gateway().unwrap();
        assert!(!gateway.glossary_fallback.load(Ordering::SeqCst), "fallback is reset after the job");
        assert_eq!(gateway.glossary_terms(), vec![("Attention".to_string(), "注意力".to_string())], "terms stay available for the next fallback");
        gateway.shutdown();
        let _ = std::fs::remove_file(fake);
        drop(lib);
        std::fs::remove_dir_all(root).unwrap();
    }
}

#[cfg(test)]
mod progress_tests {
    use super::*;

    #[test]
    fn parses_percent_progress_and_trims_the_detail() {
        let (percent, detail) = parse_progress_line("  Translating  \t 42% of paragraphs  ").unwrap();
        assert_eq!(percent, 42);
        assert_eq!(detail, "Translating 42% of paragraphs");
    }

    #[test]
    fn parses_decimal_percent_without_regressing_to_its_fraction() {
        assert_eq!(parse_progress_line("Typesetting 87.5% done").unwrap().0, 88);
        assert_eq!(parse_progress_line("translating 0%").unwrap().0, 0);
    }

    #[test]
    fn parses_page_ratios_with_units_before_and_after() {
        assert_eq!(parse_progress_line("12/30 pages").unwrap().0, 40);
        assert_eq!(parse_progress_line("第 3 / 10 页").unwrap().0, 30);
        assert_eq!(parse_progress_line("PAGE 7/10").unwrap().0, 70);
        // A zero total is meaningless and must not produce a division.
        assert!(parse_progress_line("0/0 pages").is_none());
    }

    #[test]
    fn strips_ansi_sequences_and_keeps_the_last_carriage_return_rewrite() {
        let line = "\u{1b}[2K\u{1b}[1mTranslating\u{1b}[0m 87%\r\
                    \u{1b}[2K\u{1b}[1mTranslating\u{1b}[0m 91%\r";
        let (percent, detail) = parse_progress_line(line).unwrap();
        assert_eq!(percent, 91);
        assert_eq!(detail, "Translating 91%");
        assert!(!detail.contains('\u{1b}'), "ANSI must be stripped: {detail:?}");
    }

    #[test]
    fn ignores_log_noise_without_a_number() {
        for line in [
            "",
            "   ",
            "INFO: engine ready",
            "[2026-11-21 10:00:00] starting translation",
            "\u{1b}[0m",
        ] {
            assert!(parse_progress_line(line).is_none(), "{line:?} must not move progress");
        }
    }

    #[test]
    fn clamps_percentages_and_rejects_four_digit_runs() {
        assert_eq!(parse_progress_line("250%").unwrap().0, 100);
        assert!(parse_progress_line("1234%").is_none(), "four digits are not a percentage");
    }

    #[test]
    fn collapses_whitespace_and_drops_control_characters() {
        assert_eq!(clean_line("  Translating\t\t  page  3 \u{7}"), "Translating page 3");
        assert_eq!(clean_line("\u{1b}[2K\r"), "");
    }

    #[test]
    fn caps_the_detail_at_the_character_limit() {
        let line = format!("42% {}", "z".repeat(400));
        let (percent, detail) = parse_progress_line(&line).unwrap();
        assert_eq!(percent, 42);
        assert_eq!(detail.chars().count(), MAX_DETAIL_CHARS);
        assert!(detail.ends_with('…'), "{detail}");
        // Truncation never splits a multi-byte character.
        let chinese = format!("{} 50%", "译".repeat(400));
        let (_, detail) = parse_progress_line(&chinese).unwrap();
        assert_eq!(detail.chars().count(), MAX_DETAIL_CHARS);
    }

    #[test]
    fn progress_never_regresses_inside_a_run() {
        let t0 = Instant::now();
        let mut tracker = ProgressTracker::new(t0);
        assert_eq!(tracker.observe("60%", "translating", t0).unwrap().percent, 60);
        let later = t0 + Duration::from_secs(2);
        let update = tracker.observe("40% after an engine restart", "translating", later).unwrap();
        assert_eq!(update.percent, 60, "the maximum percentage is sticky");
    }

    #[test]
    fn throttles_to_one_event_per_second_and_emits_phase_changes() {
        let t0 = Instant::now();
        let mut tracker = ProgressTracker::new(t0);
        let first = tracker.observe("10%", "parsing", t0).expect("first line emits");
        assert_eq!(first.percent, 10);
        assert_eq!(first.elapsed_ms, 0);
        assert!(tracker
            .observe("11%", "parsing", t0 + Duration::from_millis(999))
            .is_none());
        // A phase change bypasses the throttle.
        let phase = tracker
            .observe("12%", "translating", t0 + Duration::from_millis(250))
            .expect("phase change emits immediately");
        assert_eq!(phase.percent, 12);
        assert_eq!(phase.elapsed_ms, 250);
        // The one-second window restarts at the last emitted event.
        assert!(tracker
            .observe("13%", "translating", t0 + Duration::from_millis(1000))
            .is_none());
        let next = tracker
            .observe("14%", "translating", t0 + Duration::from_millis(1250))
            .expect("due again after one second");
        assert_eq!(next.percent, 14);
        // A phase change alone (no percentage on the line) still emits.
        let phase_only = tracker
            .observe("Save PDF", "validating", t0 + Duration::from_millis(1300))
            .expect("phase change without a number emits");
        assert_eq!(phase_only.percent, 14);
        // Noise inside the same window is dropped.
        assert!(tracker
            .observe("INFO: tick", "validating", t0 + Duration::from_millis(1400))
            .is_none());
    }

    #[test]
    fn builds_the_job_event_payload() {
        let update = ProgressUpdate {
            percent: 42,
            detail: "Translating 42%".into(),
            elapsed_ms: 1234,
        };
        let event = progress_event("job-1", "translating", &update);
        assert_eq!(event["event"], json!("job"));
        assert_eq!(event["jobId"], json!("job-1"));
        assert_eq!(event["status"], json!("translating"));
        assert_eq!(event["phase"], json!("translating"));
        assert_eq!(event["progress"], json!(42));
        assert_eq!(event["detail"], json!("Translating 42%"));
        assert_eq!(event["elapsed_ms"], json!(1234));
    }
}
