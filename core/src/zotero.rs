//! Legacy local API fallback. Full-fidelity migration uses zotero_local.
pub use crate::zotero_local::{probe, import};
use crate::library::Library;
use anyhow::{anyhow, Result};
use regex::Regex;
use serde_json::{json, Value};
use std::{path::PathBuf, time::Duration};

fn local_api_base() -> String {
    std::env::var("MOONLIGHT_ZOTERO_API").unwrap_or_else(|_| "http://127.0.0.1:23119/api/users/0".into())
}
fn http_get(url:&str, timeout:u64)->Result<(u16,Vec<u8>)> {
    let response=reqwest::blocking::Client::builder().timeout(Duration::from_secs(timeout)).build()?.get(url).header("Zotero-API-Version","3").send()?;
    Ok((response.status().as_u16(),response.bytes()?.to_vec()))
}
fn http_json(url:&str,timeout:u64)->Result<Value> {
    let(status,body)=http_get(url,timeout)?;
    if status>=400 {return Err(anyhow!("Zotero API HTTP {status}"));}
    Ok(serde_json::from_slice(&body)?)
}

fn api_items() -> Result<Vec<Value>> {
    let mut out = Vec::new();
    let mut start = 0;
    loop {
        let url = format!("{}/items?format=json&limit=100&start={start}", local_api_base());
        let page = http_json(&url, 10)?;
        let arr = page.as_array().ok_or_else(|| anyhow!("unexpected Zotero API payload"))?.clone();
        if arr.is_empty() {
            break;
        }
        let n = arr.len();
        out.extend(arr);
        start += n;
        if n < 100 {
            break;
        }
    }
    Ok(out)
}

fn api_item_pdf(item_key: &str) -> Option<PathBuf> {
    let children = http_json(&format!("{}/items/{}/children?format=json", local_api_base(), item_key), 10).ok()?;
    for child in children.as_array()? {
        let data = &child["data"];
        let ctype = data["contentType"].as_str().unwrap_or("");
        if !ctype.to_lowercase().contains("pdf") {
            continue;
        }
        let key = child["key"].as_str()?;
        let (status, bytes) = http_get(&format!("{}/items/{}/file", local_api_base(), key), 60).ok()?;
        if status == 200 && bytes.starts_with(b"%PDF") {
            let path = std::env::temp_dir().join(format!("moonlight-zotero-{key}.pdf"));
            std::fs::write(&path, &bytes).ok()?;
            return Some(path);
        }
    }
    None
}

pub fn api_import(lib: &Library, opts: &Value) -> Result<Value> {
    let items = api_items()?;
    let mut report = json!({"source": "local_api", "items": 0, "imported": 0, "without_pdf": 0, "errors": []});
    let mut errors: Vec<Value> = Vec::new();
    for item in items {
        let data = &item["data"];
        if data["parentItem"].as_str().is_some() || data["deleted"].as_i64()==Some(1) || data["itemType"]=="annotation" {continue;}
        let limit=opts["limit"].as_i64().unwrap_or(0);
        if limit>0 && report["items"].as_i64().unwrap_or(0)>=limit {break;}
        let key = item["key"].as_str().unwrap_or_default();
        let title = data["title"].as_str().unwrap_or("Untitled");
        let doi = data["DOI"].as_str().unwrap_or("");
        let year = data["date"].as_str().and_then(|d| Regex::new(r"\b(19|20)\d{2}\b").ok().and_then(|re| re.find(d).map(|m| m.as_str().to_string())));
        let authors = data["creators"]
            .as_array()
            .map(|a| a.iter().filter_map(|c| c["name"].as_str().or_else(|| c["lastName"].as_str()).map(|s| s.to_string())).collect::<Vec<_>>().join(", "))
            .unwrap_or_default();
        let pdf = api_item_pdf(key);
        let venue = data["publicationTitle"].as_str().or_else(|| data["conferenceName"].as_str()).unwrap_or("");
        match lib.import_external(
            pdf.as_deref(),
            title,
            &authors,
            year.as_deref(),
            venue,
            doi,
            "",
            data["abstractNote"].as_str(),
            "",
        ) {
            Ok(v) => {
                report["items"] = json!(report["items"].as_i64().unwrap_or(0) + 1);
                report["imported"] = json!(report["imported"].as_i64().unwrap_or(0) + 1);
                if v["status"] == "imported_without_pdf" {
                    report["without_pdf"] = json!(report["without_pdf"].as_i64().unwrap_or(0) + 1);
                }
            }
            Err(err) => errors.push(json!({"item": key, "error": err.to_string()})),
        }
    }
    report["errors"] = Value::Array(errors);
    Ok(report)
}
