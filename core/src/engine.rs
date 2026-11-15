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
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tiny_http::{Header, Method, Response, Server};

#[derive(Clone)]
pub struct Gateway {
    pub base_url: String,
    pub token: String,
    pub model: String,
}

fn header(name: &str, value: &str) -> Header {
    Header::from_bytes(name.as_bytes(), value.as_bytes()).unwrap()
}

pub fn start_gateway(upstream: String, model: String, key: String, usage_log: PathBuf) -> Result<Gateway> {
    let server = Server::http("127.0.0.1:0").map_err(|e| anyhow!("gateway bind: {e}"))?;
    let port = match server.server_addr() {
        tiny_http::ListenAddr::IP(addr) => addr.port(),
        _ => return Err(anyhow!("gateway is not listening on IP")),
    };
    let token = uuid::Uuid::new_v4().to_string();
    let gateway = Gateway {
        base_url: format!("http://127.0.0.1:{port}/v1"),
        token: token.clone(),
        model: model.clone(),
    };
    let upstream = upstream.trim_end_matches('/').to_string();
    let session = uuid::Uuid::new_v4().to_string();
    let upstream_key = key.clone();
    let log_path = usage_log.clone();
    std::thread::Builder::new()
        .name("model-gateway".into())
        .spawn(move || {
            let client = reqwest::blocking::Client::builder()
                .timeout(Duration::from_secs(600))
                .build()
                .expect("http client");
            for request in server.incoming_requests() {
                let client = client.clone();
                let upstream = upstream.clone();
                let token = token.clone();
                let model = model.clone();
                let session = session.clone();
                let upstream_key = upstream_key.clone();
                let log_path = log_path.clone();
                std::thread::spawn(move || {
                    let _ = handle(request, &client, &upstream, &upstream_key, &token, &model, &session, &log_path);
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
    let mut payload: Value = serde_json::from_str(&body).unwrap_or_else(|_| json!({"error": "invalid json"}));
    let routed=reqwest::Url::parse(upstream).ok().and_then(|url|url.host_str().map(str::to_string)).as_deref()==Some("opencode.ai");
    if let Value::Object(ref mut map) = payload {
        map.insert("model".into(), Value::String(model.to_string()));
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
    let started = Instant::now();
    let mut upstream_request = client
        .post(format!("{upstream}/chat/completions"))
        .bearer_auth(upstream_key)
        .header("Content-Type", "application/json")
        .json(&payload);
    if routed {upstream_request=upstream_request.header("x-opencode-session",session);}
    let response=upstream_request.send();
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

fn chrono_stamp() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let secs = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
    format!("{secs}")
}

/// Chat completion through the gateway (used by the AI panel).
pub fn chat(gateway: &Gateway, messages: Vec<Value>, temperature: f64) -> Result<String> {
    let client = reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(300))
        .build()?;
    let resp = client
        .post(format!("{}/chat/completions", gateway.base_url.trim_end_matches('/')))
        .bearer_auth(&gateway.token)
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

fn probe_url(base_url: &str, bearer: &str, model: &str, timeout: Duration) -> Value {
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

/// Run one translation job.  Called on a background thread.
pub fn run_translation(library: Arc<Library>, job_id: String, paper_id: String, source_path: PathBuf, pages: Option<String>) {
    let cancel = library.cancel_flag(&job_id);
    let result = (|| -> Result<PathBuf> {
        if cancel.load(Ordering::SeqCst){return Err(anyhow!("cancelled"));}
        let gateway = library.gateway().ok_or_else(|| anyhow!("model is not configured"))?;
        let run_dir = library.root().join("tmp").join(format!("job-{job_id}"));
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
        let mut child = cmd.spawn().map_err(|err| anyhow!(
            "无法启动 BabelDOC（{}）：{err}。请在 设置 → 翻译引擎 检查可执行文件路径",
            babeldoc.display()
        ))?;
        let stdout = child.stdout.take().ok_or_else(|| anyhow!("no stdout"))?;
        let mut log_file = log;
        let mut last_phase = String::new();
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
            match library.attach_translation(&paper_id, &output, &job_id) {
                Ok(_) => {},
                Err(err) if cancel.load(Ordering::SeqCst)||err.to_string()=="cancelled" => library.set_job_status(&job_id,"cancelled",None,None),
                Err(err) => library.set_job_status(&job_id, "failed", Some(&err.to_string()), None),
            }
        }
        Err(err) if cancel.load(Ordering::SeqCst)||err.to_string() == "cancelled" => library.set_job_status(&job_id, "cancelled", None, None),
        Err(err) => library.set_job_status(&job_id, "failed", Some(&err.to_string()), None),
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
}
