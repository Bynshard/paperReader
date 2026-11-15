import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowLeft, BookOpen, ChevronDown, ChevronLeft, ChevronRight, Copy, FileText,
  Languages, Lightbulb, ListTree, Loader2, Menu, MessageSquareQuote, Minus, MoreHorizontal, MoveHorizontal, NotebookPen, PanelRightClose,
  PanelRightOpen, Pencil, Plus, RotateCcw, Search, Send, Sparkles, Square, Trash2, Undo2, Redo2, X,
} from "lucide-react";
import type { Annotation, ImportedAttachment, Paper, PdfBytes, Source } from "./types";
import PaperEditor from "./PaperEditor";
import MarkdownAnswer from "./MarkdownAnswer";
import DocumentParsing from "./DocumentParsing";
import ImportedFiles from "./ImportedFiles";
import PdfPane, { type FindMatch, type PaneApi, type Selection } from "./PdfPane";
import FloatingLayer from "./FloatingLayer";
import ReaderNav from "./ReaderNav";
import FindBar from "./FindBar";
import { api, type ChatMessage } from "./api";

type Mode = "source" | "translated" | "dual";

type Props = {
  paper: Paper;
  onBack: () => void;
  onChanged: (p: Paper) => void;
  onToast: (msg: string) => void;
  /** Opens the global library drawer while reading. */
  onToggleNav?: () => void;
};

type Live = { question: string; answer: string; sources: Source[]; warnings?: string[] };

const HIGHLIGHT_COLORS: { key: string; label: string }[] = [
  { key: "yellow", label: "黄色高亮" },
  { key: "green", label: "绿色高亮" },
  { key: "blue", label: "蓝色高亮" },
  { key: "red", label: "红色高亮" },
];

export default function Reader({ paper, onBack, onChanged, onToast, onToggleNav }: Props) {
  const initialPosition = useMemo(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(`pos:${paper.id}`) || "{}");
      return { page: Math.max(1, Number(saved.page) || 1), fraction: Math.max(0, Math.min(1, Number(saved.fraction) || 0)) };
    } catch { return { page: 1, fraction: 0 }; }
  }, [paper.id]);
  const [textRevision, setTextRevision] = useState(0);
  const [scope, setScope] = useState("related");
  const [includeHistory, setIncludeHistory] = useState(true);
  const [contextPreview, setContextPreview] = useState<{ prompt: string; history?: string; history_count?: number; context_info?: { pages: number[]; characters: number; indexed_pages: number; total_pages: number }; warnings?: string[] } | null>(null);
  const [mode, setMode] = useState<Mode>(paper.versions.some((version) => version.kind === "translated") ? "dual" : "source");
  const [scale, setScale] = useState(1.15);
  const [page, setPage] = useState(initialPosition.page);
  const positionRef = useRef(initialPosition);
  const persistTimer = useRef<ReturnType<typeof setTimeout>>();
  const [source, setSource] = useState<PdfBytes | null>(null);
  const [translated, setTranslated] = useState<PdfBytes | null>(null);
  const [annotations, setAnnotations] = useState<Annotation[]>([]);
  const [files, setFiles] = useState<ImportedAttachment[]>([]);
  const sourceRequest = useRef(0);
  const [nativeText, setNativeText] = useState<Record<number, boolean>>({});
  const [activeSide, setActiveSide] = useState<"source" | "translated">("source");
  const [findMatches, setFindMatches] = useState<FindMatch[]>([]);
  const [findIndex, setFindIndex] = useState(0);
  const [zoomMode, setZoomMode] = useState<"custom" | "fit-width" | "fit-page">(() => {
    try { const saved = localStorage.getItem("moonlight-reader-zoom-mode"); return saved === "fit-width" || saved === "fit-page" ? saved : "custom"; } catch { return "custom"; }
  });
  useEffect(() => { try { localStorage.setItem("moonlight-reader-zoom-mode", zoomMode); } catch { /* ignore */ } }, [zoomMode]);
  const [selection, setSelection] = useState<Selection | null>(null);
  const [annotating, setAnnotating] = useState(false);
  const [activeAnnotation, setActiveAnnotation] = useState<{ annotation: Annotation; x: number; y: number } | null>(null);
  const [annotationDraft, setAnnotationDraft] = useState("");
  const [job, setJob] = useState<{ id: string; status: string; phase?: string } | null>(null);
  const [tab, setTab] = useState<"notes" | "ai">("ai");
  const [editing, setEditing] = useState(false);
  const [aiQuestion, setAiQuestion] = useState("");
  const [live, setLive] = useState<Live | null>(null);
  const aiRequest = useRef<string | null>(null);
  const previewToken = useRef(0);
  const [aiHistory, setAiHistory] = useState<ChatMessage[]>([]);
  const [aiProvider, setAiProvider] = useState("");
  const [aiBusy, setAiBusy] = useState(false);
  const [aiError, setAiError] = useState<string | null>(null);
  const composer = useRef<HTMLTextAreaElement>(null);
  const [contextAnchor, setContextAnchor] = useState<{ x: number; y: number } | null>(null);
  const contextButton = useRef<HTMLButtonElement>(null);
  const [showTranslateMenu, setShowTranslateMenu] = useState(false);
  const [loading, setLoading] = useState(true);
  const [pageInput, setPageInput] = useState("1");
  const [error, setError] = useState<string | null>(null);
  const [sideWidth, setSideWidth] = useState(() => {
    try { const saved = Number(localStorage.getItem("moonlight-reader-side-width")); return saved >= 280 && saved <= 560 ? saved : 360; } catch { return 360; }
  });
  const sideWidthRef = useRef(sideWidth); sideWidthRef.current = sideWidth;
  const [sideOpen, setSideOpen] = useState(true);
  const [navTab, setNavTab] = useState<"outline" | "pages" | null>(null);
  const [findOpen, setFindOpen] = useState(false);
  const dragging = useRef(false);
  const panesRef = useRef<HTMLDivElement>(null);
  const historyBack = useRef<{ page: number; fraction: number }[]>([]);
  const historyForward = useRef<{ page: number; fraction: number }[]>([]);
  const [historyTick, setHistoryTick] = useState(0);

  useEffect(() => { previewToken.current++; setContextPreview(null); }, [source?.versionId, page, scope, includeHistory, aiQuestion, textRevision]);

  const previewContext = async () => {
    const token = ++previewToken.current;
    try {
      const result = await api.aiAction("preview", { paper_id: paper.id, version_id: source?.versionId, question: aiQuestion, kind: "ask", scope, page: scope === "page" ? page - 1 : undefined, include_history: includeHistory });
      if (token === previewToken.current) setContextPreview(result as typeof contextPreview);
    } catch (e) {
      if (token === previewToken.current) setAiError((e as Error).message);
    }
  };

  useEffect(() => {
    let alive = true;
    api.aiHistory(paper.id).then((rows) => { if (alive) setAiHistory(rows); }).catch(() => undefined);
    api.aiPreferences().then((state) => { if (alive) setAiProvider(state.provider); }).catch(() => undefined);
    const off = api.onEvent((msg) => {
      if ((msg.event as string) === "ai_delta" && "request_id" in msg && msg.request_id === aiRequest.current && "answer" in msg) {
        setLive((current) => current ? { ...current, answer: String(msg.answer) } : current);
      }
    });
    return () => { alive = false; off(); if (aiRequest.current) void api.aiAction("cancel", { request_id: aiRequest.current }).catch(() => undefined); };
  }, [paper.id]);

  const refreshAiHistory = () => api.aiHistory(paper.id).then(setAiHistory).catch(() => undefined);
  const clearChat = async () => {
    if (!confirm("清空本篇论文的全部 AI 对话记录？")) return;
    try { await api.aiClear(paper.id); setAiHistory([]); setLive(null); onToast("本篇对话已清空"); }
    catch (e) { setAiError((e as Error).message); }
  };
  const deleteExchange = async (chatId: string) => {
    try { await api.aiDelete(chatId); await refreshAiHistory(); }
    catch (e) { setAiError((e as Error).message); }
  };
  const reloadAnnotations = async () => { const rows = await api.annotations(paper.id); setAnnotations(rows); return rows; };

  const sourceApi = useRef<PaneApi | null>(null);
  const transApi = useRef<PaneApi | null>(null);
  const activePane = useRef<"source" | "translated">("source");
  const registerSource = useCallback((pane: PaneApi | null) => { sourceApi.current = pane; pane?.goTo(positionRef.current.page, positionRef.current.fraction); }, []);
  const registerTranslated = useCallback((pane: PaneApi | null) => { transApi.current = pane; pane?.goTo(positionRef.current.page, positionRef.current.fraction); }, []);
  const remember = (p: number, fraction: number) => {
    positionRef.current = { page: p, fraction };
    setPage(p);
    clearTimeout(persistTimer.current);
    persistTimer.current = setTimeout(() => { try { localStorage.setItem(`pos:${paper.id}`, JSON.stringify(positionRef.current)); } catch { /* ignore */ } }, 250);
  };
  const navigate = (p: number, fraction = 0) => {
    remember(p, fraction);
    sourceApi.current?.goTo(p, fraction);
    transApi.current?.goTo(p, fraction);
  };
  const pushHistory = () => {
    historyBack.current.push({ ...positionRef.current });
    if (historyBack.current.length > 80) historyBack.current.shift();
    historyForward.current = [];
    setHistoryTick((tick) => tick + 1);
  };
  const jumpTo = (p: number, fraction = 0, bbox?: number[], record = true) => {
    if (record) pushHistory();
    remember(p, fraction);
    sourceApi.current?.goTo(p, fraction, bbox);
    transApi.current?.goTo(p, fraction);
  };
  const goBack = () => {
    const previous = historyBack.current.pop();
    if (!previous) return;
    historyForward.current.push({ ...positionRef.current });
    remember(previous.page, previous.fraction);
    sourceApi.current?.goTo(previous.page, previous.fraction);
    transApi.current?.goTo(previous.page, previous.fraction);
    setHistoryTick((tick) => tick + 1);
  };
  const goForward = () => {
    const next = historyForward.current.pop();
    if (!next) return;
    historyBack.current.push({ ...positionRef.current });
    remember(next.page, next.fraction);
    sourceApi.current?.goTo(next.page, next.fraction);
    transApi.current?.goTo(next.page, next.fraction);
    setHistoryTick((tick) => tick + 1);
  };
  const translatedVersions = useMemo(() => paper.versions.filter((version) => version.kind === "translated").sort((a, b) => b.created_at - a.created_at), [paper.versions]);
  const [translatedVersionId, setTranslatedVersionId] = useState<string | undefined>(() => translatedVersions[0]?.id);
  const translatedVersion = translatedVersions.find((version) => version.id === translatedVersionId) ?? translatedVersions[0];
  const sourceVersions = useMemo(() => paper.versions.filter((version) => version.kind === "source").sort((a, b) => a.created_at - b.created_at || a.id.localeCompare(b.id)), [paper.versions]);
  useEffect(() => {
    if (translatedVersions.length && !translatedVersions.some((version) => version.id === translatedVersionId)) setTranslatedVersionId(translatedVersions[0].id);
  }, [translatedVersions, translatedVersionId]);
  const isPrimary = !source || source.versionId === sourceVersions[0]?.id;
  const loadOcr = useCallback(async (pageNumber: number) => source ? (await api.blocks(paper.id, source.versionId, pageNumber)).filter((block) => block.kind === "ocr") : [], [paper.id, source?.versionId]);
  const sourceAnnotations = useMemo(() => annotations.filter((annotation) => annotation.version_kind === "source" && (!annotation.version_id || annotation.version_id === source?.versionId)), [annotations, source?.versionId]);
  const translatedAnnotations = useMemo(() => annotations.filter((annotation) => annotation.version_kind === "translated" && (!annotation.version_id || annotation.version_id === translated?.versionId)), [annotations, translated?.versionId]);

  const loadTranslated = useCallback(async () => { if (!translatedVersion) return; setTranslated(await api.pdf(paper.id, "translated", translatedVersion.id)); }, [paper.id, translatedVersion]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    (async () => {
      try {
        const bytes = paper.versions.some((version) => version.kind === "source") ? await api.pdf(paper.id, "source") : null;
        if (cancelled) return;
        setSource(bytes);
      } catch (e) {
        setError(String((e as Error).message || e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; sourceRequest.current++; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paper.id, sourceVersions[0]?.id]);

  useEffect(() => {
    let active = true;
    void Promise.all([api.annotations(paper.id), api.zoteroFiles(paper.id).catch(() => [])]).then(([rows, items]) => { if (active) { setAnnotations(rows); setFiles(items); } }).catch(() => undefined);
    return () => { active = false; };
  }, [paper]);
  useEffect(() => {
    let active = true;
    if (translatedVersion) void api.pdf(paper.id, "translated", translatedVersion.id).then((bytes) => { if (active) { setTranslated(bytes); setMode((current) => current === "source" ? "dual" : current); } }).catch(() => undefined);
    return () => { active = false; };
  }, [paper.id, translatedVersion?.id]);

  const chooseSource = async (versionId: string, targetPage = 1, fraction = 0) => {
    const request = ++sourceRequest.current;
    try {
      const bytes = await api.pdf(paper.id, "source", versionId);
      if (request !== sourceRequest.current) return;
      remember(targetPage, fraction);
      setSource(bytes); setMode("source"); chooseActive("source"); setSelection(null); setNativeText({}); setError(null); setShowTranslateMenu(false);
    } catch (e) {
      if (request === sourceRequest.current) onToast(`打开附件失败：${String(e)}`);
    }
  };

  useEffect(() => { setFindMatches([]); setFindIndex(0); }, [activeSide, source?.versionId, translated?.versionId]);
  useEffect(() => { setPageInput(String(page)); }, [page]);
  useEffect(() => () => {
    clearTimeout(persistTimer.current);
    try { localStorage.setItem(`pos:${paper.id}`, JSON.stringify(positionRef.current)); } catch { /* ignore */ }
  }, [paper.id]);

  useEffect(() => {
    return api.onEvent((event) => {
      if (!("jobId" in event)) return;
      if (!job || event.jobId !== job.id) return;
      if (event.status) setJob((current) => current ? { ...current, status: event.status!, phase: event.phase } : current);
      if (event.phase) setJob((current) => current ? { ...current, phase: event.phase } : current);
      if (event.status === "completed") {
        onToast("译文已生成");
        setJob(null);
        api.getPaper(paper.id).then(async (fresh) => {
          onChanged(fresh);
          if (fresh.versions.some((version) => version.kind === "translated")) {
            const newest = fresh.versions.filter((version) => version.kind === "translated").sort((a, b) => b.created_at - a.created_at)[0];
            if (newest) setTranslatedVersionId(newest.id);
            setTranslated(await api.pdf(paper.id, "translated", newest?.id));
            setMode((current) => current === "source" ? "dual" : current);
          }
        });
      } else if (event.status === "failed" || event.status === "cancelled") {
        onToast(event.error ? `翻译失败：${event.error}` : event.status === "cancelled" ? "翻译已取消" : "翻译失败");
        setJob(null);
      }
    });
  }, [job, onChanged, onToast, paper.id]);

  useEffect(() => {
    const move = (event: PointerEvent) => {
      if (!dragging.current) return;
      setSideWidth(Math.min(560, Math.max(280, window.innerWidth - event.clientX)));
    };
    const up = () => {
      if (!dragging.current) return;
      dragging.current = false;
      try { localStorage.setItem("moonlight-reader-side-width", String(sideWidthRef.current)); } catch { /* ignore */ }
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    return () => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up); };
  }, []);

  const chooseActive = (side: "source" | "translated") => { activePane.current = side; setActiveSide(side); };
  const clampScale = (value: number) => Math.max(0.4, Math.min(4, Number(value.toFixed(3))));
  const zoomTo = (value: number, focal?: { clientX: number; clientY: number }, keepMode = false) => {
    sourceApi.current?.prepareZoom?.(focal);
    transApi.current?.prepareZoom?.(focal);
    if (!keepMode) setZoomMode("custom");
    setScale(clampScale(value));
  };
  const applyFit = useCallback(() => {
    if (zoomMode === "custom") return;
    const pane = activeSide === "translated" ? transApi.current : sourceApi.current;
    if (!pane) return;
    pane.prepareZoom?.();
    const next = pane.fit(zoomMode === "fit-width" ? "width" : "page");
    if (next) setScale(next);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [zoomMode, activeSide]);
  useEffect(() => {
    if (zoomMode === "custom") return;
    const run = () => requestAnimationFrame(applyFit);
    const initial = setTimeout(run, 80);
    run();
    const element = panesRef.current;
    let observer: ResizeObserver | undefined;
    if (element) { observer = new ResizeObserver(run); observer.observe(element); }
    return () => { clearTimeout(initial); observer?.disconnect(); };
  }, [zoomMode, activeSide, mode, sideOpen, sideWidth, source?.versionId, translated?.versionId, applyFit]);

  useEffect(() => {
    const element = panesRef.current;
    if (!element) return;
    const wheel = (event: WheelEvent) => {
      if (!(event.ctrlKey || event.metaKey)) return;
      event.preventDefault();
      const focal = { clientX: event.clientX, clientY: event.clientY };
      sourceApi.current?.prepareZoom?.(focal);
      transApi.current?.prepareZoom?.(focal);
      setZoomMode("custom");
      setScale((current) => clampScale(current * Math.exp(-event.deltaY * 0.002)));
    };
    element.addEventListener("wheel", wheel, { passive: false });
    return () => element.removeEventListener("wheel", wheel);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const typing = !!target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.tagName === "SELECT" || target.isContentEditable);
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "f") { event.preventDefault(); setFindOpen(true); return; }
      if (event.altKey && event.key === "ArrowLeft") { event.preventDefault(); goBack(); return; }
      if (event.altKey && event.key === "ArrowRight") { event.preventDefault(); goForward(); return; }
      if (event.key === "Escape") { setFindOpen(false); setFindMatches([]); setFindIndex(0); setNavTab(null); return; }
      if (typing || !source) return;
      if (event.ctrlKey || event.metaKey) {
        if (event.key === "+" || event.key === "=") { event.preventDefault(); zoomTo(scale * 1.2); return; }
        if (event.key === "-") { event.preventDefault(); zoomTo(scale / 1.2); return; }
        if (event.key === "0") { event.preventDefault(); setZoomMode("fit-width"); return; }
      }
      if (event.key === "PageDown" || event.key === "j" || event.key === "J" || event.key === "ArrowDown" && event.shiftKey) { event.preventDefault(); navigate(Math.min(source.pages, page + 1)); }
      else if (event.key === "PageUp" || event.key === "k" || event.key === "K" || event.key === "ArrowUp" && event.shiftKey) { event.preventDefault(); navigate(Math.max(1, page - 1)); }
      else if (event.key === "Home") { event.preventDefault(); navigate(1); }
      else if (event.key === "End") { event.preventDefault(); navigate(source.pages); }
      else if (event.key === "+" || event.key === "=") { event.preventDefault(); zoomTo(scale * 1.2); }
      else if (event.key === "-") { event.preventDefault(); zoomTo(scale / 1.2); }
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page, source?.pages, source?.versionId, scale]);

  const savePosition = () => {
    const pane = activePane.current === "translated" ? transApi.current : sourceApi.current;
    if (pane) { const position = pane.getPosition(); remember(position.page, position.fraction); return position; }
    return positionRef.current;
  };

  const switchMode = async (next: Mode) => {
    const position = savePosition();
    if (next !== "source" && !translated) {
      try { await loadTranslated(); } catch { onToast("还没有可用的译文版本"); return; }
    }
    setMode(next);
    if (next === "translated") chooseActive("translated");
    else if (next === "source") chooseActive("source");
    if (next === "translated" || next === "dual") transApi.current?.goTo(position.page, position.fraction);
    if (next === "source" || next === "dual") sourceApi.current?.goTo(position.page, position.fraction);
    setSelection(null);
  };

  useEffect(() => { let alive = true; api.listJobs().then((rows) => { const active = rows.find((row) => row.paper_id === paper.id && !["completed", "failed", "cancelled"].includes(row.status)); if (alive && active) setJob({ id: active.id, status: active.status }); }).catch(() => undefined); return () => { alive = false; }; }, [paper.id]);

  const startTranslate = async (pages?: string) => {
    setShowTranslateMenu(false);
    try {
      const { job_id } = await api.startTranslate(paper.id, pages);
      setJob({ id: job_id, status: "queued" });
      onToast(pages ? `开始翻译第 ${pages} 页` : "开始翻译全文（后台运行，可继续阅读）");
    } catch (e) {
      onToast(`无法启动翻译：${String((e as Error).message || e)}`);
    }
  };

  const addHighlight = async (color: string, text = "") => {
    if (!selection) return;
    await api.addAnnotation({
      paper_id: paper.id,
      page: selection.page - 1,
      rects: selection.rects,
      quote: selection.quote,
      color,
      comment: text,
      version_kind: selection.side,
      version_id: selection.side === "source" ? source?.versionId : translated?.versionId,
    });
    setAnnotationDraft("");
    setAnnotating(false);
    setSelection(null);
    await reloadAnnotations();
    onToast("已保存划线");
  };

  const ask = async (kind: "explain" | "summary" | "ask" | "translate", explicit?: string) => {
    if (aiRequest.current) return;
    let question = explicit ?? aiQuestion;
    if (!question.trim() && kind !== "summary") return;
    if (kind === "summary") question = `总结第 ${page} 页的主要内容，并列出关键结论。`;
    if (kind === "explain" && explicit === undefined && selection) question = `解释这段原文：${selection.quote}`;
    if (kind === "translate") {
      if (!selection) return;
      question = selection.quote;
    }
    setTab("ai");
    aiRequest.current = crypto.randomUUID();
    setLive({ question, answer: "", sources: [] });
    setAiBusy(true);
    setAiError(null);
    try {
      if (kind === "summary" && source && sourceApi.current) {
        const blocks = await sourceApi.current.parsePage(page);
        if (blocks.length) { await api.setBlocks(paper.id, source.versionId, page - 1, blocks); setTextRevision((value) => value + 1); }
      }
      const result = (kind === "translate"
        ? await api.aiRun({ request_id: aiRequest.current!, paper_id: paper.id, question, kind: "translate", version_id: source?.versionId })
        : await api.aiRun({ request_id: aiRequest.current!, paper_id: paper.id, question, page: kind === "summary" ? page - 1 : kind === "explain" && selection ? selection.page - 1 : scope === "page" ? page - 1 : undefined, scope, include_history: includeHistory, kind, version_id: source?.versionId })) as { answer: string; sources: Source[]; warnings?: string[] };
      setLive({ question, answer: result.answer, sources: result.sources, warnings: result.warnings });
      await refreshAiHistory();
      setLive(null);
      if (kind === "ask") setAiQuestion("");
    } catch (e) {
      setAiError(String((e as Error).message || e));
      setLive(null);
    } finally {
      aiRequest.current = null;
      setAiBusy(false);
    }
  };

  const translateSelection = () => ask("translate");

  const quoteSelection = () => {
    if (!selection) return;
    setAiQuestion(`关于选段“${selection.quote.slice(0, 140)}”：`);
    setTab("ai");
    setSelection(null);
    setTimeout(() => composer.current?.focus(), 0);
  };

  const copySelection = async () => {
    if (!selection) return;
    try { await navigator.clipboard.writeText(selection.quote); onToast("已复制选段"); }
    catch { onToast("复制失败，请手动选择复制"); }
    setSelection(null);
  };

  const jumpToSource = async (sourceItem: Source) => {
    const target = sourceItem.page + 1;
    if (sourceItem.version_id && sourceItem.version_id !== source?.versionId) {
      await chooseSource(sourceItem.version_id, target);
      return;
    }
    jumpTo(target, 0, sourceItem.bbox);
    setMode((current) => current === "translated" ? "dual" : current);
  };

  const chooseTranslatedVersion = (versionId: string) => {
    setTranslatedVersionId(versionId);
    setTranslated(null);
    setSelection(null);
    setAnnotationDraft("");
    chooseActive("translated");
  };

  const copyAnswer = async (text: string) => {
    try { await navigator.clipboard.writeText(text); onToast("回答已复制"); } catch { onToast("复制失败"); }
  };
  const saveAnswer = async (text: string, sources: Source[]) => {
    try {
      const fresh = await api.appendNote(paper.id, `AI 阅读记录\n${text}\n\n原文依据：${sources.map((item) => `[${item.n}] 第 ${item.page + 1} 页 ${item.text}`).join("\n")}`);
      onChanged(fresh); onToast("回答已保存到笔记");
    } catch (e) { onToast((e as Error).message); }
  };
  const exportAnswer = async (text: string, sources: Source[]) => {
    try {
      await api.saveText("论文阅读记录.md", `# ${paper.title}\n\n${text}\n\n${sources.map((item) => `[${item.n}] 第 ${item.page + 1} 页：${item.text}`).join("\n")}`);
    } catch (e) { onToast((e as Error).message); }
  };

  const messages = useMemo(() => [...aiHistory].reverse(), [aiHistory]);
  const contextAnchorOf = () => { const rect = contextButton.current?.getBoundingClientRect(); if (rect) setContextAnchor({ x: rect.left + rect.width / 2, y: rect.bottom }); };
  const handleFindResults = useCallback((matches: FindMatch[], index: number) => { setFindMatches(matches); setFindIndex(index); }, []);

  if (loading) return <div className="reader loading">正在打开论文…</div>;
  if (error || !source) {
    return <div className="reader metadata-reader">
      <header className="reader-head">
        {onToggleNav && <button className="icon-btn" aria-label="打开论文库导航" onClick={onToggleNav}><Menu size={17} /></button>}
        <button className="btn ghost" onClick={onBack}><ArrowLeft size={16} />论文库</button>
        <button className="btn tiny" onClick={() => setEditing(true)}><Pencil size={14} />编辑资料</button>
      </header>
      {editing && <PaperEditor paper={paper} onClose={() => setEditing(false)} onSaved={(fresh) => { onChanged(fresh); setEditing(false); }} />}
      <div className="metadata-body">
        <h2>{paper.title}</h2>
        <p className="muted">{paper.authors}</p>
        {error ? <p role="alert">打开 PDF 失败：{error}</p> : <p className="muted">此条目没有可用的 PDF，元数据和笔记已保存。</p>}
        {paper.short_note && <p className="paper-short-note">速记：{paper.short_note}</p>}
        {paper.abstract && <p>{paper.abstract}</p>}
        {paper.notes && <section><h3>笔记</h3><div className="migrated-notes">{paper.notes}</div></section>}
        <ImportedFiles paperId={paper.id} files={files} onOpen={chooseSource} onError={onToast} />
      </div>
    </div>;
  }

  return (
    <div className="reader">
      {editing && <PaperEditor paper={paper} onClose={() => setEditing(false)} onSaved={(fresh) => { onChanged(fresh); setEditing(false); }} />}
      <header className="reader-head">
        {onToggleNav && <button className="icon-btn" aria-label="打开论文库导航" onClick={onToggleNav}><Menu size={17} /></button>}
        <button className="icon-btn" aria-label="返回论文库" title="返回论文库" onClick={onBack}><ArrowLeft size={17} /></button>
        <button className="icon-btn" aria-label="编辑论文资料" title="编辑论文资料" onClick={() => setEditing(true)}><Pencil size={15} /></button>
        <div className="reader-title" title={paper.title}>{paper.title}</div>
        <button className="icon-btn" aria-label="上次阅读位置" title="上次阅读位置（Alt+←）" disabled={!historyBack.current.length} onClick={goBack}><Undo2 size={16} /></button>
        <button className="icon-btn" aria-label="下次阅读位置" title="下次阅读位置（Alt+→）" disabled={!historyForward.current.length} onClick={goForward}><Redo2 size={16} /></button>
        <button className={navTab ? "icon-btn on" : "icon-btn"} aria-label="目录与页面导航" aria-pressed={!!navTab} title="目录大纲 / 页面缩略图" onClick={() => setNavTab(navTab ? null : "outline")}><ListTree size={16} /></button>
        <button className={findOpen ? "icon-btn on" : "icon-btn"} aria-label="查找文内关键词" title="文内查找（Ctrl+F）" onClick={() => setFindOpen((value) => !value)}><Search size={16} /></button>
        {sourceVersions.length > 1 && <select className="select compact" aria-label="原文附件" value={source.versionId} onChange={(event) => chooseSource(event.target.value)}>
          {sourceVersions.map((version, index) => <option key={version.id} value={version.id}>{files.find((file) => file.version_id === version.id)?.title || `PDF ${index + 1}`}{index === 0 ? "（主文档）" : ""}</option>)}
        </select>}
        {translatedVersions.length > 1 && <select className="select compact" aria-label="译文版本" value={translatedVersion?.id} onChange={(event) => chooseTranslatedVersion(event.target.value)}>
          {translatedVersions.map((version, index) => <option key={version.id} value={version.id}>{`译文 ${index + 1}${index === 0 ? "（最新）" : ""} · ${new Date(version.created_at).toLocaleDateString()}`}</option>)}
        </select>}
        <DocumentParsing key={source.versionId} paperId={paper.id} versionId={source.versionId} pages={source.pages} page={page} pane={sourceApi} onIndexed={() => setTextRevision((value) => value + 1)} hasText={nativeText[page]} />
        <div className="mode-switch">
          <button className={mode === "source" ? "on" : ""} onClick={() => switchMode("source")}>原文</button>
          <button className={mode === "translated" ? "on" : ""} disabled={!translated || !isPrimary} title={translated ? "" : "尚未生成译文"} onClick={() => switchMode("translated")}>译文</button>
          <button className={mode === "dual" ? "on" : ""} disabled={!translated || !isPrimary} onClick={() => switchMode("dual")}>对照</button>
        </div>
        <div className="page-nav">
          <button className="icon-btn" aria-label="上一页" onClick={() => navigate(Math.max(1, page - 1))}><ChevronLeft size={16} /></button>
          <input aria-label="跳转页码" value={pageInput} onChange={(event) => setPageInput(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") navigate(Math.max(1, Math.min(source.pages, Number(pageInput) || 1))); }} />
          <span className="muted">/ {source.pages}</span>
          <button className="icon-btn" aria-label="下一页" onClick={() => navigate(Math.min(source.pages, page + 1))}><ChevronRight size={16} /></button>
        </div>
        <div className="zoom">
          <button className="icon-btn" aria-label="缩小" onClick={() => zoomTo(scale / 1.2)}><Minus size={15} /></button>
          <select className="select compact zoom-select" aria-label="缩放比例" value={zoomValue(scale, zoomMode)} onChange={(event) => {
            const choice = event.target.value;
            if (choice === "fit-width" || choice === "fit-page") { setZoomMode(choice); return; }
            if (choice === "current") return;
            setZoomMode("custom");
            zoomTo(Number(choice));
          }}>
            <option value="current" disabled>{Math.round(scale * 100)}%</option>
            <option value="fit-width">适应页宽{zoomMode === "fit-width" ? `（${Math.round(scale * 100)}%）` : ""}</option>
            <option value="fit-page">适应整页{zoomMode === "fit-page" ? `（${Math.round(scale * 100)}%）` : ""}</option>
            {[0.4, 0.5, 0.75, 1, 1.15, 1.25, 1.5, 2, 3, 4].map((value) => <option key={value} value={value}>{Math.round(value * 100)}%</option>)}
          </select>
          <button className="icon-btn" aria-label="放大" onClick={() => zoomTo(scale * 1.2)}><Plus size={15} /></button>
          <button className={zoomMode === "fit-width" ? "icon-btn on" : "icon-btn"} aria-label="一键适应页宽" title="适应页宽（Ctrl/Cmd+0）" onClick={() => setZoomMode("fit-width")}><MoveHorizontal size={15} /></button>
        </div>
        <div className="translate-wrap">
          <button className="btn primary" title={!isPrimary ? "全文翻译当前使用主文档" : ""} onClick={() => (translated ? setShowTranslateMenu((value) => !value) : startTranslate(undefined))} disabled={!!job || !isPrimary}>
            <Languages size={15} />{job ? phaseLabel(job) : translated ? "重新翻译" : "翻译全文"}
          </button>
          {translated && <button className="icon-btn" aria-label="翻译选项" onClick={() => setShowTranslateMenu((value) => !value)} disabled={!!job || !isPrimary}><ChevronDown size={15} /></button>}
        </div>
        {job && <button className="btn tiny ghost" onClick={() => job && api.cancelJob(job.id)}><Square size={13} />取消</button>}
        <button className="icon-btn" aria-label={sideOpen ? "收起侧栏" : "展开侧栏"} title={sideOpen ? "收起侧栏" : "展开侧栏"} onClick={() => setSideOpen((value) => !value)}>{sideOpen ? <PanelRightClose size={16} /> : <PanelRightOpen size={16} />}</button>
      </header>

      {job && <div className="jobbar"><div className="jobbar-text">翻译任务 · {statusLabel(job.status)} {job.phase ? `· ${phaseLabel(job)}` : ""}</div><div className="progress"><div className={`bar ${job.status}`} /></div></div>}
      {findOpen && <FindBar key={`${activeSide}:${source.versionId}:${translated?.versionId ?? ""}`} pane={activeSide === "translated" ? transApi : sourceApi}
        onResults={handleFindResults}
        onJump={(target, bbox) => { remember(target, 0); (activeSide === "translated" ? transApi : sourceApi).current?.goTo(target, 0, bbox); }}
        onClose={() => { setFindOpen(false); setFindMatches([]); setFindIndex(0); }} />}

      <div className="reader-body">
        {navTab && <ReaderNav pane={activeSide === "translated" ? transApi : sourceApi} pages={source.pages} current={page} versionKey={`${activeSide}:${activeSide === "translated" ? translated?.versionId ?? "" : source.versionId}`} onJump={(target, fraction) => jumpTo(target, fraction)} onClose={() => setNavTab(null)} />}
        <div className={`panes mode-${mode}`} ref={panesRef}>
          {(mode === "source" || mode === "dual") && (
            <PdfPane key="source" bytes={source.bytes} scale={scale} annotations={sourceAnnotations}
              initialPage={page} initialFraction={positionRef.current.fraction} side="source" loadOcr={loadOcr} textRevision={textRevision} registerApi={registerSource}
              findMatches={activeSide === "source" ? findMatches : undefined} activeMatchIndex={activeSide === "source" ? findIndex : undefined}
              onNativeText={(index, hasText) => setNativeText((all) => all[index] === hasText ? all : { ...all, [index]: hasText })}
              onHighlightClick={(annotation, anchor) => { setActiveAnnotation({ annotation, ...anchor }); setAnnotationDraft(annotation.comment || ""); }}
              onAreaSelect={(selected) => { setSelection({ ...selected, quote: selected.quote || "（框选区域）" }); setAnnotating(true); }}
              onInternalLink={(target, fraction) => jumpTo(target, fraction)}
              onSelect={(selected) => { chooseActive("source"); setSelection(selected); setAnnotating(false); }}
              onScrollFraction={(p, fraction) => { chooseActive("source"); remember(p, fraction); if (mode === "dual") transApi.current?.goTo(p, fraction); }}
              onBlocks={(pageNo, blocks) => { if (blocks.length) api.setBlocks(paper.id, source.versionId, pageNo, blocks).catch(() => undefined); }}
            />
          )}
          {(mode === "translated" || mode === "dual") && translated && (
            <PdfPane key="translated" bytes={translated.bytes} scale={scale} annotations={translatedAnnotations}
              initialPage={page} initialFraction={positionRef.current.fraction} side="translated" registerApi={registerTranslated}
              findMatches={activeSide === "translated" ? findMatches : undefined} activeMatchIndex={activeSide === "translated" ? findIndex : undefined}
              onHighlightClick={(annotation, anchor) => { setActiveAnnotation({ annotation, ...anchor }); setAnnotationDraft(annotation.comment || ""); }}
              onAreaSelect={(selected) => { setSelection({ ...selected, quote: selected.quote || "（框选区域）" }); setAnnotating(true); }}
              onInternalLink={(target, fraction) => jumpTo(target, fraction)}
              onSelect={(selected) => { chooseActive("translated"); setSelection(selected); setAnnotating(false); }}
              onScrollFraction={(p, fraction) => { chooseActive("translated"); remember(p, fraction); if (mode === "dual") sourceApi.current?.goTo(p, fraction); }}
              onBlocks={(pageNo, blocks) => { if (blocks.length) api.setBlocks(paper.id, translated.versionId, pageNo, blocks).catch(() => undefined); }}
            />
          )}
        </div>

        {selection && (
          <FloatingLayer x={selection.anchor?.x ?? window.innerWidth / 2} y={selection.anchor?.y ?? window.innerHeight * 0.32} placement="above" boundsTop={56} onClose={() => { setSelection(null); setAnnotating(false); }} className="selection-toolbar" label="选区操作">
            <div className="selection-row">
              {HIGHLIGHT_COLORS.map((color) => <button key={color.key} className={`color-dot ${color.key}`} onClick={() => void addHighlight(color.key)} title={color.label} aria-label={color.label}><span className="sr-only">{color.label}</span></button>)}
              <span className="toolbar-sep" />
              <button className={annotating ? "tool on" : "tool"} onClick={() => setAnnotating((value) => !value)} title="写批注"><NotebookPen size={15} /><span className="sr-only">批注</span></button>
              {selection.area ? <span className="area-label">框选区域</span> : <>
                <button className="tool" onClick={() => void translateSelection()} title="翻译选段"><Languages size={15} /><span className="sr-only">翻译</span></button>
                <button className="tool" title="AI 解释选段" onClick={() => void ask("explain", `解释这段原文：${selection.quote}`)}><Sparkles size={15} /><span className="sr-only">解释</span></button>
                <button className="tool" title="引用选段提问" onClick={quoteSelection}><MessageSquareQuote size={15} /><span className="sr-only">引用提问</span></button>
                <button className="tool" title="复制选段" onClick={() => void copySelection()}><Copy size={15} /><span className="sr-only">复制</span></button>
              </>}
              <button className="tool subtle" aria-label="关闭选区工具" onClick={() => setSelection(null)}><X size={14} /></button>
            </div>
            {annotating && <div className="selection-note">
              <textarea aria-label="批注内容" rows={2} value={annotationDraft} placeholder="写一条批注…" onChange={(event) => setAnnotationDraft(event.target.value)} />
              <button className="btn tiny primary" onClick={() => void addHighlight("yellow", annotationDraft)}>保存批注</button>
            </div>}
            <div className="selection-quote-small">“{selection.quote.slice(0, 90)}{selection.quote.length > 90 ? "…" : ""}”</div>
          </FloatingLayer>
        )}

        {activeAnnotation && (
          <FloatingLayer x={activeAnnotation.x} y={activeAnnotation.y} placement="auto" onClose={() => setActiveAnnotation(null)} className="annotation-popover" label="高亮批注">
            <div className="annotation-head"><span className={`color-dot ${activeAnnotation.annotation.color}`} /><span className="small">第 {activeAnnotation.annotation.page + 1} 页</span><button className="icon-btn" aria-label="关闭批注" onClick={() => setActiveAnnotation(null)}><X size={13} /></button></div>
            <p className="annotation-quote">“{activeAnnotation.annotation.quote.slice(0, 160)}…”</p>
            <div className="selection-row">
              {HIGHLIGHT_COLORS.map((color) => <button key={color.key} className={`color-dot ${color.key}`} title={color.label} aria-label={`改为${color.label}`} onClick={async () => { await api.updateAnnotation(activeAnnotation.annotation.id, { color: color.key }); await reloadAnnotations(); setActiveAnnotation(null); }}><span className="sr-only">{color.label}</span></button>)}
              <button className="tool" title="跳转到原文" onClick={() => { const annotation = activeAnnotation.annotation; setActiveAnnotation(null); remember(annotation.page + 1, annotation.rects[0]?.y ?? 0); if (annotation.version_kind === "translated") { setMode("translated"); chooseActive("translated"); transApi.current?.goTo(annotation.page + 1, annotation.rects[0]?.y ?? 0); } else { setMode("source"); chooseActive("source"); sourceApi.current?.goTo(annotation.page + 1, annotation.rects[0]?.y ?? 0); } }}><BookOpen size={14} /><span className="sr-only">跳转</span></button>
              <button className="tool danger" title="删除高亮" onClick={async () => { await api.deleteAnnotation(activeAnnotation.annotation.id); await reloadAnnotations(); setActiveAnnotation(null); }}><Trash2 size={14} /><span className="sr-only">删除</span></button>
            </div>
            <textarea aria-label="高亮批注内容" rows={2} value={annotationDraft} placeholder="补充批注…" onChange={(event) => setAnnotationDraft(event.target.value)} />
            <button className="btn tiny" onClick={async () => { await api.updateAnnotation(activeAnnotation.annotation.id, { comment: annotationDraft }); await reloadAnnotations(); setActiveAnnotation(null); onToast("批注已保存"); }}>保存批注</button>
          </FloatingLayer>
        )}

        {sideOpen && (
          <aside className="side" style={{ width: sideWidth, flexBasis: sideWidth }}>
            <div className="side-resizer" role="separator" aria-label="拖动调整侧栏宽度" onPointerDown={() => { dragging.current = true; }} />
            <div className="side-tabs">
              <button className={tab === "ai" ? "on" : ""} onClick={() => setTab("ai")}><Sparkles size={14} />阅读助手</button>
              <button className={tab === "notes" ? "on" : ""} onClick={() => setTab("notes")}><NotebookPen size={14} />笔记 {annotations.length > 0 && <span className="badge">{annotations.length}</span>}</button>
            </div>

            {tab === "notes" && (
              <div className="notes">
                {paper.notes && <section><h3>迁入笔记</h3><div className="migrated-notes">{paper.notes}</div></section>}
                <ImportedFiles paperId={paper.id} files={files} onOpen={chooseSource} onError={onToast} />
                <p className="muted hint">在 PDF 中选中文字即可就地高亮、批注、翻译或提问；点击已有高亮可修改颜色或批注。</p>
                {annotations.length === 0 && <p className="muted small">还没有划线或批注。</p>}
                {annotations.map((annotation) => (
                  <div className="note-item" key={annotation.id}>
                    <div className="note-quote"><span className={`color-dot small ${annotation.color}`} />{annotation.quote.slice(0, 180)}</div>
                    {annotation.comment && <div className="note-comment">{annotation.comment}</div>}
                    <div className="note-meta">
                      <span>第 {annotation.page + 1} 页</span>
                      <button className="link" onClick={() => {
                        if (annotation.version_kind === "source" && annotation.version_id && annotation.version_id !== source.versionId) { void chooseSource(annotation.version_id, annotation.page + 1, annotation.rects[0]?.y ?? 0); return; }
                        remember(annotation.page + 1, annotation.rects[0]?.y ?? 0);
                        setMode(annotation.version_kind === "translated" ? "translated" : "source");
                        (annotation.version_kind === "translated" ? transApi : sourceApi).current?.goTo(annotation.page + 1, annotation.rects[0]?.y ?? 0);
                      }}>跳转</button>
                      <button className="link danger" onClick={() => api.deleteAnnotation(annotation.id).then(reloadAnnotations)}>删除</button>
                    </div>
                  </div>
                ))}
              </div>
            )}

            {tab === "ai" && (
              <div className="ai">
                <div className="ai-quick">
                  <button className={aiBusy ? "chip-action disabled" : "chip-action"} onClick={() => void ask("summary")} disabled={aiBusy}><FileText size={14} />总结本页</button>
                  <button className="chip-action" disabled={aiBusy} onClick={() => void ask("ask", "提炼这篇论文的核心贡献与创新点。")}><Lightbulb size={14} />提炼核心贡献</button>
                  <button ref={contextButton} className="icon-btn" aria-label="上下文设置" aria-expanded={!!contextAnchor} onClick={() => contextAnchor ? setContextAnchor(null) : contextAnchorOf()}><MoreHorizontal size={16} /></button>
                  <button className="icon-btn" aria-label="清空本篇对话" title="清空本篇对话" disabled={!aiHistory.length || aiBusy} onClick={() => void clearChat()}><Trash2 size={15} /></button>
                </div>

                {contextAnchor && (
                  <FloatingLayer x={contextAnchor.x} y={contextAnchor.y} onClose={() => setContextAnchor(null)} ignore={contextButton} className="context-menu-panel" label="上下文设置">
                    <label className="small">提问上下文
                      <select aria-label="提问上下文" value={scope} disabled={aiBusy} onChange={(event) => { setScope(event.target.value); setContextPreview(null); }}>
                        <option value="related">相关页检索与取样</option><option value="page">仅当前页</option><option value="full">全文顺序（最多 32000 字）</option>
                      </select>
                    </label>
                    <label className="small check"><input type="checkbox" checked={includeHistory} onChange={(event) => setIncludeHistory(event.target.checked)} />带入最近 6 轮对话（Codex）</label>
                    <button className="btn tiny" disabled={aiBusy || !source} onClick={() => void previewContext()}>查看将发送的上下文</button>
                    {contextPreview && <details open>
                      <summary>上下文预览：{contextPreview.context_info?.characters} 字 · 第 {contextPreview.context_info?.pages.join("、")} 页 · 历史 {contextPreview.history_count || 0} 轮</summary>
                      <p className="small muted">正文已索引 {contextPreview.context_info?.indexed_pages}/{contextPreview.context_info?.total_pages} 页。只发送以下文字，不发送 PDF 文件或整库。</p>
                      {contextPreview.warnings?.map((warning) => <p className="small" key={warning}>{warning}</p>)}
                      <textarea aria-label="上下文预览" readOnly rows={8} value={`${contextPreview.history || ""}\n\n${contextPreview.prompt}`} />
                    </details>}
                  </FloatingLayer>
                )}

                <div className="chat" aria-label="对话记录">
                  {messages.map((message) => <Exchange key={message.id} message={message} onJump={jumpToSource} onCopy={copyAnswer} onSave={saveAnswer} onExport={exportAnswer}
                    onDelete={(id) => void deleteExchange(id)} onRegenerate={(question) => { setAiQuestion(question); void ask("ask", question); }} />)}
                  {live && <Exchange message={{ id: "live", kind: "ask", question: live.question, answer: live.answer, sources: live.sources, warnings: live.warnings }} busy={aiBusy} onJump={jumpToSource} onCopy={copyAnswer} onSave={saveAnswer} onExport={exportAnswer} />}
                  {messages.length === 0 && !live && <div className="chat-empty"><Sparkles size={26} /><p>就这篇论文提问，或从选段直接发起解释与翻译。</p><span className="muted small">回答只依据论文原文片段；引用编号可点击回到原文。</span></div>}
                </div>

                <div className="composer">
                  {selection && <div className="quote-bar"><MessageSquareQuote size={13} /><span>引用选段：{selection.quote.slice(0, 60)}{selection.quote.length > 60 ? "…" : ""}</span><button className="icon-btn" aria-label="取消引用" onClick={() => setSelection(null)}><X size={12} /></button></div>}
                  <textarea ref={composer} aria-label="论文提问" value={aiQuestion} placeholder="就这篇论文提问，例如：HybridFlow 的 3D 并行如何拆分数据？" rows={2}
                    onChange={(event) => setAiQuestion(event.target.value)}
                    onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); void ask("ask"); } }} />
                  <div className="composer-foot">
                    <span className="muted small">{aiProvider === "codex" ? "Codex 账号额度" : "API 问答服务"} · Enter 发送 / Shift+Enter 换行</span>
                    {aiBusy
                      ? (aiProvider === "codex"
                        ? <button className="btn tiny" aria-label="停止生成" onClick={() => { if (aiRequest.current) void api.aiAction("cancel", { request_id: aiRequest.current }).catch((e) => setAiError(e.message)); }}><Square size={13} />停止</button>
                        : <span className="muted small">模型处理中…</span>)
                      : <button className="btn primary tiny" aria-label="发送问题" disabled={!aiQuestion.trim()} onClick={() => void ask("ask")}><SendIcon /></button>}
                  </div>
                </div>
                {aiError && <div className="error-box" role="alert">{aiError}</div>}
              </div>
            )}
          </aside>
        )}
        {!sideOpen && <button className="side-reopen icon-btn" aria-label="展开侧栏" onClick={() => setSideOpen(true)}><PanelRightOpen size={16} /></button>}
      </div>

      {showTranslateMenu && (
        <FloatingLayer x={window.innerWidth - 60} y={64} onClose={() => setShowTranslateMenu(false)} className="menu translate-floating" label="翻译选项">
          <button onClick={() => void startTranslate(String(page))}>只翻译当前页（第 {page} 页）</button>
          <button onClick={() => void startTranslate(undefined)}>翻译全文</button>
        </FloatingLayer>
      )}
    </div>
  );
}

function Exchange({ message, busy, onJump, onCopy, onSave, onExport, onDelete, onRegenerate }: {
  message: ChatMessage; busy?: boolean;
  onJump: (source: Source) => void; onCopy: (text: string) => void;
  onSave: (text: string, sources: Source[]) => void; onExport: (text: string, sources: Source[]) => void;
  onDelete?: (id: string) => void; onRegenerate?: (question: string) => void;
}) {
  const sources = message.sources || [];
  const saved = message.id !== "live";
  return (
    <div className="exchange">
      {message.question && <div className="bubble user">{message.question}</div>}
      <div className="bubble assistant">
        <div className="assistant-head">
          <Sparkles size={13} />
          <span>阅读助手</span>
          {busy && <Loader2 className="spin" size={13} />}
          <div className="assistant-tools">
            {saved && message.kind !== "translate" && <button className="icon-btn" aria-label="重新生成" title="重新生成" onClick={() => onRegenerate?.(message.question)}><RotateCcw size={13} /></button>}
            {saved && <button className="icon-btn" aria-label="删除这条问答" title="删除这条问答" onClick={() => onDelete?.(message.id)}><Trash2 size={13} /></button>}
            <button className="icon-btn" aria-label="复制回答" title="复制回答" onClick={() => onCopy(message.answer)}><Copy size={13} /></button>
            <button className="icon-btn" aria-label="保存到笔记" title="保存到笔记" onClick={() => onSave(message.answer, sources)}><NotebookPen size={13} /></button>
            <button className="icon-btn" aria-label="导出回答" title="导出回答" onClick={() => onExport(message.answer, sources)}><FileText size={13} /></button>
          </div>
        </div>
        {message.warnings?.map((warning) => <p role="alert" key={warning}>{warning}</p>)}
        {message.answer ? <MarkdownAnswer text={message.answer} /> : <div className="muted small"><Loader2 className="spin" size={13} /> 模型正在阅读原文…</div>}
        {sources.length > 0 && <div className="citation-row">{sources.map((source) => <button key={source.block_id} className="citation-pill" title={source.text.slice(0, 160)} onClick={() => onJump(source)}>[{source.n}] p.{source.page + 1}</button>)}</div>}
      </div>
    </div>
  );
}

function SendIcon() {
  return <Send size={14} className="send-icon" />;
}

function zoomValue(scale: number, mode: "custom" | "fit-width" | "fit-page") {
  if (mode !== "custom") return mode;
  return [0.4, 0.5, 0.75, 1, 1.15, 1.25, 1.5, 2, 3, 4].includes(scale) ? String(scale) : "current";
}

function statusLabel(status: string) {
  return ({ queued: "排队", preparing: "准备", parsing: "解析", translating: "翻译", typesetting: "排版", validating: "校验", completed: "完成", failed: "失败", cancelled: "已取消", cancelling: "取消中" } as Record<string, string>)[status] || status;
}
function phaseLabel(job: { status: string; phase?: string }) {
  if (job.status === "queued") return "排队中…";
  return job.phase ? statusLabel(job.phase) + "中…" : "处理中…";
}
