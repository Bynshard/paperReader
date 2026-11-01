import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import Library from "./Library";
import TaxonomyList from "./TaxonomyList";
import ZoteroCollections from "./ZoteroCollections";
import CloudSync from './CloudSync';
import AiSettings from './AiSettings';
import PaperEditor from './PaperEditor';
import TaskCenter from './TaskCenter';
import BackupSettings from './BackupSettings';
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

export default function App() {
  const client = useQueryClient();
  const [filter, setFilter] = useState<Filter>({ kind: "all" });
  const [query, setQuery] = useState("");
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState<PaperSort>("recent");
  const [offset, setOffset] = useState(0);
  const [openPaper, setOpenPaper] = useState<Paper | null>(null);
  const currentPaper=useRef<Paper|null>(null);currentPaper.current=openPaper;
  const completedSync=useRef<string>();
  const openRequest = useRef(0);
  const [importing, setImporting] = useState(false);
  const [importProgress, setImportProgress] = useState<string>();
  const [toast, setToast] = useState<string | null>(null);
  const [info, setInfo] = useState<AppInfo | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [editPaper,setEditPaper]=useState<Paper|null>(null);
  const [showTasks,setShowTasks]=useState(false);
  const [zotero, setZotero] = useState<{ open: boolean; probe: any; busy: boolean; report: any; selected: string[]; copy: boolean; dataDir:string; linkedBase:string }>({
    open: false,
    probe: null,
    busy: false,
    report: null,
    selected: [],
    copy: true,
    dataDir:'',linkedBase:'',
  });

  const opts: PaperPageOptions = { query: search, sort, offset, limit: 100 };
  if (filter.kind === "trash") opts.trashed = true;
  if (filter.kind === "favorite") opts.favorite = true;
  if (filter.kind === "unread") opts.status = "unread";
  if (filter.kind === "category") opts.category = filter.id;
  if (filter.kind === "tag") opts.tag = filter.name;
  const pageQuery = useQuery({ queryKey: ["papers", opts], queryFn: () => api.paperPage(opts), enabled: !openPaper });
  const taxQuery = useQuery({ queryKey: ["taxonomy"], queryFn: api.taxonomy, staleTime: 300_000 });
  const syncQuery = useQuery({queryKey:['sync-status'],queryFn:api.syncStatus,refetchInterval:5000,retry:false});
  const refreshCloud = useCallback(()=>{
    void client.invalidateQueries({queryKey:['papers']});void client.invalidateQueries({queryKey:['taxonomy']});
    const paper=currentPaper.current;
    if(paper) void api.getPaper(paper.id).then((fresh)=>setOpenPaper((current)=>current?.id===fresh.id?fresh:current)).catch((error)=>{
      if(String(error).includes('paper not found')) setOpenPaper((current)=>current?.id===paper.id?null:current);
    });
  },[client]);
  useEffect(()=>{
    const state=syncQuery.data;
    if(state?.id && !state.running && state.status==='completed' && completedSync.current!==state.id){completedSync.current=state.id;refreshCloud();}
  },[syncQuery.data,refreshCloud]);
  const papers = pageQuery.data?.items || [];
  const taxonomy = taxQuery.data || { categories: [], tags: [] };
  useEffect(() => {
    if (pageQuery.data && offset >= pageQuery.data.total && offset > 0) {
      setOffset(Math.max(0, Math.floor((pageQuery.data.total - 1) / 100) * 100));
    }
  }, [pageQuery.data, offset]);
  const reload = async () => {
    await Promise.all([client.invalidateQueries({ queryKey: ["papers"] }), client.invalidateQueries({ queryKey: ["taxonomy"] })]);
  };

  useEffect(() => api.onEvent((event) => {
    if(event.event==='job'&&'status'in event&&['completed','failed','cancelled'].includes(String(event.status)))refreshCloud();
    if (event.event === 'import_progress' && 'completed' in event) {
      setImportProgress(`${event.completed.toLocaleString()} / ${event.total.toLocaleString()}`);
      void client.invalidateQueries({queryKey:['papers']});
    }
  }), [client,refreshCloud]);

  useEffect(() => {
    const timer = setTimeout(() => { setSearch(query); setOffset(0); }, 200);
    return () => clearTimeout(timer);
  }, [query]);

  useEffect(() => {
    api.appInfo().then(setInfo).catch(() => undefined);
    const t = setTimeout(() => setToast(null), 3200);
    return () => clearTimeout(t);
  }, [toast]);

  const changeFilter = (next: Filter) => { setFilter(next); setOffset(0); };
  const open = async (p: PaperSummary) => {
    const request = ++openRequest.current;
    try {
      const paper = await api.getPaper(p.id);
      if (request === openRequest.current) setOpenPaper(paper);
    } catch (e) { if (request === openRequest.current) setToast(`打开失败：${String(e)}`); }
  };

  const doImport = async () => {
    setImporting(true);
    setImportProgress(undefined);
    try {
      const results = (await api.pickPdfs()) as { status: string; title?: string; error?: string }[];
      const imported = results.filter((r) => r.status === "imported").length;
      const dup = results.filter((r) => r.status === "duplicate").length;
      const failed = results.filter((r) => r.status === "failed");
      await reload();
      setToast(
        results.length === 0
          ? "未选择文件"
          : `导入 ${imported} 篇${dup ? `，跳过重复 ${dup} 篇` : ""}${failed.length ? `，失败 ${failed.length} 篇` : ""}`,
      );
    } catch (e) {
      setToast(`导入失败：${String((e as Error).message || e)}`);
    } finally {
      setImporting(false);
    }
  };

  const updatePaper = (p: Paper) => {
    void client.invalidateQueries({ queryKey: ["papers"] });
    setOpenPaper((cur) => (cur && cur.id === p.id ? p : cur));
  };

  const toggleFavorite = async (p: PaperSummary) => {
    const updated = await api.updatePaper(p.id, { favorite: !p.favorite });
    updatePaper(updated);
  };

  const trash = async (p: PaperSummary) => {
    await api.trash(p.id);
    setToast(`已移到回收站：${p.title.slice(0, 40)}`);
    await reload();
  };

  const restore = async (p: PaperSummary) => {
    await api.restore(p.id);
    await reload();
  };

  const purge = async (p: PaperSummary) => {
    if (!confirm(`永久删除《${p.title}》？只删除本应用管理的文件。`)) return;
    await api.purge(p.id);
    await reload();
  };

  const exportPaper = async (p: PaperSummary, fmt: "bibtex" | "ris") => {
    const { text } = await api.exportPapers([p.id], fmt);
    const res = await api.saveText(`${p.title.replace(/[\\/:*?"<>|]/g, "_").slice(0, 60)}.${fmt === "bibtex" ? "bib" : "ris"}`, text);
    if (res.saved) setToast(`已导出 ${fmt.toUpperCase()}`);
  };

  const inspectZotero = async (dataDir?:string) => {
    setZotero((z) => ({ ...z, open: true, busy: true, report: null,selected:[] }));
    try {
      const probe = await api.zoteroProbe(dataDir);
      setZotero((z) => ({ ...z, probe, dataDir:probe.data_dir || dataDir || '', busy: false }));
    } catch (e) {
      setZotero((z) => ({ ...z, busy: false, probe: { found: false, error: String((e as Error).message || e) } }));
    }
  };
  const openZotero = () => inspectZotero();
  const chooseZoteroDirectory = async () => {
    const directory=await api.pickDirectory();
    if(directory) await inspectZotero(directory);
  };

  const runZoteroImport = async () => {
    setZotero((z) => ({ ...z, busy: true, report: null }));
    try {
      const report = await api.zoteroImport({
        data_dir: zotero.probe?.data_dir || undefined,
        collections: zotero.selected.length ? zotero.selected : undefined,
        copy_attachments: zotero.copy,
        linked_base_dir:zotero.linkedBase || undefined,
      });
      setZotero((z) => ({ ...z, busy: false, report }));
      await reload();
    } catch (e) {
      setZotero((z) => ({ ...z, busy: false, report: { error: String((e as Error).message || e) } }));
    }
  };

  const navItems: { key: string; label: string; filter: Filter; count?: number }[] = [
    { key: "all", label: "全部论文", filter: { kind: "all" } },
    { key: "favorite", label: "星标", filter: { kind: "favorite" } },
    { key: "unread", label: "未读", filter: { kind: "unread" } },
    { key: "trash", label: "回收站", filter: { kind: "trash" } },
  ];

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-mark">◐</span>
          <div>
            <div className="brand-name">Moonlight</div>
            <div className="brand-sub">论文库 · 原位翻译</div>
          </div>
        </div>
        <nav>
          {navItems.map((n) => (
            <button key={n.key} className={`nav-item ${sameFilter(n.filter, filter) ? "on" : ""}`} onClick={() => changeFilter(n.filter)}>
              <span>{n.label}</span>
              {n.key === "all" && filter.kind === "all" && !search && <span className="nav-count">{pageQuery.data?.total ?? "…"}</span>}
            </button>
          ))}
        </nav>
        <div className="nav-section">
          <div className="nav-title">分类</div>
          <TaxonomyList items={taxonomy.categories} label="论文分类"
            selected={filter.kind === "category" ? filter.id : undefined}
            onSelect={(id,name)=>changeFilter({kind:"category",id,name})} />
        </div>
        {taxonomy.tags.length > 0 && (
          <div className="nav-section">
            <div className="nav-title">标签</div>
            <TaxonomyList items={taxonomy.tags} label="论文标签"
              selected={filter.kind === "tag" ? taxonomy.tags.find((t)=>t.name===filter.name)?.id : undefined}
              onSelect={(_id,name)=>changeFilter({kind:"tag",name})} />
          </div>
        )}
        <div className="sidebar-foot">
          <button className="nav-item small" onClick={() => setShowSettings(true)}>
            设置与状态
          </button>
        </div>
      </aside>

      <main className="main">
        {openPaper ? (
          <Suspense fallback={<div className="reader loading">正在载入阅读器…</div>}><Reader
            key={openPaper.id}
            paper={openPaper}
            onBack={() => {
              setOpenPaper(null);
              reload();
            }}
            onChanged={updatePaper}
            onToast={setToast}
          /></Suspense>
        ) : (
          <Library
            papers={papers}
            total={pageQuery.data?.total ?? 0}
            loading={pageQuery.isFetching}
            error={pageQuery.error?.message}
            sort={sort}
            onSort={(next) => { setSort(next); setOffset(0); }}
            offset={offset}
            pageSize={100}
            onOffset={setOffset}
            query={query}
            onQuery={setQuery}
            onOpen={open}
            onImport={doImport}
            onToggleFavorite={toggleFavorite}
            onTrash={trash}
            onRestore={restore}
            onPurge={purge}
            onExport={exportPaper}
            onEdit={p=>{void api.getPaper(p.id).then(setEditPaper).catch(e=>setToast(e.message));}}
            onZotero={openZotero}
            importing={importing}
            importProgress={importProgress}
          />
        )}
      </main>

      <button className="btn task-center-button" onClick={()=>setShowTasks(true)}>任务中心</button>
      {showTasks&&<TaskCenter onClose={()=>setShowTasks(false)} onOpen={id=>{void api.getPaper(id).then(p=>{setOpenPaper(p);setShowTasks(false);}).catch(e=>setToast(e.message));}}/>}
      {editPaper&&<PaperEditor paper={editPaper} onClose={()=>setEditPaper(null)} onSaved={p=>{setEditPaper(null);updatePaper(p);void reload();}}/>}
      {toast && <div className="toast">{toast}</div>}

      {zotero.open && (
        <div className="modal-backdrop" onClick={() => setZotero((z) => ({ ...z, open: false }))}>
          <div className="modal zotero-modal" onClick={(e) => e.stopPropagation()}>
            <h2>从 Zotero 导入</h2>
            <p className="muted">迁入论文、分类、标签、笔记和附件，由本地论文库管理。原 Zotero 数据保留。</p>
            <label>数据目录<input aria-label="Zotero 数据目录" value={zotero.dataDir} disabled={zotero.busy} onChange={(e)=>setZotero((z)=>({...z,dataDir:e.target.value,probe:null}))}/></label>
            <div className="row-actions">
              <button className="btn" disabled={zotero.busy} onClick={chooseZoteroDirectory}>选择 Zotero 目录</button>
              <button className="btn" disabled={zotero.busy || !zotero.dataDir} onClick={()=>inspectZotero(zotero.dataDir)}>读取目录</button>
            </div>
            {zotero.busy && <p className="muted">正在读取 Zotero 数据…</p>}
            {!zotero.busy && zotero.probe && !zotero.probe.found && (
              <div className="error-box">
                未找到 Zotero 数据目录。{zotero.probe.error || "请选择包含 zotero.sqlite 的目录。"}
              </div>
            )}
            {!zotero.busy && zotero.probe?.found && (
              <>
                <dl>
                  <dt>数据源</dt>
                  <dd>{zotero.probe.source === "sqlite" ? "本地数据库（只读快照）" : "Zotero 本地 API"}</dd>
                  <dt>目录</dt>
                  <dd className="mono small">{zotero.probe.data_dir}</dd>
                  <dt>条目</dt>
                  <dd>
                    {zotero.probe.items} 条 · {zotero.probe.collections?.length || 0} 个分类
                  </dd>
                </dl>
                {zotero.probe.collections?.length > 0 && (
                  <div className="zotero-collections">
                    <div className="nav-title">选择分类，包含子分类（不选=全部）</div>
                    <ZoteroCollections items={zotero.probe.collections} selected={zotero.selected}
                      onChange={(selected)=>setZotero((z)=>({...z,selected}))}/>
                  </div>
                )}
                <label className="zotero-collection">
                  <input type="checkbox" checked={zotero.copy} onChange={(e) => setZotero((z) => ({ ...z, copy: e.target.checked }))} />
                  <span>复制所有本地附件（PDF、网页快照等），迁移后可独立使用</span>
                </label>
                <label>外链附件基础目录（可选）<input aria-label="外链附件基础目录" value={zotero.linkedBase} onChange={(e)=>setZotero((z)=>({...z,linkedBase:e.target.value}))}/></label>
                <button className="btn tiny" disabled={zotero.busy} onClick={async()=>{const directory=await api.pickDirectory();if(directory)setZotero((z)=>({...z,linkedBase:directory}));}}>选择外链目录</button>
                {zotero.report && (
                  <div className={zotero.report.error ? "error-box" : "report-box"}>
                    {zotero.report.error
                      ? zotero.report.error
                      : <>
                        <p>新增 {zotero.report.imported} 条，已有关联 {zotero.report.updated} 条，合并重复 {zotero.report.duplicates} 条；附件 {zotero.report.attachments} 个，批注 {zotero.report.annotations} 条。</p>
                        <p>无 PDF 条目 {zotero.report.without_pdf} 条，缺失附件 {zotero.report.missing_attachments?.length || 0} 个，失败 {zotero.report.errors?.length || 0} 条，兼容提示 {zotero.report.warnings?.length || 0} 条。</p>
                        {(zotero.report.missing_attachments || []).slice(0,10).map((f:any)=><p key={`${f.item}:${f.attachment}`} className="small">{f.path || f.attachment}：{f.reason==='linked_base_directory_required'?'需指定外链基础目录':'本机缺少文件，可下载后再次迁移补齐'}</p>)}
                        {(zotero.report.errors || []).slice(0,10).map((e:any)=><p key={`${e.library}:${e.item}`} role="alert">{e.item}：{e.error}</p>)}
                        <button className="btn tiny" onClick={()=>api.saveText('zotero-migration-report.json',JSON.stringify(zotero.report,null,2))}>保存完整迁移报告</button>
                      </>}
                  </div>
                )}
                <div className="modal-actions">
                  <button className="btn" onClick={() => setZotero((z) => ({ ...z, open: false }))}>
                    关闭
                  </button>
                  <button className="btn primary" onClick={runZoteroImport} disabled={zotero.busy}>
                    开始导入
                  </button>
                </div>
              </>
            )}
            {(!zotero.probe?.found || zotero.busy) && <button className="btn" onClick={()=>setZotero((z)=>({...z,open:false}))}>关闭</button>}
          </div>
        </div>
      )}

      {showSettings && (
        <div className="modal-backdrop" onClick={() => setShowSettings(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h2>设置与状态</h2>
            <dl>
              <dt>版本</dt>
              <dd>{info?.version}</dd>
              <dt>论文库目录</dt>
              <dd className="mono small">{info?.library}</dd>
              <dt>PDF 翻译模型</dt>
              <dd>{info?.model}</dd>
              <dt>凭据</dt>
              <dd>{info?.credentialConfigured ? "已配置（仅主进程/服务进程可见）" : "未配置 API：可在下方登录 Codex 使用论文问答"}</dd>
              <dt>离线能力</dt>
              <dd>导入、分类、检索、原文阅读、批注与导出不依赖网络</dd>
            </dl>
            <BackupSettings/>
            <AiSettings/>
            <CloudSync onChanged={refreshCloud}/>
            <div className="modal-actions">
              <button className="btn" onClick={() => setShowSettings(false)}>
                关闭
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function sameFilter(a: Filter, b: Filter) {
  return JSON.stringify(a) === JSON.stringify(b);
}
