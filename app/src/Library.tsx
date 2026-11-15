import { useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { ChevronDown, Columns3, FileDown, Inbox, LayoutGrid, MoreHorizontal, Search, Star, Table2, Trash2, Upload, X } from "lucide-react";
import PaperTable, { COLUMN_LABELS, DEFAULT_COLUMN_VISIBILITY, HIDEABLE_COLUMNS, type PaperTableActions } from "./PaperTable";
import type { ColumnSizingState, VisibilityState } from "@tanstack/react-table";
import FloatingLayer from "./FloatingLayer";
import { PaperMenuItems, type PaperMenuActions } from "./PaperMenu";
import IdentifierImport from "./IdentifierImport";
import type { PaperSort, PaperSummary } from "./types";

type Props = {
  papers: PaperSummary[];
  total: number; loading: boolean; error?: string;
  sort: PaperSort; onSort: (sort: PaperSort) => void;
  offset: number; pageSize: number; onOffset: (offset: number) => void;
  query: string; onQuery: (q: string) => void;
  title?: string;
  onOpen: (p: PaperSummary) => void;
  onInspect?: (p: PaperSummary) => void;
  inspectedId?: string;
  onImport: () => void;
  onZotero: () => void;
  onToggleFavorite: (p: PaperSummary) => void;
  onTrash: (p: PaperSummary) => void;
  onRestore: (p: PaperSummary) => void;
  onPurge: (p: PaperSummary) => void;
  onExport: (p: PaperSummary, fmt: "bibtex" | "ris") => void;
  onBulkExport?: (ids: string[], fmt: "bibtex" | "ris") => void;
  onEdit?: (p: PaperSummary) => void;
  onOrganize?: (ids: string[]) => void;
  onShortNote?: (paper: PaperSummary, text: string) => Promise<void>;
  onRefreshCitations?: (id: string, force?: boolean) => Promise<boolean>;
  onTag?: (name: string) => void;
  onCycleStatus: (p: PaperSummary) => void;
  onMarkMany?: (ids: string[], status: "read" | "unread") => void;
  onTranslateMany?: (ids: string[]) => void;
  onImported?: (message: string) => void;
  importing: boolean;
  importProgress?: string;
};

const columnsKey = "moonlight-library-columns-v1";
function initialPrefs(): { visibility: VisibilityState; sizing: ColumnSizingState; view: string } {
  try {
    const saved = JSON.parse(localStorage.getItem(columnsKey) || "{}");
    const visibility = { ...DEFAULT_COLUMN_VISIBILITY, ...Object.fromEntries(Object.entries(saved.visibility || {}).filter(([, value]) => typeof value === "boolean")) } as VisibilityState;
    const sizing = Object.fromEntries(Object.entries(saved.sizing || {}).filter(([, value]) => typeof value === "number" && Number.isFinite(value) && value >= 28 && value <= 800)) as ColumnSizingState;
    return { visibility, sizing, view: ["overview", "reading", "citations", "custom"].includes(saved.view) ? saved.view : "overview" };
  } catch {
    return { visibility: DEFAULT_COLUMN_VISIBILITY, sizing: {}, view: "overview" };
  }
}

const PRESETS: Record<string, Record<string, boolean>> = {
  overview: { categories: false },
  reading: { categories: false, citations: false },
  citations: { categories: false, short_note: false, status: false },
};

export default function Library(props: Props) {
  const { papers, total, loading, error, sort, onSort, offset, pageSize, onOffset, query, onQuery, onOpen, onInspect, inspectedId, onImport, onZotero, onToggleFavorite, onTrash, onRestore, onPurge, onExport, onBulkExport, onEdit, onOrganize, onShortNote, onRefreshCitations, onTag, onCycleStatus, onMarkMany, onTranslateMany, importing, importProgress } = props;
  const [view, setView] = useState<"table" | "cards">(() => { try { return localStorage.getItem("moonlight-library-view-v1") === "cards" ? "cards" : "table"; } catch { return "table"; } });
  useEffect(() => { try { localStorage.setItem("moonlight-library-view-v1", view); } catch { /* ignore */ } }, [view]);
  const initial = useMemo(initialPrefs, []);
  const [visibility, setVisibility] = useState(initial.visibility);
  const [sizing, setSizing] = useState(initial.sizing);
  const [presetName, setPresetName] = useState(initial.view);
  useEffect(() => { try { localStorage.setItem(columnsKey, JSON.stringify({ visibility, sizing, view: presetName })); } catch { /* ignore */ } }, [visibility, sizing, presetName]);

  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [quick, setQuick] = useState<{ id: string; text: string; updatedAt: number } | null>(null);
  const [noteBusy, setNoteBusy] = useState(false);
  const [noteError, setNoteError] = useState("");
  const [refreshing, setRefreshing] = useState(false);
  const [citationMessage, setCitationMessage] = useState("");
  const [menu, setMenu] = useState<{ paper: PaperSummary; x: number; y: number } | null>(null);
  const menuTrigger = useRef<HTMLElement | null>(null);
  const inspectTimer = useRef<ReturnType<typeof setTimeout>>();
  useEffect(() => () => clearTimeout(inspectTimer.current), []);
  const previewLater = (paper: PaperSummary) => {
    clearTimeout(inspectTimer.current);
    inspectTimer.current = setTimeout(() => onInspect?.(paper), 180);
  };
  const [importMenu, setImportMenu] = useState<{ x: number; y: number } | null>(null);
  const [identifierOpen, setIdentifierOpen] = useState(false);
  const [columnsMenu, setColumnsMenu] = useState<{ x: number; y: number } | null>(null);
  const importButton = useRef<HTMLButtonElement>(null);
  const columnsButton = useRef<HTMLButtonElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const stop = useRef(false);
  const alive = useRef(true);

  useEffect(() => { alive.current = true; return () => { alive.current = false; stop.current = true; }; }, []);
  useEffect(() => { const present = new Set(papers.filter((paper) => !paper.deleted).map((paper) => paper.id)); setSelected((old) => new Set([...old].filter((id) => present.has(id)))); }, [papers]);

  const refresh = async (ids: string[], force = false) => {
    if (refreshing || !onRefreshCitations) return;
    setRefreshing(true); stop.current = false;
    let success = 0, failed = 0, cached = 0, lastError = "";
    for (const id of ids) {
      if (stop.current) break;
      setCitationMessage(`更新引用量 ${success + failed + 1}/${ids.length}`);
      try { const hit = await onRefreshCitations(id, force); success++; if (hit) cached++; } catch (e) { failed++; lastError = (e as Error).message; }
    }
    if (alive.current) { setRefreshing(false); setCitationMessage(`${stop.current ? "已停止：" : ""}${success} 篇成功（${cached} 篇使用近期缓存），${failed} 篇失败${lastError ? `：${lastError}` : ""}`); }
  };
  const saveNote = async (paper: PaperSummary) => {
    if (!quick || !onShortNote) return;
    setNoteBusy(true); setNoteError("");
    try { await onShortNote({ ...paper, updated_at: quick.updatedAt }, quick.text); setQuick(null); }
    catch (e) { setNoteError((e as Error).message); }
    finally { setNoteBusy(false); }
  };

  const scrollRef = useRef<HTMLDivElement>(null);
  const virtual = useVirtualizer({ count: papers.length, getScrollElement: () => scrollRef.current, estimateSize: () => 130, getItemKey: (index) => papers[index].id, overscan: 4 });
  useEffect(() => { scrollRef.current?.scrollTo({ top: 0 }); setQuick(null); setSelected(new Set()); setMenu(null); }, [offset, sort, query]);

  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const typing = target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.tagName === "SELECT" || target.isContentEditable);
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") { event.preventDefault(); search.current?.focus(); search.current?.select(); return; }
      if (event.key === "/" && !typing) { event.preventDefault(); search.current?.focus(); }
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, []);

  const openMenu = (event: ReactMouseEvent, paper: PaperSummary) => {
    event.stopPropagation();
    menuTrigger.current = event.currentTarget as HTMLElement;
    const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
    setMenu((open) => open?.paper.id === paper.id ? null : { paper, x: rect.left + rect.width / 2, y: rect.bottom });
  };
  const anchorOf = (element: HTMLElement | null) => { const rect = element?.getBoundingClientRect(); return rect ? { x: rect.left + rect.width / 2, y: rect.bottom } : { x: 12, y: 60 }; };

  const toggleAll = (checked: boolean) => setSelected(checked ? new Set(papers.filter((paper) => !paper.deleted).map((paper) => paper.id)) : new Set());
  const toggleOne = (id: string, checked: boolean) => setSelected((old) => { const next = new Set(old); if (checked) next.add(id); else next.delete(id); return next; });

  const tableActions: PaperTableActions = {
    onOpen, onInspect: onInspect ?? (() => undefined), onToggleFavorite, onOrganize, onTag, onEdit, onTrash, onRestore, onPurge, onExport, onCycleStatus,
  };
  const menuActions: PaperMenuActions = { onInspect, onOpen, onEdit, onOrganize, onExport, onTrash, onRestore, onPurge };

  const preset = (value: string) => {
    setPresetName(value);
    setSizing({});
    setVisibility({ ...DEFAULT_COLUMN_VISIBILITY, ...(PRESETS[value] || {}) });
  };
  const changeVisibility = (next: typeof visibility) => { setPresetName("custom"); setVisibility(next); };

  const noteEditor = (paper: PaperSummary) => quick?.id === paper.id && (
    <form className="quick-note" onClick={(event) => event.stopPropagation()} onSubmit={(event) => { event.preventDefault(); void saveNote(paper); }}>
      <input aria-label={`一句话速记 ${paper.title}`} maxLength={300} autoFocus disabled={noteBusy} value={quick.text} onChange={(event) => setQuick({ ...quick, text: event.target.value })} placeholder="一句话记住这篇论文的贡献或用途" />
      <button className="btn tiny" disabled={noteBusy}>保存速记</button>
      <button type="button" className="btn tiny ghost" disabled={noteBusy} onClick={() => setQuick(null)}>取消</button>
      {noteError && <span role="alert">{noteError}</span>}
    </form>
  );

  return (
    <div className="library">
      <header className="library-head">
        <div className="library-heading">
          <h1>{props.title || "论文库"}</h1>
          <span className="count-badge" title={`${total.toLocaleString()} 篇论文`}>{total.toLocaleString()}</span>
          {loading && <span className="loading-dot" aria-label="加载中" title="加载中" />}
        </div>
        <div className="search-box">
          <Search size={16} className="search-icon" />
          <input ref={search} className="search" aria-label="论文搜索" placeholder="搜索标题、作者、DOI、速记、标签或正文…" value={query} onChange={(event) => onQuery(event.target.value)} />
          {query && <button className="icon-btn clear-search" aria-label="清除搜索" onClick={() => onQuery("")}><X size={14} /></button>}
        </div>
        <select aria-label="论文排序" value={sort} onChange={(event) => onSort(event.target.value as PaperSort)} className="select compact">
          <option value="recent">最近导入</option>
          <option value="title">标题</option>
          <option value="year">年份</option>
          <option value="citations">引用量（从高到低）</option>
        </select>
        <div className="library-actions">
          <button ref={importButton} className="btn primary import-button" aria-label="导入论文" aria-haspopup="menu" aria-expanded={!!importMenu} disabled={importing} onClick={() => setImportMenu(anchorOf(importButton.current))}>
            <Upload size={15} /><span>{importing ? `导入中${importProgress ? ` ${importProgress}` : "…"}` : "导入"}</span><ChevronDown size={14} />
          </button>
          <div className="segmented" aria-label="论文展示方式">
            <button aria-label="表格" aria-pressed={view === "table"} className={view === "table" ? "on" : ""} onClick={() => setView("table")} title="表格视图"><Table2 size={16} /></button>
            <button aria-label="卡片" aria-pressed={view === "cards"} className={view === "cards" ? "on" : ""} onClick={() => setView("cards")} title="卡片视图"><LayoutGrid size={16} /></button>
          </div>
          {view === "table" && <button ref={columnsButton} className="btn icon-text" aria-label="显示列" aria-expanded={!!columnsMenu} onClick={() => setColumnsMenu(columnsMenu ? null : anchorOf(columnsButton.current))}><Columns3 size={15} /><span>显示列</span></button>}
        </div>
      </header>

      {importMenu && <FloatingLayer x={importMenu.x} y={importMenu.y} onClose={() => setImportMenu(null)} ignore={importButton} className="menu library-menu" label="导入方式">
        <button onClick={() => { setImportMenu(null); onImport(); }}><Upload size={15} />导入本地 PDF</button>
        <button onClick={() => { setImportMenu(null); onZotero(); }}>从 Zotero 导入</button>
        <button onClick={() => { setImportMenu(null); setIdentifierOpen(true); }}>通过 DOI / arXiv 导入</button>
      </FloatingLayer>}

      {columnsMenu && <FloatingLayer x={columnsMenu.x} y={columnsMenu.y} onClose={() => setColumnsMenu(null)} ignore={columnsButton} className="menu library-menu column-menu" label="显示列">
        <div className="menu-head">显示列</div>
        <label className="menu-field">列表预设
          <select aria-label="列表视图预设" value={presetName} onChange={(event) => preset(event.target.value)}>
            <option value="custom" disabled>自定义</option><option value="overview">研究概览</option><option value="reading">阅读与速记</option><option value="citations">引用量与标签</option>
          </select>
        </label>
        {HIDEABLE_COLUMNS.map((id) => <label key={id} className="menu-check"><input type="checkbox" checked={visibility[id] !== false} onChange={(event) => changeVisibility({ ...visibility, [id]: event.target.checked })} />{COLUMN_LABELS[id]}</label>)}
      </FloatingLayer>}

      {citationMessage && <div className="small citation-status" role="status">{citationMessage}</div>}
      {error && <div className="error-box" role="alert">加载失败：{error}</div>}

      {papers.length === 0 ? (
        <div className="empty">
          <div className="empty-icon"><Inbox size={44} /></div>
          <h2>{loading ? "正在加载论文…" : query ? "没有匹配的论文" : "当前分类没有论文"}</h2>
          <p>导入 PDF 后即可离线阅读；翻译、解释与问答按需调用已配置的模型。</p>
          <button className="btn primary" aria-label="导入 PDF" onClick={onImport}><Upload size={15} />导入 PDF</button>
        </div>
      ) : view === "table" ? (
        <PaperTable {...tableActions} papers={papers} total={total} offset={offset} query={query} sort={sort} selected={selected} inspectedId={inspectedId}
          onSelect={toggleOne} onSelectAll={toggleAll} onSort={onSort} onNote={(paper) => { setQuick({ id: paper.id, text: paper.short_note || "", updatedAt: paper.updated_at }); setNoteError(""); }} noteId={quick?.id} renderNote={noteEditor}
          refreshing={refreshing} onRefresh={(id) => void refresh([id], true)} visibility={visibility} onVisibilityChange={changeVisibility} sizing={sizing} onColumnSizingChange={setSizing} />
      ) : (
        <>
          <div className="cards-tools">
            <label><input type="checkbox" aria-label="选择当前页论文" checked={papers.some((paper) => !paper.deleted) && papers.filter((paper) => !paper.deleted).every((paper) => selected.has(paper.id))} onChange={(event) => toggleAll(event.target.checked)} />选择当前页</label>
          </div>
          <div className="paper-list" ref={scrollRef} aria-label="论文列表">
            <div style={{ height: virtual.getTotalSize(), width: "100%", position: "relative" }}>
              {virtual.getVirtualItems().map((item) => {
                const paper = papers[item.index];
                return (
                  <div key={item.key} data-index={item.index} ref={virtual.measureElement} style={{ position: "absolute", top: 0, left: 0, width: "100%", paddingBottom: 8, transform: `translateY(${item.start}px)` }}>
                    <div className={`paper-row card-row ${paper.deleted ? "deleted" : ""} ${inspectedId === paper.id ? "inspected" : ""} ${selected.has(paper.id) ? "selected" : ""}`} data-paper-id={paper.id}
                      onClick={(event) => { if (event.detail > 1) return; if ((event.target as HTMLElement).closest("button,input,form,a,select,textarea")) return; previewLater(paper); }}
                      onDoubleClick={(event) => { if ((event.target as HTMLElement).closest("button,input,form,a,select,textarea")) return; clearTimeout(inspectTimer.current); onOpen(paper); }}
                      onContextMenu={(event) => { event.preventDefault(); setMenu({ paper, x: event.clientX, y: event.clientY }); }}>
                      {!paper.deleted && <input type="checkbox" aria-label={`选择论文 ${paper.title}`} checked={selected.has(paper.id)} onChange={(event) => toggleOne(paper.id, event.target.checked)} />}
                      <button className={`icon-btn star ${paper.favorite ? "on" : ""}`} aria-label={paper.favorite ? "取消星标" : "星标"} title="星标" onClick={() => onToggleFavorite(paper)}><Star size={16} fill={paper.favorite ? "currentColor" : "none"} /></button>
                      <div className="paper-main">
                        <div className="paper-title">{paper.title}</div>
                        <div className="paper-meta">
                          <span>{paper.authors || "未知作者"}</span>
                          {paper.year && <span>{paper.year}</span>}
                          {paper.venue && <span>{paper.venue}</span>}
                          {paper.doi && <span className="mono">DOI {paper.doi}</span>}
                          {paper.arxiv && <span className="mono">arXiv:{paper.arxiv}</span>}
                        </div>
                        {paper.short_note && quick?.id !== paper.id && <div className="paper-short-note" title={paper.short_note}>{paper.short_note}</div>}
                        {noteEditor(paper)}
                        <div className="paper-tags">
                          {paper.categories.map((category) => <span className="chip" key={category.id}>{category.name}</span>)}
                          {paper.tags.map((tag) => <button className="chip ghost tag-filter" key={tag.id} onClick={(event) => { event.stopPropagation(); onTag?.(tag.name); }} title={`筛选标签 ${tag.name}`}>#{tag.name}</button>)}
                          {paper.has_translation && <span className="chip accent">已有译文</span>}
                          <button className={`reading-state ${paper.read_status}`} title="点击切换阅读状态" onClick={(event) => { event.stopPropagation(); onCycleStatus(paper); }}>{(STATUS_LABELS as Record<string, string>)[paper.read_status]}</button>
                        </div>
                      </div>
                      <div className="paper-side">
                        <span className="citation-count" title={paper.citation_count == null ? "尚未获取引用量" : `${paper.citation_source || ""} · ${paper.citation_updated_at ? new Date(paper.citation_updated_at).toLocaleString() : ""}`}>{paper.citation_count == null ? "引用量未知" : `引用 ${paper.citation_count.toLocaleString()}`}{paper.citation_source && <small>{paper.citation_source}</small>}</span>
                        {!paper.deleted && <div className="row-actions">
                          <button className="btn tiny" disabled={!onOrganize} onClick={() => onOrganize?.([paper.id])}>分类 / 标签</button>
                          <button className="btn tiny" disabled={!onShortNote} onClick={() => { setQuick({ id: paper.id, text: paper.short_note || "", updatedAt: paper.updated_at }); setNoteError(""); }}>速记</button>
                          <button className="btn tiny ghost" disabled={refreshing || !onRefreshCitations} onClick={() => void refresh([paper.id], true)}>刷新引用量</button>
                        </div>}
                        <div className="row-actions">
                          <button className="btn tiny" onClick={() => onOpen(paper)}>阅读</button>
                          <button className="icon-btn" aria-label={`更多操作 ${paper.title}`} title="更多操作" aria-haspopup="menu" onClick={(event) => openMenu(event, paper)}><MoreHorizontal size={17} /></button>
                        </div>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </>
      )}

      {selected.size > 0 && (
        <div className="batch-bar" role="toolbar" aria-label="批量操作">
          <span className="batch-count">已选 {selected.size} 篇</span>
          <button className="btn tiny" disabled={!onOrganize} onClick={() => onOrganize?.([...selected])}>分类 / 标签</button>
          <button className="btn tiny" disabled={refreshing || !onRefreshCitations} onClick={() => void refresh([...selected])}>更新引用量</button>
          {refreshing && <button className="btn tiny" onClick={() => { stop.current = true; }}>停止</button>}
          <button className="btn tiny" disabled={!onMarkMany} onClick={() => onMarkMany?.([...selected], "read")}>标记已读</button>
          <button className="btn tiny" disabled={!onMarkMany} onClick={() => onMarkMany?.([...selected], "unread")}>标记未读</button>
          <button className="btn tiny" disabled={!onTranslateMany} onClick={() => onTranslateMany?.([...selected])}>批量翻译</button>
          <button className="btn tiny" disabled={!onBulkExport} onClick={() => onBulkExport?.([...selected], "bibtex")}><FileDown size={13} />导出 BibTeX</button>
          <button className="btn tiny" disabled={!onBulkExport} onClick={() => onBulkExport?.([...selected], "ris")}><FileDown size={13} />导出 RIS</button>
          <button className="btn tiny danger" onClick={() => { for (const id of selected) { const paper = papers.find((item) => item.id === id); if (paper) onTrash(paper); } setSelected(new Set()); }}><Trash2 size={13} />移到回收站</button>
          <button className="btn tiny ghost" onClick={() => setSelected(new Set())}>取消选择</button>
        </div>
      )}

      <div className="pagination">
        <button className="btn tiny" disabled={loading || offset === 0} onClick={() => onOffset(Math.max(0, offset - pageSize))}>上一页</button>
        <span>{total ? `${offset + 1}–${Math.min(offset + pageSize, total)} / ${total.toLocaleString()}` : "0 篇"}</span>
        <button className="btn tiny" disabled={loading || offset + pageSize >= total} onClick={() => onOffset(offset + pageSize)}>下一页</button>
      </div>

      {identifierOpen && <IdentifierImport onClose={() => setIdentifierOpen(false)} onImported={(message) => { props.onImported?.(message); }} />}

      {menu && <FloatingLayer x={menu.x} y={menu.y} onClose={() => setMenu(null)} ignore={menuTrigger} className="menu context-menu" label="论文操作">
        <div className="menu-head" title={menu.paper.title}>{menu.paper.title}</div>
        <PaperMenuItems paper={menu.paper} actions={menuActions} close={() => setMenu(null)} />
      </FloatingLayer>}
    </div>
  );
}

const STATUS_LABELS = { unread: "未读", reading: "在读", read: "已读" };
