//! Explicit citation lookups; no network on list render. Counts are source-specific.
use crate::library::{Library,now_ms};
use anyhow::{Result,anyhow,ensure};
use rusqlite::params;
use serde_json::{json,Value};
use std::{sync::{Mutex,OnceLock},time::{Duration,Instant},io::Read};
static HTTP:OnceLock<reqwest::blocking::Client>=OnceLock::new();
static LAST:Mutex<Option<Instant>>=Mutex::new(None);
fn get(url:reqwest::Url)->Result<Value>{
    {
        let mut last=LAST.lock().map_err(|_|anyhow!("citation request lock"))?;
        if let Some(previous)=*last{if let Some(wait)=Duration::from_secs(1).checked_sub(previous.elapsed()){std::thread::sleep(wait);}}
        *last=Some(Instant::now());
    }
    let client=HTTP.get_or_init(||reqwest::blocking::Client::builder().connect_timeout(Duration::from_secs(5)).timeout(Duration::from_secs(20)).redirect(reqwest::redirect::Policy::none()).user_agent("Moonlight/0.1 (https://github.com/Bynshard/paperReader)").build().expect("citation HTTP client"));
    let response=client.get(url).send()?;
    if response.status().as_u16()==429{return Err(anyhow!("引用量服务限流，请稍后刷新；已有缓存已保留"));}
    ensure!(response.status().is_success(),"引用量查询失败（HTTP {}），未更新已有缓存",response.status());
    let mut text=String::new();response.take(2_000_001).read_to_string(&mut text)?;
    ensure!(text.len()<=2_000_000,"引用量响应过大");Ok(serde_json::from_str(&text)?)
}
fn doi(raw:&str)->String {let text=raw.trim();for prefix in ["https://doi.org/","http://doi.org/","https://dx.doi.org/","doi:","DOI:"]{if let Some(value)=text.strip_prefix(prefix){return value.trim().to_ascii_lowercase();}}text.to_ascii_lowercase()}
fn arxiv(raw:&str)->String {
    let text=raw.trim().trim_start_matches("arXiv:").trim_start_matches("https://arxiv.org/abs/").trim_start_matches("https://arxiv.org/pdf/").trim_end_matches(".pdf");
    let re=regex::Regex::new(r"v\d+$").unwrap();re.replace(text,"").to_string()
}
fn crossref(identifier:&str)->Result<(i64,String,String)>{
    let mut url=reqwest::Url::parse("https://api.crossref.org/works/")?;url.path_segments_mut().unwrap().pop_if_empty().push(identifier);
    let response=get(url)?;let message=&response["message"];
    ensure!(message["DOI"].as_str().map(doi).as_deref()==Some(identifier),"返回的 DOI 不一致，未保存引用量");
    let count=message["is-referenced-by-count"].as_i64().filter(|n|*n>=0).ok_or_else(||anyhow!("Crossref 未返回引用量，保持未知"))?;
    Ok((count,"Crossref".to_string(),format!("https://doi.org/{identifier}")))
}
fn semantic(kind:&str,identifier:&str)->Result<(i64,String,String)>{
    let mut url=reqwest::Url::parse("https://api.semanticscholar.org/graph/v1/paper/")?;url.path_segments_mut().unwrap().pop_if_empty().push(&format!("{kind}:{identifier}"));url.query_pairs_mut().append_pair("fields","citationCount,externalIds,url");
    let response=get(url)?;
    let same=if kind=="DOI"{response["externalIds"]["DOI"].as_str().map(doi)}else{response["externalIds"]["ArXiv"].as_str().map(arxiv)};
    ensure!(same.as_deref()==Some(identifier),"返回的论文标识不一致，未保存引用量");
    let count=response["citationCount"].as_i64().filter(|n|*n>=0).ok_or_else(||anyhow!("Semantic Scholar 未返回引用量，保持未知"))?;
    let source_url=response["url"].as_str().filter(|url|url.starts_with("https://www.semanticscholar.org/")).unwrap_or("https://www.semanticscholar.org/").to_string();
    Ok((count,"Semantic Scholar".to_string(),source_url))
}
pub fn refresh(lib:&Library,p:&Value)->Result<Value>{
    let id=p["paper_id"].as_str().ok_or_else(||anyhow!("paper_id required"))?;
    // A refresh needs identifiers and metrics only, never full notes/versions.
    let paper:Value=lib.conn().query_row("SELECT doi,arxiv,citation_count,citation_source,citation_updated_at,deleted_at IS NOT NULL FROM papers WHERE id=?",[id],|r|Ok(json!({"doi":r.get::<_,Option<String>>(0)?,"arxiv":r.get::<_,Option<String>>(1)?,"citation_count":r.get::<_,Option<i64>>(2)?,"citation_source":r.get::<_,Option<String>>(3)?,"citation_updated_at":r.get::<_,Option<i64>>(4)?,"deleted":r.get::<_,bool>(5)?})))?;
    ensure!(paper["deleted"]!=true,"回收站论文不刷新引用量");
    if !p["force"].as_bool().unwrap_or(false)&&paper["citation_count"].as_i64().is_some(){
        let age=now_ms()-paper["citation_updated_at"].as_i64().unwrap_or(0);
        if (0..7*24*60*60*1000).contains(&age){return Ok(json!({"cached":true,"citation_count":paper["citation_count"],"citation_source":paper["citation_source"],"citation_updated_at":paper["citation_updated_at"]}));}
    }
    let raw_doi=paper["doi"].as_str();let raw_arxiv=paper["arxiv"].as_str();
    let doi_id=raw_doi.filter(|s|!s.trim().is_empty()).map(doi);
    let arxiv_id=raw_arxiv.filter(|s|!s.trim().is_empty()).map(arxiv);
    let (count,source,source_url)=if let Some(identifier)=doi_id {
        ensure!(identifier.starts_with("10.")&&identifier.contains('/')&&identifier.len()<=500,"DOI 格式无效，请先编辑资料");
        // Crossref does not register every DOI (for example DataCite/arXiv).
        // Fall back by the same exact DOI, never by a fuzzy title search.
        crossref(&identifier).or_else(|first|semantic("DOI",&identifier).map_err(|second|anyhow!("Crossref：{first}；Semantic Scholar：{second}")))?
    }else if let Some(identifier)=arxiv_id {
        ensure!(regex::Regex::new(r"^(?:\d{4}\.\d{4,5}|[A-Za-z.-]+/\d{7})$")?.is_match(&identifier),"arXiv ID 无效，请先编辑资料");
        semantic("ARXIV",&identifier)?
    }else{return Err(anyhow!("缺少 DOI/arXiv ID，请先编辑资料；不会按近似标题猜测论文"));};
    let fetched_at=now_ms();
    {
        let conn=lib.conn();
        let updated=conn.execute("UPDATE papers SET citation_count=?,citation_source=?,citation_updated_at=?,citation_url=?,updated_at=max(updated_at+1,?) WHERE id=? AND doi IS ? AND arxiv IS ? AND deleted_at IS NULL",params![count,source,fetched_at,source_url,fetched_at,id,raw_doi,raw_arxiv])?;
        ensure!(updated==1,"查询期间论文标识已修改，未保存旧引用量");
    }
    Ok(json!({"cached":false,"citation_count":count,"citation_source":source,"citation_updated_at":fetched_at}))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn exact_identifier_normalization(){assert_eq!(doi("https://doi.org/10.1000/ABC"),"10.1000/abc");assert_eq!(arxiv("https://arxiv.org/abs/2409.19256v2"),"2409.19256");}
    #[test]
    fn zero_is_cached_and_identifier_edits_invalidate_metrics_without_network(){
        let root=std::env::temp_dir().join(format!("moonlight-citations-{}",uuid::Uuid::new_v4()));let lib=Library::new(&root).unwrap();
        lib.conn().execute("INSERT INTO papers(id,title,authors,doi,imported_at,updated_at,citation_count,citation_source,citation_updated_at) VALUES('p','Paper','','10.1000/example',0,0,0,'Crossref',?)",[now_ms()]).unwrap();
        let result=refresh(&lib,&json!({"paper_id":"p"})).unwrap();assert_eq!(result["cached"],true);assert_eq!(result["citation_count"],0);
        lib.update_paper("p",&json!({"doi":""})).unwrap();let fresh=lib.get_paper("p").unwrap();assert!(fresh["citation_count"].is_null());assert!(fresh["citation_updated_at"].is_null());
        assert!(refresh(&lib,&json!({"paper_id":"p"})).unwrap_err().to_string().contains("缺少 DOI"));
        drop(lib);std::fs::remove_dir_all(root).unwrap();
    }
}
