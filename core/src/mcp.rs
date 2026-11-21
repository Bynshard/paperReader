//! FEAT-AI-03: built-in local Model Context Protocol (MCP) server.
//!
//! `moonlight-core --root <library> --mcp` speaks JSON-RPC 2.0 over stdio
//! (one JSON object per line), so Cursor / Claude Desktop / VS Code agents can
//! query the local Moonlight library while writing code or LaTeX.
//!
//! The server is intentionally **read-only**: it exposes exactly five tools
//! (`search_papers`, `get_paper_summary`, `search_paper_evidence`,
//! `list_paper_annotations`, `list_library_taxonomy`) built on the existing
//! read paths, rejects mutating/unknown tool names, caps every payload and
//! never returns credentials, file paths or absolute PDF locations.

use crate::library::Library;
use crate::search;
use anyhow::{anyhow, Result};
use rusqlite::{params, OptionalExtension};
use serde_json::{json, Value};
use std::io::{BufRead, Write};
use std::sync::Arc;

/// MCP protocol revision implemented here.
pub const PROTOCOL_VERSION: &str = "2024-11-05";
pub const SERVER_NAME: &str = "moonlight";
pub const SERVER_VERSION: &str = "0.1.0";

/// Upper bound for one tool result text payload.
const MAX_TOOL_TEXT_CHARS: usize = 60_000;
const MAX_SEARCH_RESULTS: i64 = 20;
const MAX_EVIDENCE_RESULTS: i64 = 20;
const MAX_ANNOTATIONS: usize = 500;
const MAX_TAXONOMY_ENTRIES: usize = 1_000;
const MAX_EVIDENCE_TEXT_CHARS: usize = 1_200;

/// Names that would mutate the library; kept explicit so a client gets a
/// clearer error than "unknown tool".
const WRITE_TOOLS: &[&str] = &[
    "import_pdfs",
    "save_paper",
    "update_paper",
    "trash_paper",
    "restore_paper",
    "purge_paper",
    "add_annotation",
    "update_annotation",
    "delete_annotation",
    "set_categories",
    "set_tags",
    "add_category",
    "bulk_assign",
    "bulk_unassign",
    "bulk_set_status",
    "bulk_trash",
    "bulk_restore",
    "merge_papers",
    "save_glossary",
    "import_bibliography",
    "backup_create",
    "backup_restore",
    "reload_gateway",
    "shutdown",
];

/// Run the MCP server over stdin/stdout until EOF.
pub fn serve_stdio(lib: &Arc<Library>) -> Result<()> {
    let mut stdout = std::io::stdout();
    for line in std::io::stdin().lock().lines() {
        let line = line.map_err(|err| anyhow!("读取 MCP 标准输入失败：{err}"))?;
        if line.trim().is_empty() {
            continue;
        }
        if let Some(response) = handle_message(lib, &line) {
            writeln!(stdout, "{response}")?;
            stdout.flush()?;
        }
    }
    Ok(())
}

/// Handle one line of JSON-RPC input.
///
/// Returns the serialized response, or `None` for notifications and blank
/// input (JSON-RPC 2.0: notifications must not be answered).  Kept pure with
/// respect to stdin/stdout so tests can drive it directly.
pub fn handle_message(lib: &Arc<Library>, line: &str) -> Option<String> {
    if line.trim().is_empty() {
        return None;
    }
    let request: Value = match serde_json::from_str(line) {
        Ok(value) => value,
        Err(err) => {
            return Some(
                error_response(Value::Null, -32700, &format!("Parse error: {err}")).to_string(),
            )
        }
    };
    handle_request(lib, &request).map(|response| response.to_string())
}

fn handle_request(lib: &Arc<Library>, request: &Value) -> Option<Value> {
    if !request.is_object() {
        return Some(error_response(Value::Null, -32600, "Invalid Request"));
    }
    let id = request.get("id").cloned();
    let is_notification = id.is_none();
    let method = request.get("method").and_then(Value::as_str).unwrap_or("");
    let params = request.get("params").cloned().unwrap_or(json!({}));

    // The result itself is computed even for notifications (future-proof), but
    // only requests with an `id` get a response line.
    let result: Option<Result<Value>> = match method {
        "notifications/initialized" | "notifications/cancelled" => None,
        "initialize" => Some(Ok(json!({
            "protocolVersion": PROTOCOL_VERSION,
            "capabilities": {"tools": {"listChanged": false}},
            "serverInfo": {"name": SERVER_NAME, "version": SERVER_VERSION},
        }))),
        "ping" => Some(Ok(json!({}))),
        "tools/list" => Some(Ok(json!({"tools": tool_definitions()}))),
        "tools/call" => Some(call_tool(lib, &params)),
        // Empty lists keep generic MCP clients from erroring during discovery.
        "resources/list" => Some(Ok(json!({"resources": []}))),
        "prompts/list" => Some(Ok(json!({"prompts": []}))),
        _ => {
            return Some(error_response(
                id.unwrap_or(Value::Null),
                -32601,
                &format!("Method not found: {method}"),
            ))
        }
    };
    if is_notification {
        return None;
    }
    let id = id.unwrap_or(Value::Null);
    match result {
        None => None,
        Some(Ok(value)) => Some(ok_response(id, value)),
        Some(Err(error)) => Some(error_response(id, -32602, &error.to_string())),
    }
}

fn call_tool(lib: &Arc<Library>, params: &Value) -> Result<Value> {
    let name = params
        .get("name")
        .and_then(Value::as_str)
        .ok_or_else(|| anyhow!("tools/call 缺少 name"))?;
    let arguments = params.get("arguments").cloned().unwrap_or(json!({}));
    if !arguments.is_object() && !arguments.is_null() {
        return Err(anyhow!("tools/call 的 arguments 必须是 JSON 对象"));
    }
    let arguments = if arguments.is_null() {
        json!({})
    } else {
        arguments
    };
    if WRITE_TOOLS.contains(&name) {
        return Ok(tool_error(format!(
            "工具 {name} 是写操作；Moonlight MCP Server 只暴露只读工具，拒绝执行写操作。"
        )));
    }
    match name {
        "search_papers" => Ok(tool_result(tool_search_papers(lib, &arguments))),
        "get_paper_summary" => Ok(tool_result(tool_get_paper_summary(lib, &arguments))),
        "search_paper_evidence" => Ok(tool_result(tool_search_paper_evidence(lib, &arguments))),
        "list_paper_annotations" => Ok(tool_result(tool_list_paper_annotations(lib, &arguments))),
        "list_library_taxonomy" => Ok(tool_result(tool_list_library_taxonomy(lib))),
        other => Ok(tool_error(format!(
            "未知 MCP 工具：{other}。可用只读工具：{}",
            tool_names().join(", ")
        ))),
    }
}

fn tool_names() -> Vec<&'static str> {
    vec![
        "search_papers",
        "get_paper_summary",
        "search_paper_evidence",
        "list_paper_annotations",
        "list_library_taxonomy",
    ]
}

fn tool_definitions() -> Vec<Value> {
    vec![
        json!({
            "name": "search_papers",
            "description": "全文/元数据检索本地 Moonlight 论文库；返回论文元数据与命中段落（page 为 1-based 页码）。",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "query": {"type": "string", "description": "检索词（标题、作者、摘要或正文）；留空则按最近导入排序"},
                    "category": {"type": "string", "description": "分类 id（可选）"},
                    "tag": {"type": "string", "description": "标签名（可选）"},
                    "limit": {"type": "integer", "minimum": 1, "maximum": 20, "description": "返回条数，默认 10"}
                },
                "required": [],
                "additionalProperties": false
            }
        }),
        json!({
            "name": "get_paper_summary",
            "description": "读取一篇论文的元数据、摘要、完整用户笔记、速记与已缓存的一页纸导读；不含文件路径或凭据。",
            "inputSchema": {
                "type": "object",
                "properties": {"paper_id": {"type": "string", "description": "论文 id"}},
                "required": ["paper_id"],
                "additionalProperties": false
            }
        }),
        json!({
            "name": "search_paper_evidence",
            "description": "在一篇论文的原文（主 source 版本）中检索证据段落，返回精确页码（1-based）、段落文本、block id 与 bbox。",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "paper_id": {"type": "string", "description": "论文 id"},
                    "query": {"type": "string", "description": "检索词或一句话论点"},
                    "limit": {"type": "integer", "minimum": 1, "maximum": 20, "description": "返回段落数，默认 6"}
                },
                "required": ["paper_id", "query"],
                "additionalProperties": false
            }
        }),
        json!({
            "name": "list_paper_annotations",
            "description": "按页码排列一篇论文的高亮摘录与批注（page 为 1-based 页码）。",
            "inputSchema": {
                "type": "object",
                "properties": {"paper_id": {"type": "string", "description": "论文 id"}},
                "required": ["paper_id"],
                "additionalProperties": false
            }
        }),
        json!({
            "name": "list_library_taxonomy",
            "description": "读取当前论文库的目录树与标签分布（含每项论文数）。",
            "inputSchema": {
                "type": "object",
                "properties": {},
                "required": [],
                "additionalProperties": false
            }
        }),
    ]
}

// ---------------------------------------------------------------------------
// tool implementations (read-only)
// ---------------------------------------------------------------------------

fn tool_search_papers(lib: &Arc<Library>, args: &Value) -> Result<Value> {
    let query = args
        .get("query")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim()
        .chars()
        .take(256)
        .collect::<String>();
    let limit = args
        .get("limit")
        .and_then(Value::as_i64)
        .unwrap_or(10)
        .clamp(1, MAX_SEARCH_RESULTS);
    let params = json!({
        "query": query,
        "category": args.get("category").and_then(Value::as_str),
        "tag": args.get("tag").and_then(Value::as_str),
        "limit": limit,
        "offset": 0,
        "trashed": false,
    });
    let page = {
        let conn = lib.conn();
        search::list_page(&conn, &params)?
    };
    let items: Vec<Value> = page["items"]
        .as_array()
        .map(|items| items.as_slice())
        .unwrap_or(&[])
        .iter()
        .take(MAX_SEARCH_RESULTS as usize)
        .map(|item| {
            let mut out = json!({
                "paper_id": item["id"],
                "title": cap_value(&item["title"], 300),
                "authors": cap_value(&item["authors"], 300),
                "year": item["year"],
                "venue": item["venue"],
                "doi": item["doi"],
                "arxiv": item["arxiv"],
                "favorite": item["favorite"],
                "read_status": item["read_status"],
                "has_translation": item["has_translation"],
                "short_note": cap_value(&item["short_note"], 1_000),
                "categories": names_of(item["categories"].as_array()),
                "tags": names_of(item["tags"].as_array()),
            });
            if let Some(snippet) = item.get("match_snippet").and_then(Value::as_object) {
                // The search index stores 0-based pages; MCP clients get the
                // same 1-based page a human reads in the PDF.
                out["match_snippet"] = json!({
                    "page": snippet.get("page").and_then(Value::as_i64).unwrap_or(0) + 1,
                    "text": cap_value(&snippet.get("text").cloned().unwrap_or(Value::Null), 800),
                    "version_id": snippet.get("version_id"),
                });
            }
            out
        })
        .collect();
    Ok(json!({
        "query": query,
        "total": page["total"],
        "returned": items.len(),
        "items": items,
        "note": "page 为 1-based 页码；match_snippet 为正文命中段落。",
    }))
}

fn tool_get_paper_summary(lib: &Arc<Library>, args: &Value) -> Result<Value> {
    let paper_id = required_str(args, "paper_id")?;
    let paper = lib.get_paper(&paper_id)?;
    let digest = if paper["digest"].is_object() {
        json!({
            "markdown": cap_value(&paper["digest"]["markdown"], 12_000),
            "generated_at": paper["digest"]["generated_at"],
            "model": paper["digest"]["model"],
            "version_id": paper["digest"]["version_id"],
        })
    } else {
        Value::Null
    };
    // Deliberately hand-picked fields: `paper_json` embeds `rel_path`/`sha256`
    // per version, which must never leak through MCP.
    let versions: Vec<Value> = paper["versions"]
        .as_array()
        .map(|versions| {
            versions
                .iter()
                .take(50)
                .map(|version| {
                    json!({
                        "id": version["id"],
                        "kind": version["kind"],
                        "pages": version["pages"],
                        "created_at": version["created_at"],
                        "page_map": version["page_map"],
                    })
                })
                .collect()
        })
        .unwrap_or_default();
    Ok(json!({
        "paper_id": paper["id"],
        "title": cap_value(&paper["title"], 500),
        "authors": cap_value(&paper["authors"], 1_000),
        "year": paper["year"],
        "venue": paper["venue"],
        "doi": paper["doi"],
        "arxiv": paper["arxiv"],
        "abstract": cap_value(&paper["abstract"], 8_000),
        "notes": cap_value(&paper["notes"], 12_000),
        "short_note": cap_value(&paper["short_note"], 2_000),
        "favorite": paper["favorite"],
        "read_status": paper["read_status"],
        "imported_at": paper["imported_at"],
        "updated_at": paper["updated_at"],
        "categories": names_of(paper["categories"].as_array()),
        "tags": names_of(paper["tags"].as_array()),
        "versions": versions,
        "digest": digest,
    }))
}

fn tool_search_paper_evidence(lib: &Arc<Library>, args: &Value) -> Result<Value> {
    let paper_id = required_str(args, "paper_id")?;
    let query = required_str(args, "query")?;
    let limit = args
        .get("limit")
        .and_then(Value::as_i64)
        .unwrap_or(6)
        .clamp(1, MAX_EVIDENCE_RESULTS) as usize;
    let tokens = query_tokens(&query);
    let conn = lib.conn();
    let version: Option<String> = conn
        .query_row(
            "SELECT id FROM versions WHERE paper_id=? AND kind='source' ORDER BY created_at,id LIMIT 1",
            params![paper_id],
            |row| row.get(0),
        )
        .optional()?;
    let Some(version) = version else {
        return Ok(json!({
            "paper_id": paper_id,
            "query": query,
            "items": [],
            "note": "该论文还没有原文版本；请先在阅读器中打开并解析 PDF。",
        }));
    };
    let mut stmt = conn.prepare(
        "SELECT id,page,block_index,bbox,text FROM blocks \
         WHERE paper_id=? AND version_id=? AND length(trim(text))>0 \
         ORDER BY page,block_index LIMIT 20000",
    )?;
    let mapped = stmt.query_map(params![paper_id, version], |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, i64>(1)?,
            row.get::<_, i64>(2)?,
            row.get::<_, String>(3)?,
            row.get::<_, String>(4)?,
        ))
    })?;
    let mut ranked: Vec<(f64, i64, i64, String, String, String)> = Vec::new();
    for row in mapped {
        let (block_id, page, block_index, bbox, text) = row?;
        let lowered = text.to_lowercase();
        let mut score = 0.0f64;
        for token in &tokens {
            if token.is_empty() {
                continue;
            }
            let hits = lowered.matches(token.as_str()).count();
            score += hits as f64;
        }
        if score <= 0.0 {
            continue;
        }
        ranked.push((score, page, block_index, block_id, bbox, text));
    }
    drop(stmt);
    drop(conn);
    ranked.sort_by(|left, right| {
        right
            .0
            .total_cmp(&left.0)
            .then(left.1.cmp(&right.1))
            .then(left.2.cmp(&right.2))
    });
    ranked.truncate(limit);
    let items: Vec<Value> = ranked
        .into_iter()
        .map(|(score, page, block_index, block_id, bbox, text)| {
            json!({
                "paper_id": paper_id,
                "page": page + 1,
                "page_index": page,
                "block_id": block_id,
                "block_index": block_index,
                "bbox": serde_json::from_str::<Value>(&bbox).unwrap_or(json!([])),
                "score": (score * 100.0).round() / 100.0,
                "text": snippet_around(&text, &tokens, 200),
            })
        })
        .collect();
    Ok(json!({
        "paper_id": paper_id,
        "query": query,
        "version_id": version,
        "items": items,
        "note": if items.is_empty() {
            "未在原文中检索到包含检索词的段落；请换用更常见的英文术语。"
        } else {
            "page 为 1-based 页码；text 为命中段落附近的原文摘录。"
        },
    }))
}

fn tool_list_paper_annotations(lib: &Arc<Library>, args: &Value) -> Result<Value> {
    let paper_id = required_str(args, "paper_id")?;
    let annotations = lib.list_annotations(&paper_id)?;
    let mut items: Vec<Value> = Vec::new();
    let mut used_chars = 0usize;
    let mut truncated = false;
    for annotation in annotations.iter().take(MAX_ANNOTATIONS) {
        let quote = cap_value(&annotation["quote"], 1_000);
        let comment = cap_value(&annotation["comment"], 1_000);
        let cost = quote.chars().count() + comment.chars().count() + 200;
        if used_chars + cost > MAX_TOOL_TEXT_CHARS.saturating_sub(2_000) {
            truncated = true;
            break;
        }
        used_chars += cost;
        items.push(json!({
            "annotation_id": annotation["id"],
            "page": annotation["page"].as_i64().unwrap_or(0) + 1,
            "page_index": annotation["page"],
            "version_kind": annotation["version_kind"],
            "version_id": annotation["version_id"],
            "color": annotation["color"],
            "quote": quote,
            "comment": comment,
            "created_at": annotation["created_at"],
        }));
    }
    Ok(json!({
        "paper_id": paper_id,
        "count": items.len(),
        "truncated": truncated,
        "items": items,
        "note": "page 为 1-based 页码；按页码升序排列。",
    }))
}

fn tool_list_library_taxonomy(lib: &Arc<Library>) -> Result<Value> {
    let taxonomy = lib.taxonomy()?;
    let categories: Vec<Value> = taxonomy["categories"]
        .as_array()
        .map(|entries| entries.as_slice())
        .unwrap_or(&[])
        .iter()
        .take(MAX_TAXONOMY_ENTRIES)
        .map(|entry| {
            json!({
                "id": entry["id"],
                "name": cap_value(&entry["name"], 200),
                "parent_id": entry["parent_id"],
                "paper_count": entry["paper_count"],
            })
        })
        .collect();
    let tags: Vec<Value> = taxonomy["tags"]
        .as_array()
        .map(|entries| entries.as_slice())
        .unwrap_or(&[])
        .iter()
        .take(MAX_TAXONOMY_ENTRIES)
        .map(|entry| {
            json!({
                "id": entry["id"],
                "name": cap_value(&entry["name"], 200),
                "paper_count": entry["paper_count"],
            })
        })
        .collect();
    Ok(json!({"categories": categories, "tags": tags}))
}

// ---------------------------------------------------------------------------
// protocol + payload helpers
// ---------------------------------------------------------------------------

fn tool_result(result: Result<Value>) -> Value {
    match result {
        Ok(payload) => {
            let mut text = payload.to_string();
            if text.chars().count() > MAX_TOOL_TEXT_CHARS {
                text = json!({
                    "truncated": true,
                    "note": format!("输出超过 {MAX_TOOL_TEXT_CHARS} 字符上限；请使用更精确的 query、更小的 limit 或指定 paper_id。"),
                    "preview": truncate_chars(&text, 8_000),
                })
                .to_string();
            }
            json!({"content": [{"type": "text", "text": text}], "isError": false})
        }
        Err(error) => tool_error(error.to_string()),
    }
}

fn tool_error(message: impl Into<String>) -> Value {
    json!({
        "content": [{"type": "text", "text": message.into()}],
        "isError": true,
    })
}

fn ok_response(id: Value, result: Value) -> Value {
    json!({"jsonrpc": "2.0", "id": id, "result": result})
}

fn error_response(id: Value, code: i64, message: &str) -> Value {
    json!({"jsonrpc": "2.0", "id": id, "error": {"code": code, "message": message}})
}

fn required_str(args: &Value, key: &str) -> Result<String> {
    args.get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty() && value.chars().count() <= 500)
        .map(str::to_string)
        .ok_or_else(|| anyhow!("缺少参数 {key}（需要 1–500 字符的字符串）"))
}

fn truncate_chars(text: &str, max: usize) -> String {
    if text.chars().count() <= max {
        return text.to_string();
    }
    let mut out: String = text.chars().take(max).collect();
    out.push('…');
    out
}

fn cap_value(value: &Value, max: usize) -> String {
    value
        .as_str()
        .map(|text| truncate_chars(text.trim(), max))
        .unwrap_or_default()
}

fn names_of(entries: Option<&Vec<Value>>) -> Vec<String> {
    entries
        .map(|items| {
            items
                .iter()
                .filter_map(|item| item["name"].as_str())
                .take(50)
                .map(|name| truncate_chars(name, 200))
                .collect()
        })
        .unwrap_or_default()
}

/// Split a query into lowercase tokens; a spaceless CJK/identifier query stays
/// one token (substring matching still works for Han text).
fn query_tokens(query: &str) -> Vec<String> {
    let mut tokens: Vec<String> = query
        .split_whitespace()
        .map(|token| {
            token
                .trim_matches(|ch: char| ch.is_ascii_punctuation())
                .to_lowercase()
        })
        .filter(|token| !token.is_empty())
        .collect();
    if tokens.is_empty() {
        let whole = query.trim().to_lowercase();
        if !whole.is_empty() {
            tokens.push(whole);
        }
    }
    tokens.truncate(12);
    tokens
}

/// ±`radius` characters around the earliest token match, newline-free.
fn snippet_around(text: &str, tokens: &[String], radius: usize) -> String {
    let lowered = text.to_lowercase();
    let hit = tokens
        .iter()
        .filter_map(|token| {
            lowered
                .find(token.as_str())
                .map(|byte| (byte, token.chars().count()))
        })
        .min_by_key(|(byte, _)| *byte);
    let chars: Vec<char> = text.chars().collect();
    let (start_char, token_chars) = match hit {
        Some((byte, len)) => (lowered[..byte].chars().count(), len),
        None => (0, 0),
    };
    let start = start_char.saturating_sub(radius);
    let end = (start_char + token_chars + radius)
        .min(chars.len())
        .max(start);
    let mut snippet: String = chars[start..end]
        .iter()
        .collect::<String>()
        .replace(['\n', '\r'], " ");
    if start > 0 {
        snippet.insert(0, '…');
    }
    if end < chars.len() {
        snippet.push('…');
    }
    truncate_chars(snippet.trim(), MAX_EVIDENCE_TEXT_CHARS)
}

// ---------------------------------------------------------------------------
// tests (drive the pure JSON-RPC layer against a temp library fixture)
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_library(tag: &str) -> (Arc<Library>, std::path::PathBuf) {
        let stamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|value| value.as_nanos())
            .unwrap_or(0);
        let root = std::env::temp_dir().join(format!(
            "moonlight-mcp-{tag}-{}-{stamp}",
            std::process::id()
        ));
        let lib = Library::new(&root).unwrap();
        (lib, root)
    }

    fn seed(lib: &Library) {
        let conn = lib.conn();
        conn.execute(
            "INSERT INTO papers(id,title,authors,abstract,notes,short_note,imported_at,updated_at) VALUES(?1,?2,?3,?4,?5,?6,0,0)",
            params![
                "p1",
                "Transformer Survey",
                "Ada Lovelace",
                "A survey of transformer models.",
                "用户笔记：attention 很关键",
                "速记：transformer",
            ],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO versions(id,paper_id,kind,sha256,rel_path,pages,bytes,created_at) VALUES('v1','p1','source','hash','p1.pdf',2,10,0)",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO categories(id,name,sort_order) VALUES('c1','NLP',0)",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO paper_categories(paper_id,category_id) VALUES('p1','c1')",
            [],
        )
        .unwrap();
        conn.execute("INSERT INTO tags(id,name) VALUES('t1','transformers')", [])
            .unwrap();
        conn.execute(
            "INSERT INTO paper_tags(paper_id,tag_id) VALUES('p1','t1')",
            [],
        )
        .unwrap();
        drop(conn);
        lib.set_blocks(
            "p1",
            "v1",
            0,
            vec![json!({
                "text": "Transformer attention improves translation quality.",
                "bbox": [1, 2, 3, 4]
            })],
        )
        .unwrap();
        lib.set_blocks(
            "p1",
            "v1",
            1,
            vec![json!({
                "text": "Baseline results are reported on the benchmark.",
                "bbox": [5, 6, 7, 8]
            })],
        )
        .unwrap();
        lib.add_annotation(
            "p1",
            0,
            json!([[1.0, 2.0, 3.0, 4.0]]),
            "Transformer attention improves translation quality.",
            "yellow",
            "这条批注指出了核心贡献",
            "source",
            Some("v1"),
        )
        .unwrap();
        lib.save_digest(
            "p1",
            &json!({"markdown": "## ① 研究痛点\nTransformer 综述。", "generated_at": 7i64, "model": "fixture"}),
        )
        .unwrap();
    }

    fn call(lib: &Arc<Library>, name: &str, arguments: Value) -> Value {
        let request = json!({
            "jsonrpc": "2.0",
            "id": 9,
            "method": "tools/call",
            "params": {"name": name, "arguments": arguments},
        });
        let response = handle_message(lib, &request.to_string()).expect("tools/call must respond");
        let response: Value = serde_json::from_str(&response).unwrap();
        let text = response["result"]["content"][0]["text"]
            .as_str()
            .expect("tool content must be text");
        json!({
            "isError": response["result"]["isError"],
            "payload": serde_json::from_str::<Value>(text).unwrap_or(Value::Null),
            "text": text,
        })
    }

    #[test]
    fn initialize_and_tools_list_are_mcp_compatible() {
        let (lib, root) = temp_library("protocol");
        let init = handle_message(
            &lib,
            &json!({"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}).to_string(),
        )
        .unwrap();
        let init: Value = serde_json::from_str(&init).unwrap();
        assert_eq!(init["jsonrpc"], json!("2.0"));
        assert_eq!(init["id"], json!(1));
        assert_eq!(init["result"]["protocolVersion"], json!(PROTOCOL_VERSION));
        assert_eq!(init["result"]["serverInfo"]["name"], json!("moonlight"));

        let list = handle_message(
            &lib,
            &json!({"jsonrpc":"2.0","id":2,"method":"tools/list"}).to_string(),
        )
        .unwrap();
        let list: Value = serde_json::from_str(&list).unwrap();
        let mut names: Vec<String> = list["result"]["tools"]
            .as_array()
            .unwrap()
            .iter()
            .map(|tool| tool["name"].as_str().unwrap().to_string())
            .collect();
        names.sort();
        let mut expected: Vec<String> = tool_names().iter().map(|name| name.to_string()).collect();
        expected.sort();
        assert_eq!(names, expected);
        assert_eq!(names.len(), 5, "exactly five read-only tools");
        for tool in list["result"]["tools"].as_array().unwrap() {
            assert_eq!(tool["inputSchema"]["type"], json!("object"));
        }

        // Notifications never get a response line.
        assert!(handle_message(
            &lib,
            &json!({"jsonrpc":"2.0","method":"notifications/initialized"}).to_string()
        )
        .is_none());
        drop(lib);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn search_papers_tool_returns_capped_items_and_page_numbers() {
        let (lib, root) = temp_library("search");
        seed(&lib);
        let result = call(
            &lib,
            "search_papers",
            json!({"query": "Transformer", "limit": 5}),
        );
        assert_eq!(result["isError"], json!(false), "{result}");
        let payload = &result["payload"];
        assert!(payload["total"].as_i64().unwrap() >= 1);
        let items = payload["items"].as_array().unwrap();
        assert_eq!(items.len(), 1);
        assert_eq!(items[0]["paper_id"], json!("p1"));
        assert_eq!(items[0]["title"], json!("Transformer Survey"));
        assert_eq!(items[0]["categories"], json!(["NLP"]));
        assert_eq!(items[0]["tags"], json!(["transformers"]));
        assert_eq!(items[0]["match_snippet"]["page"], json!(1));
        drop(lib);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn summary_tool_returns_notes_and_digest_without_private_paths() {
        let (lib, root) = temp_library("summary");
        seed(&lib);
        let result = call(&lib, "get_paper_summary", json!({"paper_id": "p1"}));
        assert_eq!(result["isError"], json!(false), "{result}");
        let payload = &result["payload"];
        assert_eq!(payload["title"], json!("Transformer Survey"));
        assert_eq!(payload["notes"], json!("用户笔记：attention 很关键"));
        assert_eq!(payload["digest"]["markdown"], json!("## ① 研究痛点\nTransformer 综述。"));
        assert_eq!(payload["versions"][0]["id"], json!("v1"));
        assert_eq!(payload["versions"][0]["pages"], json!(2));
        // No path, hash or credential may leak through MCP.
        let text = result["text"].as_str().unwrap();
        for forbidden in ["rel_path", "sha256", "p1.pdf", "api_key", "token"] {
            assert!(!text.contains(forbidden), "summary leaked {forbidden}: {text}");
        }
        drop(lib);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn evidence_tool_returns_precise_pages_and_reports_empty_matches() {
        let (lib, root) = temp_library("evidence");
        seed(&lib);
        let result = call(
            &lib,
            "search_paper_evidence",
            json!({"paper_id": "p1", "query": "baseline benchmark"}),
        );
        assert_eq!(result["isError"], json!(false), "{result}");
        let items = result["payload"]["items"].as_array().unwrap();
        assert_eq!(items.len(), 1);
        assert_eq!(items[0]["page"], json!(2));
        assert_eq!(items[0]["page_index"], json!(1));
        assert!(items[0]["text"].as_str().unwrap().contains("Baseline"));

        let empty = call(
            &lib,
            "search_paper_evidence",
            json!({"paper_id": "p1", "query": "nonexistentphrase"}),
        );
        assert_eq!(empty["isError"], json!(false));
        assert_eq!(empty["payload"]["items"], json!([]));

        let missing = call(
            &lib,
            "search_paper_evidence",
            json!({"paper_id": "missing", "query": "x"}),
        );
        // A missing paper has no source version; it is reported as a readable
        // empty result rather than a hard protocol failure.
        assert_eq!(missing["payload"]["items"], json!([]));
        drop(lib);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn annotations_and_taxonomy_tools_are_read_only() {
        let (lib, root) = temp_library("annotations");
        seed(&lib);
        let annotations = call(&lib, "list_paper_annotations", json!({"paper_id": "p1"}));
        assert_eq!(annotations["isError"], json!(false), "{annotations}");
        let items = annotations["payload"]["items"].as_array().unwrap();
        assert_eq!(items.len(), 1);
        assert_eq!(items[0]["page"], json!(1));
        assert_eq!(items[0]["quote"], json!("Transformer attention improves translation quality."));
        assert_eq!(items[0]["comment"], json!("这条批注指出了核心贡献"));

        let taxonomy = call(&lib, "list_library_taxonomy", json!({}));
        assert_eq!(taxonomy["isError"], json!(false), "{taxonomy}");
        assert_eq!(taxonomy["payload"]["categories"][0]["name"], json!("NLP"));
        assert_eq!(taxonomy["payload"]["categories"][0]["paper_count"], json!(1));
        assert_eq!(taxonomy["payload"]["tags"][0]["name"], json!("transformers"));
        drop(lib);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn write_tools_unknown_tools_and_bad_input_are_rejected() {
        let (lib, root) = temp_library("reject");
        seed(&lib);
        let write = call(&lib, "add_annotation", json!({"paper_id": "p1"}));
        assert_eq!(write["isError"], json!(true));
        assert!(write["text"].as_str().unwrap().contains("只读"));

        let unknown = call(&lib, "delete_everything", json!({}));
        assert_eq!(unknown["isError"], json!(true));
        assert!(unknown["text"].as_str().unwrap().contains("未知 MCP 工具"));

        let missing_arg = call(&lib, "get_paper_summary", json!({}));
        assert_eq!(missing_arg["isError"], json!(true));
        assert!(missing_arg["text"].as_str().unwrap().contains("paper_id"));

        let unknown_method = handle_message(
            &lib,
            &json!({"jsonrpc":"2.0","id":3,"method":"library/delete"}).to_string(),
        )
        .unwrap();
        let unknown_method: Value = serde_json::from_str(&unknown_method).unwrap();
        assert_eq!(unknown_method["error"]["code"], json!(-32601));

        let parse_error = handle_message(&lib, "{not json").unwrap();
        let parse_error: Value = serde_json::from_str(&parse_error).unwrap();
        assert_eq!(parse_error["error"]["code"], json!(-32700));
        assert_eq!(parse_error["id"], json!(null));
        drop(lib);
        std::fs::remove_dir_all(root).unwrap();
    }
}
