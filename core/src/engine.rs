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

fn babeldoc_bin() -> PathBuf {
    if let Ok(p) = std::env::var("MOONLIGHT_BABELDOC_BIN") {
        return PathBuf::from(p);
    }
    let root = std::env::var("MOONLIGHT_ROOT").unwrap_or_else(|_| ".".into());
    let candidate = Path::new(&root).join(if cfg!(windows){".venv/Scripts/babeldoc.exe"}else{".venv/bin/babeldoc"});
    if candidate.exists() {
        candidate
    } else {
        PathBuf::from("babeldoc")
    }
}

/// Run one translation job.  Called on a background thread.
pub fn run_translation(library: Arc<Library>, job_id: String, paper_id: String, source_path: PathBuf, pages: Option<String>) {
    let cancel = library.cancel_flag(&job_id);
    let result = (|| -> Result<PathBuf> {
        if cancel.load(Ordering::SeqCst){return Err(anyhow!("cancelled"));}
        let gateway = library.gateway().ok_or_else(|| anyhow!("model is not configured"))?;
        let run_dir = library.root().join("tmp").join(format!("job-{job_id}"));
        std::fs::create_dir_all(&run_dir)?;
        let model = std::env::var("MOONLIGHT_MODEL").unwrap_or_else(|_| "qwen3.8-flash".into());
        let qps = std::env::var("MOONLIGHT_QPS").unwrap_or_else(|_| "6".into());
        let mut cmd = Command::new(babeldoc_bin());
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
            .arg(&qps)
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
        let mut child = cmd.spawn()?;
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
