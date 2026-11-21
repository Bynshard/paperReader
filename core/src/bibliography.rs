//! Metadata-only bibliography import (FEAT-UX-04).
//!
//! Parses BibTeX and RIS text into the same metadata shape the PDF importer
//! fills (`title/authors/year/venue/doi/arxiv/abstract`), then inserts one
//! paper row per new record **without** any PDF/version.  The user can attach
//! a PDF later (drag-and-drop) or keep the record as a citation-only entry.
//!
//! Safety rails: the text is capped at 5 MB and one import at 2000 records, a
//! record without a title is reported as failed instead of inserting a blank
//! row, and dedupe reuses the library-wide identity rules (DOI, arXiv id with
//! `vN` stripped, normalized title) that `organization::list_duplicates` uses.

use crate::library::{now_ms, Library};
use anyhow::{ensure, Result};
use rusqlite::params;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::OnceLock;

/// Hard input cap: a `.bib`/`.ris` file (not a PDF) should never exceed this.
pub const MAX_BIBLIOGRAPHY_BYTES: usize = 5 * 1024 * 1024;
/// Hard cap for one import; the app batches larger libraries.
pub const MAX_BIBLIOGRAPHY_ENTRIES: usize = 2000;
/// Maximum number of per-entry errors echoed back (the `failed` count is exact).
const MAX_REPORTED_ERRORS: usize = 50;

/// One parsed bibliography record before normalization/insertion.
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct BibEntry {
    pub title: String,
    pub authors: String,
    pub year: String,
    pub venue: String,
    pub doi: String,
    pub arxiv: String,
    pub abstract_text: String,
}

fn author_separator() -> &'static regex::Regex {
    static SEPARATOR: OnceLock<regex::Regex> = OnceLock::new();
    SEPARATOR.get_or_init(|| regex::Regex::new(r"(?i)\s+and\s+").expect("author separator regex"))
}

/// Collapse a BibTeX `and` author list into the library's `", "` convention.
fn join_bibtex_authors(raw: &str) -> String {
    author_separator()
        .split(raw)
        .map(str::trim)
        .filter(|name| !name.is_empty())
        .collect::<Vec<_>>()
        .join(", ")
}

/// First plausible 4-digit year (BibTeX `year`, RIS `PY`/`DA`, `2024-05-01`).
fn extract_year(raw: &str) -> String {
    let chars: Vec<char> = raw.chars().collect();
    let mut index = 0;
    while index + 4 <= chars.len() {
        let window = &chars[index..index + 4];
        if window.iter().all(char::is_ascii_digit) {
            let year: i32 = window.iter().collect::<String>().parse().unwrap_or(0);
            if (1000..=2999).contains(&year) {
                return year.to_string();
            }
        }
        index += 1;
    }
    String::new()
}

/// If a `url` field points at a DOI resolver, recover the identifier.
fn doi_from_url(url: &str) -> String {
    let lower = url.to_ascii_lowercase();
    for marker in ["doi.org/", "dx.doi.org/"] {
        if let Some(position) = lower.find(marker) {
            let start = position + marker.len();
            return url[start..].trim().trim_end_matches('/').to_string();
        }
    }
    String::new()
}

// ---- BibTeX ---------------------------------------------------------------

/// Strip TeX markup that would otherwise end up in the library title.
fn flatten_tex(raw: &str) -> String {
    let chars: Vec<char> = raw.chars().collect();
    let mut out = String::new();
    let mut index = 0;
    while index < chars.len() {
        let current = chars[index];
        match current {
            '\\' => {
                index += 1;
                if index >= chars.len() {
                    break;
                }
                let next = chars[index];
                if next.is_ascii_alphabetic() {
                    // Control word such as `\textit` / `\emph`: drop the command,
                    // keep the braced argument content.
                    while index < chars.len() && chars[index].is_ascii_alphabetic() {
                        index += 1;
                    }
                } else if matches!(next, '&' | '%' | '$' | '#' | '_' | '{' | '}' | '\\') {
                    out.push(next);
                    index += 1;
                } else {
                    // Accent marker (`\'`, `\"`, `\^`, …): the following base
                    // character is handled by the next loop iteration.
                    index += 1;
                }
            }
            '{' | '}' => index += 1,
            '~' => {
                out.push(' ');
                index += 1;
            }
            _ => {
                out.push(current);
                index += 1;
            }
        }
    }
    out.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// Split a field value on top-level `#` concatenation markers.
fn split_concatenation(raw: &str) -> Vec<String> {
    let mut parts = Vec::new();
    let mut current = String::new();
    let mut braces = 0i32;
    let mut quoted = false;
    let mut escaped = false;
    for character in raw.chars() {
        if escaped {
            current.push(character);
            escaped = false;
            continue;
        }
        if character == '\\' {
            current.push(character);
            escaped = true;
            continue;
        }
        match character {
            '{' => {
                braces += 1;
                current.push(character);
            }
            '}' => {
                braces -= 1;
                current.push(character);
            }
            '"' if braces == 0 => {
                quoted = !quoted;
                current.push(character);
            }
            '#' if braces == 0 && !quoted => {
                parts.push(current.trim().to_string());
                current.clear();
            }
            _ => current.push(character),
        }
    }
    parts.push(current.trim().to_string());
    parts
}

fn decode_bib_value(raw: &str) -> String {
    split_concatenation(raw)
        .into_iter()
        .map(|segment| {
            let segment = segment.trim();
            let inner = if segment.len() >= 2 && segment.starts_with('{') && segment.ends_with('}') {
                &segment[1..segment.len() - 1]
            } else if segment.len() >= 2 && segment.starts_with('"') && segment.ends_with('"') {
                &segment[1..segment.len() - 1]
            } else {
                segment
            };
            flatten_tex(inner)
        })
        .collect::<Vec<_>>()
        .join("")
}

/// Split the inside of an `@article{…}` body into `(lowercase name, decoded value)`.
fn split_bib_fields(body: &str) -> Vec<(String, String)> {
    let mut parts: Vec<String> = Vec::new();
    let mut current = String::new();
    let mut braces = 0i32;
    let mut quoted = false;
    let mut escaped = false;
    for character in body.chars() {
        if escaped {
            current.push(character);
            escaped = false;
            continue;
        }
        if character == '\\' {
            current.push(character);
            escaped = true;
            continue;
        }
        match character {
            '{' => {
                braces += 1;
                current.push(character);
            }
            '}' => {
                braces -= 1;
                current.push(character);
            }
            '"' if braces == 0 => {
                quoted = !quoted;
                current.push(character);
            }
            ',' if braces == 0 && !quoted => {
                parts.push(std::mem::take(&mut current));
            }
            _ => current.push(character),
        }
    }
    if !current.trim().is_empty() {
        parts.push(current);
    }
    let mut fields = Vec::new();
    for part in parts {
        let mut braces = 0i32;
        let mut quoted = false;
        let mut escaped = false;
        let mut split_at = None;
        for (index, character) in part.char_indices() {
            if escaped {
                escaped = false;
                continue;
            }
            if character == '\\' {
                escaped = true;
                continue;
            }
            match character {
                '{' => braces += 1,
                '}' => braces -= 1,
                '"' if braces == 0 => quoted = !quoted,
                '=' if braces == 0 && !quoted => {
                    split_at = Some(index);
                    break;
                }
                _ => {}
            }
        }
        let Some(split_at) = split_at else { continue };
        let name = part[..split_at].trim().to_ascii_lowercase();
        if name.is_empty() || !name.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_') {
            continue;
        }
        fields.push((name, decode_bib_value(&part[split_at + 1..])));
    }
    fields
}

fn entry_from_bib_fields(fields: &[(String, String)]) -> Result<BibEntry, String> {
    let get = |key: &str| {
        fields
            .iter()
            .rev()
            .find(|(name, _)| name == key)
            .map(|(_, value)| value.trim().to_string())
            .unwrap_or_default()
    };
    let title = get("title");
    if title.is_empty() {
        return Err("缺少 title 字段".into());
    }
    let url = get("url");
    let mut doi = get("doi");
    if doi.is_empty() {
        doi = doi_from_url(&url);
    }
    let mut arxiv = get("eprint");
    if arxiv.is_empty() {
        arxiv = get("arxiv");
    }
    let venue = {
        let journal = get("journal");
        if !journal.is_empty() {
            journal
        } else {
            let booktitle = get("booktitle");
            if !booktitle.is_empty() {
                booktitle
            } else {
                get("publisher")
            }
        }
    };
    let year = {
        let year = extract_year(&get("year"));
        if year.is_empty() {
            extract_year(&get("date"))
        } else {
            year
        }
    };
    Ok(BibEntry {
        title,
        authors: join_bibtex_authors(&get("author")),
        year,
        venue,
        doi,
        arxiv,
        abstract_text: get("abstract"),
    })
}

/// Parse a BibTeX file into records.  `@comment`/`@preamble`/`@string` are
/// skipped; a malformed entry becomes one `Err` so the rest still imports.
pub fn parse_bibtex(text: &str) -> Vec<Result<BibEntry, String>> {
    let chars: Vec<char> = text.chars().collect();
    let mut entries = Vec::new();
    let mut index = 0;
    while index < chars.len() {
        if chars[index] != '@' {
            index += 1;
            continue;
        }
        let entry_start = index;
        index += 1;
        let type_start = index;
        while index < chars.len() && chars[index].is_ascii_alphabetic() {
            index += 1;
        }
        let kind: String = chars[type_start..index].iter().collect::<String>().to_ascii_lowercase();
        while index < chars.len() && chars[index].is_whitespace() {
            index += 1;
        }
        if index >= chars.len() || (chars[index] != '{' && chars[index] != '(') {
            index = entry_start + 1;
            continue;
        }
        let open = chars[index];
        let body_start = index + 1;
        index = body_start;
        let mut braces = if open == '{' { 1i32 } else { 0i32 };
        let mut parens = if open == '(' { 1i32 } else { 0i32 };
        let mut quoted = false;
        let mut escaped = false;
        let mut body_end = None;
        while index < chars.len() {
            let character = chars[index];
            if escaped {
                escaped = false;
                index += 1;
                continue;
            }
            if character == '\\' {
                escaped = true;
                index += 1;
                continue;
            }
            if open == '(' {
                if braces > 0 || character == '{' {
                    if character == '{' {
                        braces += 1;
                    } else if character == '}' {
                        braces -= 1;
                    }
                } else if character == '"' {
                    quoted = !quoted;
                } else if !quoted {
                    match character {
                        '(' => parens += 1,
                        ')' => {
                            parens -= 1;
                            if parens == 0 {
                                body_end = Some(index);
                                break;
                            }
                        }
                        _ => {}
                    }
                }
            } else {
                match character {
                    '{' => braces += 1,
                    '}' => {
                        braces -= 1;
                        if braces == 0 {
                            body_end = Some(index);
                            break;
                        }
                    }
                    _ => {}
                }
            }
            index += 1;
        }
        let Some(end) = body_end else {
            entries.push(Err("BibTeX 条目缺少结束括号".into()));
            break;
        };
        let body: String = chars[body_start..end].iter().collect();
        index = end + 1;
        if matches!(kind.as_str(), "comment" | "preamble" | "string") {
            continue;
        }
        entries.push(entry_from_bib_fields(&split_bib_fields(&body)));
        if entries.len() > MAX_BIBLIOGRAPHY_ENTRIES {
            break;
        }
    }
    entries
}

// ---- RIS ------------------------------------------------------------------

/// Parse an RIS file (`TY  - JOUR` … `ER  - `) into records.
pub fn parse_ris(text: &str) -> Vec<Result<BibEntry, String>> {
    let mut entries = Vec::new();
    let mut fields: HashMap<String, String> = HashMap::new();
    let mut authors: Vec<String> = Vec::new();
    let finish = |fields: &mut HashMap<String, String>, authors: &mut Vec<String>, entries: &mut Vec<Result<BibEntry, String>>| {
        let mut taken = HashMap::new();
        for (key, value) in fields.drain() {
            taken.insert(key, value);
        }
        let authors = authors.drain(..).collect::<Vec<_>>();
        if taken.is_empty() && authors.is_empty() {
            return;
        }
        let title = taken.get("title").cloned().unwrap_or_default().trim().to_string();
        if title.is_empty() {
            entries.push(Err("缺少 TI/T1 标题".into()));
            return;
        }
        let url = taken.get("url").cloned().unwrap_or_default();
        let mut doi = taken.get("doi").cloned().unwrap_or_default();
        if doi.is_empty() {
            doi = doi_from_url(&url);
        }
        let mut arxiv = taken.get("arxiv").cloned().unwrap_or_default();
        if arxiv.is_empty() {
            for key in ["an", "c7"] {
                let candidate = taken.get(key).cloned().unwrap_or_default();
                if !candidate.is_empty() {
                    arxiv = candidate;
                    break;
                }
            }
        }
        let year = {
            let year = extract_year(taken.get("year").map(String::as_str).unwrap_or(""));
            if year.is_empty() {
                extract_year(taken.get("date").map(String::as_str).unwrap_or(""))
            } else {
                year
            }
        };
        let venue = ["venue", "journal", "booktitle"]
            .iter()
            .filter_map(|key| taken.get(*key).map(String::as_str))
            .find(|value| !value.trim().is_empty())
            .unwrap_or("")
            .trim()
            .to_string();
        entries.push(Ok(BibEntry {
            title,
            authors: authors.iter().map(|name| name.trim()).filter(|name| !name.is_empty()).collect::<Vec<_>>().join(", "),
            year,
            venue,
            doi: doi.trim().to_string(),
            arxiv: arxiv.trim().to_string(),
            abstract_text: taken
                .get("abstract")
                .cloned()
                .or_else(|| taken.get("n2").cloned())
                .unwrap_or_default()
                .trim()
                .to_string(),
        }));
    };
    for line in text.lines() {
        let line = line.trim_end_matches('\r');
        if line.trim().is_empty() {
            continue;
        }
        let mut chars = line.chars();
        let tag: String = chars.by_ref().take(2).collect::<String>().trim().to_ascii_uppercase();
        if tag.len() != 2 || !tag.chars().all(|c| c.is_ascii_alphanumeric()) {
            continue;
        }
        let rest: String = chars.collect();
        let value = rest.trim_start().trim_start_matches('-').trim().to_string();
        match tag.as_str() {
            "TY" => {
                if !fields.is_empty() || !authors.is_empty() {
                    finish(&mut fields, &mut authors, &mut entries);
                }
            }
            "ER" => finish(&mut fields, &mut authors, &mut entries),
            "TI" | "T1" => {
                fields.entry("title".into()).or_insert(value);
            }
            "AU" | "A1" => {
                if !value.is_empty() {
                    authors.push(value);
                }
            }
            "PY" | "Y1" => {
                fields.entry("year".into()).or_insert(value);
            }
            "DA" => {
                fields.entry("date".into()).or_insert(value);
            }
            "JO" | "JF" | "T2" | "BT" => {
                fields.entry("venue".into()).or_insert(value);
            }
            "DO" => {
                fields.entry("doi".into()).or_insert(value);
            }
            "AB" | "N2" => {
                fields.entry("abstract".into()).or_insert(value);
            }
            "UR" => {
                fields.entry("url".into()).or_insert(value);
            }
            "AN" | "C7" => {
                fields.entry("an".into()).or_insert(value);
            }
            _ => {}
        }
        if entries.len() > MAX_BIBLIOGRAPHY_ENTRIES {
            break;
        }
    }
    if !fields.is_empty() || !authors.is_empty() {
        finish(&mut fields, &mut authors, &mut entries);
    }
    entries
}

// ---- import ---------------------------------------------------------------

#[derive(Default)]
struct ExistingIndex {
    doi: HashMap<String, String>,
    arxiv: HashMap<String, String>,
    title: HashMap<String, String>,
}

impl ExistingIndex {
    fn load(conn: &rusqlite::Connection) -> Result<Self> {
        let mut index = Self::default();
        let mut stmt = conn.prepare("SELECT id,title,doi,arxiv FROM papers")?;
        let rows = stmt.query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, Option<String>>(2)?,
                row.get::<_, Option<String>>(3)?,
            ))
        })?;
        for row in rows.filter_map(std::result::Result::ok) {
            index.remember(&row.0, &row.1, row.2.as_deref(), row.3.as_deref());
        }
        Ok(index)
    }

    fn remember(&mut self, id: &str, title: &str, doi: Option<&str>, arxiv: Option<&str>) {
        if let Some(key) = doi_key(doi.unwrap_or("")) {
            self.doi.entry(key).or_insert_with(|| id.to_string());
        }
        if let Some(key) = arxiv_key(arxiv.unwrap_or("")) {
            self.arxiv.entry(key).or_insert_with(|| id.to_string());
        }
        let normalized = crate::pdfmeta::normalize_title(title);
        if normalized.chars().count() >= 10 {
            self.title.entry(normalized).or_insert_with(|| id.to_string());
        }
    }

    fn duplicate_of(&self, doi: Option<&str>, arxiv: Option<&str>, title: &str) -> Option<&String> {
        if let Some(key) = doi.and_then(doi_key) {
            if let Some(id) = self.doi.get(&key) {
                return Some(id);
            }
        }
        if let Some(key) = arxiv.and_then(arxiv_key) {
            if let Some(id) = self.arxiv.get(&key) {
                return Some(id);
            }
        }
        let normalized = crate::pdfmeta::normalize_title(title);
        if normalized.chars().count() >= 10 {
            return self.title.get(&normalized);
        }
        None
    }
}

/// Normalized DOI key, only when the identifier is actually a DOI.
fn doi_key(raw: &str) -> Option<String> {
    let normalized = crate::citations::doi(raw);
    crate::citations::valid_doi(&normalized).then_some(normalized)
}

fn arxiv_key(raw: &str) -> Option<String> {
    let normalized = crate::citations::arxiv(raw);
    crate::citations::valid_arxiv(&normalized).then_some(normalized)
}

/// Normalize one parsed record into the columns the `papers` table stores.
fn normalize(entry: BibEntry) -> Result<BibEntry, String> {
    let title = entry.title.trim().to_string();
    if title.is_empty() {
        return Err("标题为空".into());
    }
    if title.chars().count() > 1000 {
        return Err("标题超过 1000 字".into());
    }
    let authors = entry.authors.trim().to_string();
    if authors.chars().count() > 4000 {
        return Err("作者列表超过 4000 字".into());
    }
    let abstract_text = entry.abstract_text.trim().to_string();
    if abstract_text.len() > 200_000 {
        return Err("摘要超过 200KB".into());
    }
    let doi = {
        let value = entry.doi.trim();
        if value.is_empty() {
            String::new()
        } else {
            crate::citations::doi(value)
        }
    };
    let arxiv = {
        let value = entry.arxiv.trim();
        if value.is_empty() {
            String::new()
        } else {
            crate::citations::arxiv(value)
        }
    };
    Ok(BibEntry {
        title,
        authors,
        year: extract_year(&entry.year),
        venue: entry.venue.trim().to_string(),
        doi,
        arxiv,
        abstract_text,
    })
}

/// RPC `import_bibliography {format:"bibtex"|"ris", text}`.
///
/// Inserts metadata-only papers and returns `{imported,duplicates,failed,errors}`.
/// Duplicate rows (same DOI / arXiv id / normalized title, including records
/// already in the trash) are counted instead of inserted.  No filesystem or
/// network access happens here.
pub fn import_bibliography(lib: &Library, params: &Value) -> Result<Value> {
    let format = params.get("format").and_then(Value::as_str).unwrap_or("").trim().to_ascii_lowercase();
    ensure!(matches!(format.as_str(), "bibtex" | "ris"), "不支持的文献格式：{format}（仅支持 bibtex / ris）");
    let text = params.get("text").and_then(Value::as_str).unwrap_or("");
    ensure!(!text.trim().is_empty(), "文献内容为空");
    ensure!(text.len() <= MAX_BIBLIOGRAPHY_BYTES, "文献文件过大（最多 5MB）");
    let parsed = if format == "ris" { parse_ris(text) } else { parse_bibtex(text) };
    ensure!(
        parsed.len() <= MAX_BIBLIOGRAPHY_ENTRIES,
        "一次最多导入 {MAX_BIBLIOGRAPHY_ENTRIES} 条文献（当前 {} 条）",
        parsed.len()
    );

    let conn = lib.conn();
    let mut index = ExistingIndex::load(&conn)?;
    let tx = conn.unchecked_transaction()?;
    let mut imported = 0usize;
    let mut duplicates = 0usize;
    let mut failed = 0usize;
    let mut errors: Vec<String> = Vec::new();
    for (position, record) in parsed.into_iter().enumerate() {
        let entry = match record.and_then(normalize) {
            Ok(entry) => entry,
            Err(error) => {
                failed += 1;
                if errors.len() < MAX_REPORTED_ERRORS {
                    errors.push(format!("第 {} 条：{error}", position + 1));
                }
                continue;
            }
        };
        let doi = (!entry.doi.is_empty()).then_some(entry.doi.as_str());
        let arxiv = (!entry.arxiv.is_empty()).then_some(entry.arxiv.as_str());
        if index.duplicate_of(doi, arxiv, &entry.title).is_some() {
            duplicates += 1;
            continue;
        }
        let id = uuid::Uuid::new_v4().to_string();
        tx.execute(
            "INSERT INTO papers(id,title,authors,year,venue,doi,arxiv,abstract,imported_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)",
            params![
                id,
                entry.title,
                entry.authors,
                (!entry.year.is_empty()).then_some(entry.year.as_str()),
                (!entry.venue.is_empty()).then_some(entry.venue.as_str()),
                doi,
                arxiv,
                (!entry.abstract_text.is_empty()).then_some(entry.abstract_text.as_str()),
                now_ms(),
                now_ms(),
            ],
        )?;
        index.remember(&id, &entry.title, doi, arxiv);
        imported += 1;
    }
    tx.commit()?;
    if failed > errors.len() {
        errors.push(format!("另有 {} 条失败记录未展开", failed - errors.len()));
    }
    Ok(json!({
        "imported": imported,
        "duplicates": duplicates,
        "failed": failed,
        "errors": errors,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::library::Library;
    use std::path::PathBuf;

    fn temp_lib() -> (std::sync::Arc<Library>, PathBuf) {
        let root = std::env::temp_dir().join(format!("moonlight-bibliography-{}", uuid::Uuid::new_v4()));
        let lib = Library::new(&root).unwrap();
        (lib, root)
    }

    fn paper_count(lib: &Library) -> i64 {
        lib.conn().query_row("SELECT COUNT(*) FROM papers", [], |row| row.get(0)).unwrap()
    }

    #[test]
    fn parses_bibtex_fields_authors_and_tex_protection() {
        let text = r#"
@comment{this is ignored}
@string{publisher = "ACM"}
@article{vaswani2017,
  title = {Attention Is {All} You Need},
  author = {Ashish Vaswani and Noam Shazeer AND Jakob Uszkoreit},
  journal = {NeurIPS},
  year = {2017},
  doi = {10.5555/3295222.3295349},
  eprint = {1706.03762v5},
  archiveprefix = {arXiv},
  abstract = {The dominant sequence transduction models are based on complex recurrent networks.},
  url = {https://example.org/paper}
}
@inproceedings(paren2024,
  title = "A Q\&A Benchmark",
  author = "Ada Lovelace",
  booktitle = {Proc. of {ACL}},
  date = {2024-05-01},
  url = {https://doi.org/10.1000/ABC}
)
"#;
        let entries = parse_bibtex(text);
        assert_eq!(entries.len(), 2, "comment/string/environment markers are skipped: {entries:?}");
        let first = entries[0].as_ref().unwrap();
        assert_eq!(first.title, "Attention Is All You Need");
        assert_eq!(first.authors, "Ashish Vaswani, Noam Shazeer, Jakob Uszkoreit");
        assert_eq!(first.year, "2017");
        assert_eq!(first.venue, "NeurIPS");
        assert_eq!(first.doi, "10.5555/3295222.3295349");
        assert_eq!(first.arxiv, "1706.03762v5");
        assert!(first.abstract_text.contains("dominant sequence"));

        let second = entries[1].as_ref().unwrap();
        assert_eq!(second.title, "A Q&A Benchmark");
        assert_eq!(second.authors, "Ada Lovelace");
        assert_eq!(second.venue, "Proc. of ACL");
        assert_eq!(second.year, "2024", "date is used when year is absent");
        assert_eq!(second.doi, "10.1000/ABC", "a doi.org url is recovered as the identifier");

        assert!(parse_bibtex("@article{broken, title={unterminated").first().unwrap().is_err());
        assert!(parse_bibtex("@article{no-title, author={A}}").first().unwrap().is_err());
        assert_eq!(parse_bibtex("just some free text, no entries"), Vec::new());
    }

    #[test]
    fn parses_ris_records_with_authors_abstract_and_arxiv() {
        let text = "\
TY  - JOUR
TI  - Efficient Serving Systems
AU  - Ada Lovelace
AU  - Alan Turing
PY  - 2021
JO  - ASPLOS
DO  - 10.1000/serve
AB  - A study of serving.
AN  - 2401.00001v3
ER  - 

TY  - JOUR
T1  - Second Paper
A1  - Grace Hopper
Y1  - 1952
ER  - 

TY  - JOUR
AU  - Nobody
ER  - 
";
        let entries = parse_ris(text);
        assert_eq!(entries.len(), 3, "{entries:?}");
        let first = entries[0].as_ref().unwrap();
        assert_eq!(first.title, "Efficient Serving Systems");
        assert_eq!(first.authors, "Ada Lovelace, Alan Turing");
        assert_eq!(first.year, "2021");
        assert_eq!(first.venue, "ASPLOS");
        assert_eq!(first.doi, "10.1000/serve");
        assert_eq!(first.arxiv, "2401.00001v3");
        assert_eq!(first.abstract_text, "A study of serving.");
        let second = entries[1].as_ref().unwrap();
        assert_eq!(second.title, "Second Paper");
        assert_eq!(second.year, "1952");
        assert!(entries[2].is_err(), "a record without TI/T1 is reported, not inserted");
    }

    #[test]
    fn imports_metadata_only_and_dedupes_by_doi_arxiv_and_title() {
        let (lib, root) = temp_lib();
        let text = r#"
@article{a,
  title = {Attention Is All You Need}, author = {Ashish Vaswani and Noam Shazeer},
  journal = {NeurIPS}, year = {2017}, doi = {10.5555/3295222.3295349},
  eprint = {1706.03762}, abstract = {An abstract.}
}
@article{b, title = {Same DOI Different Title}, author = {Someone}, doi = {10.5555/3295222.3295349}}
@article{c, title = {Same arXiv With Version}, author = {Someone}, eprint = {1706.03762v5}}
@article{d, title = {Attention is all you need!}, author = {Someone}}
@article{e, title = {Efficient Serving Systems}, author = {Ada Lovelace}, year = {2021}, journal = {ASPLOS}}
@article{f, author = {No Title}}
"#;
        let result = import_bibliography(&lib, &json!({"format":"bibtex","text":text})).unwrap();
        assert_eq!(result["imported"], json!(2), "{result}");
        assert_eq!(result["duplicates"], json!(3), "{result}");
        assert_eq!(result["failed"], json!(1), "{result}");
        assert!(result["errors"].as_array().unwrap().iter().any(|error| error.as_str().unwrap().contains("第 6 条")), "{result}");
        assert_eq!(paper_count(&lib), 2, "metadata-only import creates paper rows only");
        assert_eq!(lib.conn().query_row("SELECT COUNT(*) FROM versions", [], |row| row.get::<_, i64>(0)).unwrap(), 0);
        let paper = lib.get_paper(&result_primary(&lib, "Attention Is All You Need")).unwrap();
        assert_eq!(paper["title"], json!("Attention Is All You Need"));
        assert_eq!(paper["authors"], json!("Ashish Vaswani, Noam Shazeer"));
        assert_eq!(paper["year"], json!("2017"));
        assert_eq!(paper["venue"], json!("NeurIPS"));
        assert_eq!(paper["doi"], json!("10.5555/3295222.3295349"));
        assert_eq!(paper["arxiv"], json!("1706.03762"), "arXiv version suffix is stripped");
        assert_eq!(paper["abstract"], json!("An abstract."));
        assert_eq!(paper["versions"].as_array().unwrap().len(), 0);

        // Re-importing the same text is idempotent.
        let again = import_bibliography(&lib, &json!({"format":"bibtex","text":text})).unwrap();
        assert_eq!(again["imported"], json!(0), "{again}");
        assert_eq!(again["duplicates"], json!(5), "{again}");
        assert_eq!(paper_count(&lib), 2);

        // Cross-format dedupe also works against an existing library row.
        let ris = "TY  - JOUR\nTI  - Efficient serving systems\nAU  - Ada Lovelace\nER  - \n\nTY  - JOUR\nTI  - A Brand New RIS Paper\nPY  - 2022\nER  - \n";
        let mixed = import_bibliography(&lib, &json!({"format":"ris","text":ris})).unwrap();
        assert_eq!(mixed["imported"], json!(1), "{mixed}");
        assert_eq!(mixed["duplicates"], json!(1), "title match spans formats: {mixed}");
        assert_eq!(paper_count(&lib), 3);

        lib.conn().execute("INSERT INTO papers(id,title,authors,doi,imported_at,updated_at) VALUES('manual','Manual Paper','', '10.1000/manual',0,0)", []).unwrap();
        let manual = import_bibliography(&lib, &json!({"format":"bibtex","text":"@article{m, title={Another Title Entirely}, doi={https://doi.org/10.1000/MANUAL}}"})).unwrap();
        assert_eq!(manual["imported"], json!(0), "{manual}");
        assert_eq!(manual["duplicates"], json!(1), "DOI normalization catches URL/case variants: {manual}");

        drop(lib);
        std::fs::remove_dir_all(root).unwrap();
    }

    fn result_primary(lib: &Library, title: &str) -> String {
        lib.conn()
            .query_row("SELECT id FROM papers WHERE title=?", [title], |row| row.get(0))
            .unwrap()
    }

    #[test]
    fn rejects_oversized_inputs_and_unsupported_formats() {
        let (lib, root) = temp_lib();
        let huge = "x".repeat(MAX_BIBLIOGRAPHY_BYTES + 1);
        let error = import_bibliography(&lib, &json!({"format":"bibtex","text":huge})).unwrap_err().to_string();
        assert!(error.contains("过大"), "{error}");

        let many = (0..=MAX_BIBLIOGRAPHY_ENTRIES)
            .map(|index| format!("@article{{k{index}, title={{Unique title number {index} with enough words}}}}"))
            .collect::<Vec<_>>()
            .join("\n");
        let error = import_bibliography(&lib, &json!({"format":"bibtex","text":many})).unwrap_err().to_string();
        assert!(error.contains("2000"), "{error}");

        let error = import_bibliography(&lib, &json!({"format":"endnote","text":"@x{}"})).unwrap_err().to_string();
        assert!(error.contains("不支持"), "{error}");
        assert!(import_bibliography(&lib, &json!({"format":"bibtex","text":"   "})).is_err());
        assert!(import_bibliography(&lib, &json!({})).is_err());
        assert_eq!(paper_count(&lib), 0);

        drop(lib);
        std::fs::remove_dir_all(root).unwrap();
    }
}

