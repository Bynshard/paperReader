import { useEffect, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import PaperTable from './PaperTable';
import type { PaperSort, PaperSummary } from "./types";

type Props = {
  papers: PaperSummary[];
  total: number; loading: boolean; error?: string;
  sort: PaperSort; onSort: (sort: PaperSort) => void;
  offset: number; pageSize: number; onOffset: (offset: number) => void;
  query: string;
  onQuery: (q: string) => void;
  onOpen: (p: PaperSummary) => void;
  onImport: () => void;
  onToggleFavorite: (p: PaperSummary) => void;
  onTrash: (p: PaperSummary) => void;
  onRestore: (p: PaperSummary) => void;
  onPurge: (p: PaperSummary) => void;
  onExport: (p: PaperSummary, fmt: "bibtex" | "ris") => void;
  onEdit?: (p:PaperSummary)=>void;
  onOrganize?: (ids:string[])=>void;
  onShortNote?: (paper:PaperSummary,text:string)=>Promise<void>;
  onRefreshCitations?: (id:string,force?:boolean)=>Promise<boolean>;
  onTag?: (name:string)=>void;
  onZotero: () => void;
  importing: boolean;
  importProgress?: string;
};

export default function Library({ papers, total, loading, error, sort, onSort, offset, pageSize, onOffset, query, onQuery, onOpen, onImport, onToggleFavorite, onTrash, onRestore, onPurge, onExport, onEdit,onOrganize,onShortNote,onRefreshCitations,onTag, onZotero, importing, importProgress }: Props) {
  const [view,setView]=useState<'table'|'cards'>(()=>{try{return localStorage.getItem('moonlight-library-view-v1')==='cards'?'cards':'table';}catch{return 'table';}});
  useEffect(()=>{try{localStorage.setItem('moonlight-library-view-v1',view);}catch{}},[view]);
  const [menu, setMenu] = useState<string | null>(null);
  const [selected,setSelected]=useState<Set<string>>(new Set()),[quick,setQuick]=useState<{id:string;text:string;updatedAt:number}|null>(null),[noteBusy,setNoteBusy]=useState(false),[noteError,setNoteError]=useState('');
  const [refreshing,setRefreshing]=useState(false),[citationMessage,setCitationMessage]=useState('');
  const stop=useRef(false),alive=useRef(true);
  useEffect(()=>{alive.current=true;return()=>{alive.current=false;stop.current=true;};},[]);
  useEffect(()=>{const present=new Set(papers.filter(p=>!p.deleted).map(p=>p.id));setSelected(old=>new Set([...old].filter(id=>present.has(id))));},[papers]);
  const refresh=async(ids:string[],force=false)=>{
    if(refreshing||!onRefreshCitations)return;setRefreshing(true);stop.current=false;let success=0,failed=0,cached=0,lastError='';
    for(const id of ids){if(stop.current)break;setCitationMessage(`更新引用量 ${success+failed+1}/${ids.length}`);try{const hit=await onRefreshCitations(id,force);success++;if(hit)cached++;}catch(e){failed++;lastError=(e as Error).message;}}
    if(alive.current){setRefreshing(false);setCitationMessage(`${stop.current?'已停止：':''}${success} 篇成功（${cached} 篇使用近期缓存），${failed} 篇失败${lastError?`：${lastError}`:''}`);}
  };
  const saveNote=async(p:PaperSummary)=>{if(!quick||!onShortNote)return;setNoteBusy(true);setNoteError('');try{await onShortNote({...p,updated_at:quick.updatedAt},quick.text);setQuick(null);}catch(e){setNoteError((e as Error).message);}finally{setNoteBusy(false);}};
  const scrollRef = useRef<HTMLDivElement>(null);
  const virtual = useVirtualizer({ count: papers.length, getScrollElement: () => scrollRef.current,
    estimateSize: () => 130, getItemKey: (index) => papers[index].id, overscan: 4,
  });
  useEffect(() => { scrollRef.current?.scrollTo({ top: 0 }); setMenu(null);setQuick(null);setSelected(new Set()); }, [offset, sort, query]);

  const noteEditor=(p:PaperSummary)=>quick?.id===p.id&&<form className="quick-note" onClick={e=>e.stopPropagation()} onSubmit={e=>{e.preventDefault();void saveNote(p);}}><input aria-label={`一句话速记 ${p.title}`} maxLength={300} autoFocus disabled={noteBusy} value={quick.text} onChange={e=>setQuick({...quick,text:e.target.value})} placeholder="一句话记住这篇论文的贡献或用途"/><button className="btn tiny" disabled={noteBusy}>保存速记</button><button type="button" className="btn tiny ghost" disabled={noteBusy} onClick={()=>setQuick(null)}>取消</button>{noteError&&<span role="alert">{noteError}</span>}</form>;
  return (
    <div className="library">
      <div className="library-head">
        <div>
          <h1>论文库</h1>
          <p className="muted">{total.toLocaleString()} 篇{loading ? " · 加载中…" : ""} · 原文离线可读，译文按需生成</p>
        </div>
        <div className="library-actions"><div className="library-view-switch" aria-label="论文展示方式"><button className="btn tiny" aria-pressed={view==='table'} onClick={()=>setView('table')}>表格</button><button className="btn tiny" aria-pressed={view==='cards'} onClick={()=>setView('cards')}>卡片</button></div>
          <input className="search" aria-label="论文搜索" placeholder="搜索标题、作者、DOI、速记、标签或正文…" value={query} onChange={(e) => onQuery(e.target.value)} />
          <select aria-label="论文排序" value={sort} onChange={(e) => onSort(e.target.value as PaperSort)} className="select">
            <option value="recent">最近导入</option>
            <option value="title">标题</option>
            <option value="year">年份</option>
            <option value="citations">引用量（从高到低）</option>
          </select>
          <button className="btn" onClick={onZotero}>
            从 Zotero 导入
          </button>
          <button className="btn primary" onClick={onImport} disabled={importing}>
            {importing ? `导入中${importProgress ? ` ${importProgress}` : '…'}` : "导入 PDF"}
          </button>
        </div>
      </div>

      <div className="library-organize-bar"><label><input type="checkbox" aria-label="选择当前页论文" checked={papers.some(p=>!p.deleted)&&papers.filter(p=>!p.deleted).every(p=>selected.has(p.id))} onChange={e=>setSelected(e.target.checked?new Set(papers.filter(p=>!p.deleted).map(p=>p.id)):new Set())}/>选择当前页</label><span className="small">已选 {selected.size} 篇</span><button className="btn tiny" disabled={!selected.size||!onOrganize} onClick={()=>onOrganize?.([...selected])}>分类 / 标签</button><button className="btn tiny" disabled={!selected.size||refreshing||!onRefreshCitations} onClick={()=>void refresh([...selected])}>更新所选引用量</button>{refreshing&&<button className="btn tiny" onClick={()=>{stop.current=true;}}>停止后续更新</button>}<span className="small muted">左侧可新建分层目录；每篇论文可直接填写速记。</span></div>
      {citationMessage&&<div className="small citation-status" role="status">{citationMessage}</div>}
      {error && <div className="error-box" role="alert">加载失败：{error}</div>}
      {papers.length === 0 ? (
        <div className="empty">
          <div className="empty-icon">◫</div>
          <h2>{loading ? "正在加载论文…" : query ? "没有匹配的论文" : "当前分类没有论文"}</h2>
          <p>导入 PDF 后即可离线阅读；翻译、解释与问答按需调用已配置的模型。</p>
          <button className="btn primary" onClick={onImport}>
            导入 PDF
          </button>
        </div>
      ) : view==='table'?(
        <PaperTable papers={papers} query={query} total={total} offset={offset} sort={sort} selected={selected} onSort={onSort} onSelect={(id,checked)=>setSelected(old=>{const next=new Set(old);if(checked)next.add(id);else next.delete(id);return next;})} onOpen={onOpen} onToggleFavorite={onToggleFavorite} onOrganize={onOrganize} onTag={onTag} onEdit={onEdit} onTrash={onTrash} onRestore={onRestore} onPurge={onPurge} onExport={onExport} onNote={p=>{setQuick({id:p.id,text:p.short_note||'',updatedAt:p.updated_at});setNoteError('');}} noteId={quick?.id} renderNote={noteEditor} refreshing={refreshing} onRefresh={id=>void refresh([id],true)}/>
      ) : (
        <div className="paper-list" ref={scrollRef} aria-label="论文列表">
          <div style={{ height: virtual.getTotalSize(), width: "100%", position: "relative" }}>
          {virtual.getVirtualItems().map((item) => {
            const p = papers[item.index];
            const translated = p.has_translation;
            return (
              <div key={item.key} data-index={item.index} ref={virtual.measureElement}
                style={{ position: "absolute", top: 0, left: 0, width: "100%", paddingBottom: 8, transform: `translateY(${item.start}px)`, zIndex: menu === p.id ? 20 : undefined }}>
              <div className={`paper-row ${p.deleted ? "deleted" : ""}`} data-paper-id={p.id} onDoubleClick={e=>{if(!(e.target as HTMLElement).closest('button,input,form,a,select'))onOpen(p);}}>
                {!p.deleted&&<input type="checkbox" aria-label={`选择论文 ${p.title}`} checked={selected.has(p.id)} onChange={e=>setSelected(old=>{const next=new Set(old);if(e.target.checked)next.add(p.id);else next.delete(p.id);return next;})}/>}
                <button className={`star ${p.favorite ? "on" : ""}`} title="星标" onClick={() => onToggleFavorite(p)}>
                  ★
                </button>
                <div className="paper-main" onClick={() => onOpen(p)}>
                  <div className="paper-title">{p.title}</div>
                  <div className="paper-meta">
                    <span>{p.authors || "未知作者"}</span>
                    {p.year && <span>{p.year}</span>}
                    {p.venue && <span>{p.venue}</span>}
                    {p.doi && <span className="mono">DOI {p.doi}</span>}
                    {p.arxiv && <span className="mono">arXiv:{p.arxiv}</span>}
                  </div>
                  {p.short_note&&quick?.id!==p.id&&<div className="paper-short-note" title={p.short_note}>{p.short_note}</div>}
                  {noteEditor(p)}
                  <div className="paper-tags">
                    {p.categories.map((c) => (
                      <span className="chip" key={c.id}>
                        {c.name}
                      </span>
                    ))}
                    {p.tags.map((t) => (
                      <button className="chip ghost tag-filter" key={t.id} onClick={e=>{e.stopPropagation();onTag?.(t.name);}} title={`筛选标签 ${t.name}`}>#{t.name}</button>
                    ))}
                    {translated && <span className="chip accent">已有译文</span>}
                    {p.read_status === "read" && <span className="chip">已读</span>}
                  </div>
                </div>
                <div className="paper-side">
                  <span className="citation-count" title={p.citation_count==null?'尚未获取引用量':`${p.citation_source||''} · ${p.citation_updated_at?new Date(p.citation_updated_at).toLocaleString():''}`}>{p.citation_count==null?'引用量未知':`引用 ${p.citation_count.toLocaleString()}`} {p.citation_source&&<small>{p.citation_source}</small>}</span>
                  {!p.deleted&&<div className="row-actions"><button className="btn tiny" disabled={!onOrganize} onClick={()=>onOrganize?.([p.id])}>分类 / 标签</button><button className="btn tiny" disabled={!onShortNote} onClick={()=>{setQuick({id:p.id,text:p.short_note||'',updatedAt:p.updated_at});setNoteError('');}}>速记</button><button className="btn tiny ghost" disabled={refreshing||!onRefreshCitations} onClick={()=>void refresh([p.id],true)}>刷新引用量</button></div>}
                  <div className="row-actions">
                    <button className="btn tiny" onClick={() => onOpen(p)}>
                      阅读
                    </button>
                    <button className="btn tiny ghost" onClick={() => setMenu(menu === p.id ? null : p.id)}>
                      ⋯
                    </button>
                  </div>
                  {menu === p.id && (
                    <div className="menu" onMouseLeave={() => setMenu(null)}>
                      {!p.deleted && (
                        <>
                          <button onClick={()=>{setMenu(null);onEdit?.(p);}}>编辑资料</button>
                          <button onClick={() => onExport(p, "bibtex")}>导出 BibTeX</button>
                          <button onClick={() => onExport(p, "ris")}>导出 RIS</button>
                          <button className="danger" onClick={() => onTrash(p)}>
                            移到回收站
                          </button>
                        </>
                      )}
                      {p.deleted && (
                        <>
                          <button onClick={() => onRestore(p)}>恢复</button>
                          <button className="danger" onClick={() => onPurge(p)}>
                            永久删除
                          </button>
                        </>
                      )}
                    </div>
                  )}
                </div>
              </div>
              </div>
            );
          })}
          </div>
        </div>
      )}
      <div className="pagination">
        <button className="btn tiny" disabled={loading || offset === 0} onClick={() => onOffset(Math.max(0, offset-pageSize))}>上一页</button>
        <span>{total ? `${offset + 1}–${Math.min(offset+pageSize,total)} / ${total.toLocaleString()}` : "0 篇"}</span>
        <button className="btn tiny" disabled={loading || offset+pageSize >= total} onClick={() => onOffset(offset+pageSize)}>下一页</button>
      </div>
    </div>
  );
}
