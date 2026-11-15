import { lazy, Suspense, useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Circle, ListChecks, MailOpen, Moon, Settings, Star, Trash2, UploadCloud } from "lucide-react";
import Library from "./Library";
import FolderTreeView from "./FolderTree";
import FolderManager from "./FolderManager";
import OrganizePapers from "./OrganizePapers";
import TaxonomyList from "./TaxonomyList";
import ZoteroCollections from "./ZoteroCollections";
import PaperEditor from "./PaperEditor";
import TaskCenter from "./TaskCenter";
import TagManager from "./TagManager";
import Inspector from "./Inspector";
import SettingsModal from "./SettingsModal";
import { api } from "./api";
import type { AppInfo, Paper, PaperPageOptions, PaperSort, PaperSummary } from "./types";

const Reader = lazy(() => import("./Reader"));

type Filter =
  | { kind: "all" }
  | { kind: "favorite" }
  | { kind: "unread" }
  | { kind: "trash" }
  | { kind: "category"; id: string; name: string }
  | { kind: "tag"; name: string };

type InspectState = { summary: PaperSummary; paper: Paper | null; loading: boolean; error?: string };

export default function App() {
  const client = useQueryClient();
  const [filter, setFilter] = useState<Filter>({ kind: "all" });
  const [query, setQuery] = useState("");
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState<PaperSort>("recent");
  const [offset, setOffset] = useState(0);
  const [openPaper, setOpenPaper] = useState<Paper | null>(null);
  const currentPaper = useRef<Paper | null>(null);
  currentPaper.current = openPaper;
  const completedSync = useRef<string>();
  const openRequest = useRef(0);
  const inspectRequest = useRef(0);
  const [inspect, setInspect] = useState<InspectState | null>(null);
  const [navOpen, setNavOpen] = useState(false);
  const [importing, setImporting] = useState(false);
  const [importProgress, setImportProgress] = useState<string>();
  const [toast, setToast] = useState<string | null>(null);
  const [info, setInfo] = useState<AppInfo | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [editPaper, setEditPaper] = useState<Paper | null>(null);
  const [showFolders, setShowFolders] = useState(false);
  const [showTags, setShowTags] = useState(false);
  const [dragActive, setDragActive] = useState(false);
  const [organizeIds, setOrganizeIds] = useState<string[] | null>(null);
  const [showTasks, setShowTasks] = useState(false);
  const [zotero, setZotero] = useState<{ open: boolean; probe: any; busy: boolean; report: any; selected: string[]; copy: boolean; dataDir: string; linkedBase: string }>({
    open: false, probe: null, busy: false, report: null, selected: [], copy: true, dataDir: "", linkedBase: "",
  });

  const opts: PaperPageOptions = { query: search, sort, offset, limit: 100 };
  if (filter.kind === "trash") opts.trashed = true;
  if (filter.kind === "favorite") opts.favorite = true;
  if (filter.kind === "unread") opts.status = "unread";
  if (filter.kind === "category") opts.category = filter.id;
  if (filter.kind === "tag") opts.tag = filter.name;
  const pageQuery = useQuery({ queryKey: ["papers", opts], queryFn: () => api.paperPage(opts), enabled: !openPaper });
  const taxQuery = useQuery({ queryKey: ["taxonomy"], queryFn: api.taxonomy, staleTime: 300_000 });
  const syncQuery = useQuery({ queryKey: ["sync-status"], queryFn: api.syncStatus, refetchInterval: 5000, retry: false });
  const jobsQuery = useQuery({ queryKey: ["jobs"], queryFn: () => (api.listJobs ? api.listJobs() : Promise.resolve([])), refetchInterval: 5000, retry: false });
  const activeJobs = (jobsQuery.data || []).filter((job) => !["completed", "failed", "cancelled"].includes(job.status)).length;

  const refreshCloud = useCallback(() => {
    void client.invalidateQueries({ queryKey: ["papers"] });
    void client.invalidateQueries({ queryKey: ["taxonomy"] });
    const paper = currentPaper.current;
    if (paper) void api.getPaper(paper.id).then((fresh) => setOpenPaper((current) => current?.id === fresh.id ? fresh : current)).catch((error) => {
      if (String(error).includes("paper not found")) setOpenPaper((current) => current?.id === paper.id ? null : current);
    });
  }, [client]);
  useEffect(() => {
    const state = syncQuery.data;
    if (state?.id && !state.running && state.status === "completed" && completedSync.current !== state.id) { completedSync.current = state.id; refreshCloud(); }
  }, [syncQuery.data, refreshCloud]);
  const papers = pageQuery.data?.items || [];
  const taxonomy = taxQuery.data || { categories: [], tags: [] };
  useEffect(() => {
    if (pageQuery.data && offset >= pageQuery.data.total && offset > 0) setOffset(Math.max(0, Math.floor((pageQuery.data.total - 1) / 100) * 100));
  }, [pageQuery.data, offset]);
  const reload = async () => { await Promise.all([client.invalidateQueries({ queryKey: ["papers"] }), client.invalidateQueries({ queryKey: ["taxonomy"] })]); };

  useEffect(() => api.onEvent((event) => {
    if (event.event === "job" && "status" in event && ["completed", "failed", "cancelled"].includes(String(event.status))) refreshCloud();
    if (event.event === "import_progress" && "completed" in event) {
      setImportProgress(`${event.completed.toLocaleString()} / ${event.total.toLocaleString()}`);
      void client.invalidateQueries({ queryKey: ["papers"] });
    }
  }), [client, refreshCloud]);

  useEffect(() => { const timer = setTimeout(() => { setSearch(query); setOffset(0); }, 200); return () => clearTimeout(timer); }, [query]);
  useEffect(() => { api.appInfo().then(setInfo).catch(() => undefined); }, []);
  useEffect(() => { const timer = setTimeout(() => setToast(null), 3200); return () => clearTimeout(timer); }, [toast]);
  useEffect(() => {
    if (!navOpen) return;
    const key = (event: KeyboardEvent) => { if (event.key === "Escape") setNavOpen(false); };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [navOpen]);

  const changeFilter = (next: Filter) => { setFilter(next); setOffset(0); setOpenPaper(null); setNavOpen(false); };
  const title = filter.kind === "category" ? filter.name : filter.kind === "tag" ? `#${filter.name}` : filter.kind === "favorite" ? "星标" : filter.kind === "unread" ? "未读" : filter.kind === "trash" ? "回收站" : "论文库";

  const open = async (summary: PaperSummary | Paper) => {
    const request = ++openRequest.current;
    try {
      const paper = await api.getPaper(summary.id);
      if (request === openRequest.current) { setOpenPaper(paper); setInspect(null); setNavOpen(false); }
    } catch (e) { if (request === openRequest.current) setToast(`打开失败：${String(e)}`); }
  };

  const inspectPaper = async (summary: PaperSummary) => {
    const request = ++inspectRequest.current;
    setInspect({ summary, paper: null, loading: true });
    try {
      const paper = await api.getPaper(summary.id);
      if (request === inspectRequest.current) setInspect({ summary, paper, loading: false });
    } catch (e) {
      if (request === inspectRequest.current) setInspect({ summary, paper: null, loading: false, error: String((e as Error).message || e) });
    }
  };

  const fillImportedMetadata = (results: { status?: string; paper_id?: string }[]) => {
    if (typeof api.refreshMetadata !== "function") return;
    for (const paperId of results.filter((row) => row.status === "imported" && row.paper_id).slice(0, 20).map((row) => row.paper_id!)) {
      void api.refreshMetadata(paperId, false).catch(() => undefined);
    }
  };

  const doImport = async () => {
    setImporting(true); setImportProgress(undefined);
    try {
      const results = (await api.pickPdfs()) as { status: string; paper_id?: string; title?: string; error?: string }[];
      const imported = results.filter((result) => result.status === "imported").length;
      const dup = results.filter((result) => result.status === "duplicate").length;
      const failed = results.filter((result) => result.status === "failed");
      await reload();
      fillImportedMetadata(results);
      setToast(results.length === 0 ? "未选择文件" : `导入 ${imported} 篇${dup ? `，跳过重复 ${dup} 篇` : ""}${failed.length ? `，失败 ${failed.length} 篇` : ""}`);
    } catch (e) {
      setToast(`导入失败：${String((e as Error).message || e)}`);
    } finally {
      setImporting(false);
    }
  };

  const importDropped = async (fileList: FileList | null) => {
    const files = Array.from(fileList || []);
    if (!files.length) return;
    const paths = files.map((file) => {
      try { return window.moonlight?.getPathForFile?.(file) || (file as File & { path?: string }).path || ""; }
      catch { return ""; }
    }).filter((path) => path && /\.pdf$/i.test(path));
    if (!paths.length) { setToast("请拖入 PDF 文件"); return; }
    setImporting(true); setImportProgress(undefined);
    try {
      const results = (await api.importPaths(paths)) as { status: string; paper_id?: string }[];
      await reload();
      fillImportedMetadata(results);
      const imported = results.filter((row) => row.status === "imported").length;
      const duplicate = results.filter((row) => row.status === "duplicate").length;
      const failed = results.filter((row) => row.status === "failed").length;
      setToast(`拖入导入 ${imported} 篇${duplicate ? `，跳过重复 ${duplicate} 篇` : ""}${failed ? `，失败 ${failed} 篇` : ""}`);
    } catch (e) {
      setToast(`导入失败：${(e as Error).message}`);
    } finally {
      setImporting(false);
    }
  };

  const markMany = async (ids: string[], read_status: "read" | "unread") => {
    try {
      for (const id of ids) await api.updatePaper(id, { read_status });
      void client.invalidateQueries({ queryKey: ["papers"] });
      setToast(`已将 ${ids.length} 篇标记为${read_status === "read" ? "已读" : "未读"}`);
    } catch (e) { setToast(`批量更新失败：${(e as Error).message}`); }
  };
  const translateMany = async (ids: string[]) => {
    if (!confirm(`为所选 ${ids.length} 篇论文启动整篇翻译？任务会在后台依次排队。`)) return;
    let started = 0;
    try {
      for (const id of ids) { await api.startTranslate(id); started++; }
      void client.invalidateQueries({ queryKey: ["jobs"] });
      setToast(`已加入翻译队列：${started} 篇`);
    } catch (e) { setToast(`批量翻译失败（已加入 ${started} 篇）：${(e as Error).message}`); }
  };

  const updatePaper = (paper: Paper) => {
    void client.invalidateQueries({ queryKey: ["papers"] });
    setOpenPaper((current) => current && current.id === paper.id ? paper : current);
    setInspect((current) => current && current.summary.id === paper.id ? { ...current, paper, loading: false, error: undefined } : current);
  };

  const toggleFavorite = async (paper: PaperSummary) => { const updated = await api.updatePaper(paper.id, { favorite: !paper.favorite }); updatePaper(updated); };
  const cycleStatus = async (paper: PaperSummary) => {
    const next = paper.read_status === "unread" ? "reading" : paper.read_status === "reading" ? "read" : "unread";
    try { await api.updatePaper(paper.id, { read_status: next }); void client.invalidateQueries({ queryKey: ["papers"] }); }
    catch (e) { setToast(`更新阅读状态失败：${(e as Error).message}`); }
  };
  const trash = async (paper: PaperSummary) => { await api.trash(paper.id); setToast(`已移到回收站：${paper.title.slice(0, 40)}`); await reload(); };
  const restore = async (paper: PaperSummary) => { await api.restore(paper.id); await reload(); };
  const purge = async (paper: PaperSummary) => { if (!confirm(`永久删除《${paper.title}》？只删除本应用管理的文件。`)) return; await api.purge(paper.id); await reload(); };

  const exportPaper = async (paper: PaperSummary, format: "bibtex" | "ris") => {
    const { text } = await api.exportPapers([paper.id], format);
    const result = await api.saveText(`${paper.title.replace(/[\\/:*?"<>|]/g, "_").slice(0, 60)}.${format === "bibtex" ? "bib" : "ris"}`, text);
    if (result.saved) setToast(`已导出 ${format.toUpperCase()}`);
  };
  const exportMany = async (ids: string[], format: "bibtex" | "ris") => {
    try {
      const { text } = await api.exportPapers(ids, format);
      const result = await api.saveText(`论文库导出-${new Date().toISOString().slice(0, 10)}.${format === "bibtex" ? "bib" : "ris"}`, text);
      if (result.saved) setToast(`已导出 ${ids.length} 篇（${format.toUpperCase()}）`);
    } catch (e) { setToast(`导出失败：${(e as Error).message}`); }
  };

  const inspectZotero = async (dataDir?: string) => {
    setZotero((state) => ({ ...state, open: true, busy: true, report: null, selected: [] }));
    try {
      const probe = await api.zoteroProbe(dataDir);
      setZotero((state) => ({ ...state, probe, dataDir: probe.data_dir || dataDir || "", busy: false }));
    } catch (e) {
      setZotero((state) => ({ ...state, busy: false, probe: { found: false, error: String((e as Error).message || e) } }));
    }
  };
  const openZotero = () => inspectZotero();
  const chooseZoteroDirectory = async () => { const directory = await api.pickDirectory(); if (directory) await inspectZotero(directory); };
  const runZoteroImport = async () => {
    setZotero((state) => ({ ...state, busy: true, report: null }));
    try {
      const report = await api.zoteroImport({ data_dir: zotero.probe?.data_dir || undefined, collections: zotero.selected.length ? zotero.selected : undefined, copy_attachments: zotero.copy, linked_base_dir: zotero.linkedBase || undefined });
      setZotero((state) => ({ ...state, busy: false, report }));
      await reload();
    } catch (e) {
      setZotero((state) => ({ ...state, busy: false, report: { error: String((e as Error).message || e) } }));
    }
  };

  const navItems: { key: string; label: string; filter: Filter; icon: ReactNode }[] = [
    { key: "all", label: "全部论文", filter: { kind: "all" }, icon: <Circle size={15} /> },
    { key: "favorite", label: "星标", filter: { kind: "favorite" }, icon: <Star size={15} /> },
    { key: "unread", label: "未读", filter: { kind: "unread" }, icon: <MailOpen size={15} /> },
    { key: "trash", label: "回收站", filter: { kind: "trash" }, icon: <Trash2 size={15} /> },
  ];

  return (
    <div className={`app ${openPaper ? "is-reading" : ""} ${dragActive ? "dragging" : ""}`}
      onDragOver={(event) => { event.preventDefault(); if (event.dataTransfer?.types?.includes("Files")) setDragActive(true); }}
      onDragLeave={(event) => { if (event.currentTarget === event.target) setDragActive(false); }}
      onDrop={(event) => { event.preventDefault(); setDragActive(false); void importDropped(event.dataTransfer?.files ?? null); }}>
      <aside className={`sidebar ${openPaper ? "reader-mode" : ""} ${navOpen ? "open" : ""}`} aria-label="论文库导航">
        <div className="brand">
          <span className="brand-mark"><Moon size={22} /></span>
          <div>
            <div className="brand-name">Moonlight</div>
            <div className="brand-sub">论文库 · 原位翻译</div>
          </div>
        </div>
        <nav>
          {navItems.map((item) => (
            <button key={item.key} className={`nav-item ${sameFilter(item.filter, filter) && !openPaper ? "on" : ""}`} onClick={() => changeFilter(item.filter)}>
              <span className="nav-label">{item.icon}{item.label}</span>
              {item.key === "all" && filter.kind === "all" && !search && <span className="nav-count">{pageQuery.data?.total ?? "…"}</span>}
            </button>
          ))}
        </nav>
        <div className="nav-section">
          <div className="nav-title folder-heading"><span>目录</span><button className="btn tiny ghost" onClick={() => setShowFolders(true)}>新建 / 管理</button></div>
          <FolderTreeView items={taxonomy.categories} selected={filter.kind === "category" ? filter.id : undefined} onSelect={(id, name) => changeFilter({ kind: "category", id, name })} />
        </div>
        <div className="nav-section">
          <div className="nav-title folder-heading"><span>标签</span><button className="btn tiny ghost" onClick={() => setShowTags(true)}>管理</button></div>
          {taxonomy.tags.length > 0 && <TaxonomyList items={taxonomy.tags} label="论文标签" selected={filter.kind === "tag" ? taxonomy.tags.find((tag) => tag.name === filter.name)?.id : undefined} onSelect={(_id, name) => changeFilter({ kind: "tag", name })} />}
        </div>
        <div className="sidebar-foot">
          <button className="nav-item small" onClick={() => setShowTasks(true)}>
            <span className="nav-label"><ListChecks size={15} />任务中心</span>
            {activeJobs > 0 && <span className="badge">{activeJobs}</span>}
          </button>
          <button className="nav-item small" onClick={() => setShowSettings(true)}>
            <span className="nav-label"><Settings size={15} />设置与状态</span>
          </button>
        </div>
      </aside>
      {openPaper && navOpen && <div className="drawer-backdrop" onClick={() => setNavOpen(false)} />}

      <main className="main">
        {openPaper ? (
          <Suspense fallback={<div className="reader loading">正在载入阅读器…</div>}>
            <Reader key={openPaper.id} paper={openPaper} onBack={() => { setOpenPaper(null); void reload(); }} onChanged={updatePaper} onToast={setToast} onToggleNav={() => setNavOpen((value) => !value)} />
          </Suspense>
        ) : (
          <div className="main-content">
            <Library
              papers={papers} total={pageQuery.data?.total ?? 0} loading={pageQuery.isFetching} error={pageQuery.error?.message}
              sort={sort} onSort={(next) => { setSort(next); setOffset(0); }} offset={offset} pageSize={100} onOffset={setOffset}
              query={query} onQuery={setQuery} title={title}
              onOpen={open} onInspect={inspectPaper} inspectedId={inspect?.summary.id}
              onImport={doImport} onZotero={openZotero}
              onToggleFavorite={toggleFavorite} onTrash={trash} onRestore={restore} onPurge={purge}
              onExport={exportPaper} onBulkExport={exportMany}
              onEdit={(paper) => { void api.getPaper(paper.id).then(setEditPaper).catch((e) => setToast(e.message)); }}
              onOrganize={(ids) => setOrganizeIds(ids)}
              onShortNote={async (paper, text) => { await api.setShortNote(paper.id, text, paper.updated_at); await reload(); }}
              onRefreshCitations={async (id, force) => { const result = await api.refreshCitations(id, force); await client.invalidateQueries({ queryKey: ["papers"] }); return result.cached; }}
              onTag={(name) => changeFilter({ kind: "tag", name })}
              onCycleStatus={cycleStatus}
              onMarkMany={markMany}
              onTranslateMany={translateMany}
              onImported={(message) => { setToast(message); void reload(); }}
              importing={importing} importProgress={importProgress}
            />
            {inspect && <Inspector paper={inspect.paper} loading={inspect.loading} error={inspect.error} onClose={() => { inspectRequest.current++; setInspect(null); }} onOpen={(paper) => void open(paper)} onSaved={updatePaper} onToast={setToast} />}
          </div>
        )}
      </main>

      {showTasks && <TaskCenter onClose={() => setShowTasks(false)} onOpen={(id) => { void api.getPaper(id).then((paper) => { setOpenPaper(paper); setShowTasks(false); }).catch((e) => setToast(e.message)); }} />}
      {showFolders && <FolderManager items={taxonomy.categories} onChanged={reload} onClose={() => setShowFolders(false)} />}
      {showTags && <TagManager tags={taxonomy.tags} onChanged={reload} onClose={() => setShowTags(false)} />}
      {organizeIds && <OrganizePapers ids={organizeIds} categories={taxonomy.categories} tags={taxonomy.tags} onSaved={reload} onClose={() => setOrganizeIds(null)} />}
      {editPaper && <PaperEditor paper={editPaper} onClose={() => setEditPaper(null)} onSaved={(paper) => { setEditPaper(null); updatePaper(paper); void reload(); }} />}
      {dragActive && <div className="drop-overlay" aria-hidden="true"><div className="drop-card"><UploadCloud size={34} /><strong>松开即可导入 PDF</strong><span className="muted small">支持一次拖入多篇；重复文件会自动跳过</span></div></div>}
      {toast && <div className="toast">{toast}</div>}

      {zotero.open && (
        <div className="modal-backdrop" onClick={() => setZotero((state) => ({ ...state, open: false }))}>
          <div className="modal zotero-modal" onClick={(event) => event.stopPropagation()}>
            <header className="modal-head">
              <div><h2>从 Zotero 导入</h2><p className="muted small">迁入论文、分类、标签、笔记和附件，由本地论文库管理。原 Zotero 数据保留。</p></div>
              <button className="icon-btn" aria-label="关闭 Zotero 导入" onClick={() => setZotero((state) => ({ ...state, open: false }))}>×</button>
            </header>
            <label>数据目录<input aria-label="Zotero 数据目录" value={zotero.dataDir} disabled={zotero.busy} onChange={(event) => setZotero((state) => ({ ...state, dataDir: event.target.value, probe: null }))} /></label>
            <div className="row-actions">
              <button className="btn" disabled={zotero.busy} onClick={chooseZoteroDirectory}>选择 Zotero 目录</button>
              <button className="btn" disabled={zotero.busy || !zotero.dataDir} onClick={() => inspectZotero(zotero.dataDir)}>读取目录</button>
            </div>
            {zotero.busy && <p className="muted">正在读取 Zotero 数据…</p>}
            {!zotero.busy && zotero.probe && !zotero.probe.found && <div className="error-box">未找到 Zotero 数据目录。{zotero.probe.error || "请选择包含 zotero.sqlite 的目录。"}</div>}
            {!zotero.busy && zotero.probe?.found && (
              <>
                <dl>
                  <dt>数据源</dt><dd>{zotero.probe.source === "sqlite" ? "本地数据库（只读快照）" : "Zotero 本地 API"}</dd>
                  <dt>目录</dt><dd className="mono small">{zotero.probe.data_dir}</dd>
                  <dt>条目</dt><dd>{zotero.probe.items} 条 · {zotero.probe.collections?.length || 0} 个分类</dd>
                </dl>
                {zotero.probe.collections?.length > 0 && (
                  <div className="zotero-collections">
                    <div className="nav-title">选择分类，包含子分类（不选=全部）</div>
                    <ZoteroCollections items={zotero.probe.collections} selected={zotero.selected} onChange={(selected) => setZotero((state) => ({ ...state, selected }))} />
                  </div>
                )}
                <label className="zotero-collection">
                  <input type="checkbox" checked={zotero.copy} onChange={(event) => setZotero((state) => ({ ...state, copy: event.target.checked }))} />
                  <span>复制所有本地附件（PDF、网页快照等），迁移后可独立使用</span>
                </label>
                <label>外链附件基础目录（可选）<input aria-label="外链附件基础目录" value={zotero.linkedBase} onChange={(event) => setZotero((state) => ({ ...state, linkedBase: event.target.value }))} /></label>
                <button className="btn tiny" disabled={zotero.busy} onClick={async () => { const directory = await api.pickDirectory(); if (directory) setZotero((state) => ({ ...state, linkedBase: directory })); }}>选择外链目录</button>
                {zotero.report && (
                  <div className={zotero.report.error ? "error-box" : "report-box"}>
                    {zotero.report.error ? zotero.report.error : <>
                      <p>新增 {zotero.report.imported} 条，已有关联 {zotero.report.updated} 条，合并重复 {zotero.report.duplicates} 条；附件 {zotero.report.attachments} 个，批注 {zotero.report.annotations} 条。</p>
                      <p>无 PDF 条目 {zotero.report.without_pdf} 条，缺失附件 {zotero.report.missing_attachments?.length || 0} 个，失败 {zotero.report.errors?.length || 0} 条，兼容提示 {zotero.report.warnings?.length || 0} 条。</p>
                      {(zotero.report.missing_attachments || []).slice(0, 10).map((file: any) => <p key={`${file.item}:${file.attachment}`} className="small">{file.path || file.attachment}：{file.reason === "linked_base_directory_required" ? "需指定外链基础目录" : "本机缺少文件，可下载后再次迁移补齐"}</p>)}
                      {(zotero.report.errors || []).slice(0, 10).map((error: any) => <p key={`${error.library}:${error.item}`} role="alert">{error.item}：{error.error}</p>)}
                      <button className="btn tiny" onClick={() => api.saveText("zotero-migration-report.json", JSON.stringify(zotero.report, null, 2))}>保存完整迁移报告</button>
                    </>}
                  </div>
                )}
                <div className="modal-actions">
                  <button className="btn" onClick={() => setZotero((state) => ({ ...state, open: false }))}>关闭</button>
                  <button className="btn primary" onClick={runZoteroImport} disabled={zotero.busy}>开始导入</button>
                </div>
              </>
            )}
            {(!zotero.probe?.found || zotero.busy) && <button className="btn" onClick={() => setZotero((state) => ({ ...state, open: false }))}>关闭</button>}
          </div>
        </div>
      )}

      {showSettings && <SettingsModal info={info} onClose={() => setShowSettings(false)} onChanged={refreshCloud} onOpenPaper={(paper) => { setShowSettings(false); void open(paper); }} />}
    </div>
  );
}

function sameFilter(a: Filter, b: Filter) {
  return JSON.stringify(a) === JSON.stringify(b);
}
