//! PDF metadata, coarse text extraction and standard metadata lookups.
//!
//! The renderer sends exact per-page block geometry after PDF.js has parsed a
//! document; this module only needs enough information to import a paper
//! (title/authors/year/DOI, page count, searchable text) before it is opened.
//!
//! Local heuristics only guess. Once a DOI or arXiv id is known the same
//! information can be completed from the arXiv/Crossref registries; that
//! network access is an injected parameter so tests never touch the network.

use crate::library::{now_ms, Library};
use anyhow::{anyhow, ensure, Result};
use lopdf::{Document, Object};
use regex::Regex;
use rusqlite::OptionalExtension;
use serde_json::{json, Value};
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

// ---- standard metadata: arXiv / Crossref --------------------------------

#[derive(Debug, Default, Clone)]
pub struct StandardMeta {
    pub source: String,
    pub title: Option<String>,
    pub authors: Option<String>,
    pub year: Option<String>,
    pub venue: Option<String>,
    pub abstract_text: Option<String>,
    pub doi: Option<String>,
    pub arxiv: Option<String>,
}

fn one_line(text: &str) -> String {
    text.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn xml_unescape(raw: &str) -> String {
    let mut out = String::with_capacity(raw.len());
    let mut rest = raw;
    while let Some(idx) = rest.find('&') {
        out.push_str(&rest[..idx]);
        let tail = &rest[idx..];
        let entity_end = tail.find(';').filter(|end| *end <= 10);
        let Some(end) = entity_end else {
            out.push('&');
            rest = &tail[1..];
            continue;
        };
        let entity = &tail[1..end];
        let decoded = match entity {
            "amp" => Some('&'),
            "lt" => Some('<'),
            "gt" => Some('>'),
            "quot" => Some('"'),
            "apos" => Some('\''),
            _ => entity.strip_prefix('#').and_then(|number| {
                let code = match number.strip_prefix('x').or_else(|| number.strip_prefix('X')) {
                    Some(hex) => u32::from_str_radix(hex, 16).ok(),
                    None => number.parse::<u32>().ok(),
                };
                code.and_then(char::from_u32)
            }),
        };
        match decoded {
            Some(character) => {
                out.push(character);
                rest = &tail[end + 1..];
            }
            None => {
                out.push('&');
                rest = &tail[1..];
            }
        }
    }
    out.push_str(rest);
    out
}

fn atom_entries(xml: &str) -> Vec<&str> {
    let re = match Regex::new(r"(?s)<entry[^>]*>(.*?)</entry>") {
        Ok(re) => re,
        Err(_) => return Vec::new(),
    };
    re.captures_iter(xml).filter_map(|c| c.get(1).map(|m| m.as_str())).collect()
}

fn atom_tag<'a>(block: &'a str, tag: &str) -> Option<&'a str> {
    let pattern = format!("(?s)<{}[^>]*>(.*?)</{}>", regex::escape(tag), regex::escape(tag));
    Regex::new(&pattern).ok()?.captures(block)?.get(1).map(|m| m.as_str())
}

fn atom_tag_text(block: &str, tag: &str) -> Option<String> {
    atom_tag(block, tag).map(|value| one_line(&xml_unescape(value))).filter(|value| !value.is_empty())
}

fn atom_tag_all<'a>(block: &'a str, tag: &str) -> Vec<&'a str> {
    let pattern = format!("(?s)<{}[^>]*>(.*?)</{}>", regex::escape(tag), regex::escape(tag));
    match Regex::new(&pattern) {
        Ok(re) => re.captures_iter(block).filter_map(|c| c.get(1).map(|m| m.as_str())).collect(),
        Err(_) => Vec::new(),
    }
}

/// arXiv identity from any form of link (`http://arxiv.org/abs/2409.1v2`).
fn arxiv_identity(raw: &str) -> String {
    let text = raw.trim();
    let tail = match text.find("/abs/") {
        Some(index) => &text[index + 5..],
        None => text.rsplit('/').next().unwrap_or(text),
    };
    crate::citations::arxiv(tail)
}

fn first_text(value: &Value) -> Option<&str> {
    match value {
        Value::String(text) => Some(text.as_str()),
        Value::Array(items) => items.first().and_then(Value::as_str),
        _ => None,
    }
}

/// Strip JATS/HTML markup (`<jats:p>…</jats:p>`) from Crossref abstracts.
fn strip_markup(raw: &str) -> String {
    let mut out = String::new();
    let mut depth = 0usize;
    for character in raw.chars() {
        match character {
            '<' => depth += 1,
            '>' => depth = depth.saturating_sub(1),
            _ if depth == 0 => out.push(character),
            _ => {}
        }
    }
    one_line(&xml_unescape(&out))
}

/// Normalized title used both for duplicate detection and for accepting a
/// Crossref title search: only an exact match may fill fields.
pub fn normalize_title(raw: &str) -> String {
    let mut out = String::new();
    let mut pending_space = false;
    for character in raw.chars().flat_map(char::to_lowercase) {
        if character.is_alphanumeric() {
            if pending_space && !out.is_empty() {
                out.push(' ');
            }
            pending_space = false;
            out.push(character);
        } else {
            pending_space = true;
        }
    }
    out
}

/// Parse an arXiv Atom feed for exactly `arxiv_id`; never guesses another paper.
pub fn parse_arxiv_atom(xml: &str, arxiv_id: &str) -> Result<StandardMeta> {
    ensure!(xml.contains("<feed") && xml.contains("<entry"), "arXiv 返回内容不是 Atom 结果，未修改资料");
    let wanted = arxiv_identity(arxiv_id);
    let entry = atom_entries(xml)
        .into_iter()
        .find(|entry| atom_tag_text(entry, "id").map(|id| arxiv_identity(&id) == wanted).unwrap_or(false))
        .ok_or_else(|| anyhow!("arXiv 未返回 {arxiv_id}（ID 可能有误），未修改资料"))?;
    let title = atom_tag_text(entry, "title").ok_or_else(|| anyhow!("arXiv 未返回标题，未修改资料"))?;
    let authors = atom_tag_all(entry, "author")
        .iter()
        .filter_map(|author| atom_tag_text(author, "name"))
        .collect::<Vec<_>>()
        .join(", ");
    let published = atom_tag_text(entry, "published").or_else(|| atom_tag_text(entry, "updated"));
    let year = published
        .map(|text| text.chars().take(4).collect::<String>())
        .filter(|year| year.len() == 4 && year.chars().all(|c| c.is_ascii_digit()));
    let abstract_text = atom_tag_text(entry, "summary").filter(|text| text.chars().count() > 80);
    let doi = atom_tag_text(entry, "arxiv:doi")
        .map(|value| crate::citations::doi(&value))
        .filter(|value| crate::citations::valid_doi(value));
    let venue = atom_tag_text(entry, "arxiv:journal_ref").or_else(|| Some("arXiv".to_string()));
    Ok(StandardMeta {
        source: "arXiv".into(),
        title: Some(title),
        authors: (!authors.is_empty()).then_some(authors),
        year,
        venue,
        abstract_text,
        doi,
        arxiv: Some(wanted),
    })
}

fn crossref_authors(message: &Value) -> Option<String> {
    let authors = message["author"]
        .as_array()?
        .iter()
        .filter_map(|author| {
            let given = author["given"].as_str().map(str::trim).unwrap_or("");
            let family = author["family"].as_str().map(str::trim).unwrap_or("");
            let name = if !given.is_empty() && !family.is_empty() {
                format!("{given} {family}")
            } else if !family.is_empty() {
                family.to_string()
            } else {
                author["name"].as_str().map(str::trim).unwrap_or("").to_string()
            };
            (!name.is_empty()).then_some(name)
        })
        .collect::<Vec<_>>();
    (!authors.is_empty()).then(|| authors.join(", "))
}

fn crossref_year(message: &Value) -> Option<String> {
    for key in ["issued", "published-print", "published-online", "published", "created"] {
        if let Some(parts) = message[key]["date-parts"].as_array().and_then(|parts| parts.first()).and_then(Value::as_array) {
            if let Some(year) = parts.first().and_then(Value::as_i64) {
                if (1000..=2999).contains(&year) {
                    return Some(year.to_string());
                }
            }
        }
        if let Some(year) = message[key]["date-time"].as_str() {
            let year: String = year.chars().take(4).collect();
            if year.len() == 4 && year.chars().all(|c| c.is_ascii_digit()) {
                return Some(year);
            }
        }
    }
    None
}

/// Parse one Crossref `message` object. `expected_doi` pins the identity so a
/// fuzzy response can never overwrite a paper it does not describe.
pub fn parse_crossref_work(value: &Value, expected_doi: Option<&str>) -> Result<StandardMeta> {
    let message = &value["message"];
    ensure!(message.is_object(), "Crossref 返回内容格式无法识别，未修改资料");
    let doi = message["DOI"].as_str().map(crate::citations::doi);
    if let Some(expected) = expected_doi {
        ensure!(doi.as_deref() == Some(expected), "返回的 DOI 不一致，未修改资料");
    }
    let title = first_text(&message["title"]).map(one_line).filter(|title| !title.is_empty())
        .ok_or_else(|| anyhow!("Crossref 未返回标题，未修改资料"))?;
    let title = one_line(&xml_unescape(&title));
    let venue = first_text(&message["container-title"]).map(one_line)
        .or_else(|| message["event"]["name"].as_str().map(one_line))
        .or_else(|| message["publisher"].as_str().map(one_line))
        .map(|venue| one_line(&xml_unescape(&venue)))
        .filter(|venue| !venue.is_empty());
    let abstract_text = message["abstract"].as_str().map(strip_markup).filter(|text| text.chars().count() > 80);
    Ok(StandardMeta {
        source: "Crossref".into(),
        title: Some(title),
        authors: crossref_authors(message),
        year: crossref_year(message),
        venue,
        abstract_text,
        doi,
        arxiv: None,
    })
}

fn arxiv_url(identifier: &str) -> Result<String> {
    let mut url = reqwest::Url::parse("https://export.arxiv.org/api/query")?;
    url.query_pairs_mut().append_pair("id_list", identifier);
    Ok(url.to_string())
}

fn crossref_work_url(identifier: &str) -> Result<String> {
    let mut url = reqwest::Url::parse("https://api.crossref.org/works/")?;
    url.path_segments_mut().map_err(|_| anyhow!("Crossref URL 无效"))?.pop_if_empty().push(identifier);
    Ok(url.to_string())
}

fn crossref_search_url(title: &str) -> Result<String> {
    let mut url = reqwest::Url::parse("https://api.crossref.org/works")?;
    url.query_pairs_mut().append_pair("query.bibliographic", title).append_pair("rows", "5");
    Ok(url.to_string())
}

/// arXiv DOIs (`10.48550/arXiv.2409.19256`) name the paper they describe.
fn arxiv_from_doi(identifier: &str) -> Option<String> {
    let tail = identifier.strip_prefix("10.48550/arxiv.")?;
    let tail = crate::citations::arxiv(tail);
    crate::citations::valid_arxiv(&tail).then_some(tail)
}

/// Injected HTTP GET returning the response body.
fn lookup(fetch: &impl Fn(&str) -> Result<String>, doi_id: Option<&str>, arxiv_id: Option<&str>, title: &str) -> Result<StandardMeta> {
    let mut failures: Vec<String> = Vec::new();
    if let Some(identifier) = arxiv_id {
        match fetch(&arxiv_url(identifier)?).and_then(|xml| parse_arxiv_atom(&xml, identifier)) {
            Ok(meta) => return Ok(meta),
            Err(error) => failures.push(format!("arXiv：{error}")),
        }
    }
    if let Some(identifier) = doi_id {
        let attempt = fetch(&crossref_work_url(identifier)?).and_then(|body| {
            let value: Value = serde_json::from_str(&body)?;
            parse_crossref_work(&value, Some(identifier))
        });
        match attempt {
            Ok(meta) => return Ok(meta),
            Err(error) => failures.push(format!("Crossref：{error}")),
        }
        if let Some(derived) = arxiv_from_doi(identifier) {
            match fetch(&arxiv_url(&derived)?).and_then(|xml| parse_arxiv_atom(&xml, &derived)) {
                Ok(meta) => return Ok(meta),
                Err(error) => failures.push(format!("arXiv：{error}")),
            }
        }
    }
    // No identifier (or both registries missed): only an exact title match is
    // accepted, so a similar-looking paper can never rewrite this record.
    if arxiv_id.is_none() && doi_id.is_none() {
        ensure!(!title.is_empty(), "缺少 DOI/arXiv ID 且标题为空，请先编辑资料");
        let wanted = normalize_title(title);
        ensure!(wanted.chars().count() >= 8, "标题太短，无法可靠匹配；请先填写 DOI/arXiv ID");
        let body = fetch(&crossref_search_url(title)?)?;
        let value: Value = serde_json::from_str(&body)?;
        let hit = value["message"]["items"]
            .as_array()
            .and_then(|items| items.iter().find(|item| normalize_title(first_text(&item["title"]).unwrap_or("")) == wanted))
            .cloned()
            .ok_or_else(|| anyhow!("Crossref 未找到与该标题完全一致的条目，请手动填写 DOI/arXiv ID"))?;
        return parse_crossref_work(&json!({"message": hit}), None);
    }
    Err(anyhow!("标准元数据补全失败：{}；可稍后重试或手动编辑资料", failures.join("；")))
}

fn bounded(column: &str, value: &str) -> Result<()> {
    ensure!(value.chars().count() <= 20_000, "{column} 过长，未保存标准元数据");
    Ok(())
}

fn blank(value: Option<&str>) -> bool {
    value.map(str::trim).map(str::is_empty).unwrap_or(true)
}

/// Queue a column only when it is empty (or `force` wins) and the value changed.
fn push_fill(sets: &mut Vec<(&'static str, String)>, column: &'static str, current: Option<&str>, candidate: Option<&str>, force: bool) -> Result<()> {
    let Some(candidate) = candidate.map(str::trim).filter(|value| !value.is_empty()) else { return Ok(()) };
    if !force && !blank(current) {
        return Ok(());
    }
    bounded(column, candidate)?;
    if current.map(str::trim) != Some(candidate) {
        sets.push((column, candidate.to_string()));
    }
    Ok(())
}

/// Fill only empty fields unless `force` is set; a guessed "Untitled" title
/// counts as empty because the import heuristic had nothing to work with.
fn apply(lib: &Library, paper_id: &str, meta: &StandardMeta, force: bool) -> Result<Vec<String>> {
    let (title, authors, year, venue, doi, arxiv, abstract_text) = {
        let conn = lib.conn();
        conn.query_row(
            "SELECT title,authors,year,venue,doi,arxiv,abstract FROM papers WHERE id=? AND deleted_at IS NULL",
            [paper_id],
            |r| Ok((
                r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, Option<String>>(2)?,
                r.get::<_, Option<String>>(3)?, r.get::<_, Option<String>>(4)?,
                r.get::<_, Option<String>>(5)?, r.get::<_, Option<String>>(6)?,
            )),
        ).optional()?.ok_or_else(|| anyhow!("论文不存在或已移入回收站"))?
    };
    let mut sets: Vec<(&'static str, String)> = Vec::new();
    let title_unknown = blank(Some(title.as_str())) || title.trim().eq_ignore_ascii_case("untitled");
    if let Some(candidate) = meta.title.as_deref().map(str::trim).filter(|value| !value.is_empty()) {
        if (force || title_unknown) && candidate != title.trim() {
            bounded("title", candidate)?;
            sets.push(("title", candidate.to_string()));
        }
    }
    push_fill(&mut sets, "authors", Some(authors.as_str()), meta.authors.as_deref(), force)?;
    push_fill(&mut sets, "year", year.as_deref(), meta.year.as_deref(), force)?;
    push_fill(&mut sets, "venue", venue.as_deref(), meta.venue.as_deref(), force)?;
    push_fill(&mut sets, "doi", doi.as_deref(), meta.doi.as_deref(), force)?;
    push_fill(&mut sets, "arxiv", arxiv.as_deref(), meta.arxiv.as_deref(), force)?;
    push_fill(&mut sets, "abstract", abstract_text.as_deref(), meta.abstract_text.as_deref(), force)?;
    if sets.is_empty() {
        return Ok(Vec::new());
    }
    let assignments = sets.iter().map(|(column, _)| format!("{column}=?")).collect::<Vec<_>>().join(",");
    let mut args: Vec<rusqlite::types::Value> = sets.iter().map(|(_, value)| value.clone().into()).collect();
    args.push(now_ms().into());
    args.push(paper_id.to_string().into());
    {
        let conn = lib.conn();
        let tx = conn.unchecked_transaction()?;
        let updated = tx.execute(
            &format!("UPDATE papers SET {assignments},updated_at=max(updated_at+1,?) WHERE id=? AND deleted_at IS NULL"),
            rusqlite::params_from_iter(args),
        )?;
        ensure!(updated == 1, "查询期间论文已被移动或删除，未保存标准元数据");
        tx.commit()?;
    }
    Ok(sets.into_iter().map(|(column, _)| column.to_string()).collect())
}

/// Injected HTTP GET returning the response body. Tests pass fixtures and the
/// app passes the shared throttled transport in `citations`, so no test can
/// reach the network by accident.
pub fn refresh_metadata_with(lib: &Library, params: &Value, fetch: &impl Fn(&str) -> Result<String>) -> Result<Value> {
    let paper_id = params["paper_id"].as_str().ok_or_else(|| anyhow!("paper_id required"))?;
    let force = params["force"].as_bool().unwrap_or(false);
    let (doi_raw, arxiv_raw, title, deleted) = {
        let conn = lib.conn();
        conn.query_row(
            "SELECT doi,arxiv,title,deleted_at IS NOT NULL FROM papers WHERE id=?",
            [paper_id],
            |r| Ok((r.get::<_, Option<String>>(0)?, r.get::<_, Option<String>>(1)?, r.get::<_, String>(2)?, r.get::<_, bool>(3)?)),
        ).optional()?.ok_or_else(|| anyhow!("论文不存在"))?
    };
    ensure!(!deleted, "回收站论文不刷新资料");
    let doi_id = doi_raw.as_deref().filter(|value| !value.trim().is_empty()).map(crate::citations::doi);
    let arxiv_id = arxiv_raw.as_deref().filter(|value| !value.trim().is_empty()).map(crate::citations::arxiv);
    if let Some(identifier) = &doi_id {
        ensure!(crate::citations::valid_doi(identifier), "DOI 格式无效，请先编辑资料");
    }
    if let Some(identifier) = &arxiv_id {
        ensure!(crate::citations::valid_arxiv(identifier), "arXiv ID 无效，请先编辑资料");
    }
    let meta = lookup(fetch, doi_id.as_deref(), arxiv_id.as_deref(), title.trim())?;
    let updated_fields = apply(lib, paper_id, &meta, force)?;
    let mut paper = lib.get_paper(paper_id)?;
    paper["metadata_source"] = json!(meta.source);
    paper["updated_fields"] = json!(updated_fields);
    Ok(paper)
}

/// RPC `refresh_metadata`: fill title/authors/year/venue/abstract from the
/// arXiv or Crossref registry of the paper's own identifier.
pub fn refresh_metadata(lib: &Library, params: &Value) -> Result<Value> {
    let fetch = |url: &str| crate::citations::fetch_text(url);
    refresh_metadata_with(lib, params, &fetch)
}

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::params;

    const ARXIV_FEED: &str = r#"<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title type="html">ArXiv Query: id_list=2409.19256</title>
  <entry>
    <id>http://arxiv.org/abs/2409.19256v2</id>
    <updated>2024-10-08T00:00:00Z</updated>
    <published>2024-09-30T09:00:00Z</published>
    <title>A Study of Throughput &amp; Latency in
      Large Batch Inference</title>
    <summary>We study how batching changes throughput and latency for large
      language model inference, and we show where the memory bottleneck moves.</summary>
    <author><name>Ada Lovelace</name></author>
    <author><name>Alan M. Turing</name></author>
    <arxiv:doi xmlns:arxiv="http://arxiv.org/schemas/atom">10.1000/XYZ.1</arxiv:doi>
    <arxiv:journal_ref xmlns:arxiv="http://arxiv.org/schemas/atom">NeurIPS 2024</arxiv:journal_ref>
  </entry>
</feed>"#;

    fn crossref_work() -> Value {
        json!({"message": {
            "DOI": "10.1000/ABC",
            "title": ["A Study of Throughput &amp; Latency"],
            "author": [{"given": "Ada", "family": "Lovelace"}, {"name": "Alan Turing"}],
            "issued": {"date-parts": [[2024, 9, 30]]},
            "container-title": ["NeurIPS"],
            "publisher": "Curran Associates",
            "abstract": "<jats:p>We study how batching changes throughput &amp; latency for large language model inference in production clusters.</jats:p>",
            "type": "proceedings-article"
        }})
    }

    #[test]
    fn arxiv_and_crossref_payloads_parse_into_standard_metadata() {
        let meta = parse_arxiv_atom(ARXIV_FEED, "https://arxiv.org/abs/2409.19256v2").unwrap();
        assert_eq!(meta.source, "arXiv");
        assert_eq!(meta.title.as_deref(), Some("A Study of Throughput & Latency in Large Batch Inference"));
        assert_eq!(meta.authors.as_deref(), Some("Ada Lovelace, Alan M. Turing"));
        assert_eq!(meta.year.as_deref(), Some("2024"));
        assert_eq!(meta.venue.as_deref(), Some("NeurIPS 2024"));
        assert_eq!(meta.doi.as_deref(), Some("10.1000/xyz.1"));
        assert_eq!(meta.arxiv.as_deref(), Some("2409.19256"));
        assert!(meta.abstract_text.as_deref().unwrap().contains("memory bottleneck"));
        // A feed that describes another paper is never accepted.
        let wrong = parse_arxiv_atom(ARXIV_FEED, "2409.00000").unwrap_err().to_string();
        assert!(wrong.contains("arXiv 未返回 2409.00000"), "{wrong}");
        assert!(parse_arxiv_atom("<html><body>not a feed</body></html>", "2409.19256").is_err());

        let crossref = parse_crossref_work(&crossref_work(), Some("10.1000/abc")).unwrap();
        assert_eq!(crossref.source, "Crossref");
        assert_eq!(crossref.title.as_deref(), Some("A Study of Throughput & Latency"));
        assert_eq!(crossref.authors.as_deref(), Some("Ada Lovelace, Alan Turing"));
        assert_eq!(crossref.year.as_deref(), Some("2024"));
        assert_eq!(crossref.venue.as_deref(), Some("NeurIPS"));
        assert_eq!(crossref.doi.as_deref(), Some("10.1000/abc"));
        let abstract_text = crossref.abstract_text.as_deref().unwrap();
        assert!(abstract_text.starts_with("We study how batching") && abstract_text.contains("throughput & latency"), "{abstract_text}");
        // An identity mismatch must be refused instead of rewriting the paper.
        let mismatch = parse_crossref_work(&crossref_work(), Some("10.1000/other")).unwrap_err().to_string();
        assert!(mismatch.contains("DOI 不一致"), "{mismatch}");
        assert_eq!(normalize_title("A Study of  Throughput!"), "a study of throughput");
    }

    fn paper(lib: &Library, id: &str, title: &str, authors: &str, year: Option<&str>, venue: Option<&str>, doi: Option<&str>, arxiv: Option<&str>, abstract_text: Option<&str>) {
        lib.conn().execute(
            "INSERT INTO papers(id,title,authors,year,venue,doi,arxiv,abstract,imported_at,updated_at) VALUES(?,?,?,?,?,?,?,?,0,0)",
            params![id, title, authors, year, venue, doi, arxiv, abstract_text],
        ).unwrap();
    }

    #[test]
    fn refresh_fills_empty_fields_and_only_overwrites_them_with_force_without_network() {
        let root = std::env::temp_dir().join(format!("moonlight-metadata-{}", uuid::Uuid::new_v4()));
        let lib = Library::new(&root).unwrap();
        paper(&lib, "p", "Untitled", "", None, Some("Old Venue"), None, Some("2409.19256"), Some("old abstract"));
        let calls = std::cell::Cell::new(0usize);
        let fetch = |url: &str| -> Result<String> {
            calls.set(calls.get() + 1);
            assert!(url.starts_with("https://export.arxiv.org/api/query?id_list=2409.19256"), "{url}");
            Ok(ARXIV_FEED.to_string())
        };
        let paper_json = refresh_metadata_with(&lib, &json!({"paper_id": "p"}), &fetch).unwrap();
        assert_eq!(calls.get(), 1);
        assert_eq!(paper_json["id"], "p");
        assert_eq!(paper_json["metadata_source"], "arXiv");
        assert_eq!(paper_json["title"], "A Study of Throughput & Latency in Large Batch Inference");
        assert_eq!(paper_json["authors"], "Ada Lovelace, Alan M. Turing");
        assert_eq!(paper_json["year"], "2024");
        assert_eq!(paper_json["doi"], "10.1000/xyz.1");
        assert_eq!(paper_json["updated_fields"], json!(["title", "authors", "year", "doi"]));
        // Existing values survive a non-forced refresh.
        assert_eq!(paper_json["venue"], "Old Venue");
        assert_eq!(paper_json["abstract"], "old abstract");
        assert_eq!(paper_json["arxiv"], "2409.19256");
        let forced = refresh_metadata_with(&lib, &json!({"paper_id": "p", "force": true}), &fetch).unwrap();
        assert_eq!(forced["updated_fields"], json!(["venue", "abstract"]));
        assert_eq!(forced["venue"], "NeurIPS 2024");
        assert!(forced["abstract"].as_str().unwrap().contains("memory bottleneck"));
        assert_eq!(calls.get(), 2);
        // A second non-forced refresh is a no-op, not a rewrite.
        let again = refresh_metadata_with(&lib, &json!({"paper_id": "p"}), &fetch).unwrap();
        assert_eq!(again["updated_fields"], json!([]));
        assert_eq!(again["title"], paper_json["title"]);
        drop(lib);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn refresh_failures_are_readable_and_leave_the_record_untouched() {
        let root = std::env::temp_dir().join(format!("moonlight-metadata-errors-{}", uuid::Uuid::new_v4()));
        let lib = Library::new(&root).unwrap();
        paper(&lib, "offline", "Untitled", "", None, None, None, Some("2409.19256"), None);
        paper(&lib, "bad-id", "Untitled", "", None, None, None, Some("not-an-id"), None);
        paper(&lib, "no-id", "   ", "", None, None, None, None, None);
        paper(&lib, "titled", "A study of throughput", "", None, None, None, None, None);
        paper(&lib, "titled2", "Some other paper title", "", None, None, None, None, None);
        paper(&lib, "missing", "Some paper", "", None, None, None, Some("2409.19256"), None);
        lib.trash("missing").unwrap();

        // Network failures surface as text, never a panic, and never a write.
        let offline = |_: &str| -> Result<String> { Err(anyhow!("网络不可用（测试注入）")) };
        let error = refresh_metadata_with(&lib, &json!({"paper_id": "offline"}), &offline).unwrap_err().to_string();
        assert!(error.contains("网络不可用（测试注入）") && error.contains("标准元数据补全失败"), "{error}");
        assert_eq!(lib.get_paper("offline").unwrap()["title"], "Untitled");

        // Invalid identifiers and trashed papers are rejected before any request.
        let unused = |_: &str| -> Result<String> { Err(anyhow!("不应访问网络")) };
        assert!(refresh_metadata_with(&lib, &json!({"paper_id": "bad-id"}), &unused).unwrap_err().to_string().contains("arXiv ID 无效"));
        assert!(refresh_metadata_with(&lib, &json!({"paper_id": "missing"}), &unused).unwrap_err().to_string().contains("回收站"));
        assert!(refresh_metadata_with(&lib, &json!({"paper_id": "no-id"}), &unused).unwrap_err().to_string().contains("缺少 DOI/arXiv ID"));
        assert!(refresh_metadata_with(&lib, &json!({}), &unused).unwrap_err().to_string().contains("paper_id required"));
        assert!(refresh_metadata_with(&lib, &json!({"paper_id": "ghost"}), &unused).unwrap_err().to_string().contains("论文不存在"));

        // Title fallback accepts only the exact normalized title.
        let search = |url: &str| -> Result<String> {
            assert!(url.starts_with("https://api.crossref.org/works?"), "{url}");
            assert!(url.contains("query.bibliographic=A+study+of+throughput") || url.contains("query.bibliographic=A%20study%20of%20throughput"), "{url}");
            Ok(json!({"message": {"items": [
                {"DOI": "10.5555/other", "title": ["A survey of throughput"]},
                {"DOI": "10.1000/abc", "title": ["A Study of  Throughput!"], "author": [{"given": "Grace", "family": "Hopper"}],
                 "issued": {"date-parts": [[2024]]}, "container-title": ["Queueing Systems"]}
            ]}}).to_string())
        };
        let matched = refresh_metadata_with(&lib, &json!({"paper_id": "titled"}), &search).unwrap();
        assert_eq!(matched["metadata_source"], "Crossref");
        assert_eq!(matched["authors"], "Grace Hopper");
        assert_eq!(matched["doi"], "10.1000/abc");
        assert_eq!(matched["venue"], "Queueing Systems");
        assert_eq!(matched["title"], "A study of throughput");
        let miss = |_: &str| -> Result<String> { Ok(json!({"message": {"items": [{"DOI": "10.5555/other", "title": ["A survey of throughput"]}]}}).to_string()) };
        let error = refresh_metadata_with(&lib, &json!({"paper_id": "titled2"}), &miss).unwrap_err().to_string();
        assert!(error.contains("未找到与该标题完全一致的条目"), "{error}");
        drop(lib);
        std::fs::remove_dir_all(root).unwrap();
    }
}
