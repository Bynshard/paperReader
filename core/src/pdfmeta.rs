//! PDF metadata and coarse text extraction.
//!
//! The renderer sends exact per-page block geometry after PDF.js has parsed a
//! document; this module only needs enough information to import a paper
//! (title/authors/year/DOI, page count, searchable text) before it is opened.

use anyhow::Result;
use lopdf::{Document, Object};
use regex::Regex;
use std::path::Path;

#[derive(Debug, Default, Clone, serde::Serialize, serde::Deserialize)]
pub struct PdfMeta {
    pub title: String,
    pub authors: String,
    pub year: Option<String>,
    pub venue: String,
    pub doi: Option<String>,
    pub arxiv: Option<String>,
    pub abstract_text: Option<String>,
    pub pages: i64,
}

fn info_string(doc: &Document, key: &[u8]) -> Option<String> {
    let info = doc.trailer.get(b"Info").ok()?.as_reference().ok()?;
    let dict = doc.get_dictionary(info).ok()?;
    let value = dict.get(key).ok()?;
    match value {
        Object::String(_, _) => {
            let text = lopdf::decode_text_string(value).ok()?;
            let text = text.trim().to_string();
            if text.is_empty() {
                None
            } else {
                Some(text)
            }
        }
        _ => None,
    }
}

fn regex_capture(patterns: &[(&str, &str)], text: &str) -> Option<String> {
    for (pat, _) in patterns {
        let re = Regex::new(pat).ok()?;
        if let Some(c) = re.captures(text) {
            if let Some(m) = c.get(1) {
                return Some(m.as_str().to_string());
            }
        }
    }
    None
}

fn clean(text: &str) -> String {
    text.split_whitespace().collect::<Vec<_>>().join(" ")
}

// Keep pdf-extract's process-global stdout redirection out of the RPC process.
// One persistent helper amortizes process startup over a whole import session.
// A bounded import queue in main serializes expensive imports; the mutex also
// protects callers from background tasks that inspect an attachment.
#[cfg(not(test))]
pub fn inspect(path: &Path) -> Result<(PdfMeta, String)> {
    use std::io::{BufRead, Write};
    use std::sync::{Mutex, OnceLock};
    static WORKER: OnceLock<Mutex<Option<Inspector>>> = OnceLock::new();
    let mut slot = WORKER.get_or_init(|| Mutex::new(None)).lock()
        .map_err(|_| anyhow::anyhow!("PDF inspector lock poisoned"))?;
    if slot.is_none() { *slot = Some(Inspector::start()?); }
    let worker = slot.as_mut().unwrap();
    let result = (|| {
        serde_json::to_writer(&mut worker.input, &path.to_string_lossy())?;
        worker.input.write_all(b"\n")?;
        worker.input.flush()?;
        let mut line = String::new();
        if worker.output.read_line(&mut line)? == 0 {
            return Err(anyhow::anyhow!("PDF inspector exited"));
        }
        let value: serde_json::Value = serde_json::from_str(&line)?;
        if let Some(error) = value.get("error").and_then(|v| v.as_str()) {
            return Err(anyhow::anyhow!("{error}"));
        }
        Ok(serde_json::from_value(value["result"].clone())?)
    })();
    if result.is_err() { *slot = None; }
    result
}

#[cfg(not(test))]
struct Inspector {
    child: std::process::Child,
    input: std::process::ChildStdin,
    output: std::io::BufReader<std::process::ChildStdout>,
}
#[cfg(not(test))]
impl Inspector {
    fn start() -> Result<Self> {
        use std::process::{Command, Stdio};
        let mut command=Command::new(std::env::current_exe()?);
        command.arg("--pdf-metadata-worker").stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null());
        #[cfg(windows)]
        {use std::os::windows::process::CommandExt;command.creation_flags(0x08000000);}
        let mut child=command.spawn()?;
        let input = child.stdin.take().unwrap();
        let output = std::io::BufReader::new(child.stdout.take().unwrap());
        Ok(Self { child, input, output })
    }
}
#[cfg(not(test))]
impl Drop for Inspector {
    fn drop(&mut self) { let _ = self.child.kill(); let _ = self.child.wait(); }
}

pub fn worker_main() -> Result<()> {
    use std::io::{BufRead, Write};
    for line in std::io::stdin().lock().lines() {
        let line = line?;
        let result = serde_json::from_str::<String>(&line)
            .map_err(anyhow::Error::from).and_then(|path| inspect_local(Path::new(&path)));
        let value = match result {
            Ok(result) => serde_json::json!({"result": result}),
            Err(error) => serde_json::json!({"error": error.to_string()}),
        };
        let mut out = std::io::stdout().lock();
        writeln!(out, "{value}")?;
        out.flush()?;
    }
    Ok(())
}

#[cfg(test)]
pub fn inspect(path: &Path) -> Result<(PdfMeta, String)> { inspect_local(path) }

fn inspect_local(path: &Path) -> Result<(PdfMeta, String)> {
    let doc = Document::load(path)?;
    let pages = doc.get_pages().len() as i64;
    let title_meta = info_string(&doc, b"Title");
    let author_meta = info_string(&doc, b"Author");
    let created = info_string(&doc, b"CreationDate").unwrap_or_default();
    drop(doc);
    // pdf-extract prints recovery diagnostics to stdout; the JSONL protocol
    // owns stdout, so capture-and-discard them while extracting.
    let text = {
        let mut sink = gag::BufferRedirect::stdout().ok();
        // Preserve real page boundaries. A whole-document string cannot be
        // indexed as page zero without giving the assistant false citations.
        let text = pdf_extract::extract_text_by_pages(path).unwrap_or_default().join("\u{000c}");
        drop(sink.take());
        text
    };
    let head: String = text.chars().take(6000).collect();
    let head_clean = clean(&head);

    let arxiv = regex_capture(&[(r"(?i)arXiv:\s*(\d{4}\.\d{4,5})", "")], &head);
    let doi = Regex::new(r"\b10\.\d{4,9}/[-._;()/:A-Za-z0-9]+\b")
        .ok()
        .and_then(|re| re.find(&head).map(|m| m.as_str().trim_end_matches(['.', ',', ';', ')']).to_string()));

    let mut year = arxiv.as_ref().and_then(|id| {
        if id.len() >= 4 {
            let yy: i32 = id[..2].parse().ok()?;
            Some((if yy < 90 { 2000 + yy } else { 1900 + yy }).to_string())
        } else {
            None
        }
    });
    if year.is_none() {
        if let Some(c) = Regex::new(r"D:(\d{4})").ok().and_then(|re| re.captures(&created)) {
            year = c.get(1).map(|m| m.as_str().to_string());
        }
    }
    if year.is_none() {
        year = Regex::new(r"\b(19|20)\d{2}\b")
            .ok()
            .and_then(|re| re.find_iter(&head_clean).map(|m| m.as_str().to_string()).filter(|y| {
                let n: i32 = y.parse().unwrap_or(0);
                (1990..=2030).contains(&n)
            }).max());
    }

    let mut title = title_meta.unwrap_or_default();
    if title.trim().is_empty() || title.to_lowercase().contains("untitled") {
        // No usable Info/Title: pick the most title-like early line.  Academic
        // PDFs put the title near the top, short and usually capitalised,
        // whereas the surrounding lines are copyright notes or author lists.
        let mut best: Option<(f32, String)> = None;
        for (idx, line) in head.lines().take(60).enumerate() {
            let line = line.trim();
            if line.len() < 10 || line.len() > 90 {
                continue;
            }
            let lower = line.to_lowercase();
            if lower.starts_with("arxiv") || line.contains('@') || lower.starts_with("http") || lower.starts_with("provided") {
                continue;
            }
            let words: Vec<&str> = line.split_whitespace().collect();
            if words.len() < 2 || words.len() > 14 || line.ends_with(',') {
                continue;
            }
            let caps = words.iter().filter(|w| w.chars().next().map(|c| c.is_uppercase()).unwrap_or(false)).count() as f32
                / words.len() as f32;
            let score = caps * 2.0 + if line.len() <= 60 { 1.0 } else { 0.0 } - idx as f32 * 0.02;
            if best.as_ref().map(|(s, _)| score > *s).unwrap_or(true) {
                best = Some((score, line.to_string()));
            }
        }
        title = best.map(|(_, t)| t).unwrap_or_else(|| "Untitled".into());
    }

    let mut authors = author_meta.unwrap_or_default();
    if authors.trim().is_empty() {
        let name_re = Regex::new(r"^[A-ZÀ-Ž][\w.'\-]+(?:\s+[A-ZÀ-Ž][\w.'\-]*){1,3}[∗†‡§¶]*$").unwrap();
        let bad = Regex::new(r"(?i)univers|institut|google|research|brain|department|school|laborator|@|http|www\.").unwrap();
        let mut names: Vec<String> = Vec::new();
        for line in head.lines().take(120) {
            let line = line.trim();
            if line.len() < 4 || line.len() > 70 || bad.is_match(line) || line.chars().any(|c| c.is_ascii_digit()) {
                continue;
            }
            if name_re.is_match(line) && !names.iter().any(|n| n == line) {
                names.push(line.trim_end_matches(['*', '∗', '†', '‡', '§', '¶']).trim().to_string());
            }
            if names.len() >= 10 {
                break;
            }
        }
        authors = names.join(", ");
    }

    let abstract_text = text
        .find("Abstract")
        .or_else(|| text.find("ABSTRACT"))
        .map(|idx| {
            let rest = &text[idx + 8..];
            let cut = rest
                .find("Introduction")
                .or_else(|| rest.find("1 Introduction"))
                .unwrap_or_else(|| rest.char_indices().nth(2000).map(|(i,_)|i).unwrap_or(rest.len()));
            clean(&rest[..cut]).chars().take(1600).collect::<String>()
        })
        .filter(|s| s.len() > 80);

    let venue = Regex::new(r"(?i)(NIPS|NeurIPS|ICLR|ICML|ACL|EMNLP|CVPR|ICCV|AAAI|OSDI|SOSP|SIGCOMM)\s*'?\d{2,4}")
        .ok()
        .and_then(|re| re.find(&head_clean).map(|m| m.as_str().to_string()))
        .unwrap_or_default();

    Ok((
        PdfMeta {
            title: title.trim().to_string(),
            authors: authors.trim().to_string(),
            year,
            venue,
            doi,
            arxiv,
            abstract_text,
            pages,
        },
        text,
    ))
}

pub fn page_count(path: &Path) -> Result<i64> {
    let doc = Document::load(path)?;
    Ok(doc.get_pages().len() as i64)
}
