//! SQLite library, filenames, annotations, jobs and translation versions.

use crate::engine::{self, Gateway};
use crate::pdfmeta;
use anyhow::{anyhow, Context, Result};
use rusqlite::{backup::Backup, params, Connection, OpenFlags, OptionalExtension};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use uuid::Uuid;

const SCHEMA: &str = r#"
PRAGMA journal_mode=WAL;
PRAGMA foreign_keys=ON;
CREATE TABLE IF NOT EXISTS papers (
  id TEXT PRIMARY KEY, title TEXT NOT NULL, authors TEXT NOT NULL DEFAULT '',
  year TEXT, venue TEXT, doi TEXT, arxiv TEXT, abstract TEXT,
  imported_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  favorite INTEGER NOT NULL DEFAULT 0, read_status TEXT NOT NULL DEFAULT 'unread',
  deleted_at INTEGER, notes TEXT NOT NULL DEFAULT '',
  last_read_page INTEGER, last_read_fraction REAL, last_read_mode TEXT, last_read_at INTEGER,
  digest_json TEXT
);
CREATE TABLE IF NOT EXISTS versions (
  id TEXT PRIMARY KEY, paper_id TEXT NOT NULL REFERENCES papers(id) ON DELETE CASCADE,
  kind TEXT NOT NULL, sha256 TEXT NOT NULL, rel_path TEXT NOT NULL,
  pages INTEGER NOT NULL, bytes INTEGER NOT NULL, lang TEXT NOT NULL DEFAULT '',
  engine TEXT, model TEXT, created_at INTEGER NOT NULL, source_version_id TEXT,
  page_map TEXT
);
CREATE TABLE IF NOT EXISTS blocks (
  id TEXT PRIMARY KEY, paper_id TEXT NOT NULL REFERENCES papers(id) ON DELETE CASCADE,
  version_id TEXT NOT NULL, page INTEGER NOT NULL, block_index INTEGER NOT NULL,
  kind TEXT NOT NULL, bbox TEXT NOT NULL, text TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_blocks_page ON blocks(paper_id, version_id, page);
CREATE INDEX IF NOT EXISTS idx_versions_kind ON versions(paper_id, kind, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_versions_hash ON versions(sha256, kind);
CREATE INDEX IF NOT EXISTS idx_papers_recent ON papers(imported_at DESC, id DESC) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_papers_title ON papers(deleted_at, title COLLATE NOCASE, id);
CREATE INDEX IF NOT EXISTS idx_papers_year ON papers(deleted_at, year DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_papers_trash ON papers(deleted_at, imported_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_papers_favorite ON papers(favorite, imported_at DESC, id DESC) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_papers_status ON papers(read_status, imported_at DESC, id DESC) WHERE deleted_at IS NULL;
CREATE VIRTUAL TABLE IF NOT EXISTS blocks_fts USING fts5(text, block_id UNINDEXED, paper_id UNINDEXED, page UNINDEXED, tokenize='unicode61');
CREATE TABLE IF NOT EXISTS categories (id TEXT PRIMARY KEY, name TEXT NOT NULL, color TEXT, sort_order INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS paper_categories (
  paper_id TEXT NOT NULL REFERENCES papers(id) ON DELETE CASCADE,
  category_id TEXT NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
  PRIMARY KEY (paper_id, category_id)
);
CREATE TABLE IF NOT EXISTS tags (id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, color TEXT);
CREATE TABLE IF NOT EXISTS paper_tags (
  paper_id TEXT NOT NULL REFERENCES papers(id) ON DELETE CASCADE,
  tag_id TEXT NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  PRIMARY KEY (paper_id, tag_id)
);
CREATE TABLE IF NOT EXISTS annotations (
  id TEXT PRIMARY KEY, paper_id TEXT NOT NULL REFERENCES papers(id) ON DELETE CASCADE,
  version_kind TEXT NOT NULL DEFAULT 'source', version_id TEXT, page INTEGER NOT NULL,
  rects TEXT NOT NULL, quote TEXT NOT NULL, color TEXT NOT NULL DEFAULT 'yellow',
  comment TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY, paper_id TEXT NOT NULL, status TEXT NOT NULL, pages TEXT,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, error TEXT, output_version_id TEXT,
  source_version_id TEXT
);
CREATE TABLE IF NOT EXISTS zotero_map (
  item_key TEXT PRIMARY KEY, paper_id TEXT NOT NULL, imported_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS chats (
  id TEXT PRIMARY KEY, paper_id TEXT NOT NULL REFERENCES papers(id) ON DELETE CASCADE,
  kind TEXT NOT NULL, question TEXT NOT NULL, answer TEXT NOT NULL, sources TEXT NOT NULL,
  model TEXT, created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_categories_paper ON paper_categories(category_id, paper_id);
CREATE INDEX IF NOT EXISTS idx_tags_paper ON paper_tags(tag_id, paper_id);
CREATE INDEX IF NOT EXISTS idx_annotations_paper ON annotations(paper_id, page);
CREATE INDEX IF NOT EXISTS idx_chats_paper_time ON chats(paper_id, created_at DESC);
CREATE TABLE IF NOT EXISTS app_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
-- FEAT-UX-03: user-managed terminology table. `source` is unique per library
-- (case-insensitively) so saving is idempotent; `enabled=0` keeps a row while
-- excluding it from every prompt/CSV injection path.
CREATE TABLE IF NOT EXISTS glossary_terms (
  id TEXT PRIMARY KEY, source TEXT NOT NULL COLLATE NOCASE UNIQUE,
  target TEXT NOT NULL, domain TEXT NOT NULL DEFAULT '', enabled INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS idx_glossary_enabled ON glossary_terms(enabled, source);
CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL);
"#;

/// Bump whenever a migration in [`apply_migrations`] is added.
const SCHEMA_VERSION: i64 = 7;

/// Upper bound for expanding a `--pages` selector into a page map.  A selector
/// is user input (or an engine argument), so an absurd range like `1-99999999`
/// must never allocate without bound; exceeding this falls back to the identity
/// mapping instead of failing an otherwise finished translation.
const MAX_PAGE_MAP: i64 = 100_000;

pub type Emitter = Arc<dyn Fn(Value) + Send + Sync>;

/// Prompt sentence that every glossary injection path shares.  The loopback
/// gateway skips requests that already contain it, which is how
/// `ai::translate_text`/`explain_with` can attach a *matched* subset without the
/// gateway appending the whole table a second time.
pub const GLOSSARY_MARKER: &str = "遇到以下专业术语按指定译法";

/// Hard cap for one library's glossary (FEAT-UX-03 §schema).
pub const GLOSSARY_MAX_TERMS: usize = 500;

/// One saved glossary row, as read back for prompts/CSV export.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct GlossaryTerm {
    pub source: String,
    pub target: String,
    pub domain: String,
    pub enabled: bool,
}

impl GlossaryTerm {
    pub fn to_json(&self) -> Value {
        json!({
            "source": self.source,
            "target": self.target,
            "domain": self.domain,
            "enabled": self.enabled,
        })
    }
}

/// Render `source -> target` constraints for a system prompt.
///
/// Kept free-standing (instead of a `Library` method) so `engine` can build the
/// exact same sentence for the loopback-gateway fallback without touching a
/// second connection.  `limit` bounds the prompt size; callers usually pass 24
/// (AI turn) or 40 (whole-document fallback).
pub fn glossary_system_segment(terms: &[(String, String)], limit: usize) -> String {
    let picked: Vec<String> = terms
        .iter()
        .take(limit)
        .map(|(source, target)| format!("{source} -> {target}"))
        .collect();
    if picked.is_empty() {
        return String::new();
    }
    format!(
        "{GLOSSARY_MARKER}（保留英文或严格使用目标译名，不要意译）：{}。",
        picked.join("；")
    )
}


/// Effective translation-engine settings.
///
/// Kept next to the gateway so one saved configuration can hot-swap the
/// loopback gateway, probe it, and drive the BabelDOC arguments without an app
/// restart.  The key stays in memory only.
#[derive(Clone, Debug)]
pub struct GatewayConfig {
    pub upstream: String,
    pub model: String,
    pub api_key: String,
    pub qps: u32,
    pub babeldoc: String,
}

pub struct Library {
    pub(crate) sync: crate::sync::Manager,
    root: PathBuf,
    _lock: Option<fs::File>,
    pub(crate) maintenance: Mutex<()>,
    translation_tx: std::sync::mpsc::SyncSender<(String,String,PathBuf,Option<String>,Option<String>)>,
    conn: Mutex<Connection>,
    emitter: Mutex<Option<Emitter>>,
    gateway: Mutex<Option<Gateway>>,
    gateway_config: Mutex<Option<GatewayConfig>>,
    cancels: Mutex<HashMap<String, Arc<AtomicBool>>>,
}

pub fn now_ms() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0)
}

pub fn sha256_file(path: &Path) -> Result<String> {
    let mut file = fs::File::open(path)?;
    let mut hasher = Sha256::new();
    let mut buf = [0u8; 1 << 20];
    loop {
        let n = file.read(&mut buf)?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }
    Ok(hex::encode(hasher.finalize()))
}

mod hex {
    pub fn encode(bytes: impl AsRef<[u8]>) -> String {
        bytes.as_ref().iter().map(|b| format!("{b:02x}")).collect()
    }
}

fn copy_with_retry(from: &Path, to: &Path) -> Result<()> {
    let mut last = None;
    for attempt in 0..8 {
        match fs::copy(from, to) {
            Ok(_) => return Ok(()),
            Err(err) => {
                last = Some(err);
                #[cfg(windows)]
                if matches!(last.as_ref().map(|e| e.kind()), Some(std::io::ErrorKind::PermissionDenied)) {
                    std::thread::sleep(Duration::from_millis(40 * (attempt + 1)));
                    continue;
                }
                break;
            }
        }
    }
    Err(last.unwrap().into())
}

fn rename_with_retry(from: &Path, to: &Path) -> Result<()> {
    let mut last = None;
    for attempt in 0..8 {
        match fs::rename(from, to) {
            Ok(()) => return Ok(()),
            Err(err) => {
                last = Some(err);
                // Windows antivirus/indexers can briefly hold a freshly written
                // PDF. Retry only the permission/sharing case, then report.
                #[cfg(windows)]
                if matches!(last.as_ref().map(|e| e.kind()), Some(std::io::ErrorKind::PermissionDenied)) {
                    std::thread::sleep(Duration::from_millis(40 * (attempt + 1)));
                    continue;
                }
                break;
            }
        }
    }
    Err(last.unwrap().into())
}

fn table_exists(conn: &Connection, name: &str) -> Result<bool> {
    Ok(conn.query_row("SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name=?)", [name], |r| r.get::<_, bool>(0))?)
}

/// Remove leftover `<library>/tmp/job-*` working directories and staged
/// `job-<id>.mono.pdf` outputs.
///
/// `run_translation` now cleans its own directory, but a hard crash, a killed
/// process or an upgrade from an older build can leave one behind.  The
/// single-instance lock guarantees no other process is using these files.
fn sweep_orphan_translation_dirs(root: &Path) -> usize {
    let mut removed = 0;
    let Ok(entries) = fs::read_dir(root.join("tmp")) else { return 0 };
    for entry in entries.filter_map(Result::ok) {
        let path = entry.path();
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if !name.starts_with("job-") {
            continue;
        }
        // The success path stages the engine PDF next to the run directory so
        // the directory can be removed before the job is marked completed.
        let swept = if path.is_dir() {
            fs::remove_dir_all(&path).is_ok()
        } else if path.is_file() && name.ends_with(".mono.pdf") {
            fs::remove_file(&path).is_ok()
        } else {
            false
        };
        if swept {
            removed += 1;
        }
    }
    removed
}

fn schema_version(conn: &Connection) -> Result<i64> {
    if !table_exists(conn, "schema_migrations")? { return Ok(0); }
    Ok(conn.query_row("SELECT MAX(version) FROM schema_migrations", [], |r| r.get::<_, Option<i64>>(0))?.unwrap_or(0))
}

fn column_exists(conn: &Connection, table: &str, column: &str) -> Result<bool> {
    Ok(conn.prepare(&format!("PRAGMA table_info({table})"))?.query_map([], |r| r.get::<_, String>(1))?.collect::<rusqlite::Result<Vec<_>>>()?.iter().any(|name| name == column))
}

fn ensure_column(conn: &Connection, table: &str, column: &str, definition: &str) -> Result<()> {
    if !column_exists(conn, table, column)? {
        conn.execute_batch(&format!("ALTER TABLE {table} ADD COLUMN {column} {definition};"))?;
    }
    Ok(())
}

/// Parse a BabelDOC `--pages` selector into the 0-based source page indexes it
/// actually translated.
///
/// Accepted shapes mirror what the reader's “仅翻译当前页/页码范围” UI sends:
/// `"8"`, `"5-8"`, `"1-5, 8"` (whitespace and duplicates tolerated).  The
/// returned list is sorted ascending and deduplicated, because BabelDOC emits
/// the subset PDF in source order.  Anything unparseable, empty, or larger than
/// [`MAX_PAGE_MAP`] returns `None`, which callers persist as `NULL`
/// (= full translation / identity mapping) instead of failing the job.
fn parse_pages_selector(raw: &str) -> Option<Vec<i64>> {
    let mut pages = std::collections::BTreeSet::new();
    let mut any = false;
    for part in raw.split(',') {
        let part = part.trim();
        if part.is_empty() {
            continue;
        }
        any = true;
        if let Some((start, end)) = part.split_once('-') {
            let start = start.trim();
            let end = end.trim();
            // “-5” means 1..=5; an open-ended “5-” needs the document length,
            // which is not part of a `jobs.pages` selector, so it is rejected.
            if end.is_empty() {
                return None;
            }
            let start: i64 = if start.is_empty() {
                1
            } else {
                start.parse().ok()?
            };
            let end: i64 = end.parse().ok()?;
            let (start, end) = (start.min(end), start.max(end));
            // `checked_add` keeps a hostile selector such as `1-9223372036854775807`
            // from overflowing into an effectively infinite loop.
            let span = end.checked_sub(start).and_then(|span| span.checked_add(1));
            if start < 1 || span.map_or(true, |span| span > MAX_PAGE_MAP) {
                return None;
            }
            for page in start..=end {
                pages.insert(page - 1);
            }
        } else {
            let page: i64 = part.parse().ok()?;
            if page < 1 {
                return None;
            }
            pages.insert(page - 1);
        }
        if pages.len() as i64 > MAX_PAGE_MAP {
            return None;
        }
    }
    if !any || pages.is_empty() {
        None
    } else {
        Some(pages.into_iter().collect())
    }
}

/// Stored `versions.page_map` as a sorted 0-based source page list.
///
/// `None` means the version is a full translation (identity).  A malformed
/// stored value is treated as `None` so a corrupt row can never make block
/// writes fail.
fn stored_page_map(raw: Option<&str>) -> Option<Vec<i64>> {
    let map: Vec<i64> = serde_json::from_str(raw?).ok()?;
    if map.is_empty() || map.iter().any(|page| *page < 0) {
        None
    } else {
        Some(map)
    }
}

/// `(kind, pages, page_map)` for one version, with the version owned by the paper.
fn version_page_layout(conn: &Connection, paper_id: &str, version_id: &str) -> Result<(String, i64, Option<Vec<i64>>)> {
    let row = conn
        .query_row(
            "SELECT kind,pages,page_map FROM versions WHERE id=? AND paper_id=?",
            params![version_id, paper_id],
            |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?, r.get::<_, Option<String>>(2)?)),
        )
        .optional()?
        .ok_or_else(|| anyhow!("version not found"))?;
    Ok((row.0, row.1, stored_page_map(row.2.as_deref())))
}

/// Copy `library.db` to `<library>/backups/` before a schema upgrade, verify the
/// snapshot, and keep the newest five snapshots.
fn backup_before_upgrade(root: &Path, from: i64, to: i64) -> Result<PathBuf> {
    let dir = root.join("backups");
    fs::create_dir_all(&dir)?;
    let mut dest = dir.join(format!("pre-upgrade-v{from}-to-v{to}-{}.db", now_ms()));
    if dest.exists() { dest = dir.join(format!("pre-upgrade-v{from}-to-v{to}-{}-{}.db", now_ms(), Uuid::new_v4())); }
    {
        let source = Connection::open_with_flags(root.join("library.db"), OpenFlags::SQLITE_OPEN_READ_ONLY)?;
        let mut snapshot = Connection::open(&dest)?;
        Backup::new(&source, &mut snapshot)?.run_to_completion(256, Duration::from_millis(2), None)?;
        let check: String = snapshot.query_row("PRAGMA integrity_check", [], |r| r.get(0))?;
        if check != "ok" {
            drop(snapshot);
            let _ = fs::remove_file(&dest);
            anyhow::bail!("升级前备份完整性校验失败，已中止升级");
        }
        snapshot.execute_batch("PRAGMA journal_mode=DELETE;")?;
    }
    let mut snapshots: Vec<PathBuf> = fs::read_dir(&dir)?.filter_map(|entry| entry.ok().map(|item| item.path())).filter(|path| path.file_name().map(|name| name.to_string_lossy().starts_with("pre-upgrade-") && name.to_string_lossy().ends_with(".db")).unwrap_or(false)).collect();
    snapshots.sort();
    while snapshots.len() > 5 {
        let oldest = snapshots.remove(0);
        let _ = fs::remove_file(oldest);
    }
    Ok(dest)
}

fn apply_migrations(conn: &Connection, from: i64) -> Result<()> {
    if from < 2 {
        ensure_column(conn, "annotations", "version_id", "TEXT")?;
        ensure_column(conn, "versions", "source_version_id", "TEXT")?;
        ensure_column(conn, "jobs", "source_version_id", "TEXT")?;
        conn.execute_batch("CREATE INDEX IF NOT EXISTS idx_versions_source ON versions(source_version_id);")?;
    }
    if from < 3 {
        // Cross-device reading position.  Nullable on purpose: a library that
        // predates v3 has no resume point yet, and `NULL` is what the UI renders
        // as "start at the beginning".  Re-running the migration (for instance
        // after an interrupted upgrade) is a no-op thanks to `ensure_column`.
        ensure_column(conn, "papers", "last_read_page", "INTEGER")?;
        ensure_column(conn, "papers", "last_read_fraction", "REAL")?;
        ensure_column(conn, "papers", "last_read_mode", "TEXT")?;
        ensure_column(conn, "papers", "last_read_at", "INTEGER")?;
    }
    if from < 4 {
        // Cached 1-page structured digest (§3.4.1).  Nullable: every existing
        // paper simply reuses the no-cache path until a digest is generated.
        ensure_column(conn, "papers", "digest_json", "TEXT")?;
    }
    if from < 5 {
        // Small key/value store for app-level preferences that must survive a
        // restart *and* be visible to the headless sidecar (LAN tablet bridge,
        // quick explain, digest).  `chat_model` lives here so every transport
        // resolves the same chat-only model without Electron settings.
        conn.execute_batch("CREATE TABLE IF NOT EXISTS app_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);")?;
    }
    if from < 6 {
        // BUG-01: partial-page (`--pages`) translations produce a PDF that only
        // contains the selected subset, so block and annotation page numbers
        // need the real 0-based *source* page.  `page_map` is a JSON array such
        // as `[7]` or `[4,5,6,7]`; `NULL` means a full translation and therefore
        // the identity mapping `i -> i`.  Nullable on purpose: every existing
        // version keeps its historical (full-document) behavior.
        ensure_column(conn, "versions", "page_map", "TEXT")?;
    }
    if from < 7 {
        // FEAT-UX-03: user terminology glossary.  The table is also part of
        // `SCHEMA` (so a fresh library gets it before the first migration), but
        // it is created here as well: an upgraded v6 file must gain it through
        // the same migration path (and tests roll a real v6 fixture back).
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS glossary_terms (
               id TEXT PRIMARY KEY, source TEXT NOT NULL COLLATE NOCASE UNIQUE,
               target TEXT NOT NULL, domain TEXT NOT NULL DEFAULT '', enabled INTEGER NOT NULL DEFAULT 1
             );
             CREATE INDEX IF NOT EXISTS idx_glossary_enabled ON glossary_terms(enabled, source);",
        )?;
    }
    Ok(())
}

/// Create/upgrade the SQLite schema.  Existing libraries are snapshotted before
/// any migration so a failed upgrade can never be the only copy of user data.
fn initialize_schema(conn: &Connection, root: &Path) -> Result<()> {
    let legacy = table_exists(conn, "papers")?;
    let mut version = if legacy { schema_version(conn)? } else { 0 };
    if legacy && version == 0 { version = 1; }
    anyhow::ensure!(version <= SCHEMA_VERSION, "论文库来自更新版本的 Moonlight（schema v{version}），请升级应用后再打开");
    if legacy && version < SCHEMA_VERSION {
        backup_before_upgrade(root, version, SCHEMA_VERSION)?;
    }
    conn.execute_batch(SCHEMA)?;
    if legacy && version < SCHEMA_VERSION {
        let tx = conn.unchecked_transaction()?;
        tx.execute("INSERT OR IGNORE INTO schema_migrations(version,applied_at) VALUES(1,?)", [now_ms()])?;
        apply_migrations(&tx, version)?;
        tx.execute("INSERT OR IGNORE INTO schema_migrations(version,applied_at) VALUES(?,?)", params![SCHEMA_VERSION, now_ms()])?;
        tx.commit()?;
    } else if !legacy {
        for v in 1..=SCHEMA_VERSION {
            conn.execute("INSERT OR IGNORE INTO schema_migrations(version,applied_at) VALUES(?,?)", params![v, now_ms()])?;
        }
    }
    conn.execute_batch("CREATE INDEX IF NOT EXISTS idx_versions_source ON versions(source_version_id);")?;
    Ok(())
}

impl Library {
    pub fn new(root: &Path) -> Result<Arc<Self>> {
        fs::create_dir_all(root.join("files"))?;
        fs::create_dir_all(root.join("derived"))?;
        fs::create_dir_all(root.join("tmp"))?;
        let lock=fs::OpenOptions::new().create(true).truncate(false).read(true).write(true).open(root.join(".moonlight.lock"))?;
        lock.try_lock().map_err(|_|anyhow!("论文库已被另一个 Moonlight 进程使用"))?;
        let conn = Connection::open(root.join("library.db"))?;
        conn.busy_timeout(std::time::Duration::from_secs(5))?;
        // Triggers use this scalar for CJK bigrams; every connection that may
        // fire them must register it before the first write.
        crate::search::register(&conn)?;
        initialize_schema(&conn, root)?;
        conn.execute_batch(crate::zotero_local::SCHEMA)?;
        crate::organization::initialize(&conn)?;
        crate::sync::initialize(&conn)?;
        crate::search::initialize(&conn)?;
        conn.execute("UPDATE jobs SET status='failed',error='应用上次异常退出，任务已中断；可重试',updated_at=? WHERE status NOT IN ('completed','failed','cancelled')",[now_ms()])?;
        // BUG-06: `run_translation` cleans its own tmp/job-<id>, but a crash can
        // orphan one.  With the single-instance lock held it is safe to sweep.
        sweep_orphan_translation_dirs(root);
        conn.execute_batch("CREATE UNIQUE INDEX IF NOT EXISTS idx_jobs_active_paper ON jobs(paper_id) WHERE status NOT IN ('completed','failed','cancelled'); CREATE INDEX IF NOT EXISTS idx_jobs_recent ON jobs(created_at DESC,id);")?;
        let (translation_tx,translation_rx)=std::sync::mpsc::sync_channel::<(String,String,PathBuf,Option<String>,Option<String>)>(32);
        let lib = Arc::new(Self {
            sync: crate::sync::Manager::default(),
            root: root.to_path_buf(),
            _lock: Some(lock),
            maintenance: Mutex::new(()),
            translation_tx,
            conn: Mutex::new(conn),
            emitter: Mutex::new(None),
            gateway: Mutex::new(None),
            gateway_config: Mutex::new(None),
            cancels: Mutex::new(HashMap::new()),
        });
        let weak=Arc::downgrade(&lib);
        std::thread::Builder::new().name("translation-queue".into()).spawn(move||{
            while let Ok((job,paper,source,pages,source_version_id))=translation_rx.recv(){
                let Some(lib)=weak.upgrade() else {break};
                engine::run_translation(lib,job,paper,source,pages,source_version_id);
            }
        })?;
        lib.seed_categories()?;
        Ok(lib)
    }

    /// Read-only opener for `moonlight-core --mcp` so external IDE agents can
    /// query an open library without contending on `.moonlight.lock` or running
    /// desktop startup cleanups on `jobs` / `tmp/`.
    pub fn open_for_mcp(root: &Path) -> Result<Arc<Self>> {
        let db = root.join("library.db");
        if !db.is_file() {
            return Self::new(root);
        }
        let conn = Connection::open_with_flags(&db, OpenFlags::SQLITE_OPEN_READ_ONLY)?;
        conn.busy_timeout(std::time::Duration::from_secs(5))?;
        crate::search::register(&conn)?;
        let (translation_tx, _) = std::sync::mpsc::sync_channel(1);
        Ok(Arc::new(Self {
            sync: crate::sync::Manager::default(),
            root: root.to_path_buf(),
            _lock: None,
            maintenance: Mutex::new(()),
            translation_tx,
            conn: Mutex::new(conn),
            emitter: Mutex::new(None),
            gateway: Mutex::new(None),
            gateway_config: Mutex::new(None),
            cancels: Mutex::new(HashMap::new()),
        }))
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    pub fn set_emitter(&self, emitter: Emitter) {
        *self.emitter.lock().unwrap() = Some(emitter);
    }

    pub fn emit(&self, value: Value) {
        if let Some(cb) = self.emitter.lock().unwrap().as_ref() {
            cb(value);
        }
    }

    pub fn conn(&self) -> std::sync::MutexGuard<'_, Connection> {
        self.conn.lock().unwrap()
    }

    fn seed_categories(&self) -> Result<()> {
        let conn = self.conn();
        let count: i64 = conn.query_row("SELECT COUNT(*) FROM categories", [], |r| r.get(0))?;
        if count == 0 {
            for (i, name) in ["待读", "精读", "已读", "方法", "实验"].iter().enumerate() {
                conn.execute(
                    "INSERT INTO categories(id,name,sort_order) VALUES(?,?,?)",
                    params![crate::sync::digest(&format!("default-category:{name}")), name, i as i64],
                )?;
            }
        }
        Ok(())
    }

    // ---- app settings ---------------------------------------------------
    /// Persist the chat-only model pick from 「设置 → AI 阅读助手」.
    ///
    /// Electron keeps its own `ai-settings.json`, but quick explain (highlight
    /// bubble / context chips / region ask), the digest and the LAN tablet
    /// bridge all call `explain` / `ai_digest` directly.  Storing the choice in
    /// the library lets every transport resolve the same model.  An empty or
    /// whitespace-only value clears the override.
    pub fn set_chat_model(&self, model: &str) -> Result<Value> {
        let model = model.trim();
        anyhow::ensure!(model.chars().count() <= 200, "问答模型名称过长（最多 200 字）");
        let conn = self.conn();
        if model.is_empty() {
            conn.execute("DELETE FROM app_settings WHERE key='chat_model'", [])?;
            Ok(json!({"ok": true, "chat_model": Value::Null}))
        } else {
            conn.execute("INSERT OR REPLACE INTO app_settings(key,value) VALUES('chat_model',?)", [model])?;
            Ok(json!({"ok": true, "chat_model": model}))
        }
    }

    /// The persisted chat-only model, `None` when unset or cleared.
    pub fn chat_model(&self) -> Option<String> {
        self.conn()
            .query_row("SELECT value FROM app_settings WHERE key='chat_model'", [], |r| r.get::<_, String>(0))
            .optional()
            .ok()
            .flatten()
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty())
    }

    // ---- glossary (FEAT-UX-03) -----------------------------------------
    /// Read-only glossary rows for the LAN read pool / tests.
    pub fn glossary_on(conn: &Connection) -> Result<Vec<GlossaryTerm>> {
        let mut stmt = conn.prepare(
            "SELECT source,target,domain,enabled FROM glossary_terms ORDER BY domain COLLATE NOCASE, source COLLATE NOCASE",
        )?;
        let rows = stmt.query_map([], |r| {
            Ok(GlossaryTerm {
                source: r.get(0)?,
                target: r.get(1)?,
                domain: r.get(2)?,
                enabled: r.get::<_, i64>(3)? != 0,
            })
        })?;
        Ok(rows.filter_map(Result::ok).collect())
    }

    pub fn glossary_terms(&self) -> Result<Vec<GlossaryTerm>> {
        Self::glossary_on(&self.conn())
    }

    /// `list_glossary` contract: `{terms:[{source,target,domain,enabled}]}`.
    pub fn list_glossary(&self) -> Result<Value> {
        let terms: Vec<Value> = self.glossary_terms()?.iter().map(GlossaryTerm::to_json).collect();
        Ok(json!({ "terms": terms }))
    }

    /// Enabled `(source,target)` pairs in stable order, for the gateway and for
    /// BabelDOC's glossary CSV.
    pub fn enabled_glossary_pairs(&self) -> Result<Vec<(String, String)>> {
        Ok(self
            .glossary_terms()?
            .into_iter()
            .filter(|term| term.enabled)
            .map(|term| (term.source, term.target))
            .collect())
    }

    /// Pick at most `limit` enabled terms for one AI turn.
    ///
    /// Terms that literally occur in `haystack` (question + evidence) win; the
    /// remaining slots are filled with globally enabled terms so a short English
    /// snippet still carries the table.  Returns `None` when the glossary is
    /// empty, which keeps the historic prompt byte-identical.
    pub fn glossary_prompt_for(&self, haystack: &str, limit: usize) -> Result<Option<String>> {
        let mut terms = self
            .glossary_terms()?
            .into_iter()
            .filter(|term| term.enabled)
            .collect::<Vec<_>>();
        if terms.is_empty() || limit == 0 {
            return Ok(None);
        }
        let lower = haystack.to_lowercase();
        terms.sort_by_key(|term| {
            let hit = !term.source.is_empty() && lower.contains(&term.source.to_lowercase());
            (!hit, term.source.to_lowercase())
        });
        let pairs: Vec<(String, String)> = terms
            .into_iter()
            .take(limit)
            .map(|term| (term.source, term.target))
            .collect();
        let segment = glossary_system_segment(&pairs, limit);
        Ok((!segment.is_empty()).then_some(segment))
    }

    /// Persist the whole glossary from `save_glossary` (`{terms:[…]}`).
    ///
    /// Trims every field, rejects an empty source/target, caps the table at
    /// [`GLOSSARY_MAX_TERMS`], deduplicates case-insensitively (first wins) so a
    /// double-clicked "add" row never fails the save, and then hot-updates the
    /// live gateway state without restarting it.
    pub fn save_glossary(&self, params: &Value) -> Result<Value> {
        let raw = params
            .get("terms")
            .and_then(Value::as_array)
            .ok_or_else(|| anyhow!("缺少术语表 terms"))?;
        anyhow::ensure!(raw.len() <= GLOSSARY_MAX_TERMS, "术语表最多 {GLOSSARY_MAX_TERMS} 条");
        let mut seen = HashSet::new();
        let mut normalized: Vec<(String, String, String, i64)> = Vec::new();
        for item in raw {
            let source = item.get("source").and_then(Value::as_str).unwrap_or("").trim();
            let target = item.get("target").and_then(Value::as_str).unwrap_or("").trim();
            anyhow::ensure!(!source.is_empty(), "术语原文不能为空");
            anyhow::ensure!(!target.is_empty(), "术语译文不能为空");
            anyhow::ensure!(source.chars().count() <= 200, "术语原文最多 200 字");
            anyhow::ensure!(target.chars().count() <= 300, "术语译文最多 300 字");
            let domain = item.get("domain").and_then(Value::as_str).unwrap_or("").trim();
            anyhow::ensure!(domain.chars().count() <= 100, "术语学科最多 100 字");
            if !seen.insert(source.to_lowercase()) {
                continue;
            }
            let enabled = i64::from(item.get("enabled").and_then(Value::as_bool).unwrap_or(true));
            normalized.push((source.to_string(), target.to_string(), domain.to_string(), enabled));
        }
        {
            let conn = self.conn();
            let tx = conn.unchecked_transaction()?;
            tx.execute("DELETE FROM glossary_terms", [])?;
            for (source, target, domain, enabled) in &normalized {
                tx.execute(
                    "INSERT INTO glossary_terms(id,source,target,domain,enabled) VALUES(?,?,?,?,?)",
                    params![Uuid::new_v4().to_string(), source, target, domain, enabled],
                )?;
            }
            tx.commit()?;
        }
        self.sync_gateway_glossary();
        Ok(json!({ "ok": true, "count": normalized.len() }))
    }

    /// Push the enabled glossary into the live loopback gateway (hot update).
    ///
    /// Loads the DB first, then takes the gateway lock, so the lock order is
    /// always `conn -> gateway` and cannot deadlock against request handlers.
    fn sync_gateway_glossary(&self) {
        if let Ok(pairs) = self.enabled_glossary_pairs() {
            if let Some(gateway) = self.gateway.lock().unwrap().as_ref() {
                gateway.set_glossary(pairs);
            }
        }
    }

    // ---- papers ---------------------------------------------------------
    pub fn import_paths(&self, paths: Vec<String>) -> Vec<Value> {
        paths
            .iter()
            .map(|raw| match self.import_one(Path::new(raw)) {
                Ok(v) => v,
                Err(err) => json!({"path": raw, "status": "failed", "error": err.to_string()}),
            })
            .collect()
    }

    fn import_one(&self, path: &Path) -> Result<Value> {
        if !path.exists() || path.extension().map(|e| e != "pdf").unwrap_or(true) {
            return Err(anyhow!("not a PDF file"));
        }
        let sha = sha256_file(path)?;
        {
            let conn = self.conn();
            if let Some((id, title, deleted)) = conn
                .query_row(
                    "SELECT p.id,p.title,p.deleted_at FROM versions v JOIN papers p ON p.id=v.paper_id WHERE v.sha256=? AND v.kind='source'",
                    params![sha],
                    |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, Option<i64>>(2)?)),
                )
                .optional()?
            {
                if deleted.is_some() {
                    conn.execute("UPDATE papers SET deleted_at=NULL WHERE id=?", params![id])?;
                }
                return Ok(json!({"status": "duplicate", "paper_id": id, "title": title, "sha256": sha}));
            }
        }
        let (meta, text) = pdfmeta::inspect(path)?;
        let paper_id = Uuid::new_v4().to_string();
        let version_id = Uuid::new_v4().to_string();
        let rel = format!("files/{sha}.pdf");
        let dest = self.root.join(&rel);
        let tmp = self.root.join("tmp").join(format!("{paper_id}.pdf"));
        fs::copy(path, &tmp)?;
        fs::rename(&tmp, &dest)?;
        let bytes = dest.metadata()?.len() as i64;
        {
            let conn = self.conn();
            let tx = conn.unchecked_transaction()?;
            tx.execute(
                "INSERT INTO papers(id,title,authors,year,venue,doi,arxiv,abstract,imported_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)",
                params![
                    paper_id,
                    meta.title.clone(),
                    meta.authors.clone(),
                    meta.year.clone(),
                    meta.venue.clone(),
                    meta.doi.clone(),
                    meta.arxiv.clone(),
                    meta.abstract_text.clone(),
                    now_ms(),
                    now_ms()
                ],
            )?;
            tx.execute(
                "INSERT INTO versions(id,paper_id,kind,sha256,rel_path,pages,bytes,lang,created_at) VALUES(?,?,?,?,?,?,?,?,?)",
                params![version_id, paper_id, "source", sha, rel, meta.pages, bytes, "en", now_ms()],
            )?;
            Self::index_coarse_text(&tx, &paper_id, &version_id, &text)?;
            tx.commit()?;
        }
        Ok(json!({
            "status": "imported", "paper_id": paper_id, "version_id": version_id,
            "title": meta.title, "pages": meta.pages, "sha256": sha
        }))
    }

    fn index_coarse_text(tx: &Connection, paper_id: &str, version_id: &str, text: &str) -> Result<()> {
        for (page, page_text) in text.split('\u{000c}').enumerate() {
          for (i, chunk) in page_text.split("\n\n").map(str::trim).filter(|c| c.len()>20).take(2000).enumerate() {
            let id = format!("{:x}", Sha256::digest(format!("{version_id}:{page}:{i}:{chunk}")));
            tx.execute(
                "INSERT INTO blocks(id,paper_id,version_id,page,block_index,kind,bbox,text) VALUES(?,?,?,?,?,?,?,?)",
                params![id, paper_id, version_id, page as i64, i as i64, "text", "[]", chunk],
            )?;
          }
        }
        Ok(())
    }

    /// Build one paper payload. Takes a `&Connection` so the LAN read pool can
    /// serve the same shape from a read-only snapshot instead of the writer.
    fn paper_json(conn: &Connection, paper_id: &str) -> Result<Value> {
        let mut stmt = conn.prepare("SELECT * FROM papers WHERE id=?")?;
        let mut rows = stmt.query(params![paper_id])?;
        let row = rows.next()?.ok_or_else(|| anyhow!("paper not found"))?;
        let mut value = json!({
            "id": row.get::<_, String>("id")?,
            "title": row.get::<_, String>("title")?,
            "authors": row.get::<_, String>("authors")?,
            "year": row.get::<_, Option<String>>("year")?,
            "venue": row.get::<_, Option<String>>("venue")?,
            "doi": row.get::<_, Option<String>>("doi")?,
            "arxiv": row.get::<_, Option<String>>("arxiv")?,
            "abstract": row.get::<_, Option<String>>("abstract")?,
            "imported_at": row.get::<_, i64>("imported_at")?,
            "updated_at": row.get::<_, i64>("updated_at")?,
            "favorite": row.get::<_, i64>("favorite")? != 0,
            "read_status": row.get::<_, String>("read_status")?,
            "deleted": row.get::<_, Option<i64>>("deleted_at")?.is_some(),
            "notes": row.get::<_, String>("notes")?,
            // Always present, `null` until the paper is first opened, so the
            // renderer can resume without a missing-key branch.
            "last_read_page": row.get::<_, Option<i64>>("last_read_page")?,
            "last_read_fraction": row.get::<_, Option<f64>>("last_read_fraction")?,
            "last_read_mode": row.get::<_, Option<String>>("last_read_mode")?,
            "last_read_at": row.get::<_, Option<i64>>("last_read_at")?,
            // Cached 1-page digest (§3.4.1), already parsed so the renderer can
            // render it without a second RPC.  `null` until it is generated.
            "digest": row.get::<_, Option<String>>("digest_json")?.and_then(|raw| serde_json::from_str::<Value>(&raw).ok()),
            "short_note":row.get::<_,String>("short_note")?,"citation_count":row.get::<_,Option<i64>>("citation_count")?,"citation_source":row.get::<_,Option<String>>("citation_source")?,"citation_updated_at":row.get::<_,Option<i64>>("citation_updated_at")?,"citation_url":row.get::<_,Option<String>>("citation_url")?,
        });
        drop(rows);
        drop(stmt);

        let versions: Vec<Value> = {
            let mut stmt = conn.prepare("SELECT id,paper_id,kind,sha256,rel_path,pages,bytes,lang,engine,model,created_at,source_version_id,page_map FROM versions WHERE paper_id=? ORDER BY created_at")?;
            let rows = stmt.query_map(params![paper_id], |r| {
                Ok(json!({
                    "id": r.get::<_, String>(0)?, "paper_id": r.get::<_, String>(1)?, "kind": r.get::<_, String>(2)?,
                    "sha256": r.get::<_, String>(3)?, "rel_path": r.get::<_, String>(4)?, "pages": r.get::<_, i64>(5)?,
                    "bytes": r.get::<_, i64>(6)?, "lang": r.get::<_, String>(7)?, "engine": r.get::<_, Option<String>>(8)?,
                    "model": r.get::<_, Option<String>>(9)?, "created_at": r.get::<_, i64>(10)?,
                    "source_version_id": r.get::<_, Option<String>>(11)?,
                    // BUG-01: `null` means a full translation (identity page
                    // mapping); otherwise every entry is a 0-based SOURCE page.
                    "page_map": r.get::<_, Option<String>>(12)?.and_then(|raw| serde_json::from_str::<Value>(&raw).ok()),
                }))
            })?;
            rows.filter_map(Result::ok).collect()
        };
        let categories: Vec<Value> = {
            let mut stmt = conn.prepare("SELECT c.id,c.name,c.color,c.parent_id FROM categories c JOIN paper_categories pc ON pc.category_id=c.id WHERE pc.paper_id=?")?;
            let rows = stmt.query_map(params![paper_id], |r| Ok(json!({"id": r.get::<_, String>(0)?, "name": r.get::<_, String>(1)?, "color": r.get::<_, Option<String>>(2)?,"parent_id":r.get::<_,Option<String>>(3)?})))?;
            rows.filter_map(Result::ok).collect()
        };
        let tags: Vec<Value> = {
            let mut stmt = conn.prepare("SELECT t.id,t.name,t.color FROM tags t JOIN paper_tags pt ON pt.tag_id=t.id WHERE pt.paper_id=?")?;
            let rows = stmt.query_map(params![paper_id], |r| Ok(json!({"id": r.get::<_, String>(0)?, "name": r.get::<_, String>(1)?, "color": r.get::<_, Option<String>>(2)?})))?;
            rows.filter_map(Result::ok).collect()
        };
        value["versions"] = Value::Array(versions);
        value["categories"] = Value::Array(categories);
        value["tags"] = Value::Array(tags);
        Ok(value)
    }

    pub fn get_paper(&self, paper_id: &str) -> Result<Value> {
        Self::paper_json(&self.conn(), paper_id)
    }

    /// Read-only variant for the LAN HTTP read pool (no write mutex).
    pub fn get_paper_on(conn: &Connection, paper_id: &str) -> Result<Value> {
        Self::paper_json(conn, paper_id)
    }

    /// Cache a generated 1-page digest for `paper_id` (§3.4.1).
    ///
    /// The digest is a derived cache, not user-authored metadata: it never
    /// touches `updated_at`, so generating one cannot reorder the library.
    /// Only an object with a non-empty `markdown` field is accepted, which
    /// keeps `paper_json`'s parse-and-return contract meaningful.
    pub fn save_digest(&self, paper_id: &str, digest: &Value) -> Result<Value> {
        anyhow::ensure!(digest.is_object(), "导读必须是 JSON 对象");
        anyhow::ensure!(
            digest["markdown"].as_str().map_or(false, |markdown| !markdown.trim().is_empty()),
            "导读缺少 markdown 正文"
        );
        let stored = digest.to_string();
        anyhow::ensure!(stored.len() <= 2 * 1024 * 1024, "导读过大（最多 2MB）");
        let conn = self.conn();
        let updated = conn.execute("UPDATE papers SET digest_json=? WHERE id=?", params![stored, paper_id])?;
        anyhow::ensure!(updated > 0, "论文不存在");
        Ok(json!({"ok": true}))
    }

    /// Read the cached digest as JSON, `None` when the paper has never been
    /// digested (or an older cached value is no longer valid JSON).
    pub fn digest_json(&self, paper_id: &str) -> Result<Option<Value>> {
        let conn = self.conn();
        let stored: Option<Option<String>> = conn
            .query_row("SELECT digest_json FROM papers WHERE id=?", [paper_id], |r| r.get(0))
            .optional()?;
        let Some(stored) = stored else { anyhow::bail!("论文不存在") };
        Ok(stored.and_then(|raw| serde_json::from_str::<Value>(&raw).ok()))
    }

    pub fn list_papers(&self, query: &str, category: Option<&str>, tag: Option<&str>, trashed: bool, status: Option<&str>) -> Result<Vec<Value>> {
        let conn = self.conn();
        let mut sql = String::from("SELECT DISTINCT p.id FROM papers p");
        let mut where_parts: Vec<String> = Vec::new();
        let mut args: Vec<Box<dyn rusqlite::ToSql>> = Vec::new();
        if let Some(cat) = category {
            sql.push_str(" JOIN paper_categories pc ON pc.paper_id=p.id");
            where_parts.push("pc.category_id=?".into());
            args.push(Box::new(cat.to_string()));
        }
        if let Some(t) = tag {
            sql.push_str(" JOIN paper_tags pt ON pt.paper_id=p.id JOIN tags tg ON tg.id=pt.tag_id");
            where_parts.push("tg.name=?".into());
            args.push(Box::new(t.to_string()));
        }
        if !query.trim().is_empty() {
            where_parts.push("(p.title LIKE ? OR p.authors LIKE ? OR p.doi LIKE ? OR p.abstract LIKE ? OR EXISTS(SELECT 1 FROM blocks b WHERE b.paper_id=p.id AND b.text LIKE ?))".into());
            let like = format!("%{}%", query.trim());
            for _ in 0..5 {
                args.push(Box::new(like.clone()));
            }
        }
        where_parts.push(if trashed { "p.deleted_at IS NOT NULL".into() } else { "p.deleted_at IS NULL".into() });
        if let Some(s) = status {
            where_parts.push("p.read_status=?".into());
            args.push(Box::new(s.to_string()));
        }
        if !where_parts.is_empty() {
            sql.push_str(" WHERE ");
            sql.push_str(&where_parts.join(" AND "));
        }
        sql.push_str(" ORDER BY p.favorite DESC, p.imported_at DESC");
        let mut stmt = conn.prepare(&sql)?;
        let params_vec: Vec<&dyn rusqlite::ToSql> = args.iter().map(|b| b.as_ref()).collect();
        let ids: Vec<String> = stmt
            .query_map(params_vec.as_slice(), |r| r.get::<_, String>(0))?
            .filter_map(Result::ok)
            .collect();
        drop(stmt);
        ids.iter().map(|id| Self::paper_json(&conn, id)).collect()
    }

    pub fn update_paper(&self, paper_id: &str, fields: &Value) -> Result<Value> {
        let allowed = ["title", "authors", "year", "venue", "doi", "arxiv", "abstract", "read_status", "notes", "short_note"];
        let mut sets: Vec<String> = Vec::new();
        let mut args: Vec<Box<dyn rusqlite::ToSql>> = Vec::new();
        if let Value::Object(map) = fields {
            for key in allowed {
                if let Some(v) = map.get(key) {
                    if key=="short_note"{anyhow::ensure!(v.as_str().unwrap_or("").chars().count()<=300,"一句话速记最多 300 字");}
                    sets.push(format!("{key}=?"));
                    args.push(Box::new(v.as_str().unwrap_or_default().to_string()));
                }
            }
            if let Some(fav) = map.get("favorite") {
                sets.push("favorite=?".into());
                args.push(Box::new(if fav.as_bool().unwrap_or(false) { 1i64 } else { 0i64 }));
            }
        }
        if sets.is_empty() {
            return self.get_paper(paper_id);
        }
        sets.push("updated_at=?".into());
        args.push(Box::new(now_ms()));
        args.push(Box::new(paper_id.to_string()));
        {
            let conn = self.conn();
            let refs: Vec<&dyn rusqlite::ToSql> = args.iter().map(|b| b.as_ref()).collect();
            conn.execute(&format!("UPDATE papers SET {} WHERE id=?", sets.join(",")), refs.as_slice())?;
        }
        self.get_paper(paper_id)
    }

    /// Persist the cross-device reading position.
    ///
    /// Deliberately never touches `papers.updated_at`: turning a page must not
    /// reshuffle the "recently edited" order or invalidate the edit dialog's
    /// optimistic lock.  Out-of-range values are clamped instead of rejected —
    /// a stale page index (or a twitchy swipe on a tablet) is not an error.
    pub fn set_reading_position(&self, paper_id: &str, page: i64, fraction: f64, mode: &str) -> Result<Value> {
        let mode = match mode {
            "source" | "translated" | "dual" | "paper-code" => mode,
            _ => "source",
        };
        let fraction = if fraction.is_finite() { fraction.clamp(0.0, 1.0) } else { 0.0 };
        let conn = self.conn();
        let exists: bool = conn.query_row("SELECT EXISTS(SELECT 1 FROM papers WHERE id=?)", [paper_id], |r| r.get(0))?;
        anyhow::ensure!(exists, "论文不存在");
        // Unknown/zero-page versions must not squeeze the page to -1; a paper
        // without any version only guarantees a non-negative page.
        let pages: Option<i64> = conn.query_row("SELECT MAX(pages) FROM versions WHERE paper_id=? AND pages>0", [paper_id], |r| r.get(0))?;
        let page = match pages {
            Some(pages) => page.max(0).min(pages - 1),
            None => page.max(0),
        };
        conn.execute(
            "UPDATE papers SET last_read_page=?,last_read_fraction=?,last_read_mode=?,last_read_at=? WHERE id=?",
            params![page, fraction, mode, now_ms(), paper_id],
        )?;
        Ok(json!({"ok": true}))
    }

    pub fn save_paper(&self,p:&Value)->Result<Value>{
        let id=p["paper_id"].as_str().ok_or_else(||anyhow!("paper_id required"))?;
        let fields=&p["fields"];
        anyhow::ensure!(fields["title"].as_str().is_some_and(|s|!s.trim().is_empty()),"标题不能为空");
        let status=fields["read_status"].as_str().unwrap_or("unread");
        anyhow::ensure!(matches!(status,"read"|"reading"|"unread"),"无效阅读状态");
        {
            let conn=self.conn();let tx=conn.unchecked_transaction()?;
            let current:i64=tx.query_row("SELECT updated_at FROM papers WHERE id=?",[id],|r|r.get(0))?;
            if let Some(expected)=p["expected_updated_at"].as_i64(){anyhow::ensure!(expected==current,"资料已在其他位置修改，请重新打开编辑窗口");}
            let names=["title","authors","year","venue","doi","arxiv","abstract","notes","read_status","short_note"];
            let mut args=Vec::<rusqlite::types::Value>::new();
            let mut sets=Vec::new();
            for key in names {if let Some(value)=fields.get(key){let text=value.as_str().ok_or_else(||anyhow!("字段必须是文本"))?;if key=="short_note"{anyhow::ensure!(text.chars().count()<=300,"一句话速记最多 300 字");}anyhow::ensure!(text.len()<=1_000_000,"字段过长");sets.push(format!("{key}=?"));args.push(text.to_string().into());}}
            sets.push("updated_at=?".into());args.push(now_ms().max(current+1).into());args.push(id.to_string().into());
            tx.execute(&format!("UPDATE papers SET {} WHERE id=?",sets.join(",")),rusqlite::params_from_iter(args))?;
            if let Some(ids)=p["category_ids"].as_array(){
                tx.execute("DELETE FROM paper_categories WHERE paper_id=?",[id])?;
                for category in ids {tx.execute("INSERT OR IGNORE INTO paper_categories(paper_id,category_id) VALUES(?,?)",params![id,category.as_str().ok_or_else(||anyhow!("无效分类"))?])?;}
            }
            if let Some(tags)=p["tags"].as_array(){
                tx.execute("DELETE FROM paper_tags WHERE paper_id=?",[id])?;
                anyhow::ensure!(tags.len()<=200,"标签过多");
                for tag in tags{
                    let name=tag.as_str().ok_or_else(||anyhow!("无效标签"))?.trim();if name.is_empty(){continue;}
                    anyhow::ensure!(name.len()<=200,"标签过长");
                    let new_id=Uuid::new_v4().to_string();
                    tx.execute("INSERT OR IGNORE INTO tags(id,name) VALUES(?,?)",params![new_id,name])?;
                    tx.execute("INSERT OR IGNORE INTO paper_tags(paper_id,tag_id) SELECT ?,id FROM tags WHERE name=?",params![id,name])?;
                }
            }
            tx.commit()?;
        }
        self.get_paper(id)
    }

    pub fn append_note(&self,paper_id:&str,text:&str)->Result<Value>{
        anyhow::ensure!(text.len()<=512000,"笔记内容过长");
        self.conn().execute("UPDATE papers SET notes=CASE WHEN notes='' THEN ? ELSE notes||char(10)||char(10)||? END,updated_at=max(updated_at+1,?) WHERE id=?",params![text,text,now_ms(),paper_id])?;
        self.get_paper(paper_id)
    }

    pub fn trash(&self, paper_id: &str) -> Result<()> {
        self.conn().execute("UPDATE papers SET deleted_at=?,updated_at=? WHERE id=?", params![now_ms(),now_ms(),paper_id])?;
        let jobs:Vec<String>={let conn=self.conn();let mut st=conn.prepare("SELECT id FROM jobs WHERE paper_id=? AND status NOT IN ('completed','failed','cancelled')")?;let rows=st.query_map([paper_id],|r|r.get(0))?.collect::<rusqlite::Result<Vec<_>>>()?;rows};
        for id in jobs {self.cancel_job(&id)?;}
        Ok(())
    }

    pub fn restore(&self, paper_id: &str) -> Result<()> {
        self.conn().execute("UPDATE papers SET deleted_at=NULL,updated_at=? WHERE id=?", params![now_ms(),paper_id])?;
        Ok(())
    }

    fn param_ids(params: &Value) -> Vec<String> {
        params.get("paper_ids").and_then(Value::as_array).map(|rows| rows.iter().filter_map(Value::as_str).map(str::to_string).collect()).unwrap_or_default()
    }

    pub fn bulk_set_status(&self, params: &Value) -> Result<Value> {
        let ids = Self::param_ids(params);
        anyhow::ensure!(!ids.is_empty(), "请选择论文");
        let status = params.get("status").and_then(Value::as_str).unwrap_or("");
        anyhow::ensure!(matches!(status, "unread" | "reading" | "read"), "无效的阅读状态");
        let mut updated = 0usize;
        {
            let conn = self.conn();
            let tx = conn.unchecked_transaction()?;
            for id in &ids {
                updated += tx.execute("UPDATE papers SET read_status=?,updated_at=? WHERE id=? AND deleted_at IS NULL", params![status, now_ms(), id])?;
            }
            tx.commit()?;
        }
        Ok(json!({"updated":updated,"status":status}))
    }

    pub fn bulk_trash(&self, params: &Value) -> Result<Value> {
        let ids = Self::param_ids(params);
        anyhow::ensure!(!ids.is_empty(), "请选择论文");
        let mut updated = 0usize;
        {
            let conn = self.conn();
            let tx = conn.unchecked_transaction()?;
            for id in &ids {
                updated += tx.execute("UPDATE papers SET deleted_at=?,updated_at=? WHERE id=? AND deleted_at IS NULL", params![now_ms(), now_ms(), id])?;
            }
            tx.commit()?;
        }
        for id in &ids {
            let jobs: Vec<String> = {
                let conn = self.conn();
                let mut st = conn.prepare("SELECT id FROM jobs WHERE paper_id=? AND status NOT IN ('completed','failed','cancelled')")?;
                let rows = st.query_map([id], |r| r.get(0))?.collect::<rusqlite::Result<Vec<_>>>()?;
                rows
            };
            for job in jobs { self.cancel_job(&job)?; }
        }
        Ok(json!({"updated":updated}))
    }

    pub fn bulk_restore(&self, params: &Value) -> Result<Value> {
        let ids = Self::param_ids(params);
        anyhow::ensure!(!ids.is_empty(), "请选择论文");
        let mut updated = 0usize;
        {
            let conn = self.conn();
            let tx = conn.unchecked_transaction()?;
            for id in &ids {
                updated += tx.execute("UPDATE papers SET deleted_at=NULL,updated_at=? WHERE id=? AND deleted_at IS NOT NULL", params![now_ms(), id])?;
            }
            tx.commit()?;
        }
        Ok(json!({"updated":updated}))
    }

    pub fn bulk_purge(&self, params: &Value) -> Result<Value> {
        let ids = Self::param_ids(params);
        anyhow::ensure!(!ids.is_empty(), "请选择论文");
        let mut purged = 0usize;
        let mut failed = Vec::new();
        for id in &ids {
            match self.purge(id) {
                Ok(_) => purged += 1,
                Err(err) => failed.push(json!({"paper_id":id,"error":err.to_string()})),
            }
        }
        Ok(json!({"purged":purged,"failed":failed}))
    }

    pub fn empty_trash(&self) -> Result<Value> {
        let ids: Vec<String> = {
            let conn = self.conn();
            let mut st = conn.prepare("SELECT id FROM papers WHERE deleted_at IS NOT NULL")?;
            let rows = st.query_map([], |r| r.get(0))?.collect::<rusqlite::Result<Vec<_>>>()?;
            rows
        };
        let mut purged = 0usize;
        let mut failed = Vec::new();
        for id in &ids {
            match self.purge(id) {
                Ok(_) => purged += 1,
                Err(err) => failed.push(json!({"paper_id":id,"error":err.to_string()})),
            }
        }
        Ok(json!({"purged":purged,"failed":failed}))
    }

    pub fn purge(&self, paper_id: &str) -> Result<Value> {
        let _maintenance=self.maintenance.lock().unwrap();
        let conn = self.conn();
        let trashed:bool=conn.query_row("SELECT deleted_at IS NOT NULL FROM papers WHERE id=?",[paper_id],|r|r.get(0))?;
        anyhow::ensure!(trashed,"请先移到回收站再永久删除");
        let active:i64=conn.query_row("SELECT count(*) FROM jobs WHERE paper_id=? AND status NOT IN ('completed','failed','cancelled')",[paper_id],|r|r.get(0))?;
        anyhow::ensure!(active==0,"请等待该论文的任务停止后再删除");
        let paths:Vec<String>={let mut st=conn.prepare("SELECT rel_path FROM versions WHERE paper_id=? UNION SELECT rel_path FROM zotero_files WHERE paper_id=? AND status='copied' AND rel_path IS NOT NULL")?;let rows=st.query_map([paper_id,paper_id],|r|r.get(0))?.collect::<rusqlite::Result<Vec<_>>>()?;rows};
        let tx=conn.unchecked_transaction()?;
        tx.execute("DELETE FROM papers WHERE id=?",[paper_id])?;
        tx.execute("DELETE FROM jobs WHERE paper_id=?",[paper_id])?;
        // Commit first. A failed deletion must never remove a referenced file.
        tx.commit()?;
        let mut removed=Vec::new();
        let mut retained=Vec::new();
        for rel in paths {
            let p=Path::new(&rel);
            if p.is_absolute()||p.components().any(|c|!matches!(c,std::path::Component::Normal(_))){continue;}
            let shared:i64=conn.query_row("SELECT (SELECT count(*) FROM versions WHERE rel_path=?)+(SELECT count(*) FROM zotero_files WHERE rel_path=?)",params![rel,rel],|r|r.get(0))?;
            if shared>0{continue;}
            let full=self.root.join(p);
            // Symlink parents must never redirect a managed deletion outside the library.
            if let Ok(canonical)=full.canonicalize(){
                if !canonical.starts_with(self.root.canonicalize()?){retained.push(rel);continue;}
                match fs::remove_file(&full){Ok(())=>removed.push(rel),Err(_)=>retained.push(rel)}
            }
        }
        Ok(json!({"removed_files":removed,"retained_files":retained}))
    }

    // ---- taxonomy -------------------------------------------------------
    pub fn taxonomy(&self) -> Result<Value> {
        Self::taxonomy_on(&self.conn())
    }

    /// Read-only taxonomy for the LAN read pool.
    pub fn taxonomy_on(conn: &Connection) -> Result<Value> {
        let cats: Vec<Value> = {
            let mut stmt = conn.prepare("SELECT id,name,color,parent_id,(SELECT count(DISTINCT pc.paper_id) FROM paper_categories pc JOIN papers p ON p.id=pc.paper_id AND p.deleted_at IS NULL WHERE pc.category_id=categories.id) AS paper_count FROM categories ORDER BY sort_order,name")?;
            let mapped = stmt.query_map([], |r| Ok(json!({"id": r.get::<_, String>(0)?, "name": r.get::<_, String>(1)?, "color": r.get::<_, Option<String>>(2)?,"parent_id":r.get::<_,Option<String>>(3)?,"paper_count":r.get::<_,i64>(4)?})))?;
            let collected: Vec<Value> = mapped.filter_map(Result::ok).collect();
            collected
        };
        let tags: Vec<Value> = {
            let mut stmt = conn.prepare("SELECT id,name,color,(SELECT count(*) FROM paper_tags pt JOIN papers p ON p.id=pt.paper_id AND p.deleted_at IS NULL WHERE pt.tag_id=tags.id) AS paper_count FROM tags ORDER BY name")?;
            let mapped = stmt.query_map([], |r| Ok(json!({"id": r.get::<_, String>(0)?, "name": r.get::<_, String>(1)?, "color": r.get::<_, Option<String>>(2)?,"paper_count":r.get::<_,i64>(3)?})))?;
            let collected: Vec<Value> = mapped.filter_map(Result::ok).collect();
            collected
        };
        Ok(json!({"categories": cats, "tags": tags}))
    }

    pub fn set_categories(&self, paper_id: &str, ids: Vec<String>) -> Result<()> {
        let guard = self.conn();
        let conn = guard.unchecked_transaction()?;
        conn.execute("DELETE FROM paper_categories WHERE paper_id=?", params![paper_id])?;
        for id in ids {
            conn.execute("INSERT OR IGNORE INTO paper_categories(paper_id,category_id) VALUES(?,?)", params![paper_id, id])?;
        }
        conn.commit()?;
        Ok(())
    }

    pub fn set_tags(&self, paper_id: &str, names: Vec<String>) -> Result<()> {
        let guard = self.conn();
        let conn = guard.unchecked_transaction()?;
        conn.execute("DELETE FROM paper_tags WHERE paper_id=?", params![paper_id])?;
        for name in names {
            let name = name.trim();
            if name.is_empty() {
                continue;
            }
            let existing: Option<String> = conn.query_row("SELECT id FROM tags WHERE name=?", params![name], |r| r.get(0)).optional()?;
            let id = match existing {
                Some(id) => id,
                None => {
                    let id = Uuid::new_v4().to_string();
                    conn.execute("INSERT INTO tags(id,name) VALUES(?,?)", params![id, name])?;
                    id
                }
            };
            conn.execute("INSERT OR IGNORE INTO paper_tags(paper_id,tag_id) VALUES(?,?)", params![paper_id, id])?;
        }
        conn.commit()?;
        Ok(())
    }

    pub fn add_category(&self, name: &str) -> Result<Value> {
        crate::organization::folder_save(self,&json!({"name":name}))
    }

    /// Complete title/authors/year/venue/abstract from the arXiv or Crossref
    /// registry of this paper's own DOI/arXiv id (never a fuzzy title guess
    /// unless the returned title matches exactly).
    pub fn refresh_metadata(&self, params: &Value) -> Result<Value> {
        pdfmeta::refresh_metadata(self, params)
    }

    // ---- annotations ----------------------------------------------------
    pub fn list_annotations(&self, paper_id: &str) -> Result<Vec<Value>> {
        Self::list_annotations_on(&self.conn(), paper_id)
    }

    /// Read-only annotation list for the LAN read pool.
    pub fn list_annotations_on(conn: &Connection, paper_id: &str) -> Result<Vec<Value>> {
        let mut stmt = conn.prepare("SELECT * FROM annotations WHERE paper_id=? ORDER BY page,created_at")?;
        let rows = stmt.query_map(params![paper_id], |r| {
            let rects = r.get::<_, String>("rects")?;
            Ok(json!({
                "id": r.get::<_, String>("id")?,
                "paper_id": r.get::<_, String>("paper_id")?,
                "version_kind": r.get::<_, String>("version_kind")?,
                "version_id": r.get::<_, Option<String>>("version_id")?,
                "page": r.get::<_, i64>("page")?,
                "rects": serde_json::from_str::<Value>(&rects).unwrap_or(Value::Array(vec![])),
                "quote": r.get::<_, String>("quote")?,
                "color": r.get::<_, String>("color")?,
                "comment": r.get::<_, String>("comment")?,
                "created_at": r.get::<_, i64>("created_at")?,
            }))
        })?;
        Ok(rows.filter_map(Result::ok).collect())
    }

    pub fn add_annotation(&self, paper_id: &str, page: i64, rects: Value, quote: &str, color: &str, comment: &str, version_kind: &str, version_id: Option<&str>) -> Result<Value> {
        if page < 0 || !matches!(version_kind, "source" | "translated") {
            return Err(anyhow!("invalid annotation page or version kind"));
        }
        if let Some(version) = version_id {
            let conn = self.conn();
            // BUG-01: for a partial translation the renderer already resolves
            // the highlighted text back to its 0-based SOURCE page and sends
            // that page here.  Accept it only when that source page is really
            // part of `page_map`, and store it unchanged; the old
            // `versions.pages > page` check compares against the subset length
            // and would reject every valid translated annotation.
            let layout = version_page_layout(&conn, paper_id, version).ok();
            let valid = match layout {
                Some((kind, pages, page_map)) if kind == version_kind => match page_map {
                    Some(map) if kind == "translated" => map.contains(&page),
                    _ => pages > page,
                },
                _ => false,
            };
            if !valid { return Err(anyhow!("annotation version does not belong to this paper/page")); }
        }
        let id = Uuid::new_v4().to_string();
        self.conn().execute(
            "INSERT INTO annotations(id,paper_id,version_kind,page,rects,quote,color,comment,created_at,updated_at,version_id) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
            params![id, paper_id, version_kind, page, rects.to_string(), quote, color, comment, now_ms(), now_ms(), version_id],
        )?;
        Ok(json!({"id": id}))
    }

    pub fn update_annotation(&self, id: &str, fields: &Value) -> Result<()> {
        let mut sets: Vec<String> = Vec::new();
        let mut args: Vec<Box<dyn rusqlite::ToSql>> = Vec::new();
        for key in ["comment", "color"] {
            if let Some(v) = fields.get(key) {
                sets.push(format!("{key}=?"));
                args.push(Box::new(v.as_str().unwrap_or_default().to_string()));
            }
        }
        if sets.is_empty() {
            return Ok(());
        }
        sets.push("updated_at=?".into());
        args.push(Box::new(now_ms()));
        args.push(Box::new(id.to_string()));
        let conn = self.conn();
        let refs: Vec<&dyn rusqlite::ToSql> = args.iter().map(|b| b.as_ref()).collect();
        conn.execute(&format!("UPDATE annotations SET {} WHERE id=?", sets.join(",")), refs.as_slice())?;
        Ok(())
    }

    pub fn delete_annotation(&self, id: &str) -> Result<()> {
        self.conn().execute("DELETE FROM annotations WHERE id=?", params![id])?;
        Ok(())
    }

    // ---- export ---------------------------------------------------------
    pub fn export(&self, ids: Vec<String>, format: &str) -> Result<String> {
        let mut out = Vec::new();
        for (index, id) in ids.iter().enumerate() {
            let paper = self.get_paper(id)?;
            match format {
                "ris" => out.push(ris(&paper)),
                // FEAT-UX-04: the two citation styles Chinese/English papers
                // actually paste into a manuscript.  `bibtex` stays the default
                // so an unknown format never silently changes an existing flow.
                "gbt7714" => out.push(gbt7714(index + 1, &paper)),
                "apa" => out.push(apa(&paper)),
                _ => out.push(bibtex(&paper)),
            }
        }
        Ok(out.join("\n\n"))
    }

    // ---- blocks ---------------------------------------------------------
    pub fn set_blocks(&self, paper_id: &str, version_id: &str, page: i64, blocks: Vec<Value>) -> Result<()> {
        anyhow::ensure!(blocks.len()<=10000,"too many text blocks on one page");
        anyhow::ensure!(blocks.iter().map(|b|b["text"].as_str().unwrap_or("").len()).sum::<usize>()<=2_000_000,"page text too large");
        let conn = self.conn();
        let (kind, pages, page_map) = version_page_layout(&conn, paper_id, version_id)?;
        // BUG-01: a partial translation's PDF only contains the translated
        // subset, so the renderer addresses its pages by subset index.  Store
        // the real 0-based SOURCE page instead, which is what the dual-pane
        // alignment, the text layer and annotations all share.  Full
        // translations (`page_map IS NULL`) keep the historical identity path.
        let stored_page = match page_map {
            Some(map) if kind == "translated" => {
                anyhow::ensure!(page >= 0 && (page as u64) < map.len() as u64, "page outside translated subset");
                map[page as usize]
            }
            _ => {
                anyhow::ensure!(page>=0&&page<pages,"page outside document");
                page
            }
        };
        let prepared: Vec<(String,i64,String,String,String)> = blocks.iter().enumerate().filter_map(|(i,block)| {
            let text=block.get("text").and_then(Value::as_str).unwrap_or("").trim();
            if text.is_empty() { return None; }
            let bbox=block.get("bbox").cloned().unwrap_or(json!([]));
            let kind=if block["kind"]=="ocr"{"ocr"}else{"text"};
            let id=format!("{:x}",Sha256::digest(format!("{version_id}:{stored_page}:{i}:{bbox}:{text}:{kind}")));
            Some((id,i as i64,bbox.to_string(),text.to_string(),kind.into()))
        }).collect();
        if prepared.is_empty(){return Ok(());}
        // Revisiting a scanned page must not replace cached OCR with a tiny native header.
        if prepared.iter().all(|row|row.4=="text") {
            let old:i64=conn.query_row("SELECT coalesce(sum(length(text)),0) FROM blocks WHERE paper_id=? AND version_id=? AND page=? AND kind='ocr'",params![paper_id,version_id,stored_page],|r|r.get(0))?;
            if old>prepared.iter().map(|row|row.3.chars().count() as i64).sum::<i64>(){return Ok(());}
        }
        {
            let mut stmt=conn.prepare("SELECT id FROM blocks WHERE paper_id=? AND version_id=? AND page=? ORDER BY block_index")?;
            let old=stmt.query_map(params![paper_id,version_id,stored_page],|r|r.get::<_,String>(0))?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            if old.iter().eq(prepared.iter().map(|row| &row.0)) { return Ok(()); }
        }
        let tx = conn.unchecked_transaction()?;
        tx.execute("DELETE FROM blocks WHERE paper_id=? AND version_id=? AND page=?", params![paper_id, version_id, stored_page])?;
        for (id,i,bbox,text,kind) in prepared {
            tx.execute(
                "INSERT INTO blocks(id,paper_id,version_id,page,block_index,kind,bbox,text) VALUES(?,?,?,?,?,?,?,?)",
                params![id, paper_id, version_id, stored_page, i, kind, bbox, text],
            )?;
        }
        tx.commit()?;
        Ok(())
    }

    pub fn blocks(&self, paper_id: &str, version_id: &str, page: i64) -> Result<Vec<Value>> {
        let conn = self.conn();
        let mut stmt = conn.prepare("SELECT id,page,block_index,kind,bbox,text FROM blocks WHERE paper_id=? AND version_id=? AND page=? ORDER BY block_index")?;
        let rows = stmt.query_map(params![paper_id, version_id, page], |r| {
            let bbox = r.get::<_, String>(4)?;
            Ok(json!({
                "id": r.get::<_, String>(0)?, "page": r.get::<_, i64>(1)?, "block_index": r.get::<_, i64>(2)?,
                "kind": r.get::<_, String>(3)?, "bbox": serde_json::from_str::<Value>(&bbox).unwrap_or(Value::Array(vec![])),
                "text": r.get::<_, String>(5)?,
            }))
        })?;
        Ok(rows.filter_map(Result::ok).collect())
    }

    pub fn search_blocks(&self, paper_id: &str, query: &str, limit: i64) -> Result<Vec<Value>> {
        let conn = self.conn();
        let mut stmt = conn.prepare("SELECT id,page,block_index,kind,bbox,text FROM blocks WHERE paper_id=? AND text LIKE ? LIMIT ?")?;
        let rows = stmt.query_map(params![paper_id, format!("%{query}%"), limit], |r| {
            let bbox = r.get::<_, String>(4)?;
            Ok(json!({
                "id": r.get::<_, String>(0)?, "page": r.get::<_, i64>(1)?, "block_index": r.get::<_, i64>(2)?,
                "kind": r.get::<_, String>(3)?, "bbox": serde_json::from_str::<Value>(&bbox).unwrap_or(Value::Array(vec![])),
                "text": r.get::<_, String>(5)?,
            }))
        })?;
        Ok(rows.filter_map(Result::ok).collect())
    }

    // ---- versions / jobs ------------------------------------------------
    pub fn version_path(&self, version_id: &str) -> Result<PathBuf> {
        let rel: String = self
            .conn()
            .query_row("SELECT rel_path FROM versions WHERE id=?", params![version_id], |r| r.get(0))
            .optional()?
            .ok_or_else(|| anyhow!("version not found"))?;
        let p = PathBuf::from(rel);
        Ok(if p.is_absolute() { p } else { self.root.join(p) })
    }

    pub fn paper_pdf(&self, paper_id: &str, kind: &str, version_id: Option<&str>) -> Result<Value> {
        let conn = self.conn();
        let row = conn
            .query_row(
                "SELECT id,rel_path,pages,bytes FROM versions WHERE paper_id=? AND kind=? AND (? IS NULL OR id=?) ORDER BY CASE WHEN kind='source' THEN created_at ELSE -created_at END,id LIMIT 1",
                params![paper_id, kind, version_id, version_id],
                |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, i64>(2)?, r.get::<_, i64>(3)?)),
            )
            .optional()?;
        let (id, rel, pages, bytes) = row.ok_or_else(|| anyhow!("no {kind} version"))?;
        let path = if Path::new(&rel).is_absolute() { PathBuf::from(rel) } else { self.root.join(rel) };
        Ok(json!({"version_id": id, "path": path.to_string_lossy(), "pages": pages, "bytes": bytes}))
    }

    /// Resolve a specific source attachment (supplementary PDFs) or the primary one.
    pub fn source_version_for(&self, paper_id: &str, version_id: Option<&str>) -> Result<(String, PathBuf)> {
        let (id, rel_path): (String, String) = if let Some(version_id) = version_id {
            self.conn()
                .query_row(
                    "SELECT id,rel_path FROM versions WHERE id=? AND paper_id=? AND kind='source'",
                    params![version_id, paper_id],
                    |r| Ok((r.get(0)?, r.get(1)?)),
                )
                .optional()?
                .ok_or_else(|| anyhow!("找不到该原文附件"))?
        } else {
            self.conn()
                .query_row(
                    "SELECT id,rel_path FROM versions WHERE paper_id=? AND kind='source' ORDER BY created_at,id LIMIT 1",
                    params![paper_id],
                    |r| Ok((r.get(0)?, r.get(1)?)),
                )
                .optional()?
                .ok_or_else(|| anyhow!("paper has no source PDF"))?
        };
        let p = PathBuf::from(&rel_path);
        Ok((id, if p.is_absolute() { p } else { self.root.join(p) }))
    }

    pub fn start_translation(self: &Arc<Self>, paper_id: &str, pages: Option<String>, source_version_id: Option<String>) -> Result<Value> {
        if self.gateway.lock().unwrap().is_none() {self.ensure_gateway()?;}
        // Fail before queueing a job when the translation kernel is missing, so
        // the user sees an actionable message instead of a background
        // "program not found" failure.
        let configured_babeldoc = self.gateway_config()
            .map(|config| config.babeldoc.trim().to_string())
            .filter(|value| !value.is_empty());
        engine::babeldoc_executable(configured_babeldoc.as_deref())?;
        let (source_id, src) = self.source_version_for(paper_id, source_version_id.as_deref())?;
        let job_id = Uuid::new_v4().to_string();
        {
            let conn=self.conn();
            let available:bool=conn.query_row("SELECT deleted_at IS NULL FROM papers WHERE id=?",[paper_id],|r|r.get(0))?;
            anyhow::ensure!(available,"回收站中的论文不能启动翻译");
            let active:i64=conn.query_row("SELECT count(*) FROM jobs WHERE paper_id=? AND status NOT IN ('completed','failed','cancelled')",[paper_id],|r|r.get(0))?;
            anyhow::ensure!(active==0,"该论文已有任务，请等待完成或先停止");
            conn.execute("INSERT INTO jobs(id,paper_id,status,pages,created_at,updated_at,source_version_id) VALUES(?,?,?,?,?,?,?)",params![job_id,paper_id,"queued",pages,now_ms(),now_ms(),source_id])?;
        }
        self.cancels.lock().unwrap().insert(job_id.clone(),Arc::new(AtomicBool::new(false)));
        if self.translation_tx.try_send((job_id.clone(),paper_id.into(),src,pages,Some(source_id))).is_err(){
            self.set_job_status(&job_id,"failed",Some("翻译队列已满，请稍后重试"),None);
            self.clear_cancel(&job_id);
            return Err(anyhow!("翻译队列已满，请稍后重试"));
        }
        Ok(json!({"job_id":job_id}))
    }

    pub fn cancel_job(&self, job_id: &str) -> Result<()> {
        let status={
            let conn=self.conn();
            let status:String=conn.query_row("SELECT status FROM jobs WHERE id=?",[job_id],|r|r.get(0))?;
            if matches!(status.as_str(),"completed"|"failed"|"cancelled"){return Ok(());}
            conn.execute("UPDATE jobs SET status='cancelling',updated_at=? WHERE id=?",params![now_ms(),job_id])?;
            status
        };
        if let Some(flag)=self.cancels.lock().unwrap().get(job_id){flag.store(true,Ordering::SeqCst);}
        self.emit(json!({"event":"job","jobId":job_id,"status":"cancelling"}));
        if status=="queued"{self.set_job_status(job_id,"cancelled",None,None);}
        Ok(())
    }

    pub fn cancel_flag(&self, job_id: &str) -> Arc<AtomicBool> {
        self.cancels
            .lock()
            .unwrap()
            .entry(job_id.to_string())
            .or_insert_with(|| Arc::new(AtomicBool::new(false)))
            .clone()
    }

    pub fn clear_cancel(&self, job_id: &str) {
        self.cancels.lock().unwrap().remove(job_id);
    }

    pub fn set_job_status(&self, job_id: &str, status: &str, error: Option<&str>, version_id: Option<&str>) {
        let result=self.conn().execute(
            "UPDATE jobs SET status=?,updated_at=?,error=?,output_version_id=COALESCE(?,output_version_id) WHERE id=? AND status NOT IN ('completed','failed','cancelled') AND (status!='cancelling' OR ? IN ('cancelled','failed'))",
            params![status,now_ms(),error,version_id,job_id,status]);
        match result {
            Ok(0)=>{},
            Ok(_)=>self.emit(json!({"event":"job","jobId":job_id,"status":status,"error":error,"outputVersionId":version_id})),
            Err(e)=>self.emit(json!({"event":"job_error","jobId":job_id,"error":format!("任务状态保存失败：{e}")})),
        }
    }

    pub fn shutdown(&self)->Result<Value>{
        let ids:Vec<String>={let conn=self.conn();let mut st=conn.prepare("SELECT id FROM jobs WHERE status NOT IN ('completed','failed','cancelled')")?;let rows=st.query_map([],|r|r.get(0))?.collect::<rusqlite::Result<Vec<_>>>()?;rows};
        for id in &ids{self.cancel_job(id)?;}
        Ok(json!({"stopping":ids.len()}))
    }

    pub fn list_jobs(&self) -> Result<Value> {
        let ids:Vec<String>={let conn=self.conn();let mut st=conn.prepare("SELECT id FROM jobs ORDER BY created_at DESC,id DESC LIMIT 100")?;let rows=st.query_map([],|r|r.get(0))?.collect::<rusqlite::Result<Vec<_>>>()?;rows};
        Ok(Value::Array(ids.iter().map(|id|self.get_job(id)).collect::<Result<Vec<_>>>()?))
    }

    pub fn get_job(&self, job_id: &str) -> Result<Value> {
        let conn = self.conn();
        let row = conn
            .query_row("SELECT j.id,j.paper_id,j.status,j.pages,j.created_at,j.updated_at,j.error,j.output_version_id,j.source_version_id,p.title FROM jobs j LEFT JOIN papers p ON p.id=j.paper_id WHERE j.id=?", params![job_id], |r| {
                Ok(json!({
                    "id": r.get::<_, String>(0)?, "paper_id": r.get::<_, String>(1)?, "status": r.get::<_, String>(2)?,
                    "pages": r.get::<_, Option<String>>(3)?, "created_at": r.get::<_, i64>(4)?, "updated_at": r.get::<_, i64>(5)?,
                    "error": r.get::<_, Option<String>>(6)?, "output_version_id": r.get::<_, Option<String>>(7)?,
                    "source_version_id": r.get::<_, Option<String>>(8)?,
                    "title": r.get::<_, Option<String>>(9)?,
                }))
            })
            .optional()?;
        Ok(row.unwrap_or(Value::Null))
    }

    pub fn attach_translation(&self, paper_id: &str, output: &Path, job_id: &str, source_version_id: Option<&str>) -> Result<String> {
        let pages=pdfmeta::page_count(output)?;
        anyhow::ensure!(pages>0,"翻译引擎输出不是有效的非空 PDF");
        let version_id=Uuid::new_v4().to_string();
        let dest_rel=format!("derived/{paper_id}-{version_id}.pdf");
        let dest=self.root.join(&dest_rel);
        let sha=sha256_file(output)?;
        let bytes=output.metadata()?.len() as i64;
        let tmp=self.root.join("tmp").join(format!("{version_id}.pdf"));
        copy_with_retry(output,&tmp).with_context(|| format!("复制译文输出失败：{}", tmp.display()))?;
        fs::OpenOptions::new().read(true).write(true).open(&tmp).with_context(|| format!("打开临时译文失败：{}", tmp.display()))?.sync_all()?;
        // Prefer the hot-reloaded gateway model over the process environment.
        // Read it before taking the connection lock: the gateway mutex is
        // independent here and is only held for the clone.
        let model=self.gateway().map(|g|g.model).unwrap_or_else(||std::env::var("MOONLIGHT_MODEL").unwrap_or_default());
        let result=(||->Result<()>{
            let conn=self.conn();
            let tx=conn.unchecked_transaction()?;
            let available:bool=tx.query_row("SELECT EXISTS(SELECT 1 FROM papers p JOIN jobs j ON j.paper_id=p.id WHERE p.id=? AND p.deleted_at IS NULL AND j.id=? AND j.status NOT IN ('cancelling','cancelled','failed','completed'))",params![paper_id,job_id],|r|r.get(0))?;
            anyhow::ensure!(available,"cancelled");
            // BUG-01: the job's `--pages` selector is the only record of which
            // source pages this subset PDF covers.  Persist the expanded,
            // sorted 0-based list so `set_blocks`/annotations can translate
            // subset page indexes back to source pages.  `None` (no selector)
            // stays NULL = full translation / identity mapping.
            let selected: Option<String>=tx.query_row("SELECT pages FROM jobs WHERE id=? AND paper_id=?",params![job_id,paper_id],|r|r.get::<_,Option<String>>(0))?;
            let page_map=selected.as_deref().and_then(parse_pages_selector).map(|map|serde_json::to_string(&map).unwrap_or_default());
            rename_with_retry(&tmp,&dest)?;
            tx.execute("INSERT INTO versions(id,paper_id,kind,sha256,rel_path,pages,bytes,lang,engine,model,created_at,source_version_id,page_map) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)",params![version_id,paper_id,"translated",sha,dest_rel,pages,bytes,"zh-CN","babeldoc",model,now_ms(),source_version_id,page_map])?;
            tx.execute("UPDATE papers SET updated_at=? WHERE id=?",params![now_ms(),paper_id])?;
            tx.execute("UPDATE jobs SET status='completed',updated_at=?,output_version_id=?,error=NULL WHERE id=?",params![now_ms(),version_id,job_id])?;
            tx.commit()?;
            Ok(())
        })();
        if let Err(e)=result{let _=fs::remove_file(&dest);let _=fs::remove_file(&tmp);return Err(e);}
        self.emit(json!({"event":"job","jobId":job_id,"status":"completed","outputVersionId":version_id}));
        Ok(version_id)
    }

    // ---- generic external import (Zotero API path) ----------------------
    pub fn import_external(
        &self,
        pdf: Option<&Path>,
        title: &str,
        authors: &str,
        year: Option<&str>,
        venue: &str,
        doi: &str,
        arxiv: &str,
        abstract_text: Option<&str>,
        notes: &str,
    ) -> Result<Value> {
        if !doi.is_empty() {
            if let Some(id) = self
                .conn()
                .query_row("SELECT id FROM papers WHERE doi=? AND deleted_at IS NULL", params![doi], |r| r.get::<_, String>(0))
                .optional()?
            {
                return Ok(json!({"status": "duplicate_doi", "paper_id": id}));
            }
        }
        let paper_id = Uuid::new_v4().to_string();
        {
            let conn = self.conn();
            conn.execute(
                "INSERT INTO papers(id,title,authors,year,venue,doi,arxiv,abstract,notes,imported_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
                params![
                    paper_id,
                    if title.is_empty() { "Untitled" } else { title },
                    authors,
                    year,
                    venue,
                    if doi.is_empty() { None } else { Some(doi) },
                    if arxiv.is_empty() { None } else { Some(arxiv) },
                    abstract_text,
                    notes,
                    now_ms(),
                    now_ms()
                ],
            )?;
        }
        let mut status = "imported_without_pdf";
        if let Some(path) = pdf {
            if path.exists() {
                let sha = sha256_file(path)?;
                let rel = format!("files/{sha}.pdf");
                let dest = self.root.join(&rel);
                let tmp = self.root.join("tmp").join(format!("api-{paper_id}.pdf"));
                fs::copy(path, &tmp)?;
                fs::rename(&tmp, &dest)?;
                let pages = pdfmeta::page_count(&dest).unwrap_or(0);
                let bytes = dest.metadata()?.len() as i64;
                let vid = Uuid::new_v4().to_string();
                self.conn().execute(
                    "INSERT INTO versions(id,paper_id,kind,sha256,rel_path,pages,bytes,lang,engine,model,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
                    params![vid, paper_id, "source", sha, rel, pages, bytes, "en", "zotero-api", Option::<String>::None, now_ms()],
                )?;
                status = "imported";
            }
        }
        Ok(json!({"status": status, "paper_id": paper_id}))
    }

    // ---- gateway --------------------------------------------------------
    pub fn ensure_gateway(&self) -> Result<()> {
        let key = std::env::var("MOONLIGHT_UPSTREAM_KEY").unwrap_or_default();
        if key.is_empty() {
            return Err(anyhow!("model credential is not configured"));
        }
        let upstream = std::env::var("MOONLIGHT_UPSTREAM").unwrap_or_else(|_| "https://opencode.ai/zen/go/v1".into());
        let model = std::env::var("MOONLIGHT_MODEL").unwrap_or_else(|_| "qwen3.8-flash".into());
        let config = GatewayConfig {
            upstream: upstream.clone(),
            model: model.clone(),
            api_key: key.clone(),
            qps: env_qps(),
            babeldoc: std::env::var("MOONLIGHT_BABELDOC_BIN").unwrap_or_default(),
        };
        self.apply_gateway(&config)?;
        *self.gateway_config.lock().unwrap() = Some(config);
        // The glossary lives in SQLite, not in the credential config; a newly
        // started listener must still answer BabelDOC with the saved terms.
        self.sync_gateway_glossary();
        Ok(())
    }

    /// Apply a configuration to the single live loopback listener.
    ///
    /// BUG-06: an existing gateway is updated in place, so its address and
    /// token stay valid for the BabelDOC CLI already running and for open SSE
    /// answers.  A fresh listener is bound only when none was started yet.
    fn apply_gateway(&self, config: &GatewayConfig) -> Result<()> {
        let mut guard = self.gateway.lock().unwrap();
        match guard.as_mut() {
            Some(gateway) => gateway.update(config.upstream.clone(), config.model.clone(), config.api_key.clone()),
            None => {
                let gateway = engine::start_gateway(
                    config.upstream.clone(),
                    config.model.clone(),
                    config.api_key.clone(),
                    self.root.join("model-usage.jsonl"),
                )
                .map_err(|err| anyhow!("模型网关启动失败：{err}"))?;
                *guard = Some(gateway);
            }
        }
        Ok(())
    }

    pub fn gateway(&self) -> Option<Gateway> {
        self.gateway.lock().unwrap().clone()
    }

    pub fn gateway_config(&self) -> Option<GatewayConfig> {
        self.gateway_config.lock().unwrap().clone()
    }

    /// Register a cancellation flag for one streaming AI request.
    ///
    /// Keys are namespaced (`ai:<request_id>`) so they never collide with the
    /// translation job ids kept in the same map.
    pub fn begin_ai_request(&self, request_id: &str) -> Arc<AtomicBool> {
        let flag = Arc::new(AtomicBool::new(false));
        self.cancels.lock().unwrap().insert(format!("ai:{request_id}"), Arc::clone(&flag));
        flag
    }

    pub fn end_ai_request(&self, request_id: &str) {
        self.cancels.lock().unwrap().remove(&format!("ai:{request_id}"));
    }

    /// Flip the flag of a running streaming answer; `false` means it already ended.
    pub fn cancel_ai(&self, request_id: &str) -> bool {
        let cancels = self.cancels.lock().unwrap();
        match cancels.get(&format!("ai:{request_id}")) {
            Some(flag) => { flag.store(true, Ordering::SeqCst); true }
            None => false,
        }
    }

    /// Hot-reload the loopback gateway from a saved configuration
    /// (`reload_gateway`): same port, same token, only upstream/model/key swap.
    pub fn reload_gateway(&self, params: &Value) -> Result<Value> {
        let config = self.resolve_gateway_config(params)?;
        self.apply_gateway(&config)?;
        *self.gateway_config.lock().unwrap() = Some(config.clone());
        // Hot-updating credentials must not drop the glossary constraint.
        self.sync_gateway_glossary();
        Ok(json!({
            "ok": true,
            "model": config.model,
            "base_url": config.upstream,
            "qps": config.qps,
            "babeldoc": config.babeldoc,
        }))
    }

    /// Merge one request over the current (or environment) configuration.
    fn resolve_gateway_config(&self, params: &Value) -> Result<GatewayConfig> {
        let current = self.gateway_config();
        let field = |key: &str| {
            params
                .get(key)
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(str::to_string)
        };
        let upstream = field("base_url")
            .or_else(|| field("upstream"))
            .or_else(|| current.as_ref().map(|config| config.upstream.clone()))
            .unwrap_or_else(|| {
                std::env::var("MOONLIGHT_UPSTREAM").unwrap_or_else(|_| "https://opencode.ai/zen/go/v1".into())
            });
        let model = field("model")
            .or_else(|| current.as_ref().map(|config| config.model.clone()))
            .unwrap_or_else(|| std::env::var("MOONLIGHT_MODEL").unwrap_or_else(|_| "qwen3.8-flash".into()));
        let api_key = field("api_key")
            .or_else(|| current.as_ref().map(|config| config.api_key.clone()).filter(|key| !key.is_empty()))
            .or_else(|| std::env::var("MOONLIGHT_UPSTREAM_KEY").ok().filter(|key| !key.is_empty()))
            .ok_or_else(|| anyhow!("缺少 API Key：请先填写 API Key"))?;
        let qps = match params.get("qps").and_then(Value::as_i64) {
            Some(value) if (1..=20).contains(&value) => value as u32,
            Some(_) => return Err(anyhow!("翻译 QPS 应为 1–20 的整数")),
            None => current
                .as_ref()
                .map(|config| config.qps)
                .filter(|qps| (1..=20).contains(qps))
                .unwrap_or_else(env_qps),
        };
        let babeldoc = match params.get("babeldoc_bin").or_else(|| params.get("babeldoc")).and_then(Value::as_str) {
            Some(value) => value.trim().to_string(),
            None => current.as_ref().map(|config| config.babeldoc.clone()).unwrap_or_default(),
        };
        Ok(GatewayConfig { upstream: engine::normalize_upstream(&upstream)?, model, api_key, qps, babeldoc })
    }

    /// Minimal chat/completions probe with the current or supplied configuration.
    ///
    /// Every failure is a value (`{ok:false,error}`), never a panic, so the
    /// settings dialog can render it directly.
    pub fn translation_probe(&self, params: &Value) -> Result<Value> {
        let timeout = probe_timeout(params);
        let overrides = ["base_url", "upstream", "model", "api_key"]
            .iter()
            .any(|key| params.get(key).and_then(Value::as_str).map_or(false, |value| !value.trim().is_empty()));
        if !overrides {
            if let Some(gateway) = self.gateway() {
                return Ok(engine::probe_gateway(&gateway, timeout));
            }
        }
        let config = match self.resolve_gateway_config(params) {
            Ok(config) => config,
            Err(err) => return Ok(json!({"ok": false, "error": err.to_string()})),
        };
        // An unsaved edit in the settings dialog is probed directly: testing a
        // connection must never replace the live gateway.
        Ok(engine::probe_url(&config.upstream, &config.api_key, &config.model, timeout))
    }

    /// Locate BabelDOC: saved path first, then MOONLIGHT_BABELDOC_BIN, then PATH.
    pub fn check_babeldoc(&self, params: &Value) -> Result<Value> {
        let requested = params.get("path").and_then(Value::as_str).map(str::trim).filter(|value| !value.is_empty());
        let configured = self.gateway_config().map(|config| config.babeldoc).filter(|value| !value.trim().is_empty());
        Ok(engine::check_babeldoc(requested.or(configured.as_deref())))
    }

    /// QPS and BabelDOC binary applied by the last save (environment fallback).
    pub fn translation_engine_options(&self) -> (u32, PathBuf) {
        let config = self.gateway_config();
        let qps = config
            .as_ref()
            .map(|config| config.qps)
            .filter(|qps| (1..=20).contains(qps))
            .unwrap_or_else(env_qps);
        let babeldoc = config
            .as_ref()
            .map(|config| config.babeldoc.trim().to_string())
            .filter(|value| !value.is_empty())
            .map(PathBuf::from)
            .unwrap_or_else(engine::babeldoc_bin);
        (qps, babeldoc)
    }
}

fn env_qps() -> u32 {
    std::env::var("MOONLIGHT_QPS")
        .ok()
        .and_then(|value| value.trim().parse::<u32>().ok())
        .filter(|value| (1..=20).contains(value))
        .unwrap_or(6)
}

fn probe_timeout(params: &Value) -> std::time::Duration {
    let millis = params.get("timeout_ms").and_then(Value::as_i64).unwrap_or(15_000).clamp(250, 60_000);
    std::time::Duration::from_millis(millis as u64)
}

fn bibtex(p: &Value) -> String {
    let title = p["title"].as_str().unwrap_or("Untitled");
    let authors = p["authors"].as_str().unwrap_or("");
    let first = authors.split([',', ';']).next().unwrap_or("anon").trim();
    let key: String = first.chars().filter(|c| c.is_alphanumeric()).take(20).collect::<String>() + p["year"].as_str().unwrap_or("");
    let mut fields = vec![format!("  title = {{{title}}}")];
    let joined = authors.split([',', ';']).map(|a| a.trim()).filter(|a| !a.is_empty()).collect::<Vec<_>>().join(" and ");
    if !joined.is_empty() {
        fields.push(format!("  author = {{{joined}}}"));
    }
    for (k, name) in [("year", "year"), ("venue", "journal"), ("doi", "doi"), ("arxiv", "eprint")] {
        if let Some(v) = p[k].as_str() {
            if !v.is_empty() {
                fields.push(format!("  {name} = {{{v}}}"));
            }
        }
    }
    format!("@article{{{key},\n{}\n}}", fields.join(",\n"))
}

fn ris(p: &Value) -> String {
    let mut lines = vec!["TY  - JOUR".to_string(), format!("TI  - {}", p["title"].as_str().unwrap_or(""))];
    for a in p["authors"].as_str().unwrap_or("").split([';', ',']) {
        if !a.trim().is_empty() {
            lines.push(format!("AU  - {}", a.trim()));
        }
    }
    for (tag, key) in [("PY", "year"), ("JO", "venue"), ("DO", "doi")] {
        if let Some(v) = p[key].as_str() {
            if !v.is_empty() {
                lines.push(format!("{tag}  - {v}"));
            }
        }
    }
    lines.push("ER  - ".into());
    lines.join("\n")
}

/// Non-empty textual field of a paper payload.
fn paper_text<'a>(paper: &'a Value, key: &str) -> Option<&'a str> {
    paper[key].as_str().map(str::trim).filter(|value| !value.is_empty())
}

/// Split the library's stored author string (`, ` / `; ` separated) into names.
fn author_names(paper: &Value) -> Vec<String> {
    paper_text(paper, "authors")
        .map(|authors| {
            authors
                .split([',', ';'])
                .map(str::trim)
                .filter(|name| !name.is_empty())
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default()
}

/// Terminate a bibliography fragment with one sentence period.
fn sentence(text: &str) -> String {
    let text = text.trim();
    if text.is_empty() || text.ends_with('.') || text.ends_with('?') || text.ends_with('!') || text.ends_with('。') || text.ends_with('？') || text.ends_with('！') {
        text.to_string()
    } else {
        format!("{text}.")
    }
}

/// GB/T 7714-2015 journal article (`[1] 作者. 题名[J/OL]. 刊名, 年份. DOI.`).
///
/// The record only stores a single author string, so the standard's
/// "first three + 等/et al." abbreviation is not attempted: exporting every
/// stored name is lossless and still a valid GB/T 7714 author list.
fn gbt7714(index: usize, paper: &Value) -> String {
    let title = paper_text(paper, "title").unwrap_or("Untitled");
    let mut out = format!("[{index}] ");
    let authors = author_names(paper);
    if !authors.is_empty() {
        out.push_str(&authors.join(", "));
        out.push_str(". ");
    }
    out.push_str(title);
    out.push_str("[J/OL]. ");
    match (paper_text(paper, "venue"), paper_text(paper, "year")) {
        (Some(venue), Some(year)) => out.push_str(&format!("{venue}, {year}. ")),
        (Some(venue), None) => out.push_str(&format!("{venue}. ")),
        (None, Some(year)) => out.push_str(&format!("{year}. ")),
        (None, None) => {}
    }
    if let Some(doi) = paper_text(paper, "doi") {
        // Store/emit the bare identifier; the DOI resolver prefix is optional
        // in GB/T 7714 and a bare value stays copy-pasteable.
        out.push_str(&format!("DOI: {}.", crate::citations::doi(doi)));
    }
    out.trim_end().to_string()
}

/// APA 7th author: `Lovelace, A.` / `Turing, A. M.`
fn apa_author(name: &str) -> String {
    let tokens: Vec<&str> = name.split_whitespace().collect();
    if tokens.len() < 2 {
        return name.trim().to_string();
    }
    let surname = tokens[tokens.len() - 1];
    let initials = tokens[..tokens.len() - 1]
        .iter()
        .filter_map(|token| token.chars().next())
        .map(|first| format!("{}.", first.to_ascii_uppercase()))
        .collect::<Vec<_>>()
        .join(" ");
    format!("{surname}, {initials}")
}

fn apa_authors(paper: &Value) -> String {
    let names: Vec<String> = author_names(paper).iter().map(|name| apa_author(name)).collect();
    match names.len() {
        0 => String::new(),
        1 => names[0].clone(),
        2 => format!("{}, & {}", names[0], names[1]),
        _ => format!("{}, & {}", names[..names.len() - 1].join(", "), names[names.len() - 1]),
    }
}

/// APA 7th reference: `Authors (Year). Title. Venue. https://doi.org/…`
fn apa(paper: &Value) -> String {
    let authors = apa_authors(paper);
    let mut out = String::new();
    if !authors.is_empty() {
        out.push_str(&authors);
        out.push(' ');
    }
    out.push_str(&format!("({}). ", paper_text(paper, "year").unwrap_or("n.d.")));
    out.push_str(&sentence(paper_text(paper, "title").unwrap_or("Untitled")));
    if let Some(venue) = paper_text(paper, "venue") {
        out.push(' ');
        out.push_str(&sentence(venue));
    }
    if let Some(doi) = paper_text(paper, "doi") {
        out.push_str(&format!(" https://doi.org/{}.", crate::citations::doi(doi)));
    }
    out
}

#[cfg(test)]
mod gateway_tests {
    use super::*;
    use std::time::{Duration, Instant};
    use tiny_http::{Header, Response, Server};

    #[derive(Debug)]
    struct SeenRequest {
        path: String,
        auth: String,
        body: Value,
    }

    struct FakeUpstream {
        base_url: String,
        seen: Arc<Mutex<Vec<SeenRequest>>>,
    }

    /// A loopback upstream that speaks just enough chat/completions for the
    /// gateway and the probe.  Tests never touch the real network.
    fn fake_upstream(status: u16, reply: &str, delay: Duration) -> FakeUpstream {
        let server = Server::http("127.0.0.1:0").unwrap();
        let port = match server.server_addr() {
            tiny_http::ListenAddr::IP(addr) => addr.port(),
            _ => panic!("fake upstream must listen on an IP address"),
        };
        let seen = Arc::new(Mutex::new(Vec::new()));
        let recorded = Arc::clone(&seen);
        let reply = reply.to_string();
        std::thread::spawn(move || {
            for mut request in server.incoming_requests() {
                let path = request.url().to_string();
                let auth = request
                    .headers()
                    .iter()
                    .find(|header| header.field.equiv("Authorization"))
                    .map(|header| header.value.as_str().to_string())
                    .unwrap_or_default();
                let mut body = String::new();
                let _ = request.as_reader().read_to_string(&mut body);
                recorded.lock().unwrap().push(SeenRequest {
                    path,
                    auth,
                    body: serde_json::from_str(&body).unwrap_or(Value::Null),
                });
                if !delay.is_zero() {
                    std::thread::sleep(delay);
                }
                let payload = if status == 200 {
                    json!({"choices": [{"message": {"role": "assistant", "content": reply}}], "usage": {"total_tokens": 3}})
                } else {
                    json!({"error": {"message": "invalid api key", "type": "authentication_error"}})
                };
                let mut response = Response::from_string(payload.to_string()).with_status_code(status);
                response.add_header(Header::from_bytes(&b"Content-Type"[..], &b"application/json"[..]).unwrap());
                let _ = request.respond(response);
            }
        });
        FakeUpstream { base_url: format!("http://127.0.0.1:{port}/v1"), seen }
    }

    fn temp_library() -> (Arc<Library>, PathBuf) {
        let root = std::env::temp_dir().join(format!("moonlight-gateway-{}", Uuid::new_v4()));
        let lib = Library::new(&root).unwrap();
        (lib, root)
    }

    /// A developer shell may export a real credential; such tests only assert
    /// the paths that do not depend on the environment.
    fn no_environment_key() -> bool {
        std::env::var("MOONLIGHT_UPSTREAM_KEY").map_or(true, |value| value.trim().is_empty())
    }

    #[test]
    fn reload_gateway_reuses_the_listener_and_swaps_the_upstream_in_place() {
        let (lib, root) = temp_library();
        let first = fake_upstream(200, "first", Duration::ZERO);
        let saved = lib
            .reload_gateway(&json!({"base_url": first.base_url, "model": "academic-test", "api_key": "fixture-key", "qps": 3}))
            .unwrap();
        assert_eq!(saved["ok"], json!(true), "{saved}");
        assert_eq!(saved["model"], json!("academic-test"));
        assert_eq!(saved["qps"], json!(3));
        assert_eq!(saved["base_url"], json!(first.base_url));
        let gateway = lib.gateway().unwrap();
        assert!(gateway.base_url.starts_with("http://127.0.0.1:"), "{}", gateway.base_url);
        assert!(gateway.base_url.ends_with("/v1"), "{}", gateway.base_url);
        assert_eq!(gateway.model, "academic-test");
        let first_gateway_url = gateway.base_url.clone();
        let first_gateway_token = gateway.token.clone();
        assert_eq!(
            engine::chat(&gateway, vec![json!({"role": "user", "content": "ping"})], 0.0).unwrap(),
            "first"
        );
        {
            let seen = first.seen.lock().unwrap();
            assert_eq!(seen.len(), 1);
            assert_eq!(seen[0].path, "/v1/chat/completions");
            assert_eq!(seen[0].auth, "Bearer fixture-key");
            assert_eq!(seen[0].body["model"], json!("academic-test"));
        }

        // BUG-06: a second save is a hot reload.  The listener, its loopback
        // address and the token BabelDOC was started with must survive; only
        // upstream/model/key are swapped.  A client clone taken before the
        // reload keeps working against the same port.
        let second = fake_upstream(200, "second", Duration::ZERO);
        lib.reload_gateway(&json!({"base_url": second.base_url, "model": "academic-v2", "api_key": "second-key", "qps": 5}))
            .unwrap();
        assert_eq!(
            engine::chat(&gateway, vec![json!({"role": "user", "content": "ping"})], 0.0).unwrap(),
            "second",
            "the pre-reload client must keep using the same live listener"
        );
        let gateway = lib.gateway().unwrap();
        assert_eq!(gateway.base_url, first_gateway_url, "热更新必须复用同一个本地监听端口");
        assert_eq!(gateway.token, first_gateway_token, "热更新不得轮换网关 token（否则进行中的翻译会 401）");
        assert_eq!(gateway.model, "academic-v2");
        assert_eq!(
            engine::chat(&gateway, vec![json!({"role": "user", "content": "ping"})], 0.0).unwrap(),
            "second"
        );
        let seen = second.seen.lock().unwrap();
        assert_eq!(seen.last().unwrap().auth, "Bearer second-key");
        assert_eq!(seen.last().unwrap().body["model"], json!("academic-v2"), "新请求必须使用新模型");
        assert_eq!(seen[0].body["model"], json!("academic-test"), "旧 clone 的 per-request override 仍应优先");
        drop(seen);
        let (qps, _) = lib.translation_engine_options();
        assert_eq!(qps, 5);
        drop(lib);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn reload_gateway_is_readable_and_keeps_the_live_gateway_on_failure() {
        let (lib, root) = temp_library();
        let first = fake_upstream(200, "first", Duration::ZERO);
        lib.reload_gateway(&json!({"base_url": first.base_url, "model": "academic-test", "api_key": "fixture-key"}))
            .unwrap();
        let live = lib.gateway().unwrap();
        let bad_scheme = lib.reload_gateway(&json!({"base_url": "file:///tmp/model.sock"})).unwrap_err().to_string();
        assert!(bad_scheme.contains("http"), "{bad_scheme}");
        let bad_qps = lib.reload_gateway(&json!({"qps": 0})).unwrap_err().to_string();
        assert!(bad_qps.contains("QPS"), "{bad_qps}");
        assert_eq!(lib.gateway().unwrap().base_url, live.base_url);
        if no_environment_key() {
            let (fresh, fresh_root) = temp_library();
            let missing = fresh
                .reload_gateway(&json!({"base_url": "https://provider.example/v1", "model": "academic-test"}))
                .unwrap_err()
                .to_string();
            assert!(missing.contains("API Key"), "{missing}");
            drop(fresh);
            std::fs::remove_dir_all(fresh_root).unwrap();
        }
        drop(lib);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn translation_probe_reports_success_latency_and_model() {
        let (lib, root) = temp_library();
        let upstream = fake_upstream(200, "pong", Duration::ZERO);
        lib.reload_gateway(&json!({"base_url": upstream.base_url, "model": "academic-test", "api_key": "fixture-key"}))
            .unwrap();
        let live_gateway = lib.gateway().unwrap().base_url;
        let result = lib.translation_probe(&json!({})).unwrap();
        assert_eq!(result["ok"], json!(true), "{result}");
        assert_eq!(result["model"], json!("academic-test"));
        assert!(result["latency_ms"].as_u64().is_some(), "{result}");
        let seen = upstream.seen.lock().unwrap();
        assert_eq!(seen.len(), 1);
        assert_eq!(seen[0].path, "/v1/chat/completions");
        assert_eq!(seen[0].body["messages"][0]["role"], json!("user"));
        assert!(seen[0].body["max_tokens"].as_u64().unwrap() <= 16);
        drop(seen);

        // Unsaved edits are probed directly and never replace the live gateway.
        let draft = fake_upstream(200, "pong", Duration::ZERO);
        let result = lib.translation_probe(&json!({"base_url": draft.base_url, "model": "draft-model"})).unwrap();
        assert_eq!(result["ok"], json!(true), "{result}");
        assert_eq!(result["model"], json!("draft-model"));
        assert_eq!(draft.seen.lock().unwrap()[0].auth, "Bearer fixture-key");
        assert_eq!(lib.gateway().unwrap().base_url, live_gateway);
        drop(lib);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn translation_probe_reports_401_key_errors() {
        let (lib, root) = temp_library();
        let upstream = fake_upstream(401, "", Duration::ZERO);
        lib.reload_gateway(&json!({"base_url": upstream.base_url, "model": "academic-test", "api_key": "bad-key"}))
            .unwrap();
        let result = lib.translation_probe(&json!({})).unwrap();
        assert_eq!(result["ok"], json!(false), "{result}");
        let error = result["error"].as_str().unwrap();
        assert!(error.contains("401"), "{error}");
        assert!(error.contains("Key 无效"), "{error}");
        drop(lib);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn translation_probe_times_out_instead_of_hanging() {
        let (lib, root) = temp_library();
        let upstream = fake_upstream(200, "late", Duration::from_millis(1500));
        lib.reload_gateway(&json!({"base_url": upstream.base_url, "model": "academic-test", "api_key": "fixture-key"}))
            .unwrap();
        let started = Instant::now();
        let result = lib.translation_probe(&json!({"timeout_ms": 250})).unwrap();
        assert_eq!(result["ok"], json!(false), "{result}");
        assert!(result["error"].as_str().unwrap().contains("超时"), "{result}");
        assert!(started.elapsed() < Duration::from_millis(1400), "探针必须按超时立即返回");
        drop(lib);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn translation_probe_reports_unreachable_hosts_and_missing_keys() {
        let (lib, root) = temp_library();
        let unreachable = lib
            .translation_probe(&json!({"base_url": "http://127.0.0.1:1/v1", "model": "m", "api_key": "k", "timeout_ms": 2000}))
            .unwrap();
        assert_eq!(unreachable["ok"], json!(false), "{unreachable}");
        // Windows may report a closed loopback port as an exhausted timeout
        // instead of an immediate connection error; either is a readable failure.
        let unreachable_error = unreachable["error"].as_str().unwrap();
        assert!(
            unreachable_error.contains("网络错误") || unreachable_error.contains("超时") || unreachable_error.contains("连接"),
            "{unreachable}"
        );
        if no_environment_key() {
            let missing = lib.translation_probe(&json!({})).unwrap();
            assert_eq!(missing["ok"], json!(false), "{missing}");
            assert!(missing["error"].as_str().unwrap().contains("API Key"), "{missing}");
        }
        drop(lib);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn check_babeldoc_uses_the_hot_reloaded_path() {
        use std::os::unix::fs::PermissionsExt;
        let (lib, root) = temp_library();
        let upstream = fake_upstream(200, "pong", Duration::ZERO);
        let binary = root.join("babeldoc");
        std::fs::write(&binary, "#!/bin/sh\necho 'babeldoc 0.6.0'\n").unwrap();
        std::fs::set_permissions(&binary, std::fs::Permissions::from_mode(0o755)).unwrap();
        let binary_text = binary.to_string_lossy().to_string();
        lib.reload_gateway(&json!({
            "base_url": upstream.base_url,
            "model": "academic-test",
            "api_key": "fixture-key",
            "qps": 4,
            "babeldoc_bin": binary_text,
        }))
        .unwrap();
        let found = lib.check_babeldoc(&json!({})).unwrap();
        assert_eq!(found["ok"], json!(true), "{found}");
        assert_eq!(found["path"].as_str().unwrap(), binary_text);
        assert_eq!(found["version"], json!("babeldoc 0.6.0"));
        let (qps, configured) = lib.translation_engine_options();
        assert_eq!(qps, 4);
        assert_eq!(configured, binary);
        let missing = lib.check_babeldoc(&json!({"path": format!("{}/babeldoc", root.join("nope").display())})).unwrap();
        assert_eq!(missing["ok"], json!(false), "{missing}");
        assert!(missing["error"].as_str().unwrap().contains("未找到"), "{missing}");
        drop(lib);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn schema_upgrade_snapshots_the_library_before_migrating() {
        let root = std::env::temp_dir().join(format!("moonlight-schema-{}", Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        {
            let conn = Connection::open(root.join("library.db")).unwrap();
            conn.execute_batch(SCHEMA).unwrap();
            conn.execute("INSERT INTO papers(id,title,authors,imported_at,updated_at) VALUES('legacy-paper','Legacy','A',1,1)", []).unwrap();
            conn.execute("INSERT INTO versions(id,paper_id,kind,sha256,rel_path,pages,bytes,created_at) VALUES('legacy-version','legacy-paper','source','x','files/x.pdf',1,1,1)", []).unwrap();
            conn.execute_batch("DROP TABLE schema_migrations; DROP INDEX IF EXISTS idx_versions_source; ALTER TABLE versions DROP COLUMN source_version_id; ALTER TABLE jobs DROP COLUMN source_version_id;").unwrap();
        }
        let lib = Library::new(&root).unwrap();
        let version: i64 = lib.conn().query_row("SELECT MAX(version) FROM schema_migrations", [], |r| r.get(0)).unwrap();
        assert_eq!(version, SCHEMA_VERSION);
        assert!(column_exists(&lib.conn(), "versions", "source_version_id").unwrap());
        assert!(column_exists(&lib.conn(), "jobs", "source_version_id").unwrap());
        let title: String = lib.conn().query_row("SELECT title FROM papers WHERE id='legacy-paper'", [], |r| r.get(0)).unwrap();
        assert_eq!(title, "Legacy");
        drop(lib);
        let backups: Vec<PathBuf> = fs::read_dir(root.join("backups")).unwrap().filter_map(|entry| entry.ok().map(|item| item.path())).collect();
        assert_eq!(backups.len(), 1, "升级前应生成一份快照");
        let snapshot = Connection::open(&backups[0]).unwrap();
        let check: String = snapshot.query_row("PRAGMA integrity_check", [], |r| r.get(0)).unwrap();
        assert_eq!(check, "ok");
        let backed_up_title: String = snapshot.query_row("SELECT title FROM papers WHERE id='legacy-paper'", [], |r| r.get(0)).unwrap();
        assert_eq!(backed_up_title, "Legacy");
        drop(snapshot);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn translation_version_binds_to_the_supplementary_source_pdf() {
        let (lib, root) = temp_library();
        let sample = Path::new(env!("CARGO_MANIFEST_DIR")).join("../samples/generated/narrow-column.pdf");
        let imported = lib.import_paths(vec![sample.to_string_lossy().to_string()]);
        let paper_id = imported[0]["paper_id"].as_str().unwrap().to_string();
        let supplement_id = Uuid::new_v4().to_string();
        let rel = format!("files/supplement-{supplement_id}.pdf");
        fs::copy(&sample, root.join(&rel)).unwrap();
        let sha = sha256_file(&sample).unwrap();
        let bytes = sample.metadata().unwrap().len() as i64;
        lib.conn().execute(
            "INSERT INTO versions(id,paper_id,kind,sha256,rel_path,pages,bytes,lang,created_at,source_version_id) VALUES(?,?,?,?,?,?,?,?,?,NULL)",
            params![supplement_id, paper_id, "source", sha, rel, 1i64, bytes, "en", now_ms()],
        ).unwrap();
        let (resolved, _) = lib.source_version_for(&paper_id, Some(&supplement_id)).unwrap();
        assert_eq!(resolved, supplement_id);
        let job_id = Uuid::new_v4().to_string();
        lib.conn().execute(
            "INSERT INTO jobs(id,paper_id,status,pages,created_at,updated_at,source_version_id) VALUES(?,?,?,?,?,?,?)",
            params![job_id, paper_id, "queued", Option::<String>::None, now_ms(), now_ms(), supplement_id],
        ).unwrap();
        let output = root.join("supplement-output.pdf");
        fs::copy(&sample, &output).unwrap();
        let version_id = lib.attach_translation(&paper_id, &output, &job_id, Some(&supplement_id)).unwrap();
        let bound: Option<String> = lib.conn().query_row("SELECT source_version_id FROM versions WHERE id=?", params![version_id], |r| r.get(0)).unwrap();
        assert_eq!(bound.as_deref(), Some(supplement_id.as_str()));
        let job = lib.get_job(&job_id).unwrap();
        assert_eq!(job["source_version_id"], json!(supplement_id));
        assert_eq!(job["status"], json!("completed"));
        drop(lib);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn paper_json_exposes_the_source_version_binding() {
        let (lib, root) = temp_library();
        let paper_id = Uuid::new_v4().to_string();
        lib.conn().execute(
            "INSERT INTO papers(id,title,authors,imported_at,updated_at) VALUES(?,?,?,?,?)",
            params![paper_id, "Binding", "A", now_ms(), now_ms()],
        ).unwrap();
        let source_id = Uuid::new_v4().to_string();
        lib.conn().execute(
            "INSERT INTO versions(id,paper_id,kind,sha256,rel_path,pages,bytes,lang,created_at) VALUES(?,?,?,?,?,?,?,?,?)",
            params![source_id, paper_id, "source", "sha-source", "files/source.pdf", 2i64, 42i64, "en", now_ms()],
        ).unwrap();
        let translated_id = Uuid::new_v4().to_string();
        lib.conn().execute(
            "INSERT INTO versions(id,paper_id,kind,sha256,rel_path,pages,bytes,lang,engine,model,created_at,source_version_id) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
            params![translated_id, paper_id, "translated", "sha-translated", "derived/translated.pdf", 2i64, 43i64, "zh-CN", "babeldoc", "test-model", now_ms(), source_id],
        ).unwrap();
        let paper = lib.get_paper(&paper_id).unwrap();
        let versions = paper["versions"].as_array().unwrap();
        let translated = versions.iter().find(|version| version["id"].as_str() == Some(translated_id.as_str())).expect("translated version must be listed");
        assert_eq!(translated["source_version_id"].as_str(), Some(source_id.as_str()));
        let source = versions.iter().find(|version| version["id"].as_str() == Some(source_id.as_str())).unwrap();
        assert!(source["source_version_id"].is_null(), "source versions carry no parent binding");
        drop(lib);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn page_map_parses_page_selectors_into_sorted_zero_based_indexes() {
        assert_eq!(parse_pages_selector("8"), Some(vec![7]));
        assert_eq!(parse_pages_selector("5-8"), Some(vec![4, 5, 6, 7]));
        assert_eq!(parse_pages_selector("1-5, 8"), Some(vec![0, 1, 2, 3, 4, 7]));
        assert_eq!(parse_pages_selector(" 8, 5-6, 6 "), Some(vec![4, 5, 7]), "duplicates and whitespace collapse");
        assert_eq!(parse_pages_selector("8-5"), Some(vec![4, 5, 6, 7]), "a reversed range keeps every page");
        assert_eq!(parse_pages_selector("-4"), Some(vec![0, 1, 2, 3]), "a leading dash means from page 1");
        for invalid in ["", "   ", "abc", "0", "1-", "1-0", "1-99999999", "1-9223372036854775807", "1, nope"] {
            assert_eq!(parse_pages_selector(invalid), None, "{invalid:?} must fall back to identity");
        }
    }

    #[test]
    fn partial_translation_stores_the_page_map_and_maps_blocks_and_annotations() {
        let (lib, root) = temp_library();
        let sample = Path::new(env!("CARGO_MANIFEST_DIR")).join("../samples/generated/narrow-column.pdf");
        let paper_id = Uuid::new_v4().to_string();
        lib.conn().execute(
            "INSERT INTO papers(id,title,authors,imported_at,updated_at) VALUES(?,?,?,?,?)",
            params![paper_id, "Partial", "", now_ms(), now_ms()],
        ).unwrap();
        let source_id = Uuid::new_v4().to_string();
        lib.conn().execute(
            "INSERT INTO versions(id,paper_id,kind,sha256,rel_path,pages,bytes,lang,created_at) VALUES(?,?,'source','sha-source','files/source.pdf',10,1,'en',?)",
            params![source_id, paper_id, now_ms()],
        ).unwrap();
        let attach = |pages: Option<&str>| {
            let job_id = Uuid::new_v4().to_string();
            lib.conn().execute(
                "INSERT INTO jobs(id,paper_id,status,pages,created_at,updated_at) VALUES(?,?,'translating',?,?,?)",
                params![job_id, paper_id, pages, now_ms(), now_ms()],
            ).unwrap();
            let output = root.join(format!("subset-{job_id}.pdf"));
            fs::copy(&sample, &output).unwrap();
            let version_id = lib.attach_translation(&paper_id, &output, &job_id, None).unwrap();
            (job_id, version_id)
        };
        // BUG-01: `--pages 8` produced a one-page subset covering 0-based source page 7.
        let (_, translated_id) = attach(Some("8"));
        let paper = lib.get_paper(&paper_id).unwrap();
        let versions = paper["versions"].as_array().unwrap();
        let translated = versions.iter().find(|v| v["id"].as_str() == Some(translated_id.as_str())).unwrap();
        assert_eq!(translated["page_map"], json!([7]), "the subset's only page maps to source page 7");
        assert_eq!(translated["pages"], json!(1), "the stored PDF is the translated subset");
        let source = versions.iter().find(|v| v["id"].as_str() == Some(source_id.as_str())).unwrap();
        assert!(source["page_map"].is_null(), "source versions carry no page map");

        // The renderer addresses the subset page 0; the backend stores source page 7.
        lib.set_blocks(&paper_id, &translated_id, 0, vec![json!({"text":"译文正文","bbox":[1,1,10,10]})]).unwrap();
        assert_eq!(lib.blocks(&paper_id, &translated_id, 7).unwrap().len(), 1, "blocks land on the source page");
        assert!(lib.blocks(&paper_id, &translated_id, 0).unwrap().is_empty());
        assert!(lib.set_blocks(&paper_id, &translated_id, 1, vec![json!({"text":"越界"})]).is_err());

        // Translated annotations arrive with the 0-based SOURCE page and must be
        // accepted only when that page is in the page map.
        lib.add_annotation(&paper_id, 7, json!([]), "引文", "yellow", "", "translated", Some(&translated_id)).unwrap();
        assert!(lib.add_annotation(&paper_id, 0, json!([]), "错页", "yellow", "", "translated", Some(&translated_id)).is_err());

        // A full translation (no `--pages`) is byte-compatible with the old path:
        // page_map NULL, subset index == source page, old bounds check still applies.
        let (_, full_id) = attach(None);
        let paper = lib.get_paper(&paper_id).unwrap();
        let full = paper["versions"].as_array().unwrap().iter().find(|v| v["id"].as_str() == Some(full_id.as_str())).unwrap();
        assert!(full["page_map"].is_null(), "full translations keep the identity mapping");
        lib.set_blocks(&paper_id, &full_id, 0, vec![json!({"text":"全文译文","bbox":[1,1,10,10]})]).unwrap();
        assert_eq!(lib.blocks(&paper_id, &full_id, 0).unwrap().len(), 1);
        assert!(lib.set_blocks(&paper_id, &full_id, 1, vec![json!({"text":"越界"})]).is_err());
        lib.add_annotation(&paper_id, 0, json!([]), "全文批注", "yellow", "", "translated", Some(&full_id)).unwrap();
        assert!(lib.add_annotation(&paper_id, 1, json!([]), "越界", "yellow", "", "translated", Some(&full_id)).is_err());
        drop(lib);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn schema_upgrade_adds_the_page_map_column() {
        let root = std::env::temp_dir().join(format!("moonlight-schema-v6-{}", Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        {
            let conn = Connection::open(root.join("library.db")).unwrap();
            conn.execute_batch(SCHEMA).unwrap();
            conn.execute("INSERT INTO papers(id,title,authors,imported_at,updated_at) VALUES('v5-paper','V5 Paper','A',3,3)", []).unwrap();
            conn.execute("INSERT INTO versions(id,paper_id,kind,sha256,rel_path,pages,bytes,created_at) VALUES('v5-version','v5-paper','source','x','files/x.pdf',1,1,1)", []).unwrap();
            // Roll the fixture back to a genuine v5 file.
            conn.execute_batch("ALTER TABLE versions DROP COLUMN page_map; DELETE FROM schema_migrations WHERE version>=6;").unwrap();
            assert!(!column_exists(&conn, "versions", "page_map").unwrap(), "fixture must start at v5");
        }
        let lib = Library::new(&root).unwrap();
        assert!(column_exists(&lib.conn(), "versions", "page_map").unwrap(), "v6 upgrade must add page_map");
        let version: i64 = lib.conn().query_row("SELECT MAX(version) FROM schema_migrations", [], |r| r.get(0)).unwrap();
        assert_eq!(version, SCHEMA_VERSION);
        let page_map: Option<String> = lib.conn().query_row("SELECT page_map FROM versions WHERE id='v5-version'", [], |r| r.get(0)).unwrap();
        assert!(page_map.is_none(), "existing versions stay full translations");
        drop(lib);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn startup_sweeps_orphan_translation_directories_only() {
        let root = std::env::temp_dir().join(format!("moonlight-sweep-{}", Uuid::new_v4()));
        fs::create_dir_all(root.join("tmp/job-orphan/nested")).unwrap();
        fs::write(root.join("tmp/job-orphan/nested/result.mono.pdf"), b"pdf").unwrap();
        fs::write(root.join("tmp/job-staged.mono.pdf"), b"pdf").unwrap();
        fs::write(root.join("tmp/keep.pdf"), b"keep").unwrap();
        fs::write(root.join("tmp/job-not-a-dir"), b"keep").unwrap();
        let lib = Library::new(&root).unwrap();
        assert!(!root.join("tmp/job-orphan").exists(), "orphan job dirs must be swept on startup");
        assert!(!root.join("tmp/job-staged.mono.pdf").exists(), "a staged engine PDF is swept too");
        assert!(root.join("tmp/keep.pdf").exists(), "unrelated temp files are untouched");
        assert!(root.join("tmp/job-not-a-dir").exists(), "only directories and staged PDFs are swept");
        drop(lib);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn paper_json_returns_the_stored_digest_and_null_without_one() {
        let (lib, root) = temp_library();
        let paper_id = Uuid::new_v4().to_string();
        lib.conn().execute(
            "INSERT INTO papers(id,title,authors,imported_at,updated_at) VALUES(?,?,?,?,?)",
            params![paper_id, "Digest", "A", now_ms(), 7i64],
        ).unwrap();
        assert!(lib.get_paper(&paper_id).unwrap()["digest"].is_null(), "no digest yet");
        assert!(lib.digest_json(&paper_id).unwrap().is_none());
        let digest = json!({
            "markdown": "## ① 研究痛点\n缓存导读。\n\n## ② 核心方法\n[p.2] 检索增强。",
            "generated_at": 1234i64,
            "model": "test-model",
            "version_id": "v1",
        });
        assert_eq!(lib.save_digest(&paper_id, &digest).unwrap(), json!({"ok": true}));
        assert_eq!(lib.digest_json(&paper_id).unwrap(), Some(digest.clone()));
        let paper = lib.get_paper(&paper_id).unwrap();
        assert_eq!(paper["digest"], digest, "paper_json must parse the cached digest object");
        assert_eq!(paper["updated_at"], json!(7), "digest caching must not touch updated_at");
        // The cached value is validation-guarded so the renderer never gets a
        // half-written digest back as a plain string.
        assert!(lib.save_digest("missing-paper", &digest).is_err());
        assert!(lib.save_digest(&paper_id, &json!({"markdown": "   "})).is_err());
        assert!(lib.save_digest(&paper_id, &json!("not an object")).is_err());
        // Replacing the digest is an update, not a duplicate insert.
        let replacement = json!({"markdown": "新版导读", "generated_at": 5678i64, "model": "test-model"});
        lib.save_digest(&paper_id, &replacement).unwrap();
        assert_eq!(lib.get_paper(&paper_id).unwrap()["digest"], replacement);
        drop(lib);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn schema_upgrade_from_v3_adds_the_digest_column() {
        let root = std::env::temp_dir().join(format!("moonlight-schema-v4-{}", Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        {
            let conn = Connection::open(root.join("library.db")).unwrap();
            conn.execute_batch(SCHEMA).unwrap();
            conn.execute("INSERT INTO papers(id,title,authors,imported_at,updated_at) VALUES('v3-paper','V3 Paper','A',9,9)", []).unwrap();
            // Roll the fixture back to a genuine v3 file.
            conn.execute_batch("ALTER TABLE papers DROP COLUMN digest_json; DELETE FROM schema_migrations WHERE version>=4;").unwrap();
            assert!(!column_exists(&conn, "papers", "digest_json").unwrap(), "fixture must start at v3");
        }
        let lib = Library::new(&root).unwrap();
        assert!(column_exists(&lib.conn(), "papers", "digest_json").unwrap(), "v4 upgrade must add digest_json");
        let version: i64 = lib.conn().query_row("SELECT MAX(version) FROM schema_migrations", [], |r| r.get(0)).unwrap();
        assert_eq!(version, SCHEMA_VERSION);
        assert!(lib.digest_json("v3-paper").unwrap().is_none(), "an upgraded paper starts without a digest");
        lib.save_digest("v3-paper", &json!({"markdown":"升级后可写缓存","generated_at":1i64,"model":"m"})).unwrap();
        assert_eq!(lib.digest_json("v3-paper").unwrap().unwrap()["markdown"], json!("升级后可写缓存"));
        drop(lib);
        let backups: Vec<PathBuf> = fs::read_dir(root.join("backups")).unwrap().filter_map(|entry| entry.ok().map(|item| item.path())).collect();
        assert_eq!(backups.len(), 1, "升级前应生成一份快照");
        drop(Connection::open(&backups[0]).unwrap());
        fs::remove_dir_all(root).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn supplementary_translation_runs_end_to_end_and_binds_the_output() {
        use std::os::unix::fs::PermissionsExt;
        let (lib, root) = temp_library();
        let sample = Path::new(env!("CARGO_MANIFEST_DIR")).join("../samples/generated/narrow-column.pdf");
        let imported = lib.import_paths(vec![sample.to_string_lossy().to_string()]);
        let paper_id = imported[0]["paper_id"].as_str().unwrap().to_string();
        let supplement_id = Uuid::new_v4().to_string();
        let rel = format!("files/supplement-{supplement_id}.pdf");
        fs::copy(&sample, root.join(&rel)).unwrap();
        lib.conn().execute(
            "INSERT INTO versions(id,paper_id,kind,sha256,rel_path,pages,bytes,lang,created_at,source_version_id) VALUES(?,?,?,?,?,?,?,?,?,NULL)",
            params![supplement_id, paper_id, "source", sha256_file(&sample).unwrap(), rel, 1i64, sample.metadata().unwrap().len() as i64, "en", now_ms()],
        ).unwrap();
        let fake = root.join("fake-babeldoc");
        fs::write(&fake, "#!/bin/sh\nout=\"\"\nfiles=\"\"\nwhile [ $# -gt 0 ]; do case \"$1\" in --files) files=\"$2\"; shift 2;; --output) out=\"$2\"; shift 2;; *) shift;; esac; done\nmkdir -p \"$out\"\ncp \"$files\" \"$out/result.mono.pdf\"\n").unwrap();
        fs::set_permissions(&fake, fs::Permissions::from_mode(0o755)).unwrap();
        let upstream = fake_upstream(200, "ok", Duration::ZERO);
        lib.reload_gateway(&json!({"base_url": upstream.base_url, "model": "academic-test", "api_key": "fixture-key", "babeldoc": fake.to_string_lossy()})).unwrap();
        let job_id = lib.start_translation(&paper_id, None, Some(supplement_id.clone())).unwrap()["job_id"].as_str().unwrap().to_string();
        let mut status = String::new();
        for _ in 0..200 {
            let job = lib.get_job(&job_id).unwrap();
            status = job["status"].as_str().unwrap_or("").to_string();
            if matches!(status.as_str(), "completed" | "failed" | "cancelled") { break; }
            std::thread::sleep(Duration::from_millis(50));
        }
        assert_eq!(status, "completed", "job did not complete");
        assert!(!root.join("tmp").join(format!("job-{job_id}")).exists(), "BUG-06: a successful run must clean its tmp/job-* directory");
        let (bound, source): (Option<String>, Option<String>) = lib.conn().query_row(
            "SELECT source_version_id, (SELECT source_version_id FROM jobs WHERE id=?) FROM versions WHERE paper_id=? AND kind='translated' ORDER BY created_at DESC LIMIT 1",
            params![job_id, paper_id], |r| Ok((r.get(0)?, r.get(1)?)),
        ).unwrap();
        assert_eq!(bound.as_deref(), Some(supplement_id.as_str()));
        assert_eq!(source.as_deref(), Some(supplement_id.as_str()));
        drop(lib);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn schema_upgrade_from_v2_adds_reading_position_columns() {
        let root = std::env::temp_dir().join(format!("moonlight-schema-v3-{}", Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        {
            let conn = Connection::open(root.join("library.db")).unwrap();
            conn.execute_batch(SCHEMA).unwrap();
            conn.execute("INSERT INTO papers(id,title,authors,imported_at,updated_at) VALUES('v2-paper','V2 Paper','A',7,7)", []).unwrap();
            // Roll the fixture back to a genuine v2 file: the four reading
            // columns and the v4 digest column are gone and the highest applied
            // migration is 2.
            conn.execute_batch(
                "ALTER TABLE papers DROP COLUMN last_read_page;
                 ALTER TABLE papers DROP COLUMN last_read_fraction;
                 ALTER TABLE papers DROP COLUMN last_read_mode;
                 ALTER TABLE papers DROP COLUMN last_read_at;
                 ALTER TABLE papers DROP COLUMN digest_json;
                 DELETE FROM schema_migrations WHERE version>=3;",
            )
            .unwrap();
            assert!(!column_exists(&conn, "papers", "last_read_page").unwrap(), "fixture must start at v2");
        }
        let lib = Library::new(&root).unwrap();
        for column in ["last_read_page", "last_read_fraction", "last_read_mode", "last_read_at", "digest_json"] {
            assert!(column_exists(&lib.conn(), "papers", column).unwrap(), "v3/v4 upgrade must add {column}");
        }
        let version: i64 = lib.conn().query_row("SELECT MAX(version) FROM schema_migrations", [], |r| r.get(0)).unwrap();
        assert_eq!(version, SCHEMA_VERSION);
        let (title, updated): (String, i64) = lib
            .conn()
            .query_row("SELECT title,updated_at FROM papers WHERE id='v2-paper'", [], |r| Ok((r.get(0)?, r.get(1)?)))
            .unwrap();
        assert_eq!((title.as_str(), updated), ("V2 Paper", 7), "migration must keep existing rows");
        let resume: Option<i64> = lib.conn().query_row("SELECT last_read_page FROM papers WHERE id='v2-paper'", [], |r| r.get(0)).unwrap();
        assert!(resume.is_none(), "an upgraded paper starts without a resume point");
        drop(lib);
        let backups: Vec<PathBuf> = fs::read_dir(root.join("backups")).unwrap().filter_map(|entry| entry.ok().map(|item| item.path())).collect();
        assert_eq!(backups.len(), 1, "升级前应生成一份快照");
        let snapshot = Connection::open(&backups[0]).unwrap();
        assert!(!column_exists(&snapshot, "papers", "last_read_page").unwrap(), "快照必须保持升级前的 v2 结构");
        assert_eq!(snapshot.query_row("SELECT title FROM papers WHERE id='v2-paper'", [], |r| r.get::<_, String>(0)).unwrap(), "V2 Paper");
        drop(snapshot);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn reading_position_clamps_and_keeps_updated_at() {
        let (lib, root) = temp_library();
        let paper_id = Uuid::new_v4().to_string();
        lib.conn().execute(
            "INSERT INTO papers(id,title,authors,imported_at,updated_at) VALUES(?,?,?,?,?)",
            params![paper_id, "Reading", "A", now_ms(), 1234i64],
        ).unwrap();
        lib.conn().execute(
            "INSERT INTO versions(id,paper_id,kind,sha256,rel_path,pages,bytes,lang,created_at) VALUES(?,?,?,?,?,?,?,?,?)",
            params![Uuid::new_v4().to_string(), paper_id, "source", "sha-reading", "files/reading.pdf", 12i64, 1i64, "en", now_ms()],
        ).unwrap();

        assert_eq!(lib.set_reading_position(&paper_id, 99, 1.8, "dual").unwrap(), json!({"ok": true}));
        let paper = lib.get_paper(&paper_id).unwrap();
        assert_eq!(paper["last_read_page"], json!(11), "page must clamp to pages-1");
        assert_eq!(paper["last_read_fraction"], json!(1.0), "fraction must clamp to 1");
        assert_eq!(paper["last_read_mode"], json!("dual"));
        assert!(paper["last_read_at"].as_i64().unwrap() > 0, "last_read_at must be stamped: {paper}");
        assert_eq!(paper["updated_at"], json!(1234), "阅读进度不得改动 updated_at");

        lib.set_reading_position(&paper_id, -5, -0.4, "bogus-mode").unwrap();
        let paper = lib.get_paper(&paper_id).unwrap();
        assert_eq!(paper["last_read_page"], json!(0), "negative page clamps to 0");
        assert_eq!(paper["last_read_fraction"], json!(0.0), "fraction must clamp to 0");
        assert_eq!(paper["last_read_mode"], json!("source"), "unknown modes fall back to source");
        let stored_updated: i64 = lib.conn().query_row("SELECT updated_at FROM papers WHERE id=?", [&paper_id], |r| r.get(0)).unwrap();
        assert_eq!(stored_updated, 1234, "the SQL row's updated_at must also stay untouched");

        // No version at all: the page only has to stay non-negative.
        let versionless = Uuid::new_v4().to_string();
        lib.conn().execute(
            "INSERT INTO papers(id,title,authors,imported_at,updated_at) VALUES(?,?,?,?,?)",
            params![versionless, "No PDF", "A", now_ms(), 7i64],
        ).unwrap();
        lib.set_reading_position(&versionless, -2, 0.5, "paper-code").unwrap();
        let versionless_paper = lib.get_paper(&versionless).unwrap();
        assert_eq!(versionless_paper["last_read_page"], json!(0));
        assert_eq!(versionless_paper["last_read_mode"], json!("paper-code"));

        let error = lib.set_reading_position("no-such-paper", 0, 0.0, "source").err().expect("missing paper must error").to_string();
        assert!(error.contains("论文不存在"), "{error}");
        drop(lib);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn sync_export_and_upsert_carry_the_reading_position() {
        let (lib, root) = temp_library();
        let paper_id = Uuid::new_v4().to_string();
        lib.conn().execute(
            "INSERT INTO papers(id,title,authors,imported_at,updated_at) VALUES(?,?,?,?,?)",
            params![paper_id, "Synced", "A", now_ms(), now_ms()],
        ).unwrap();
        lib.set_reading_position(&paper_id, 3, 0.25, "translated").unwrap();
        let documents = crate::sync_model::export(&lib.conn()).unwrap();
        let key = format!("paper:{paper_id}");
        let doc = &documents[&key];
        // `export` selects `*`, so the new columns travel without touching sync_model.
        assert_eq!(doc["paper"]["last_read_page"], json!(3));
        assert_eq!(doc["paper"]["last_read_fraction"], json!(0.25));
        assert_eq!(doc["paper"]["last_read_mode"], json!("translated"));
        assert!(doc["paper"]["last_read_at"].as_i64().unwrap() > 0);
        crate::sync_model::validate(&key, doc).unwrap();
        // The upsert whitelist is PRAGMA table_info, so applying our own doc must
        // accept (not reject) the v3 columns.
        crate::sync_model::apply(&lib.conn(), &key, doc).unwrap();
        let applied = lib.get_paper(&paper_id).unwrap();
        assert_eq!(applied["last_read_fraction"], json!(0.25));
        assert_eq!(applied["last_read_mode"], json!("translated"));
        drop(lib);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn fresh_library_uses_current_schema_without_a_snapshot() {
        let root = std::env::temp_dir().join(format!("moonlight-fresh-{}", Uuid::new_v4()));
        let lib = Library::new(&root).unwrap();
        let version: i64 = lib.conn().query_row("SELECT MAX(version) FROM schema_migrations", [], |r| r.get(0)).unwrap();
        assert_eq!(version, SCHEMA_VERSION);
        drop(lib);
        let snapshots = fs::read_dir(root.join("backups")).map(|items| items.count()).unwrap_or(0);
        assert_eq!(snapshots, 0, "全新库不应产生升级快照");
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn ai_cancellation_flags_are_registered_flipped_and_released() {
        let root = std::env::temp_dir().join(format!("moonlight-ai-cancel-{}", Uuid::new_v4()));
        let lib = Library::new(&root).unwrap();
        // Unknown ids are a no-op so a late cancel cannot error the UI.
        assert!(!lib.cancel_ai("never-started"));
        let flag = lib.begin_ai_request("turn-1");
        assert!(!flag.load(Ordering::SeqCst), "a fresh request must not start cancelled");
        assert!(lib.cancel_ai("turn-1"));
        assert!(flag.load(Ordering::SeqCst), "cancel must flip the flag the stream polls");
        // The translation-job cancel table shares the map; namespacing keeps them apart.
        assert!(!lib.cancel_ai("ai:turn-1"));
        lib.end_ai_request("turn-1");
        assert!(!lib.cancel_ai("turn-1"), "a finished request is no longer cancellable");
        drop(lib);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn chat_model_persists_trims_and_clears() {
        let (lib, root) = temp_library();
        assert_eq!(lib.chat_model(), None, "a fresh library has no chat model");
        let saved = lib.set_chat_model("  reasoner-v2  ").unwrap();
        assert_eq!(saved, json!({"ok": true, "chat_model": "reasoner-v2"}), "the saved value is trimmed");
        assert_eq!(lib.chat_model().as_deref(), Some("reasoner-v2"));
        let stored: String = lib.conn().query_row("SELECT value FROM app_settings WHERE key='chat_model'", [], |r| r.get(0)).unwrap();
        assert_eq!(stored, "reasoner-v2", "the model lives in the library, not only in memory");
        drop(lib);

        // Reopening the library (the LAN tablet bridge runs in the same process,
        // but a restart must also keep the pick) still sees it.
        let reopened = Library::new(&root).unwrap();
        assert_eq!(reopened.chat_model().as_deref(), Some("reasoner-v2"));
        let cleared = reopened.set_chat_model("   ").unwrap();
        assert_eq!(cleared, json!({"ok": true, "chat_model": null}), "whitespace clears the override");
        assert_eq!(reopened.chat_model(), None);
        let rows: i64 = reopened.conn().query_row("SELECT COUNT(*) FROM app_settings WHERE key='chat_model'", [], |r| r.get(0)).unwrap();
        assert_eq!(rows, 0, "clearing deletes the row instead of storing an empty value");
        let too_long = "m".repeat(201);
        assert!(reopened.set_chat_model(&too_long).is_err(), "a model name is capped at 200 characters");
        drop(reopened);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn schema_upgrade_from_v4_adds_app_settings() {
        let root = std::env::temp_dir().join(format!("moonlight-schema-v5-{}", Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        {
            let conn = Connection::open(root.join("library.db")).unwrap();
            conn.execute_batch(SCHEMA).unwrap();
            conn.execute_batch("DROP TABLE app_settings; DELETE FROM schema_migrations WHERE version>=5;").unwrap();
            assert!(!table_exists(&conn, "app_settings").unwrap(), "fixture must start at v4");
            // The migration itself must recreate the store on a v4 file.
            apply_migrations(&conn, 4).unwrap();
            assert!(table_exists(&conn, "app_settings").unwrap(), "v5 migration must add app_settings");
        }
        let lib = Library::new(&root).unwrap();
        let version: i64 = lib.conn().query_row("SELECT MAX(version) FROM schema_migrations", [], |r| r.get(0)).unwrap();
        assert_eq!(version, SCHEMA_VERSION);
        lib.set_chat_model("migrated-model").unwrap();
        drop(lib);
        let reopened = Library::new(&root).unwrap();
        assert_eq!(reopened.chat_model().as_deref(), Some("migrated-model"));
        drop(reopened);
        let backups: Vec<PathBuf> = fs::read_dir(root.join("backups")).unwrap().filter_map(|entry| entry.ok().map(|item| item.path())).collect();
        assert_eq!(backups.len(), 1, "升级前应生成一份快照");
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn newer_schema_is_rejected_instead_of_downgraded() {
        let root = std::env::temp_dir().join(format!("moonlight-newer-{}", Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        {
            let conn = Connection::open(root.join("library.db")).unwrap();
            conn.execute_batch(SCHEMA).unwrap();
            conn.execute("INSERT OR REPLACE INTO schema_migrations(version,applied_at) VALUES(99,?)", [now_ms()]).unwrap();
        }
        let error = Library::new(&root).err().expect("newer schema must be rejected").to_string();
        assert!(error.contains("更新版本"), "{error}");
        fs::remove_dir_all(root).unwrap();
    }

    // ---- FEAT-UX-03 glossary -------------------------------------------

    #[test]
    fn glossary_round_trips_trims_and_deduplicates_case_insensitively() {
        let root = std::env::temp_dir().join(format!("moonlight-glossary-{}", Uuid::new_v4()));
        let lib = Library::new(&root).unwrap();
        assert_eq!(lib.list_glossary().unwrap(), json!({"terms": []}));

        let saved = lib.save_glossary(&json!({"terms":[
            {"source":"  Attention ","target":" 注意力 ","domain":" AI ","enabled":true},
            {"source":"attention","target":"重复词条","domain":"","enabled":true},
            {"source":"Rollout","target":"轨迹采样","domain":"RL"},
            {"source":"Legacy","target":"旧术语","enabled":false}
        ]})).unwrap();
        assert_eq!(saved, json!({"ok":true,"count":3}), "case-insensitive duplicate collapses");

        let listed = lib.list_glossary().unwrap();
        let terms = listed["terms"].as_array().unwrap();
        assert_eq!(terms.len(), 3);
        let attention = terms.iter().find(|term| term["source"]=="Attention").unwrap();
        assert_eq!(attention["target"], json!("注意力"), "fields are trimmed");
        assert_eq!(attention["domain"], json!("AI"));
        assert_eq!(attention["enabled"], json!(true));
        let legacy = terms.iter().find(|term| term["source"]=="Legacy").unwrap();
        assert_eq!(legacy["enabled"], json!(false), "disabled rows are kept for later re-enable");
        // Every entry has exactly the renderer contract keys.
        for term in terms {
            let object = term.as_object().unwrap();
            assert_eq!(object.len(), 4, "{term}");
            for key in ["source", "target", "domain", "enabled"] {
                assert!(object.contains_key(key), "{term}");
            }
        }

        assert_eq!(lib.enabled_glossary_pairs().unwrap(), vec![
            ("Attention".to_string(), "注意力".to_string()),
            ("Rollout".to_string(), "轨迹采样".to_string()),
        ]);

        // Invalid input is rejected before the table is touched.
        assert!(lib.save_glossary(&json!({})).is_err());
        assert!(lib.save_glossary(&json!({"terms":[{"source":"","target":"x"}]})).is_err());
        assert!(lib.save_glossary(&json!({"terms":[{"source":"x","target":"  "}]})).is_err());
        assert!(lib.save_glossary(&json!({"terms":[{"source":"x".repeat(201),"target":"y"}]})).is_err());
        assert!(lib.save_glossary(&json!({"terms":[{"source":"x","target":"y".repeat(301)}]})).is_err());
        assert!(lib.save_glossary(&json!({"terms":[{"source":"x","target":"y","domain":"z".repeat(101)}]})).is_err());
        let too_many = (0..501).map(|i| json!({"source":format!("term-{i}"),"target":"t"})).collect::<Vec<_>>();
        assert!(lib.save_glossary(&json!({"terms":too_many})).is_err());
        assert_eq!(lib.list_glossary().unwrap()["terms"].as_array().unwrap().len(), 3, "rejected saves keep the old table");

        drop(lib);
        let reopened = Library::new(&root).unwrap();
        assert_eq!(reopened.enabled_glossary_pairs().unwrap().len(), 2);
        drop(reopened);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn glossary_updates_the_live_gateway_on_save_and_reload() {
        let root = std::env::temp_dir().join(format!("moonlight-glossary-gateway-{}", Uuid::new_v4()));
        let lib = Library::new(&root).unwrap();
        lib.reload_gateway(&json!({
            "base_url":"http://127.0.0.1:1/v1","model":"test-model","api_key":"fixture-key"
        })).unwrap();
        let gateway = lib.gateway().unwrap();
        assert!(gateway.glossary_terms().is_empty(), "a fresh library has no terms");

        lib.save_glossary(&json!({"terms":[
            {"source":"Rollout","target":"轨迹采样"},
            {"source":"Register","target":"寄存器","enabled":false}
        ]})).unwrap();
        assert_eq!(gateway.glossary_terms(), vec![("Rollout".to_string(), "轨迹采样".to_string())],
            "save hot-updates the shared gateway state, disabled rows excluded");
        assert!(gateway.glossary_terms().iter().all(|(source, _)| source != "Register"));

        // A credential hot-reload keeps the glossary in place.
        lib.reload_gateway(&json!({"model":"another-model"})).unwrap();
        assert_eq!(lib.gateway().unwrap().glossary_terms().len(), 1);
        lib.gateway().unwrap().shutdown();
        drop(lib);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn glossary_prompt_prefers_matched_terms_then_fills_globally() {
        let root = std::env::temp_dir().join(format!("moonlight-glossary-prompt-{}", Uuid::new_v4()));
        let lib = Library::new(&root).unwrap();
        assert!(lib.glossary_prompt_for("anything", 24).unwrap().is_none(), "empty table keeps the historic prompt");
        lib.save_glossary(&json!({"terms":[
            {"source":"Rollout","target":"轨迹采样","domain":"RL"},
            {"source":"Attention","target":"注意力","domain":"DL"},
            {"source":"Register","target":"寄存器","domain":"Arch"}
        ]})).unwrap();

        let matched = lib.glossary_prompt_for("rollout sampling uses attention", 2).unwrap().unwrap();
        assert!(matched.contains(GLOSSARY_MARKER), "{matched}");
        assert!(matched.contains("Attention -> 注意力"), "matched terms are kept: {matched}");
        assert!(matched.contains("Rollout -> 轨迹采样"), "{matched}");
        assert_eq!(matched.matches(" -> ").count(), 2, "limit is respected: {matched}");
        assert!(!matched.contains("Register"));

        let single = lib.glossary_prompt_for("rollout sampling", 1).unwrap().unwrap();
        assert_eq!(single.matches(" -> ").count(), 1);
        assert!(single.contains("Rollout"), "{single}");

        // No literal hit: globally enabled terms fill the slots in stable order.
        let global = lib.glossary_prompt_for("无关文本", 2).unwrap().unwrap();
        assert!(global.contains("Attention -> 注意力"), "{global}");
        assert!(global.contains("Register -> 寄存器"), "{global}");
        assert!(!global.contains("Rollout"), "{global}");

        lib.save_glossary(&json!({"terms":[{"source":"Only","target":"唯一","enabled":false}]})).unwrap();
        assert!(lib.glossary_prompt_for("Only", 24).unwrap().is_none(), "disabled-only table is invisible");

        drop(lib);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn schema_upgrade_from_v6_adds_glossary_terms() {
        let root = std::env::temp_dir().join(format!("moonlight-schema-v7-{}", Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        {
            let conn = Connection::open(root.join("library.db")).unwrap();
            conn.execute_batch(SCHEMA).unwrap();
            conn.execute_batch("DROP TABLE glossary_terms; DELETE FROM schema_migrations WHERE version>=7;").unwrap();
            assert!(!table_exists(&conn, "glossary_terms").unwrap(), "fixture must start at v6");
            // The migration itself must recreate the table on a v6 file.
            apply_migrations(&conn, 6).unwrap();
            assert!(table_exists(&conn, "glossary_terms").unwrap(), "v7 migration must add glossary_terms");
            let columns: Vec<String> = conn.prepare("PRAGMA table_info(glossary_terms)").unwrap()
                .query_map([], |row| row.get::<_, String>(1)).unwrap()
                .filter_map(Result::ok).collect();
            assert_eq!(columns, vec!["id", "source", "target", "domain", "enabled"]);
        }
        let lib = Library::new(&root).unwrap();
        assert_eq!(lib.conn().query_row("SELECT MAX(version) FROM schema_migrations", [], |r| r.get::<_, i64>(0)).unwrap(), SCHEMA_VERSION);
        lib.save_glossary(&json!({"terms":[{"source":"Attention","target":"注意力"}]})).unwrap();
        assert_eq!(lib.list_glossary().unwrap()["terms"][0]["target"], json!("注意力"));
        assert!(root.join("backups").read_dir().unwrap().next().is_some(), "v6→v7 creates the pre-upgrade snapshot");
        drop(lib);
        fs::remove_dir_all(root).unwrap();
    }

    // ---- FEAT-UX-04 citation export ------------------------------------

    #[test]
    fn export_supports_gbt7714_and_apa_and_keeps_bibtex_ris_unchanged() {
        let root = std::env::temp_dir().join(format!("moonlight-export-{}", Uuid::new_v4()));
        let lib = Library::new(&root).unwrap();
        lib.conn().execute(
            "INSERT INTO papers(id,title,authors,year,venue,doi,arxiv,abstract,imported_at,updated_at) VALUES('p','Attention Is All You Need','Ada Lovelace, Alan Turing','2024','NeurIPS','10.1000/xyz','2401.00001','An abstract.',0,0)",
            [],
        ).unwrap();

        let gbt = lib.export(vec!["p".into()], "gbt7714").unwrap();
        assert_eq!(gbt, "[1] Ada Lovelace, Alan Turing. Attention Is All You Need[J/OL]. NeurIPS, 2024. DOI: 10.1000/xyz.");
        let apa = lib.export(vec!["p".into()], "apa").unwrap();
        assert_eq!(apa, "Lovelace, A., & Turing, A. (2024). Attention Is All You Need. NeurIPS. https://doi.org/10.1000/xyz.");

        let bib = lib.export(vec!["p".into()], "bibtex").unwrap();
        assert!(bib.starts_with("@article{"), "{bib}");
        assert!(bib.contains("title = {Attention Is All You Need}"), "{bib}");
        let ris = lib.export(vec!["p".into()], "ris").unwrap();
        assert!(ris.starts_with("TY  - JOUR"), "{ris}");
        assert!(ris.contains("AU  - Ada Lovelace"), "{ris}");
        assert_eq!(lib.export(vec!["p".into()], "unknown").unwrap(), bib, "unknown formats keep the legacy BibTeX default");

        // Numbering follows the requested order and survives missing fields.
        lib.conn().execute(
            "INSERT INTO papers(id,title,authors,imported_at,updated_at) VALUES('q','Plain Title','',0,0)",
            [],
        ).unwrap();
        let two = lib.export(vec!["p".into(), "q".into()], "gbt7714").unwrap();
        let lines = two.split("\n\n").collect::<Vec<_>>();
        assert_eq!(lines.len(), 2);
        assert!(lines[0].starts_with("[1] "), "{two}");
        assert_eq!(lines[1], "[2] Plain Title[J/OL].");
        let apa_missing = lib.export(vec!["q".into()], "apa").unwrap();
        assert_eq!(apa_missing, "(n.d.). Plain Title.");
        drop(lib);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn open_for_mcp_coexists_with_desktop_instance_lock() {
        let root = std::env::temp_dir().join(format!("moonlight-mcp-lock-{}", Uuid::new_v4()));
        let owner = Library::new(&root).unwrap();
        assert!(Library::new(&root).is_err(), "second writer must be blocked by .moonlight.lock");
        owner.conn().execute(
            "INSERT INTO papers(id,title,authors,imported_at,updated_at) VALUES('p1','知识蒸馏综述','Alice',1,1)",
            [],
        ).unwrap();

        let mcp = Library::open_for_mcp(&root).unwrap();
        assert_eq!(mcp.get_paper("p1").unwrap()["title"], json!("知识蒸馏综述"));
        let page = crate::search::list_page(&mcp.conn(), &json!({"query":"蒸馏"})).unwrap();
        assert_eq!(page["total"], json!(1));

        drop(mcp);
        drop(owner);
        fs::remove_dir_all(root).unwrap();
    }
}
