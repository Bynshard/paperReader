import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Annotation, ImportedAttachment, JobEvent, Paper, PdfBytes, Source } from "./types";
import PaperEditor from "./PaperEditor";
import MarkdownAnswer from './MarkdownAnswer';
import DocumentParsing from './DocumentParsing';
import ImportedFiles from "./ImportedFiles";
import PdfPane, { PaneApi, Selection } from "./PdfPane";
import { api, type ChatMessage } from "./api";

type Mode = "source" | "translated" | "dual";

type Props = {
  paper: Paper;
  onBack: () => void;
  onChanged: (p: Paper) => void;
  onToast: (msg: string) => void;
};

export default function Reader({ paper, onBack, onChanged, onToast }: Props) {
  const initialPosition = useMemo(() => {
    try { const saved = JSON.parse(localStorage.getItem(`pos:${paper.id}`) || "{}");
      return { page: Math.max(1, Number(saved.page) || 1), fraction: Math.max(0, Math.min(1, Number(saved.fraction) || 0)) };
    } catch { return { page: 1, fraction: 0 }; }
  }, [paper.id]);
  const [textRevision,setTextRevision]=useState(0),[scope,setScope]=useState('related'),[includeHistory,setIncludeHistory]=useState(true),[contextPreview,setContextPreview]=useState<{prompt:string;history?:string;history_count?:number;context_info?:{pages:number[];characters:number;indexed_pages:number;total_pages:number};warnings?:string[]}|null>(null);
  const [mode, setMode] = useState<Mode>(paper.versions.some((v) => v.kind === "translated") ? "dual" : "source");
  const [scale, setScale] = useState(1.15);
  const [page, setPage] = useState(initialPosition.page);
  const positionRef = useRef(initialPosition);
  const persistTimer = useRef<ReturnType<typeof setTimeout>>();
  const [source, setSource] = useState<PdfBytes | null>(null);
  const [translated, setTranslated] = useState<PdfBytes | null>(null);
  const [annotations, setAnnotations] = useState<Annotation[]>([]);
  const [files,setFiles] = useState<ImportedAttachment[]>([]);
  const sourceRequest = useRef(0);
  const [selection, setSelection] = useState<Selection | null>(null);
  const [job, setJob] = useState<{ id: string; status: string; phase?: string } | null>(null);
  const [tab, setTab] = useState<"notes" | "ai">("ai");
  const [editing,setEditing]=useState(false);
  const [aiQuestion, setAiQuestion] = useState("");
  const [aiAnswer, setAiAnswer] = useState<{ answer: string; sources: Source[]; warnings?:string[] } | null>(null);
  const aiRequest=useRef<string|null>(null),previewToken=useRef(0);
  useEffect(()=>{previewToken.current++;setContextPreview(null);},[source?.versionId,page,scope,includeHistory,aiQuestion,textRevision]);
  const previewContext=async()=>{
    const token=++previewToken.current;
    try{const result=await api.aiAction('preview',{paper_id:paper.id,version_id:source?.versionId,question:aiQuestion,kind:'ask',scope,page:scope==='page'?page-1:undefined,include_history:includeHistory});if(token===previewToken.current)setContextPreview(result as typeof contextPreview);}
    catch(e){if(token===previewToken.current)setAiError((e as Error).message);}
  };
  const [aiHistory,setAiHistory]=useState<ChatMessage[]>([]);
  const [aiProvider,setAiProvider]=useState('');
  useEffect(()=>{
    let alive=true;
    api.aiHistory(paper.id).then(rows=>{if(alive){setAiHistory(rows);if(rows[0])setAiAnswer(rows[0]);}}).catch(()=>{});
    api.aiPreferences().then(s=>{if(alive)setAiProvider(s.provider);}).catch(()=>{});
    const off=api.onEvent(msg=>{
      if((msg.event as string)==='ai_delta'&&'request_id'in msg&&msg.request_id===aiRequest.current&&'answer'in msg)
        setAiAnswer({answer:String(msg.answer),sources:[]});
    });
    return ()=>{alive=false;off();if(aiRequest.current)void api.aiAction('cancel',{request_id:aiRequest.current}).catch(()=>{});};
  },[paper.id]);
  const refreshAiHistory=()=>api.aiHistory(paper.id).then(setAiHistory).catch(()=>{});
  const [aiBusy, setAiBusy] = useState(false);
  const [aiError, setAiError] = useState<string | null>(null);
  const [comment, setComment] = useState("");
  const [showTranslateMenu, setShowTranslateMenu] = useState(false);
  const [loading, setLoading] = useState(true);
  const [pageInput, setPageInput] = useState("1");
  const [error, setError] = useState<string | null>(null);

  const sourceApi = useRef<PaneApi | null>(null);
  const transApi = useRef<PaneApi | null>(null);
  const activePane = useRef<"source" | "translated">("source");
  const registerSource = useCallback((pane: PaneApi | null) => {
    sourceApi.current = pane;
    pane?.goTo(positionRef.current.page, positionRef.current.fraction);
  }, []);
  const registerTranslated = useCallback((pane: PaneApi | null) => {
    transApi.current = pane;
    pane?.goTo(positionRef.current.page, positionRef.current.fraction);
  }, []);
  const remember = (p: number, fraction: number) => {
    positionRef.current = { page: p, fraction };
    setPage(p);
    clearTimeout(persistTimer.current);
    persistTimer.current = setTimeout(() => localStorage.setItem(`pos:${paper.id}`, JSON.stringify(positionRef.current)), 250);
  };
  const navigate = (p: number, fraction = 0) => {
    remember(p, fraction);
    sourceApi.current?.goTo(p, fraction);
    transApi.current?.goTo(p, fraction);
  };
  const translatedVersion = useMemo(() => paper.versions.filter((v) => v.kind === "translated").sort((a, b) => b.created_at - a.created_at)[0], [paper]);
  const sourceVersions = useMemo(() => paper.versions.filter((v)=>v.kind==='source').sort((a,b)=>a.created_at-b.created_at || a.id.localeCompare(b.id)),[paper.versions]);
  const isPrimary = !source || source.versionId===sourceVersions[0]?.id;
  const loadOcr=useCallback(async(page:number)=>source?(await api.blocks(paper.id,source.versionId,page)).filter(b=>b.kind==='ocr'):[],[paper.id,source?.versionId]);
  const sourceAnnotations = useMemo(() => annotations.filter((a) => a.version_kind === "source" && (!a.version_id || a.version_id === source?.versionId)), [annotations, source?.versionId]);
  const translatedAnnotations = useMemo(() => annotations.filter((a) => a.version_kind === "translated" && (!a.version_id || a.version_id === translated?.versionId)), [annotations, translated?.versionId]);

  const loadTranslated = useCallback(async () => {
    if (!translatedVersion) return;
    const bytes = await api.pdf(paper.id, "translated");
    setTranslated(bytes);
  }, [paper.id, translatedVersion]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    (async () => {
      try {
        const bytes=paper.versions.some((v)=>v.kind==='source') ? await api.pdf(paper.id, "source") : null;
        if (cancelled) return;
        setSource(bytes);
      } catch (e) {
        setError(String((e as Error).message || e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
      sourceRequest.current++;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paper.id,sourceVersions[0]?.id]);

  useEffect(()=>{
    let active=true;
    void Promise.all([api.annotations(paper.id),api.zoteroFiles(paper.id).catch(()=>[])]).then(([anns,items])=>{
      if(active){setAnnotations(anns);setFiles(items);}
    }).catch(()=>undefined);
    return()=>{active=false;};
  },[paper]);
  useEffect(()=>{
    let active=true;
    if(translatedVersion) void api.pdf(paper.id,'translated').then((bytes)=>{if(active){setTranslated(bytes);if(!translated)setMode(m=>m==='source'?'dual':m);}}).catch(()=>undefined);
    return()=>{active=false;};
  },[paper.id,translatedVersion?.id]);

  const chooseSource = async (versionId:string,targetPage=1,fraction=0) => {
    const request=++sourceRequest.current;
    try {
      const bytes=await api.pdf(paper.id,'source',versionId);
      if (request!==sourceRequest.current) return;
      remember(targetPage,fraction);setSource(bytes);setMode('source');setSelection(null);setAiAnswer(null);setError(null);setShowTranslateMenu(false);
    } catch(e) {if(request===sourceRequest.current) onToast(`打开附件失败：${String(e)}`);}
  };

  useEffect(() => {
    setPageInput(String(page));
  }, [page]);
  useEffect(() => () => {
    clearTimeout(persistTimer.current);
    localStorage.setItem(`pos:${paper.id}`, JSON.stringify(positionRef.current));
  }, [paper.id]);

  useEffect(() => {
    return api.onEvent((ev) => {
      if (!('jobId' in ev)) return;
      if (!job || ev.jobId !== job.id) return;
      if (ev.status) setJob((j) => (j ? { ...j, status: ev.status!, phase: ev.phase } : j));
      if (ev.phase) setJob((j) => (j ? { ...j, phase: ev.phase } : j));
      if (ev.status === "completed") {
        onToast("译文已生成");
        setJob(null);
        api.getPaper(paper.id).then(async (p) => {
          onChanged(p);
          if (p.versions.some((v) => v.kind === "translated")) {
            const bytes = await api.pdf(paper.id, "translated");
            setTranslated(bytes);
            setMode((m) => (m === "source" ? "dual" : m));
          }
        });
      } else if (ev.status === "failed" || ev.status === "cancelled") {
        onToast(ev.error ? `翻译失败：${ev.error}` : ev.status === "cancelled" ? "翻译已取消" : "翻译失败");
        setJob(null);
      }
    });
  }, [job, onChanged, onToast, paper.id]);

  const savePosition = () => {
    const apiRef = activePane.current === "translated" ? transApi.current : sourceApi.current;
    if (apiRef) {
      const pos = apiRef.getPosition();
      remember(pos.page, pos.fraction);
      return pos;
    }
    return positionRef.current;
  };

  const switchMode = async (next: Mode) => {
    const pos = savePosition();
    if (next !== "source" && !translated) {
      try {
        await loadTranslated();
      } catch (e) {
        onToast("还没有可用的译文版本");
        return;
      }
    }
    setMode(next);
    if (next === "translated" || next === "dual") transApi.current?.goTo(pos.page, pos.fraction);
    if (next === "source" || next === "dual") sourceApi.current?.goTo(pos.page, pos.fraction);
    setSelection(null);
  };

  useEffect(()=>{let alive=true;api.listJobs().then(rows=>{const active=rows.find(j=>j.paper_id===paper.id&&!['completed','failed','cancelled'].includes(j.status));if(alive&&active)setJob({id:active.id,status:active.status});}).catch(()=>{});return()=>{alive=false;};},[paper.id]);
  const startTranslate = async (pages?: string) => {
    setShowTranslateMenu(false);
    try {
      const { job_id } = await api.startTranslate(paper.id, pages);
      setJob({ id: job_id, status: "queued" });
      setTab("ai");
      onToast(pages ? `开始翻译第 ${pages} 页` : "开始翻译全文（后台运行，可继续阅读）");
    } catch (e) {
      onToast(`无法启动翻译：${String((e as Error).message || e)}`);
    }
  };

  const addHighlight = async (color: string) => {
    if (!selection) return;
    await api.addAnnotation({
      paper_id: paper.id,
      page: selection.page - 1,
      rects: selection.rects,
      quote: selection.quote,
      color,
      comment,
      version_kind: selection.side,
      version_id: selection.side === "source" ? source?.versionId : translated?.versionId,
    });
    setComment("");
    const anns = await api.annotations(paper.id);
    setAnnotations(anns);
    onToast("已保存划线");
  };

  const ask = async (kind: "explain" | "summary" | "ask") => {
    if (!selection && kind !== "summary" && !aiQuestion.trim()) return;
    setTab("ai");
    if(aiRequest.current)return;
    aiRequest.current=crypto.randomUUID();
    setAiAnswer(null);
    setAiBusy(true);
    setAiError(null);
    try {
      let question = aiQuestion;
      if (kind === "explain" && selection) {
        question = `解释这段原文：${selection.quote}`;
      }
      if (kind === "summary") {
        question = `总结第 ${page} 页的主要内容，并列出关键结论。`;
      }
      if(kind==='summary'&&source&&sourceApi.current){const blocks=await sourceApi.current.parsePage(page);if(blocks.length){await api.setBlocks(paper.id,source.versionId,page-1,blocks);setTextRevision(v=>v+1);}}
      const result = await api.aiRun({ request_id:aiRequest.current!, paper_id: paper.id, question, page: kind === "summary" ? page-1 : kind==='explain'&&selection ? selection.page-1 : scope==='page'?page-1:undefined, scope,include_history:includeHistory,kind, version_id:source?.versionId });
      setAiAnswer(result);
      await refreshAiHistory();
    } catch (e) {
      setAiError(String((e as Error).message || e));
    } finally {
      aiRequest.current=null;
      setAiBusy(false);
    }
  };

  const translateSelection = async () => {
    if (!selection) return;
    setTab("ai");
    if(aiRequest.current)return;
    aiRequest.current=crypto.randomUUID();
    setAiAnswer(null);
    setAiBusy(true);
    setAiError(null);
    try {
      const result=await api.aiRun({request_id:aiRequest.current!,paper_id:paper.id,question:selection.quote,kind:'translate',version_id:source?.versionId});
      setAiAnswer(result);
      await refreshAiHistory();
    } catch (e) {
      setAiError(String((e as Error).message || e));
    } finally {
      aiRequest.current=null;
      setAiBusy(false);
    }
  };

  const jumpToSource = async (src: Source) => {
    const p = src.page + 1;
    if(src.version_id&&src.version_id!==source?.versionId){
      const answer=aiAnswer;
      await chooseSource(src.version_id,p);
      setAiAnswer(answer);
      return;
    }
    navigate(p);
    sourceApi.current?.goTo(p, 0, src.bbox);
    setMode((m) => (m === "translated" ? "dual" : m));
  };

  if (loading) return <div className="reader loading">正在打开论文…</div>;
  if (error || !source) return <div className="reader metadata-reader">
    <button className="btn" onClick={onBack}>← 论文库</button>
    <button className="btn" onClick={()=>setEditing(true)}>编辑资料</button>
    {editing&&<PaperEditor paper={paper} onClose={()=>setEditing(false)} onSaved={p=>{onChanged(p);setEditing(false);}}/>}
    <h2>{paper.title}</h2><p>{paper.authors}</p>
    {error ? <p role="alert">打开 PDF 失败：{error}</p> : <p className="muted">此条目没有可用的 PDF，元数据和笔记已保存。</p>}
    {paper.short_note&&<p className="paper-short-note">速记：{paper.short_note}</p>}
    {paper.abstract && <p>{paper.abstract}</p>}
    {paper.notes && <section><h3>笔记</h3><div className="migrated-notes">{paper.notes}</div></section>}
    <ImportedFiles paperId={paper.id} files={files} onOpen={chooseSource} onError={onToast}/>
  </div>;

  return (
    <div className="reader">
      {editing&&<PaperEditor paper={paper} onClose={()=>setEditing(false)} onSaved={p=>{onChanged(p);setEditing(false);}}/>}
      <header className="reader-head">
        <button className="btn ghost" onClick={onBack}>
          ← 论文库
        </button>
        <button className="btn tiny" onClick={()=>setEditing(true)}>编辑资料</button>
        <div className="reader-title" title={paper.title}>
          {paper.title}
        </div>
        {sourceVersions.length>1 && <select aria-label="原文附件" value={source.versionId} onChange={(e)=>chooseSource(e.target.value)}>
          {sourceVersions.map((v,i)=><option key={v.id} value={v.id}>{files.find((f)=>f.version_id===v.id)?.title || `PDF ${i+1}`}{i===0?'（主文档）':''}</option>)}
        </select>}
        <div className="mode-switch">
          <button className={mode === "source" ? "on" : ""} onClick={() => switchMode("source")}>
            原文
          </button>
          <button className={mode === "translated" ? "on" : ""} disabled={!translated || !isPrimary} title={translated ? "" : "尚未生成译文"} onClick={() => switchMode("translated")}>
            译文
          </button>
          <button className={mode === "dual" ? "on" : ""} disabled={!translated || !isPrimary} onClick={() => switchMode("dual")}>
            对照
          </button>
        </div>
        <div className="page-nav">
          <button className="btn tiny" onClick={() => navigate(Math.max(1, page - 1))}>
            ‹
          </button>
          <input
            value={pageInput}
            onChange={(e) => setPageInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                const n = Math.max(1, Math.min(source.pages, Number(pageInput) || 1));
                navigate(n);
              }
            }}
          />
          <span className="muted">/ {source.pages}</span>
          <button className="btn tiny" onClick={() => navigate(Math.min(source.pages, page + 1))}>
            ›
          </button>
        </div>
        <div className="zoom">
          <button className="btn tiny" onClick={() => setScale((s) => Math.max(0.6, +(s - 0.15).toFixed(2)))}>
            −
          </button>
          <span className="muted">{Math.round(scale * 100)}%</span>
          <button className="btn tiny" onClick={() => setScale((s) => Math.min(3, +(s + 0.15).toFixed(2)))}>
            +
          </button>
        </div>
        <div className="translate-wrap">
          <button className="btn primary" title={!isPrimary?'全文翻译当前使用主文档':''} onClick={() => (translated ? setShowTranslateMenu((v) => !v) : startTranslate(undefined))} disabled={!!job || !isPrimary}>
            {job ? phaseLabel(job) : translated ? "重新翻译" : "翻译全文"}
          </button>
          {translated && (
            <button className="btn primary icon" onClick={() => setShowTranslateMenu((v) => !v)} disabled={!!job || !isPrimary}>
              ▾
            </button>
          )}
          {showTranslateMenu && (
            <div className="menu translate-menu">
              <button onClick={() => startTranslate(String(page))}>只翻译当前页（第 {page} 页）</button>
              <button onClick={() => startTranslate(undefined)}>翻译全文</button>
            </div>
          )}
        </div>
        {job && (
          <button className="btn tiny ghost" onClick={() => job && api.cancelJob(job.id)}>
            取消
          </button>
        )}
      </header>

      {source&&<DocumentParsing key={source.versionId} paperId={paper.id} versionId={source.versionId} pages={source.pages} page={page} pane={sourceApi} onIndexed={()=>setTextRevision(v=>v+1)}/>}
      {job && (
        <div className="jobbar">
          <div className="jobbar-text">
            翻译任务 · {statusLabel(job.status)} {job.phase ? `· ${phaseLabel(job)}` : ""}
          </div>
          <div className="progress">
            <div className={`bar ${job.status}`} />
          </div>
        </div>
      )}

      <div className="reader-body">
        <div className={`panes mode-${mode}`}>
          {(mode === "source" || mode === "dual") && (
            <PdfPane
              key="source"
              bytes={source.bytes}
              scale={scale}
              annotations={sourceAnnotations}
              initialPage={page}
              initialFraction={positionRef.current.fraction}
              side="source"
              loadOcr={loadOcr}
              textRevision={textRevision}
              registerApi={registerSource}
              onScrollFraction={(p, f) => {
                activePane.current = "source";
                remember(p, f);
                if (mode === "dual") transApi.current?.goTo(p, f);
              }}
              onSelect={(s) => {
                activePane.current = "source";
                setSelection(s);
                if (s) setTab("notes");
              }}
              onBlocks={(pageNo, blocks) => {
                if (source && blocks.length) api.setBlocks(paper.id, source.versionId, pageNo, blocks).catch(() => undefined);
              }}
            />
          )}
          {(mode === "translated" || mode === "dual") && translated && (
            <PdfPane
              key="translated"
              bytes={translated.bytes}
              scale={scale}
              annotations={translatedAnnotations}
              initialPage={page}
              initialFraction={positionRef.current.fraction}
              side="translated"
              registerApi={registerTranslated}
              onScrollFraction={(p, f) => {
                activePane.current = "translated";
                remember(p, f);
                if (mode === "dual") sourceApi.current?.goTo(p, f);
              }}
              onSelect={(s) => {
                activePane.current = "translated";
                setSelection(s);
                if (s) setTab("notes");
              }}
            />
          )}
        </div>

        <aside className="side">
          <div className="side-tabs">
            <button className={tab === "ai" ? "on" : ""} onClick={() => setTab("ai")}>
              阅读助手
            </button>
            <button className={tab === "notes" ? "on" : ""} onClick={() => setTab("notes")}>
              笔记 {annotations.length > 0 && <span className="badge">{annotations.length}</span>}
            </button>
          </div>

          {tab === "notes" && (
            <div className="notes">
              {paper.notes && <section><h3>迁入笔记</h3><div className="migrated-notes">{paper.notes}</div></section>}
              <ImportedFiles paperId={paper.id} files={files} onOpen={chooseSource} onError={onToast}/>
              {selection ? (
                <div className="selection-card">
                  <div className="selection-quote">“{selection.quote.slice(0, 300)}{selection.quote.length > 300 ? "…" : ""}”</div>
                  <div className="muted small">
                    第 {selection.page} 页 · {selection.rects.length} 个文本区域
                  </div>
                  <textarea placeholder="写一条笔记（可选）…" value={comment} onChange={(e) => setComment(e.target.value)} rows={2} />
                  <div className="selection-actions">
                    <button className="btn tiny" onClick={() => addHighlight("yellow")}>
                      黄色高亮
                    </button>
                    <button className="btn tiny" onClick={() => addHighlight("green")}>
                      绿色高亮
                    </button>
                    <button className="btn tiny ghost" onClick={translateSelection}>
                      翻译
                    </button>
                    <button className="btn tiny ghost" onClick={() => ask("explain")}>
                      解释
                    </button>
                    <button className="btn tiny ghost" onClick={() => setSelection(null)}>
                      清除
                    </button>
                  </div>
                </div>
              ) : (
                <p className="muted hint">在页面上选中文字，可划线、记笔记、翻译或解释。</p>
              )}
              {annotations.map((a) => (
                <div className="note-item" key={a.id}>
                  <div className="note-quote">{a.quote.slice(0, 180)}</div>
                  {a.comment && <div className="note-comment">{a.comment}</div>}
                  <div className="note-meta">
                    <span>第 {a.page + 1} 页</span>
                    <button className="link" onClick={() => {
                      if(a.version_kind==='source' && a.version_id && a.version_id!==source.versionId) {void chooseSource(a.version_id,a.page+1,a.rects[0]?.y ?? 0);return;}
                      remember(a.page + 1, a.rects[0]?.y ?? 0);
                      setMode(a.version_kind === "translated" ? "translated" : "source");
                      (a.version_kind === "translated" ? transApi : sourceApi).current?.goTo(a.page+1,a.rects[0]?.y ?? 0);
                    }}>
                      跳转
                    </button>
                    <button className="link danger" onClick={() => api.deleteAnnotation(a.id).then(() => api.annotations(paper.id)).then(setAnnotations)}>
                      删除
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}

          {tab === "ai" && (
            <div className="ai">
              <div className="ai-actions">
                <button className="btn tiny" onClick={() => ask("summary")} disabled={aiBusy}>
                  总结本页
                </button>
                <button className="btn tiny" onClick={() => ask("explain")} disabled={aiBusy || !selection} title={selection ? "" : "先在页面上选中文字"}>
                  解释选区
                </button>
                <button className="btn tiny" onClick={translateSelection} disabled={aiBusy || !selection}>
                  翻译选区
                </button>
              </div>
              <label className="small">提问上下文 <select aria-label="提问上下文" value={scope} disabled={aiBusy} onChange={e=>{setScope(e.target.value);setContextPreview(null);}}><option value="related">相关页检索与取样</option><option value="page">仅当前页</option><option value="full">全文顺序（最多 32000 字）</option></select></label>
              <label className="small"><input type="checkbox" checked={includeHistory} onChange={e=>setIncludeHistory(e.target.checked)}/>带入当前文档最近 6 轮对话（Codex）</label>
              <button className="btn tiny" disabled={aiBusy||!source} onClick={()=>void previewContext()}>查看将发送的上下文</button>
              {contextPreview&&<details open><summary>上下文预览：{contextPreview.context_info?.characters} 字 · 第 {contextPreview.context_info?.pages.join('、')} 页 · 历史 {contextPreview.history_count||0} 轮</summary><p className="small">正文已索引 {contextPreview.context_info?.indexed_pages}/{contextPreview.context_info?.total_pages} 页。只发送以下文字，不发送 PDF 文件或整库。</p>{contextPreview.warnings?.map(w=><p className="small" key={w}>{w}</p>)}<textarea aria-label="上下文预览" readOnly rows={10} value={`${contextPreview.history||''}\n\n${contextPreview.prompt}`}/></details>}
              <div className="ai-input">
                <textarea
                  value={aiQuestion}
                  onChange={(e) => setAiQuestion(e.target.value)}
                  placeholder="就这篇论文提问，例如：HybridFlow 的 3D 并行如何拆分数据？"
                  rows={2}
                />
                <button className="btn primary" onClick={() => ask("ask")} disabled={aiBusy || !aiQuestion.trim()}>
                  提问
                </button>
              </div>
              <div className="muted small">{aiProvider==='codex'?'Codex 账号额度':'API 问答服务'}</div>
              {aiBusy && <div className="muted small">模型正在阅读原文…{aiProvider==='codex'&&<button className="btn tiny" onClick={()=>void api.aiAction('cancel',{request_id:aiRequest.current}).catch(e=>setAiError(e.message))}>停止生成</button>}</div>}
              {aiHistory.length>0&&<details><summary>对话历史（最近 {aiHistory.length} 条）</summary>{aiHistory.map(m=><div key={m.id} className="ai-history-item"><button className="btn tiny ghost" disabled={aiBusy} onClick={()=>setAiAnswer(m)}>{m.question.slice(0,100)||'回答'}</button><small>{m.model}</small></div>)}</details>}
              {aiError && <div className="error-box">{aiError}</div>}
              {aiAnswer && (
                <div className="ai-answer">
                  {aiAnswer.warnings?.map(w=><p role="alert" key={w}>{w}</p>)}
                  <div className="row-actions"><button className="btn tiny" disabled={aiBusy} onClick={()=>void api.appendNote(paper.id,`AI 阅读记录\n${aiAnswer.answer}\n\n原文依据：${aiAnswer.sources.map(s=>`[${s.n}] 第 ${s.page+1} 页 ${s.text}`).join('\n')}`).then(p=>{onChanged(p);onToast('回答已保存到笔记');}).catch(e=>onToast(e.message))}>保存到笔记</button><button className="btn tiny" disabled={aiBusy} onClick={()=>void api.saveText('论文阅读记录.md',`# ${paper.title}\n\n${aiAnswer.answer}\n\n${aiAnswer.sources.map(s=>`[${s.n}] 第 ${s.page+1} 页：${s.text}`).join('\n')}`).catch(e=>onToast(e.message))}>导出回答</button></div>
                  <MarkdownAnswer text={aiAnswer.answer}/>
                  {aiAnswer.sources.length > 0 && (
                    <div className="sources">
                      <div className="sources-title">原文依据</div>
                      {aiAnswer.sources.map((s) => (
                        <button key={s.block_id} className="source-item" onClick={() => jumpToSource(s)} title="跳转到原文">
                          <span className="source-n">[{s.n}]</span>
                          <span className="source-page">p.{s.page + 1}</span>
                          <span className="source-text">{s.text.slice(0, 120)}…</span>
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              )}
              {!aiAnswer && !aiBusy && (
                <p className="muted hint">
                  回答只依据论文原文片段；引用编号可点击回到原文。模型未配置时，原文阅读、批注与分类不受影响。
                </p>
              )}
            </div>
          )}
        </aside>
      </div>
    </div>
  );
}

function statusLabel(s: string) {
  return (
    {
      queued: "排队",
      preparing: "准备",
      parsing: "解析",
      translating: "翻译",
      typesetting: "排版",
      validating: "校验",
      completed: "完成",
      failed: "失败",
      cancelled: "已取消",
      cancelling: "取消中",
    } as Record<string, string>
  )[s] || s;
}

function phaseLabel(j: { status: string; phase?: string }) {
  if (j.status === "queued") return "排队中…";
  return j.phase ? statusLabel(j.phase) + "中…" : "处理中…";
}
