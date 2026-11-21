import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import {
  ArrowLeft, BookOpen, ChevronDown, ChevronLeft, ChevronRight, Copy, Crop, FileText,
  Languages, Lightbulb, ListTree, Loader2, Lock, Maximize2, Menu, MessageSquareQuote, Minimize2, Minus, MoreHorizontal, MoveHorizontal, NotebookPen, PanelRightClose,
  PanelRightOpen, Pencil, Plus, RotateCcw, Search, Send, Sparkles, Square, Trash2, Undo2, Redo2, X,
} from "lucide-react";
import type { Annotation, Block, ImportedAttachment, Paper, PdfBytes, Source } from "./types";
import PaperEditor from "./PaperEditor";
import MarkdownAnswer from "./MarkdownAnswer";
import DocumentParsing from "./DocumentParsing";
import ImportedFiles from "./ImportedFiles";
import PdfPane, { type FindMatch, type PaneApi, type Selection, type TextReference } from "./PdfPane";
import FloatingLayer from "./FloatingLayer";
import ReaderNav from "./ReaderNav";
import FindBar from "./FindBar";
import { api, type ChatMessage } from "./api";
import { annotationsOnTranslatedPages, sourcePageForTranslated, translatedPageNumber } from "./pageMap";
import { interpolatedTargetFraction } from "./readerScroll";

type Mode = "source" | "translated" | "dual";

type Props = {
  paper: Paper;
  onBack: () => void;
  onChanged: (p: Paper) => void;
  onToast: (msg: string) => void;
  /** Opens the global library drawer while reading. */
  onToggleNav?: () => void;
  /** Deep link from a search hit / task: open on this one-based page. */
  initialPage?: number;
  /** Search query to prefill and run in the in-document find bar. */
  initialSearch?: string;
  /** Version that produced the search hit (translated hits must search the translated pane). */
  initialVersionId?: string;
  /** False while this reader is a hidden Multi-Tab; global shortcuts must pause. */
  active?: boolean;
  /** Jumps straight into Settings (translation engine / AI assistant) from a first-run hint. */
  onOpenSettings?: (tab: "translation" | "ai") => void;
};

/**
 * Maps a backend error to the Settings tab that can fix it. Recognises the
 * unconfigured-credentials / Codex login wording and missing BabelDOC engine
 * (FEAT-UX-01); returns null for ordinary reading errors.
 */
function settingsTabForError(message: string | null | undefined): "translation" | "ai" | null {
  const text = String(message ?? "").trim();
  if (!text) return null;
  if (/babeldoc|翻译引擎|翻译组件|未安装.{0,12}(翻译|babel)|缺少.{0,8}翻译/i.test(text)) return "translation";
  if (/api[\s_-]?key|apikey|凭据|credential|codex|请先登录|登录.{0,8}codex|未配置.{0,12}(模型|ai|助手|服务)/i.test(text)) return "ai";
  return null;
}

type Live = { question: string; answer: string; sources: Source[]; warnings?: string[] };

/**
 * Reads the server-side reading position (Schema v3). `get_paper` always
 * returns the four `last_read_*` keys, `null` until the paper is first opened.
 * The backend stores a zero-based page; the reader works with one-based pages.
 */
function savedReadingPosition(paper: Paper) {
  const row = paper as Paper & {
    last_read_page?: number | null; last_read_fraction?: number | null;
    last_read_mode?: string | null; last_read_at?: number | null;
  };
  const rawPage = Number(row.last_read_page);
  const rawFraction = Number(row.last_read_fraction);
  const storedMode = row.last_read_mode;
  const mode: Mode | null = storedMode === "source" || storedMode === "translated" || storedMode === "dual" ? storedMode : null;
  const page = Number.isFinite(rawPage) && rawPage >= 0 ? Math.floor(rawPage) + 1 : 1;
  return {
    page,
    fraction: Number.isFinite(rawFraction) ? Math.max(0, Math.min(1, rawFraction)) : 0,
    mode,
    /** False when this paper has never been opened: nothing to restore. */
    stored: Number.isFinite(rawPage) && rawPage >= 0,
  };
}

const HIGHLIGHT_COLORS: { key: string; label: string; name: string }[] = [
  { key: "yellow", label: "核心结论", name: "黄色高亮" },
  { key: "green", label: "方法与公式", name: "绿色高亮" },
  { key: "blue", label: "实验与数据", name: "蓝色高亮" },
  { key: "red", label: "存疑与局限", name: "红色高亮" },
];

/** Standard close-reading skeleton inserted by “套用精读模板”. */
const NOTE_TEMPLATE = "## 一句话总结 (TL;DR)\n\n## 核心问题与动机\n\n## 方法与关键技术\n\n## 实验结果与复现要点\n\n## 我的启发 / 存疑\n";

/** `1-5, 8` style page ranges accepted by the custom translation option. */
const PAGE_RANGE_PATTERN = /^\d+(-\d+)?(\s*,\s*\d+(-\d+)?)*$/;

/** 1–2 touch-first prompt pills inferred from the selected text (§3.4.2). */
function contextualChips(text: string): { label: string; question: string }[] {
  const value = text.trim();
  if (!value) return [];
  const chips: { label: string; question: string }[] = [];
  if (/[=∑∫√±≈≤≥]|\\frac|\\sum|\bEq\.|\bequation\b|\b[A-Za-z]\s*=\s*[A-Za-z0-9(]/.test(value)) {
    chips.push({ label: "∑ 解释公式符号", question: `逐项解释这段公式中每个符号的含义与作用：${value}` });
    chips.push({ label: "推导前后逻辑", question: `推导这段公式前后的逻辑关系，说明它为什么成立、依赖哪些假设：${value}` });
  } else if (/\b(table|ablation|baseline|outperform|accuracy|f1|bleu)\b|%|表\s*\d/i.test(value)) {
    chips.push({ label: "📊 提炼实验对比", question: `从实验设计与对比角度总结这段内容：基线、指标、结论与可能的偏差：${value}` });
  } else if (/[A-Za-z]{4,}/.test(value) && value.length > 40) {
    chips.push({ label: "精简释义", question: `用简体中文精简解释这段英文的含义及其在论文上下文中的作用：${value}` });
  }
  return chips.slice(0, 2);
}

/** Three-state verdict of 「核查原文依据」 (FEAT-AI-05). */
export type ClaimVerdict = "supported" | "conditional" | "unsupported";

export const CLAIM_VERDICT_LABELS: Record<ClaimVerdict, string> = {
  supported: "支持",
  conditional: "部分支持",
  unsupported: "未提及或矛盾",
};

/** Maps the backend verdict (possibly unknown/legacy wording) to its badge label. */
export function claimVerdictLabel(verdict: string | null | undefined): string {
  const key = String(verdict ?? "").trim().toLowerCase() as ClaimVerdict;
  return CLAIM_VERDICT_LABELS[key] ?? "未判定";
}

const CLAIM_VERDICT_COLORS: Record<string, string> = {
  supported: "#1a7f37", conditional: "#9a6700", unsupported: "#b42318",
};

/** Inline colours keep this feature out of the shared styles.css (owned elsewhere). */
function claimVerdictStyle(verdict: string | null | undefined): { color: string; background: string } {
  const key = String(verdict ?? "").trim().toLowerCase();
  const color = CLAIM_VERDICT_COLORS[key] ?? "#57606a";
  return { color, background: `${color}18` };
}

/**
 * FEAT-AI-01: pick the canonical block for a clicked text reference among the
 * blocks `search_blocks` returned. Caption-prefixed blocks beat in-text
 * mentions, a right-aligned `(N)` beats a mid-sentence equation, and a
 * reference-list entry beats an inline `[N]` citation.
 */
export function pickReferenceBlock(reference: TextReference, blocks: Block[], pageCount = 0): Block | null {
  const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const numbers = reference.number.split(",").map((value) => value.trim()).filter(Boolean).map(escape);
  if (!numbers.length) return null;
  const any = numbers.join("|");
  let best: { block: Block; score: number } | null = null;
  for (const block of blocks) {
    if (!block || !Array.isArray(block.bbox) || block.bbox.length !== 4) continue;
    const text = String(block.text ?? "").replace(/\s+/g, " ").trim();
    if (!text) continue;
    let score = 0;
    if (reference.kind === "figure" || reference.kind === "table" || reference.kind === "algorithm" || reference.kind === "section") {
      const prefix = reference.kind === "figure" ? "fig(?:ure)?"
        : reference.kind === "table" ? "tab(?:le)?"
          : reference.kind === "algorithm" ? "alg(?:orithm)?" : "sec(?:tion)?";
      const caption = new RegExp(`^\\s*${prefix}\\.?\\s*(?:${any})(?!\\d)`, "i");
      const inline = new RegExp(`${prefix}\\.?\\s*(?:${any})(?!\\d)`, "i");
      score = caption.test(text) ? 100 : inline.test(text) ? 70 : 15;
      // Captions are short: shrink the score of long paragraphs carrying the hit.
      score -= Math.min(30, Math.floor(text.length / 200));
    } else if (reference.kind === "equation") {
      const closed = new RegExp(`\\(\\s*(?:${any})\\s*\\)\\s*$`);
      const anywhere = new RegExp(`\\(\\s*(?:${any})\\s*\\)`);
      score = closed.test(text) ? 100 : anywhere.test(text) ? 70 : 15;
      score -= Math.min(20, Math.floor(text.length / 200));
    } else {
      const entry = new RegExp(`^\\s*(?:\\[\\s*(?:${any})\\s*\\]|(?:${any})\\.)`);
      const inline = new RegExp(`\\[\\s*(?:${any})\\s*\\]`);
      score = entry.test(text) ? 100 : inline.test(text) ? 55 : 10;
      // A reference list sits in the back matter of the paper.
      if (pageCount > 0 && Number(block.page) >= pageCount * 0.7) score += 25;
      score -= Math.min(20, Math.floor(text.length / 200));
    }
    if (!best || score > best.score) best = { block, score };
  }
  return best?.block ?? null;
}

export default function Reader({ paper, onBack, onChanged, onToast, onToggleNav, initialPage, initialSearch, initialVersionId, active = true, onOpenSettings }: Props) {
  // Reading progress lives in the library database (Schema v3) and is written
  // through `set_reading_position`; only per-device UI settings stay local.
  const initialReading = useMemo(() => {
    const saved = savedReadingPosition(paper);
    // A search hit / task deep link wins over the stored cursor exactly once.
    return initialPage && initialPage > 0 ? { ...saved, page: initialPage, fraction: 0, stored: true } : saved;
  }, [paper.id, initialPage]);
  const initialPosition = useMemo(() => ({ page: initialReading.page, fraction: initialReading.fraction }), [initialReading]);
  // A library full-text hit may come from the translated PDF. Chinese queries
  // (or a snippet explicitly bound to a translated version) must search that
  // pane, otherwise FindBar would report "no match" against the English source.
  const paperHasTranslation = paper.versions.some((version) => version.kind === "translated");
  const initialVersionIsTranslated = !!initialVersionId && paper.versions.some((version) => version.id === initialVersionId && version.kind === "translated");
  const initialSearchIsChinese = /[\u4e00-\u9fff]/.test(initialSearch ?? "");
  const searchOnTranslatedSide = !!initialSearch && paperHasTranslation && (initialVersionIsTranslated || initialSearchIsChinese);
  const [textRevision, setTextRevision] = useState(0);
  const [scope, setScope] = useState("related");
  const [includeHistory, setIncludeHistory] = useState(true);
  const [contextPreview, setContextPreview] = useState<{ prompt: string; history?: string; history_count?: number; context_info?: { pages: number[]; characters: number; indexed_pages: number; total_pages: number }; warnings?: string[] } | null>(null);
  const [mode, setMode] = useState<Mode>(() => {
    const hasTranslation = paperHasTranslation;
    // Restore the last reading mode, but only when it is still meaningful
    // (translated/dual need a translated version to exist).
    if (searchOnTranslatedSide) return "dual";
    if (initialReading.mode === "source") return "source";
    if (initialReading.mode && hasTranslation) return initialReading.mode;
    return hasTranslation ? "dual" : "source";
  });
  /** Set while the restored mode must survive the first translated-PDF load. */
  const restoredMode = useRef<Mode | null>(searchOnTranslatedSide ? "dual" : initialReading.mode);
  const modeRef = useRef<Mode>(mode); modeRef.current = mode;
  const [scale, setScale] = useState(1.15);
  const [page, setPage] = useState(initialPosition.page);
  const positionRef = useRef(initialPosition);
  const persistTimer = useRef<ReturnType<typeof setTimeout>>();
  const [source, setSource] = useState<PdfBytes | null>(null);
  const [translated, setTranslated] = useState<PdfBytes | null>(null);
  /** Mirrors translatedVersion.page_map; readable by callbacks defined before it. */
  const pageMapRef = useRef<number[] | null | undefined>(null);
  const [annotations, setAnnotations] = useState<Annotation[]>([]);
  const [files, setFiles] = useState<ImportedAttachment[]>([]);
  const sourceRequest = useRef(0);
  const [nativeText, setNativeText] = useState<Record<number, boolean>>({});
  // Restored "translated" mode must open on the translated pane, otherwise the
  // narrow single-pane layout would show the source pane and look stuck.
  const [activeSide, setActiveSide] = useState<"source" | "translated">(searchOnTranslatedSide || mode === "translated" ? "translated" : "source");
  const [findMatches, setFindMatches] = useState<FindMatch[]>([]);
  const [findIndex, setFindIndex] = useState(0);
  const [zoomMode, setZoomMode] = useState<"custom" | "fit-width" | "fit-page">(() => {
    try { const saved = localStorage.getItem("moonlight-reader-zoom-mode"); return saved === "fit-width" || saved === "fit-page" ? saved : "custom"; } catch { return "custom"; }
  });
  useEffect(() => { try { localStorage.setItem("moonlight-reader-zoom-mode", zoomMode); } catch { /* ignore */ } }, [zoomMode]);
  // Auto-crop margins is a per-device display preference: it changes nothing in
  // the PDF bytes nor in the normalised 0-1 annotation coordinates.
  const [autoCrop, setAutoCrop] = useState(() => {
    try { return localStorage.getItem("moonlight-reader-autocrop") === "1"; } catch { return false; }
  });
  useEffect(() => { try { localStorage.setItem("moonlight-reader-autocrop", autoCrop ? "1" : "0"); } catch { /* ignore */ } }, [autoCrop]);
  /** "select" = normal text selection, "area" = explicit marquee tool (Alt/stylus still work). */
  const [tool, setTool] = useState<"select" | "area">("select");
  /** Tablet portrait/narrow layout (vivo Pad 5 Pro: 917dp wide when portrait). */
  const [narrow, setNarrow] = useState(false);
  const [sheetFull, setSheetFull] = useState(false);
  const [cropTick, setCropTick] = useState(0);
  const cropRefit = useRef(0);
  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return;
    const query = window.matchMedia("(max-width: 1050px)");
    const sync = () => { setNarrow(query.matches); if (!query.matches) setSheetFull(false); };
    sync();
    query.addEventListener?.("change", sync);
    return () => query.removeEventListener?.("change", sync);
  }, []);
  const [pageBlocks, setPageBlocks] = useState<{ page: number; source: Block[]; translated: Block[] } | null>(null);
  const [aligned, setAligned] = useState<{ page: number; source?: number[]; translated?: number[] } | null>(null);
  const blockCache = useRef(new Map<string, Block[]>());
  const scrollToken = useRef(0);
  const [translatedBlockRevision, setTranslatedBlockRevision] = useState(0);
  const [selection, setSelection] = useState<Selection | null>(null);
  const [annotating, setAnnotating] = useState(false);
  const [activeAnnotation, setActiveAnnotation] = useState<{ annotation: Annotation; x: number; y: number } | null>(null);
  const [annotationDraft, setAnnotationDraft] = useState("");
  // Colour chosen while composing an annotation. Direct colour-dot clicks keep
  // saving immediately; only the "write annotation" flow uses this draft.
  const [draftColor, setDraftColor] = useState("yellow");
  const [job, setJob] = useState<{ id: string; status: string; phase?: string; progress?: number; detail?: string; startedAt: number } | null>(null);
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
  // UX-BUG-01: always offer “current page / custom range / full text”, even
  // before any translated version exists.
  const [translateRange, setTranslateRange] = useState("");
  const [translateRangeOpen, setTranslateRangeOpen] = useState(false);
  const [translateRangeError, setTranslateRangeError] = useState("");
  // UX-BUG-02: single-shot marquee by default; double-tap locks it for figures.
  const [areaLocked, setAreaLocked] = useState(false);
  const areaTap = useRef(0);
  // UX-BUG-03: in-place vocabulary/translation bubble (never hijacks the AI tab
  // or writes ephemeral look-ups into the persistent chat history).
  const [quickResult, setQuickResult] = useState<{
    kind: "translate" | "explain" | "claim"; quote: string; answer: string;
    loading: boolean; error?: string; x: number; y: number; imageDataUrl?: string;
    /** FEAT-AI-05: three-state verdict of 「核查原文依据」. */
    verdict?: ClaimVerdict;
  } | null>(null);
  const quickRequest = useRef<string | null>(null);
  // Sioyek-style internal-link preview + a pinned corner portal.
  const [preview, setPreview] = useState<{ page: number; fraction: number; src: string; loading: boolean; x: number; y: number; side: "source" | "translated" } | null>(null);
  const [pinned, setPinned] = useState<{ page: number; fraction: number; src: string; x: number; y: number; side: "source" | "translated" } | null>(null);
  const pinDrag = useRef<{ dx: number; dy: number } | null>(null);
  // Resizable dual-pane split.
  const [splitRatio, setSplitRatio] = useState(() => {
    try { const saved = Number(localStorage.getItem("moonlight-reader-split")); return saved >= 0.28 && saved <= 0.72 ? saved : 0.5; } catch { return 0.5; }
  });
  const splitDrag = useRef<{ left: number; width: number } | null>(null);
  const [digest, setDigest] = useState<Paper["digest"]>(paper.digest ?? null);
  const [digestBusy, setDigestBusy] = useState(false);
  const [clock, setClock] = useState(Date.now());
  // UX-BUG-04: the notes tab is a live Markdown editor with 600 ms autosave.
  const [noteDraft, setNoteDraft] = useState(paper.notes || "");
  const noteDraftRef = useRef(noteDraft); noteDraftRef.current = noteDraft;
  const savedNote = useRef(paper.notes || "");
  const noteTimer = useRef<ReturnType<typeof setTimeout>>();
  const noteArea = useRef<HTMLTextAreaElement>(null);
  const [noteState, setNoteState] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [notePreview, setNotePreview] = useState(false);
  const [colorFilter, setColorFilter] = useState<string | null>(null);
  const [editingComment, setEditingComment] = useState<{ id: string; text: string } | null>(null);
  const [loading, setLoading] = useState(true);
  const [pageInput, setPageInput] = useState("1");
  const [error, setError] = useState<string | null>(null);
  const [sideWidth, setSideWidth] = useState(() => {
    try { const saved = Number(localStorage.getItem("moonlight-reader-side-width")); return saved >= 280 && saved <= 560 ? saved : 360; } catch { return 360; }
  });
  const sideWidthRef = useRef(sideWidth); sideWidthRef.current = sideWidth;
  const [sideOpen, setSideOpen] = useState(true);
  const [navTab, setNavTab] = useState<"outline" | "pages" | "figures" | null>(null);
  /** First-run guidance banner when a credential / BabelDOC error is actionable. */
  const [settingsHint, setSettingsHint] = useState<{ message: string; tab: "translation" | "ai" } | null>(null);
  const noteSettingsHint = (message: string) => {
    if (!onOpenSettings) return;
    const tab = settingsTabForError(message);
    if (tab) setSettingsHint({ message, tab });
  };
  const [findOpen, setFindOpen] = useState(false);
  const dragging = useRef(false);
  /** Bottom-sheet drag: pulling the grip switches between half and full height. */
  const sheetDrag = useRef<{ y0: number } | null>(null);
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
    // A different paper means a different note document. Re-running for a
    // changed `paper.id` keeps multi-document switching (Multi-Tab) correct.
    setNoteDraft(paper.notes || ""); noteDraftRef.current = paper.notes || "";
    savedNote.current = paper.notes || ""; setNoteState("idle");
  }, [paper.id]);
  useEffect(() => {
    // External edits (AI answer "保存到笔记" → append_note, PaperEditor) arrive
    // through `paper.notes`. Sync them only when the editor has no unsaved
    // local draft, otherwise typing would overwrite the freshly appended note.
    const incoming = paper.notes || "";
    if (noteDraftRef.current === savedNote.current && incoming !== savedNote.current) {
      setNoteDraft(incoming);
      noteDraftRef.current = incoming;
      savedNote.current = incoming;
      setNoteState("idle");
    }
  }, [paper.notes, paper.id]);
  useEffect(() => () => {
    // Leaving the reader must not lose the last 600 ms of typing.
    clearTimeout(noteTimer.current);
    const draft = noteDraftRef.current;
    if (draft !== savedNote.current) void api.updatePaper(paper.id, { notes: draft }).catch(() => undefined);
  }, [paper.id]);

  useEffect(() => {
    let alive = true;
    api.aiHistory(paper.id).then((rows) => { if (alive) setAiHistory(rows); }).catch(() => undefined);
    api.aiPreferences().then((state) => { if (alive) setAiProvider(state.provider); }).catch(() => undefined);
    const off = api.onEvent((msg) => {
      if ((msg.event as string) === "ai_delta" && "request_id" in msg && "answer" in msg) {
        const answer = String(msg.answer);
        if (msg.request_id === aiRequest.current) setLive((current) => current ? { ...current, answer } : current);
        // The quick look-up bubble streams too, without touching `live`.
        if (msg.request_id === quickRequest.current) setQuickResult((current) => current ? { ...current, answer } : current);
      }
    });
    return () => { alive = false; off(); if (aiRequest.current) void api.aiAction("cancel", { request_id: aiRequest.current }).catch(() => undefined); if (quickRequest.current) void api.aiAction("cancel", { request_id: quickRequest.current }).catch(() => undefined); };
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
  const saveComment = async (id: string, text: string) => {
    try { await api.updateAnnotation(id, { comment: text }); await reloadAnnotations(); setEditingComment(null); onToast("批注已保存"); }
    catch (e) { onToast(`保存批注失败：${(e as Error).message}`); }
  };
  const exportReadingNotes = async () => {
    const lines: string[] = [
      `# ${paper.title}`, "",
      `- 作者：${paper.authors || "—"}`,
      `- 年份：${paper.year || "—"}`,
      `- 期刊 / 会议：${paper.venue || "—"}`,
      ...(paper.doi ? [`- DOI：${paper.doi}`] : []),
      "", "## 整篇阅读笔记", "", noteDraft.trim() || "_（暂无笔记）_", "", "## 高亮与批注", "",
    ];
    for (const color of HIGHLIGHT_COLORS) {
      const rows = annotations.filter((annotation) => annotation.color === color.key).sort((a, b) => a.page - b.page);
      if (!rows.length) continue;
      lines.push(`### ${color.label}`, "");
      for (const annotation of rows) {
        lines.push(`- **p.${annotation.page + 1}** “${annotation.quote.replace(/\s*\n\s*/g, " ").slice(0, 500)}”`);
        if (annotation.comment.trim()) lines.push(`  - ${annotation.comment.replace(/\n/g, "\n  - ")}`);
      }
      lines.push("");
    }
    try {
      const result = await api.saveText(`${paper.title.replace(/[\\/:*?"<>|]/g, "_").slice(0, 60)}-精读笔记.md`, lines.join("\n"));
      if (result.saved) onToast("精读笔记已导出");
    } catch (e) { onToast(`导出失败：${(e as Error).message}`); }
  };

  const sourceApi = useRef<PaneApi | null>(null);
  const transApi = useRef<PaneApi | null>(null);
  const activePane = useRef<"source" | "translated">(searchOnTranslatedSide || mode === "translated" ? "translated" : "source");
  const registerSource = useCallback((pane: PaneApi | null) => { sourceApi.current = pane; pane?.goTo(positionRef.current.page, positionRef.current.fraction); }, []);
  const registerTranslated = useCallback((pane: PaneApi | null) => {
    transApi.current = pane;
    // Partial translations have fewer pages: never clamp the source page onto
    // the wrong translated page; fall back to the first translated page.
    pane?.goTo(translatedPageNumber(pageMapRef.current, positionRef.current.page) ?? 1, positionRef.current.fraction);
  }, []);
  const toTranslatedPage = (sourcePageOne: number) => translatedPageNumber(pageMapRef.current, sourcePageOne);
  const goToTranslated = (sourcePageOne: number, fraction = 0, bbox?: number[]) => {
    const target = toTranslatedPage(sourcePageOne);
    if (target != null) transApi.current?.goTo(target, fraction, bbox);
    return target;
  };
  const goToPane = (side: "source" | "translated", sourcePageOne: number, fraction = 0, bbox?: number[]) => {
    if (side === "translated") goToTranslated(sourcePageOne, fraction, bbox);
    else sourceApi.current?.goTo(sourcePageOne, fraction, bbox);
  };
  // Cross-device reading position (Schema v3). Writes are debounced because a
  // scroll emits a position per animation frame; `set_reading_position` never
  // touches `papers.updated_at`, so this cannot reorder the library.
  const persistPosition = (position: { page: number; fraction: number }, targetMode: Mode) => {
    try {
      void api.setReadingPosition?.(paper.id, Math.max(0, position.page - 1), Math.max(0, Math.min(1, position.fraction)), targetMode)?.catch?.(() => undefined);
    } catch { /* an older desktop build without the RPC must not break scrolling */ }
  };
  const remember = (p: number, fraction: number) => {
    positionRef.current = { page: p, fraction };
    setPage(p);
    clearTimeout(persistTimer.current);
    const snapshot = { page: p, fraction: Math.max(0, Math.min(1, fraction)) };
    persistTimer.current = setTimeout(() => persistPosition(snapshot, modeRef.current), 250);
  };
  const navigate = (p: number, fraction = 0) => {
    remember(p, fraction);
    sourceApi.current?.goTo(p, fraction);
    goToTranslated(p, fraction);
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
    goToTranslated(p, fraction);
  };
  const goBack = () => {
    const previous = historyBack.current.pop();
    if (!previous) return;
    historyForward.current.push({ ...positionRef.current });
    remember(previous.page, previous.fraction);
    sourceApi.current?.goTo(previous.page, previous.fraction);
    goToTranslated(previous.page, previous.fraction);
    setHistoryTick((tick) => tick + 1);
  };
  const goForward = () => {
    const next = historyForward.current.pop();
    if (!next) return;
    historyBack.current.push({ ...positionRef.current });
    remember(next.page, next.fraction);
    sourceApi.current?.goTo(next.page, next.fraction);
    goToTranslated(next.page, next.fraction);
    setHistoryTick((tick) => tick + 1);
  };
  // Deep links (search hit / task centre): scroll to the page and, when a query
  // was supplied, open the find bar prefilled so the phrase is highlighted.
  useEffect(() => {
    if (!initialPage || initialPage < 1) return;
    jumpTo(initialPage, 0, undefined, false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialPage]);
  useEffect(() => {
    if (initialSearch) setFindOpen(true);
  }, [initialSearch]);
  const translatedVersions = useMemo(() => paper.versions.filter((version) => version.kind === "translated").sort((a, b) => b.created_at - a.created_at), [paper.versions]);
  const sourceVersions = useMemo(() => paper.versions.filter((version) => version.kind === "source").sort((a, b) => a.created_at - b.created_at || a.id.localeCompare(b.id)), [paper.versions]);
  const translatedForSource = useMemo(() => translatedVersions.filter((version) => {
    if (!source) return true;
    return (version.source_version_id || sourceVersions[0]?.id) === source.versionId;
  }), [translatedVersions, source?.versionId, sourceVersions]);
  const [translatedVersionId, setTranslatedVersionId] = useState<string | undefined>(() => initialVersionIsTranslated ? initialVersionId : translatedVersions.find((version) => (version.source_version_id || sourceVersions[0]?.id) === sourceVersions[0]?.id)?.id);
  const translatedVersion = translatedVersions.find((version) => version.id === translatedVersionId);
  pageMapRef.current = translatedVersion?.page_map ?? null;
  const translatedPageMissing = mode !== "source" && !!translated && toTranslatedPage(page) == null;
  useEffect(() => {
    if (!source) return;
    // Keep the version that produced a translated search hit; otherwise fall
    // back to the newest translation matching the current source attachment.
    const preferred = initialVersionIsTranslated && translatedForSource.some((version) => version.id === initialVersionId)
      ? initialVersionId
      : translatedForSource[0]?.id;
    setTranslatedVersionId(preferred);
    if (!preferred) { setTranslated(null); setMode((current) => current === "source" ? current : "source"); }
  }, [source?.versionId, translatedForSource, initialVersionIsTranslated, initialVersionId]);
  const loadOcr = useCallback(async (pageNumber: number) => source ? (await api.blocks(paper.id, source.versionId, pageNumber)).filter((block) => block.kind === "ocr") : [], [paper.id, source?.versionId]);
  const sourceAnnotations = useMemo(() => annotations.filter((annotation) => annotation.version_kind === "source" && (!annotation.version_id || annotation.version_id === source?.versionId)), [annotations, source?.versionId]);
  const translatedAnnotations = useMemo(() => annotationsOnTranslatedPages(
    annotations.filter((annotation) => annotation.version_kind === "translated" && (!annotation.version_id || annotation.version_id === translated?.versionId)),
    translatedVersion?.page_map,
  ), [annotations, translated?.versionId, translatedVersion?.page_map]);  const visibleAnnotations = useMemo(() => colorFilter ? annotations.filter((annotation) => annotation.color === colorFilter) : annotations, [annotations, colorFilter]);

  const loadTranslated = useCallback(async () => { if (!translatedVersion) return; setTranslated(await api.pdf(paper.id, "translated", translatedVersion.id)); }, [paper.id, translatedVersion]);

  const loadBlocks = useCallback(async (versionId: string, pageNumber: number): Promise<Block[]> => {
    const key = `${versionId}:${pageNumber}:${textRevision}:${translatedBlockRevision}`;
    const cached = blockCache.current.get(key);
    if (cached) return cached;
    try {
      const rows = await api.blocks(paper.id, versionId, pageNumber);
      blockCache.current.set(key, rows);
      return rows;
    } catch { return []; }
  }, [paper.id, textRevision, translatedBlockRevision]);

  useEffect(() => {
    let alive = true;
    setAligned(null);
    if (mode !== "dual" || !source || !translated) { setPageBlocks(null); return; }
    const pageIndex = page - 1;
    void Promise.all([loadBlocks(source.versionId, pageIndex), loadBlocks(translated.versionId, pageIndex)]).then(([sourceBlocks, translatedBlocks]) => {
      if (alive) setPageBlocks({ page, source: sourceBlocks, translated: translatedBlocks });
    });
    return () => { alive = false; };
  }, [mode, page, source?.versionId, translated?.versionId, loadBlocks, translatedBlockRevision]);

  const syncScroll = (side: "source" | "translated", p: number, fraction: number) => {
    // A translated pane reports subset pages; the reader cursor is always the
    // 0-based SOURCE page (annotations/history/database all use that space).
    const sourcePage = side === "translated" ? sourcePageForTranslated(pageMapRef.current, p - 1) + 1 : p;
    remember(sourcePage, fraction);
    if (mode !== "dual") return;
    const token = ++scrollToken.current;
    void (async () => {
      const pageIndex = sourcePage - 1;
      const [sourceRows, translatedRows] = await Promise.all([
        source ? loadBlocks(source.versionId, pageIndex) : Promise.resolve([]),
        translated ? loadBlocks(translated.versionId, pageIndex) : Promise.resolve([]),
      ]);
      if (token !== scrollToken.current) return;
      const other: "source" | "translated" = side === "source" ? "translated" : "source";
      const fromRows = side === "source" ? sourceRows : translatedRows;
      const toRows = side === "source" ? translatedRows : sourceRows;
      const fromPanePage = side === "translated" ? p : sourcePage;
      const toPanePage = other === "translated" ? (toTranslatedPage(sourcePage) ?? 1) : sourcePage;
      if (!source || !translated || fromRows.length === 0 || toRows.length === 0) { goToPane(other, sourcePage, fraction); return; }
      const fromApi = side === "source" ? sourceApi.current : transApi.current;
      const toApi = side === "source" ? transApi.current : sourceApi.current;
      if (!fromApi || !toApi) return;
      const fromSize = fromApi.pageSize?.(fromPanePage) ?? { w: 612, h: 792 };
      const toSize = toApi.pageSize?.(toPanePage) ?? { w: 612, h: 792 };
      const fromBlock = nearestBlock(fromRows, fraction * fromSize.h);
      if (!fromBlock) { goToPane(other, sourcePage, fraction); return; }
      // Pick the counterpart by paragraph centre, but position it by the same
      // relative point inside the paragraph (BUG-03: no half-paragraph drift).
      const center = (fromBlock.bbox[1] + fromBlock.bbox[3]) / 2 / fromSize.h;
      const sourceX = normalizedXRange(fromBlock.bbox, fromSize.w);
      const target = nearestBlock(toRows, center * toSize.h, sourceX, toSize.w);
      const targetFraction = target
        ? interpolatedTargetFraction(fraction * fromSize.h, fromBlock.bbox, target.bbox, toSize.h)
        : fraction;
      goToPane(other, sourcePage, Math.abs(targetFraction - fraction) > 0.35 ? fraction : targetFraction);
    })();
  };

  const alignPoint = (side: "source" | "translated", point: { page: number; x: number; y: number } | null, kind: "hover" | "click") => {
    if (!point) { if (kind === "hover") setAligned(null); return; }
    const sourcePage = side === "translated" ? sourcePageForTranslated(pageMapRef.current, point.page - 1) + 1 : point.page;
    if (!pageBlocks || pageBlocks.page !== sourcePage) { setAligned(null); return; }
    const fromRows = side === "source" ? pageBlocks.source : pageBlocks.translated;
    const toRows = side === "source" ? pageBlocks.translated : pageBlocks.source;
    const other: "source" | "translated" = side === "source" ? "translated" : "source";
    const fromPanePage = point.page;
    const toPanePage = other === "translated" ? (toTranslatedPage(sourcePage) ?? 1) : sourcePage;
    const fromApi = side === "source" ? sourceApi.current : transApi.current;
    const toApi = side === "source" ? transApi.current : sourceApi.current;
    const block = blockAt(fromRows, point.x, point.y);
    if (!block) { setAligned(null); return; }
    const fromSize = fromApi?.pageSize?.(fromPanePage) ?? { w: 612, h: 792 };
    const toSize = toApi?.pageSize?.(toPanePage) ?? { w: 612, h: 792 };
    const center = (block.bbox[1] + block.bbox[3]) / 2 / fromSize.h;
    const sourceX = normalizedXRange(block.bbox, fromSize.w);
    const target = nearestBlock(toRows, center * toSize.h, sourceX, toSize.w);
    const targetCenter = target ? (target.bbox[1] + target.bbox[3]) / 2 / toSize.h : undefined;
    const reliable = targetCenter !== undefined && Math.abs(targetCenter - center) <= 0.25;
    const next = side === "source"
      ? { page: sourcePage, source: block.bbox, translated: reliable ? target?.bbox : undefined }
      : { page: sourcePage, translated: block.bbox, source: reliable ? target?.bbox : undefined };
    setAligned((previous) => JSON.stringify(previous) === JSON.stringify(next) ? previous : next);
  };

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
    if (!translatedVersion) { setTranslated(null); return; }
    void api.pdf(paper.id, "translated", translatedVersion.id).then((bytes) => { if (active) { setTranslated(bytes); setMode((current) => (restoredMode.current || current !== "source") ? current : "dual"); } }).catch(() => undefined);
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
      if (request === sourceRequest.current) {
        const message = String(e);
        onToast(`打开附件失败：${message}`);
        noteSettingsHint(message);
      }
    }
  };

  // Switching the active pane in dual mode must not wipe Ctrl+F hits; only a
  // version change (or closing FindBar, handled there) invalidates matches.
  useEffect(() => { setFindMatches([]); setFindIndex(0); }, [source?.versionId, translated?.versionId]);
  useEffect(() => { setPageInput(String(page)); }, [page]);
  useEffect(() => () => {
    // Leaving the reader flushes the debounce so a quick page turn still lands
    // in the database, and drops the legacy localStorage copy for good.
    clearTimeout(persistTimer.current);
    persistPosition(positionRef.current, modeRef.current);
  }, [paper.id]);

  useEffect(() => {
    return api.onEvent((event) => {
      if (!("jobId" in event)) return;
      if (!job || event.jobId !== job.id) return;
      if (event.status || event.phase || event.progress != null || event.detail) setJob((current) => current ? {
        ...current,
        status: event.status || current.status,
        phase: event.phase || current.phase,
        progress: event.progress != null ? event.progress : current.progress,
        detail: event.detail || current.detail,
      } : current);
      if (event.status === "completed") {
        onToast("译文已生成");
        setJob(null);
        api.getPaper(paper.id).then(async (fresh) => {
          onChanged(fresh);
          if (fresh.versions.some((version) => version.kind === "translated")) {
            const newest = fresh.versions.filter((version) => version.kind === "translated" && (version.source_version_id || fresh.versions.find((row) => row.kind === "source")?.id) === source?.versionId).sort((a, b) => b.created_at - a.created_at)[0];
            if (newest) { setTranslatedVersionId(newest.id); setTranslated(await api.pdf(paper.id, "translated", newest.id)); }
            else setTranslated(null);
            setMode((current) => current === "source" ? "dual" : current);
          }
        });
      } else if (event.status === "failed" || event.status === "cancelled") {
        onToast(event.error ? `翻译失败：${event.error}` : event.status === "cancelled" ? "翻译已取消" : "翻译失败");
        if (event.error) noteSettingsHint(event.error);
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
  // Bottom sheet (narrow layout): drag the grip up for full screen, down for half.
  useEffect(() => {
    const move = (event: PointerEvent) => {
      const start = sheetDrag.current;
      if (!start) return;
      const delta = event.clientY - start.y0;
      if (Math.abs(delta) < 48) return;
      sheetDrag.current = null;
      setSheetFull(delta < 0);
    };
    const up = () => { sheetDrag.current = null; };
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
  /**
   * Pinch commit from a pane. The pane already previewed the gesture with a
   * CSS `transform: scale()`; here we only set the discrete scale so pdf.js
   * redraws the page bitmaps crisply, reusing `prepareZoom` for the focal point.
   */
  const pinchScale = (next: number, focal?: { clientX: number; clientY: number }) => {
    if (!Number.isFinite(next)) return;
    sourceApi.current?.prepareZoom?.(focal);
    transApi.current?.prepareZoom?.(focal);
    setZoomMode("custom");
    setScale(clampScale(next));
  };
  const noteCrop = useCallback(() => {
    if (zoomMode === "custom") return;
    clearTimeout(cropRefit.current);
    cropRefit.current = setTimeout(() => setCropTick((tick) => tick + 1), 140);
  }, [zoomMode]);
  const applyFit = useCallback(() => {
    // A hidden Multi-Tab has clientWidth 0; fitting it would collapse scale to
    // 40%. Only the active reader may fit, and PdfPane also guards zero sizes.
    if (!active || zoomMode === "custom") return;
    const pane = activeSide === "translated" ? transApi.current : sourceApi.current;
    if (!pane) return;
    pane.prepareZoom?.();
    // `fit("width")` measures the cropped body width when auto-crop is on, so
    // the page edge whitespace turns into larger body text.
    const next = pane.fit(zoomMode === "fit-width" ? "width" : "page");
    if (next) setScale(next);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, zoomMode, activeSide, autoCrop]);
  useEffect(() => {
    if (!active || zoomMode === "custom") return;
    const run = () => requestAnimationFrame(applyFit);
    const initial = setTimeout(run, 80);
    // The cropped envelope of a page is only known once its text layer has
    // painted; refit a moment later so fit-width uses the real body width.
    const late = setTimeout(run, 420);
    run();
    const element = panesRef.current;
    let observer: ResizeObserver | undefined;
    if (element) { observer = new ResizeObserver(run); observer.observe(element); }
    return () => { clearTimeout(initial); clearTimeout(late); observer?.disconnect(); };
  }, [active, zoomMode, activeSide, mode, sideOpen, sideWidth, source?.versionId, translated?.versionId, autoCrop, cropTick, applyFit]);
  useEffect(() => {
    // Returning to a background tab: recompute fit-width now that the layout
    // has a real width again.
    if (!active || zoomMode === "custom") return;
    const id = requestAnimationFrame(() => applyFit());
    return () => cancelAnimationFrame(id);
  }, [active, zoomMode, applyFit]);

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
    if (!active) return;
    const key = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const typing = !!target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.tagName === "SELECT" || target.isContentEditable);
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "f") { event.preventDefault(); setFindOpen(true); return; }
      if (event.altKey && event.key === "ArrowLeft") { event.preventDefault(); goBack(); return; }
      if (event.altKey && event.key === "ArrowRight") { event.preventDefault(); goForward(); return; }
      if (event.key === "Escape") { setFindOpen(false); setFindMatches([]); setFindIndex(0); setNavTab(null); setTool("select"); setAreaLocked(false); return; }
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
  }, [page, source?.pages, source?.versionId, scale, active]);

  const savePosition = () => {
    const pane = activePane.current === "translated" ? transApi.current : sourceApi.current;
    if (pane) { const position = pane.getPosition(); remember(position.page, position.fraction); return position; }
    return positionRef.current;
  };

  const switchMode = async (next: Mode) => {
    // An explicit mode choice overrides the restored one for good.
    restoredMode.current = null;
    const position = savePosition();
    if (next !== "source" && !translated) {
      try { await loadTranslated(); } catch { onToast("还没有可用的译文版本"); return; }
    }
    setMode(next);
    if (next === "translated") chooseActive("translated");
    else if (next === "source") chooseActive("source");
    if (next === "translated" || next === "dual") goToTranslated(position.page, position.fraction);
    if (next === "source" || next === "dual") sourceApi.current?.goTo(position.page, position.fraction);
    setSelection(null);
  };

  useEffect(() => { let alive = true; api.listJobs().then((rows) => { const active = rows.find((row) => row.paper_id === paper.id && !["completed", "failed", "cancelled"].includes(row.status)); if (alive && active) setJob({ id: active.id, status: active.status, startedAt: active.created_at || Date.now() }); }).catch(() => undefined); return () => { alive = false; }; }, [paper.id]);
  useEffect(() => { if (!job) return; const timer = setInterval(() => setClock(Date.now()), 1000); return () => clearInterval(timer); }, [job?.id]);
  useEffect(() => { setDigest(paper.digest ?? null); }, [paper.id]);
  useEffect(() => {
    const move = (event: PointerEvent) => {
      const drag = splitDrag.current;
      if (!drag) return;
      setSplitRatio(Math.min(0.72, Math.max(0.28, (event.clientX - drag.left) / drag.width)));
    };
    const up = () => {
      if (!splitDrag.current) return;
      splitDrag.current = null;
      setSplitRatio((value) => { try { localStorage.setItem("moonlight-reader-split", String(value)); } catch { /* ignore */ } return value; });
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    return () => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up); };
  }, []);
  useEffect(() => {
    const move = (event: PointerEvent) => {
      const drag = pinDrag.current;
      if (!drag) return;
      setPinned((current) => current ? { ...current, x: Math.max(8, Math.min(window.innerWidth - 340, event.clientX - drag.dx)), y: Math.max(56, Math.min(window.innerHeight - 220, event.clientY - drag.dy)) } : current);
    };
    const up = () => { pinDrag.current = null; };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    return () => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up); };
  }, []);

  const startTranslate = async (pages?: string) => {
    setShowTranslateMenu(false);
    setTranslateRangeOpen(false);
    try {
      const { job_id } = await api.startTranslate(paper.id, pages, source?.versionId);
      setJob({ id: job_id, status: "queued", startedAt: Date.now() });
      onToast(pages ? `开始翻译第 ${pages} 页` : "开始翻译全文（后台运行，可继续阅读）");
    } catch (e) {
      const message = String((e as Error).message || e);
      onToast(`无法启动翻译：${message}`);
      noteSettingsHint(message);
    }
  };

  const scheduleNoteSave = (text: string) => {
    clearTimeout(noteTimer.current);
    setNoteState("saving");
    noteTimer.current = setTimeout(async () => {
      try {
        const fresh = await api.updatePaper(paper.id, { notes: text });
        // A newer keystroke already scheduled another save; let that one win so
        // an out-of-order response can never roll the editor back.
        if (noteDraftRef.current === text) {
          savedNote.current = text;
          onChanged(fresh);
          setNoteState("saved");
        }
      } catch {
        setNoteState("error");
      }
    }, 600);
  };
  const insertNoteText = (text: string) => {
    const area = noteArea.current;
    const start = area?.selectionStart ?? noteDraft.length;
    const end = area?.selectionEnd ?? start;
    const next = `${noteDraft.slice(0, start)}${text}${noteDraft.slice(end)}`;
    setNoteDraft(next);
    scheduleNoteSave(next);
    requestAnimationFrame(() => {
      const node = noteArea.current;
      if (!node) return;
      node.focus();
      const caret = start + text.length;
      node.setSelectionRange(caret, caret);
    });
  };
  const applyNoteTemplate = () => {
    const next = noteDraft.trim() ? `${noteDraft.trimEnd()}\n\n${NOTE_TEMPLATE}` : NOTE_TEMPLATE;
    setNoteDraft(next);
    scheduleNoteSave(next);
  };

  /** Single tap = one-shot marquee, double tap = locked continuous marquee. */
  const toggleAreaTool = () => {
    if (tool === "area") {
      clearTimeout(areaTap.current); areaTap.current = 0;
      setTool("select"); setAreaLocked(false);
      return;
    }
    if (areaTap.current) {
      clearTimeout(areaTap.current); areaTap.current = 0;
      setTool("area"); setAreaLocked(true);
      onToast("已锁定连续框选：再次点击「连续框选」或按 Esc 退出");
      return;
    }
    areaTap.current = window.setTimeout(() => {
      areaTap.current = 0;
      setTool("area"); setAreaLocked(false);
    }, 260);
  };
  const handleAreaSelect = (selected: Selection) => {
    setSelection({ ...selected, quote: selected.quote || "（框选区域）" });
    setAnnotating(true);
    // UX-BUG-02: a one-shot marquee must hand the page back to one-finger
    // scrolling immediately; only a locked marquee keeps drawing boxes.
    if (!areaLocked) { setTool("select"); setAreaLocked(false); }
  };

  const closeQuick = () => {
    const request = quickRequest.current;
    quickRequest.current = null;
    if (request) void api.aiAction("cancel", { request_id: request }).catch(() => undefined);
    setQuickResult(null);
  };
  /** UX-BUG-03: answer beside the selection, never hijack the AI tab. */
  const quickAsk = async (kind: "translate" | "explain", questionOverride?: string, imageDataUrl?: string) => {
    if (!selection) return;
    const quote = selection.quote.trim();
    if (!quote) { onToast("选区内没有可识别的文字"); return; }
    const sourcePageZero = selection.side === "translated" ? sourcePageForTranslated(pageMapRef.current, selection.page - 1) : selection.page - 1;
    const anchor = selection.anchor ?? { x: window.innerWidth / 2, y: window.innerHeight * 0.35 };
    setQuickResult({ kind, quote, answer: "", loading: true, x: anchor.x, y: anchor.y, imageDataUrl });
    if (kind === "translate") {
      try {
        const result = await api.translateText(quote);
        setQuickResult((current) => current && current.quote === quote ? { ...current, answer: result.text, loading: false } : current);
      } catch (e) {
        setQuickResult((current) => current ? { ...current, loading: false, error: String((e as Error).message || e) } : current);
      }
      return;
    }
    const requestId = crypto.randomUUID();
    quickRequest.current = requestId;
    try {
      const result = await api.quickExplain({
        request_id: requestId, paper_id: paper.id, question: questionOverride ?? `解释这段原文：${quote}`,
        page: sourcePageZero, kind: "explain", version_id: source?.versionId, include_history: false, image_data_url: imageDataUrl,
      });
      setQuickResult((current) => current && current.quote === quote ? { ...current, answer: result.answer || current.answer, loading: false } : current);
    } catch (e) {
      setQuickResult((current) => current ? { ...current, loading: false, error: String((e as Error).message || e) } : current);
    } finally {
      if (quickRequest.current === requestId) quickRequest.current = null;
    }
  };
  const visionAsk = (mode: "chart" | "latex" | "table") => {
    if (!selection) return;
    if (!selection.imageDataUrl) { onToast("框选区域截图尚未生成，请重新框选该图表 / 公式 / 表格"); return; }
    const prompts = {
      chart: "解读这个框选区域：说明图表类型、横纵坐标含义、关键趋势，以及作者想用它论证的结论。",
      latex: "把框选区域中的公式转换为 LaTeX（输出 $$...$$），并列出公式中每个符号的含义。",
      table: "把框选区域中的表格转换为 Markdown 表格，保留表头、数值与单位；无法辨认的单元格标注 [?]。",
    } as const;
    void quickAsk("explain", `${prompts[mode]}\n\n（框选区域文字：${selection.quote.slice(0, 300) || "无可提取文字"}）`, selection.imageDataUrl);
  };
  /**
   * FEAT-AI-05: verify the selected statement against the paper's own evidence.
   * The answer reuses the in-place quick bubble so copy / save-as-annotation /
   * continue-in-chat keep working; the verdict rides along as a badge.
   */
  const claimVerifySelection = async () => {
    if (!selection) return;
    const claim = selection.quote.replace(/\s+/g, " ").trim();
    if (!claim) { onToast("选区内没有可识别的文字"); return; }
    const anchor = selection.anchor ?? { x: window.innerWidth / 2, y: window.innerHeight * 0.35 };
    const requestId = crypto.randomUUID();
    quickRequest.current = requestId;
    setQuickResult({ kind: "claim", quote: claim, answer: "", loading: true, x: anchor.x, y: anchor.y });
    try {
      const result = await api.claimVerify(paper.id, claim, source?.versionId);
      const raw = String(result?.verdict ?? "").trim().toLowerCase() as ClaimVerdict;
      const verdict = raw in CLAIM_VERDICT_LABELS ? raw : undefined;
      setQuickResult((current) => current && current.quote === claim ? {
        ...current, loading: false, verdict, answer: String(result?.answer ?? "").trim(),
      } : current);
    } catch (e) {
      setQuickResult((current) => current && current.quote === claim ? { ...current, loading: false, error: String((e as Error).message || e) } : current);
    } finally {
      if (quickRequest.current === requestId) quickRequest.current = null;
    }
  };
  const generateDigest = async (force = false) => {
    setDigestBusy(true); setAiError(null);
    try {
      const result = await api.aiDigest(paper.id, source?.versionId, force);
      setDigest(result);
      onToast(force ? "结构化导读已重新生成" : "结构化导读已生成并缓存");
    } catch (e) {
      setAiError(String((e as Error).message || e));
    } finally {
      setDigestBusy(false);
    }
  };
  const openInternalPreview = async (page: number, fraction: number, anchor?: { x: number; y: number }, side: "source" | "translated" = "source") => {
    setPreview({ page, fraction, src: "", loading: true, x: anchor?.x ?? window.innerWidth / 2, y: anchor?.y ?? window.innerHeight / 2, side });
    try {
      const preferred = side === "translated" ? transApi.current : sourceApi.current;
      const fallback = side === "translated" ? sourceApi.current : transApi.current;
      const pane = preferred?.renderRegion ? preferred : fallback;
      const src = await pane?.renderRegion?.(page, fraction, 380) ?? "";
      setPreview((current) => current ? { ...current, src, loading: false } : current);
    } catch {
      setPreview((current) => current ? { ...current, loading: false } : current);
    }
  };
  /**
   * FEAT-AI-01: a click on `Fig. 2` / `Table 1` / `[12]` without a native PDF
   * link. Resolve it through the block index (canonical caption first, then the
   * in-text spelling), convert the block's bbox to a page fraction and reuse
   * the existing smart preview + pin portal.
   */
  const openTextReference = async (reference: TextReference, anchor?: { x: number; y: number }, side: "source" | "translated" = "source") => {
    let block: Block | null = null;
    for (const query of reference.queries) {
      let rows: Block[] = [];
      try { rows = await api.searchBlocks(paper.id, query, 30); } catch { rows = []; }
      if (!rows?.length) continue;
      block = pickReferenceBlock(reference, rows, source?.pages ?? 0);
      if (block) break;
    }
    if (!block) {
      onToast(`未在原文中找到「${reference.label}」，可能尚未建立段落索引`);
      return;
    }
    const pageOne = Math.max(1, Number(block.page) + 1);
    const size = sourceApi.current?.pageSize?.(pageOne) ?? { w: 612, h: 792 };
    const top = Number(block.bbox[1]), bottom = Number(block.bbox[3]);
    const fraction = Number.isFinite(top) && Number.isFinite(bottom) && size.h > 0
      ? Math.max(0, Math.min(1, (top + bottom) / 2 / size.h))
      : 0;
    // A partial translation may not contain this page: preview the source pane
    // instead of rendering a wrong/empty slice.
    const translatedPage = side === "translated" ? toTranslatedPage(pageOne) : null;
    const target: "source" | "translated" = side === "translated" && translatedPage != null ? "translated" : "source";
    await openInternalPreview(target === "translated" ? translatedPage! : pageOne, fraction, anchor, target);
  };
  const pinPreview = () => {
    if (!preview?.src) return;
    setPinned({ page: preview.page, fraction: preview.fraction, src: preview.src, x: Math.max(20, window.innerWidth - 360), y: Math.max(80, window.innerHeight - 280), side: preview.side });
    setPreview(null);
  };
  const startPinDrag = (event: ReactPointerEvent) => {
    if (!pinned) return;
    event.preventDefault();
    pinDrag.current = { dx: event.clientX - pinned.x, dy: event.clientY - pinned.y };
  };
  const copyQuick = async () => {
    if (!quickResult?.answer.trim()) return;
    try { await navigator.clipboard.writeText(quickResult.answer); onToast("已复制"); }
    catch { onToast("复制失败"); }
  };
  const saveQuickAsAnnotation = async () => {
    if (!quickResult || !selection || !quickResult.answer.trim()) return;
    const answer = quickResult.answer.trim();
    await addHighlight("yellow", answer);
    setQuickResult(null);
    onToast("已存入高亮批注");
  };
  const promoteQuickToChat = () => {
    if (!quickResult) return;
    const quote = quickResult.quote.slice(0, 140);
    setQuickResult(null);
    setTab("ai");
    setSideOpen(true);
    setAiQuestion(`关于这段原文：“${quote}”，请继续深入解释。`);
    setTimeout(() => composer.current?.focus(), 0);
  };
  const startRangeTranslation = () => {
    const value = translateRange.trim();
    if (!PAGE_RANGE_PATTERN.test(value)) { setTranslateRangeError("格式如 1-5, 8"); return; }
    const total = source?.pages ?? 0;
    for (const part of value.split(",")) {
      const [rawStart, rawEnd] = part.trim().split("-");
      const start = Number(rawStart), end = Number(rawEnd ?? rawStart);
      if (!Number.isFinite(start) || !Number.isFinite(end) || start < 1 || end < start || (total > 0 && end > total)) {
        setTranslateRangeError(`页码需在 1–${total || "总页数"} 之间，且起始页不大于结束页`);
        return;
      }
    }
    setTranslateRangeError("");
    setTranslateRangeOpen(false);
    void startTranslate(value);
  };

  const addHighlight = async (color: string, text = "") => {
    if (!selection) return;
    const versionId = selection.side === "source" ? source?.versionId : translated?.versionId;
    // Annotations are stored in SOURCE-page space; a translated pane may be a
    // partial subset (BUG-01), so convert subset page → source page first.
    const pageForAnnotation = (panePageOne: number) => selection.side === "translated"
      ? sourcePageForTranslated(pageMapRef.current, panePageOne - 1) + 1
      : panePageOne;
    const targets = [{ page: selection.page, rects: selection.rects }, ...(selection.extraSlices ?? [])];
    await Promise.all(targets.map((target) => api.addAnnotation({
      paper_id: paper.id,
      page: pageForAnnotation(target.page) - 1,
      rects: target.rects,
      quote: selection.quote,
      color,
      comment: text,
      version_kind: selection.side,
      version_id: versionId,
    })));
    setAnnotationDraft("");
    setAnnotating(false);
    setSelection(null);
    await reloadAnnotations();
    onToast(selection.extraSlices?.length ? "已保存跨页划线" : "已保存划线");
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
        : await api.aiRun({ request_id: aiRequest.current!, paper_id: paper.id, question, page: kind === "summary" ? page - 1 : kind === "explain" && selection ? (selection.side === "translated" ? sourcePageForTranslated(pageMapRef.current, selection.page - 1) : selection.page - 1) : scope === "page" ? page - 1 : undefined, scope, include_history: includeHistory, kind, version_id: source?.versionId })) as { answer: string; sources: Source[]; warnings?: string[] };
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

  const translateSelection = () => { void quickAsk("translate"); };

  const quoteSelection = () => {
    if (!selection) return;
    setAiQuestion(`关于选段“${selection.quote.slice(0, 140)}”：`);
    setTab("ai");
    setSelection(null);
    setTimeout(() => composer.current?.focus(), 0);
  };

  /** Text captured inside a marquee box (empty when the box only covers a figure). */
  const selectionText = selection ? (selection.area ? (selection.areaText || "").trim() : selection.quote.trim()) : "";
  const copySelection = async () => {
    if (!selection) return;
    const text = selectionText || selection.quote;
    if (!text.trim()) return;
    try { await navigator.clipboard.writeText(text); onToast(selection.area ? "已复制框选文字" : "已复制选段"); }
    catch { onToast("复制失败，请手动选择复制"); }
    setSelection(null);
  };
  /** Region → vision: crop the rendered canvas and ask the multimodal model. */
  const areaAsk = (mode: "chart" | "latex" | "table") => visionAsk(mode);

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
      // Flush an in-flight note draft first; otherwise append_note lands in the
      // DB and the next 600 ms autosave would overwrite it with the old draft.
      clearTimeout(noteTimer.current);
      if (noteDraftRef.current !== savedNote.current) {
        const flushed = await api.updatePaper(paper.id, { notes: noteDraftRef.current });
        savedNote.current = noteDraftRef.current;
        onChanged(flushed);
      }
      const fresh = await api.appendNote(paper.id, `AI 阅读记录\n${text}\n\n原文依据：${sources.map((item) => `[${item.n}] 第 ${item.page + 1} 页 ${item.text}`).join("\n")}`);
      const notes = fresh.notes || "";
      setNoteDraft(notes); noteDraftRef.current = notes; savedNote.current = notes; setNoteState("saved");
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
  /** Header/title of the in-place bubble, including the new claim check (FEAT-AI-05). */
  const quickTitle = quickResult?.kind === "claim" ? "核查原文依据" : quickResult?.imageDataUrl ? "多模态解读" : quickResult?.kind === "translate" ? "就地译文" : "就地释义";
  const quickPlaceholder = quickResult?.kind === "claim" ? "正在检索原文证据…" : quickResult?.kind === "translate" ? "正在翻译…" : "正在解释…";

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
        <section className="note-workspace">
          <div className="note-head">
            <h3>整篇阅读笔记</h3>
            <span className={`note-state ${noteState}`} role="status">{noteState === "saving" ? "保存中…" : noteState === "saved" ? "已保存" : noteState === "error" ? "保存失败" : "600ms 自动保存"}</span>
          </div>
          <div className="note-tools">
            <button className="btn tiny" onClick={applyNoteTemplate}>+ 套用精读模板</button>
            <button className="btn tiny" onClick={() => insertNoteText(`[p.${page}]`)}>+ 引用当前页 p.{page}</button>
          </div>
          <textarea ref={noteArea} className="note-editor" aria-label="整篇阅读笔记" rows={8} value={noteDraft}
            placeholder="边读边写…支持 Markdown，停止输入 600ms 后自动保存"
            onChange={(event) => { setNoteDraft(event.target.value); scheduleNoteSave(event.target.value); }} />
        </section>
        <ImportedFiles paperId={paper.id} files={files} onOpen={chooseSource} onError={(message) => { onToast(message); noteSettingsHint(message); }} />
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
        <button className={navTab ? "icon-btn on" : "icon-btn"} aria-label="目录与页面导航" aria-pressed={!!navTab} title="目录大纲 / 页面缩略图 / 图表画廊" onClick={() => setNavTab(navTab ? null : "outline")}><ListTree size={16} /></button>
        <button className={findOpen ? "icon-btn on" : "icon-btn"} aria-label="查找文内关键词" title="文内查找（Ctrl+F）" onClick={() => setFindOpen((value) => !value)}><Search size={16} /></button>
        <button className={autoCrop ? "icon-btn on" : "icon-btn"} aria-label="自动裁白边" aria-pressed={autoCrop} title="自动裁白边：按正文包络裁掉页边空白（不改 PDF 与批注坐标）" onClick={() => setAutoCrop((value) => !value)}><Crop size={16} /></button>
        <button className={tool === "area" ? "btn tiny on" : "btn tiny"} aria-label={areaLocked ? "连续框选已锁定" : "框选模式"} aria-pressed={tool === "area"} title={areaLocked ? "连续框选已锁定：再次点击或按 Esc 退出" : "框选模式：单击开启单次框选，双击锁定连续框选（Alt+拖拽与手写笔侧键仍可用）"} onClick={toggleAreaTool}>{areaLocked ? <Lock size={13} /> : <Square size={13} />}{areaLocked ? "连续框选" : "框选"}</button>
        {narrow && mode === "dual" && <div className="mode-switch pane-switch" role="group" aria-label="单栏切换">
          <button className={activeSide === "source" ? "on" : ""} onClick={() => chooseActive("source")}>原文</button>
          <button className={activeSide === "translated" ? "on" : ""} onClick={() => chooseActive("translated")}>译文</button>
        </div>}
        {sourceVersions.length > 1 && <select className="select compact" aria-label="原文附件" value={source.versionId} onChange={(event) => chooseSource(event.target.value)}>
          {sourceVersions.map((version, index) => <option key={version.id} value={version.id}>{files.find((file) => file.version_id === version.id)?.title || `PDF ${index + 1}`}{index === 0 ? "（主文档）" : ""}</option>)}
        </select>}
        {translatedForSource.length > 1 && <select className="select compact" aria-label="译文版本" value={translatedVersion?.id} onChange={(event) => chooseTranslatedVersion(event.target.value)}>
          {translatedForSource.map((version, index) => <option key={version.id} value={version.id}>{`译文 ${index + 1}${index === 0 ? "（最新）" : ""} · ${new Date(version.created_at).toLocaleDateString()}`}</option>)}
        </select>}
        <DocumentParsing key={source.versionId} paperId={paper.id} versionId={source.versionId} pages={source.pages} page={page} pane={sourceApi} onIndexed={() => setTextRevision((value) => value + 1)} hasText={nativeText[page]} />
        <div className="mode-switch">
          <button className={mode === "source" ? "on" : ""} onClick={() => switchMode("source")}>原文</button>
          <button className={mode === "translated" ? "on" : ""} disabled={!translated} title={translated ? "" : "尚未生成译文"} onClick={() => switchMode("translated")}>译文</button>
          <button className={mode === "dual" ? "on" : ""} disabled={!translated} onClick={() => switchMode("dual")}>对照</button>
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
          <button className="btn primary" title="翻译当前原文附件" onClick={() => (translated ? setShowTranslateMenu((value) => !value) : startTranslate(undefined))} disabled={!!job}>
            <Languages size={15} />{job ? phaseLabel(job) : translated ? "重新翻译" : "翻译全文"}
          </button>
          <button className="icon-btn" aria-label="翻译选项" title="翻译选项：当前页 / 指定页码范围 / 全文" aria-expanded={showTranslateMenu} onClick={() => { setShowTranslateMenu((value) => !value); setTranslateRangeOpen(false); setTranslateRangeError(""); }} disabled={!!job}><ChevronDown size={15} /></button>
        </div>
        {job && <button className="btn tiny ghost" onClick={() => job && api.cancelJob(job.id)}><Square size={13} />取消</button>}
        <button className="icon-btn" aria-label={sideOpen ? "收起侧栏" : "展开侧栏"} title={sideOpen ? "收起侧栏" : "展开侧栏"} onClick={() => setSideOpen((value) => !value)}>{sideOpen ? <PanelRightClose size={16} /> : <PanelRightOpen size={16} />}</button>
      </header>

      {settingsHint && onOpenSettings && (
        <div className="reader-settings-banner" role="status">
          <span title={settingsHint.message}>{settingsHint.message}</span>
          <button className="btn tiny settings-cta" onClick={() => { onOpenSettings(settingsHint.tab); setSettingsHint(null); }}>前往配置 API / 登录 Codex →</button>
          <button className="icon-btn" aria-label="关闭配置提示" onClick={() => setSettingsHint(null)}><X size={13} /></button>
        </div>
      )}

      {job && (() => {
        const seconds = Math.max(0, Math.floor((clock - job.startedAt) / 1000));
        const elapsed = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
        return <div className="jobbar">
          <div className="jobbar-text">翻译任务 · {statusLabel(job.status)}{job.phase ? ` · ${phaseLabel(job)}` : ""}{job.progress != null ? ` · ${job.progress}%` : ""}{job.detail ? ` · ${job.detail}` : ""} · 已用时 {elapsed}</div>
          <div className="progress"><div className={`bar ${job.status}`} style={job.progress != null ? { width: `${job.progress}%`, animation: "none" } : undefined} /></div>
        </div>;
      })()}
      {findOpen && <FindBar key={`${activeSide}:${source.versionId}:${translated?.versionId ?? ""}`} pane={activeSide === "translated" ? transApi : sourceApi}
        initialQuery={initialSearch}
        preferredPage={activeSide === "translated" && initialPage ? (translatedPageNumber(pageMapRef.current, initialPage) ?? initialPage) : initialPage}
        onResults={handleFindResults}
        onJump={(target, bbox) => {
          if (activeSide === "translated") {
            const sourcePage = sourcePageForTranslated(pageMapRef.current, target - 1) + 1;
            remember(sourcePage, 0);
            transApi.current?.goTo(target, 0, bbox);
          } else {
            remember(target, 0);
            sourceApi.current?.goTo(target, 0, bbox);
          }
        }}
        onClose={() => { setFindOpen(false); setFindMatches([]); setFindIndex(0); }} />}

      <div className="reader-body">
        {navTab && <ReaderNav pane={activeSide === "translated" ? transApi : sourceApi} pages={source.pages} current={page} versionKey={`${activeSide}:${activeSide === "translated" ? translated?.versionId ?? "" : source.versionId}`} onJump={(target, fraction) => jumpTo(target, fraction)}
          onPin={(target, fraction, src) => setPinned({ page: target, fraction, src, x: Math.max(20, window.innerWidth - 360), y: Math.max(80, window.innerHeight - 280), side: activeSide })}
          onClose={() => setNavTab(null)} />}
        <div className={`panes mode-${mode} active-${activeSide}`} ref={panesRef}>
          {(mode === "source" || mode === "dual") && (
            <div className="pane-slot" style={mode === "dual" ? { flex: `0 1 ${splitRatio * 100}%` } : undefined}>
            <PdfPane key="source" bytes={source.bytes} url={source.url} scale={scale} annotations={sourceAnnotations}
              initialPage={page} initialFraction={positionRef.current.fraction} side="source" loadOcr={loadOcr} textRevision={textRevision} registerApi={registerSource}
              autoCrop={autoCrop} areaMode={tool === "area"} onPinchScale={pinchScale} onCropChange={noteCrop}
              findMatches={activeSide === "source" ? findMatches : undefined} activeMatchIndex={activeSide === "source" ? findIndex : undefined}
              alignedBox={aligned?.page === page && aligned.source ? { page, bbox: aligned.source } : null}
              onParagraphPoint={(point, kind) => alignPoint("source", point, kind)}
              onNativeText={(index, hasText) => setNativeText((all) => all[index] === hasText ? all : { ...all, [index]: hasText })}
              onHighlightClick={(annotation, anchor) => { setActiveAnnotation({ annotation, ...anchor }); setAnnotationDraft(annotation.comment || ""); }}
              onAreaSelect={handleAreaSelect}
              onInternalLink={(target, fraction, anchor) => void openInternalPreview(target, fraction, anchor, "source")}
              onTextReference={(reference, anchor) => void openTextReference(reference, anchor, "source")}
              onSelect={(selected) => { chooseActive("source"); setSelection(selected); setAnnotating(false); }}
              onScrollFraction={(p, fraction) => { chooseActive("source"); syncScroll("source", p, fraction); }}
              onBlocks={(pageNo, blocks) => { if (blocks.length) api.setBlocks(paper.id, source.versionId, pageNo, blocks).catch(() => undefined); }}
            />
            </div>
          )}
          {mode === "dual" && <div className="pane-splitter" role="separator" aria-orientation="vertical" aria-label="拖动调整原文与译文宽度"
            onPointerDown={(event) => { const rect = panesRef.current?.getBoundingClientRect(); if (rect) { event.preventDefault(); splitDrag.current = { left: rect.left, width: rect.width }; } }}
            onDoubleClick={() => { setSplitRatio(0.5); try { localStorage.setItem("moonlight-reader-split", "0.5"); } catch { /* ignore */ } }} />}
          {(mode === "translated" || mode === "dual") && translated && (
            <div className="pane-slot" style={mode === "dual" ? { flex: "1 1 auto" } : undefined}>
            <PdfPane key="translated" bytes={translated.bytes} url={translated.url} scale={scale} annotations={translatedAnnotations}
              initialPage={toTranslatedPage(page) ?? 1} initialFraction={positionRef.current.fraction} side="translated" registerApi={registerTranslated}
              autoCrop={autoCrop} areaMode={tool === "area"} onPinchScale={pinchScale} onCropChange={noteCrop}
              findMatches={activeSide === "translated" ? findMatches : undefined} activeMatchIndex={activeSide === "translated" ? findIndex : undefined}
              alignedBox={aligned?.page === page && aligned.translated && toTranslatedPage(page) != null ? { page: toTranslatedPage(page)!, bbox: aligned.translated } : null}
              onParagraphPoint={(point, kind) => alignPoint("translated", point, kind)}
              onHighlightClick={(annotation, anchor) => { setActiveAnnotation({ annotation, ...anchor }); setAnnotationDraft(annotation.comment || ""); }}
              onAreaSelect={handleAreaSelect}
              onInternalLink={(target, fraction, anchor) => void openInternalPreview(target, fraction, anchor, "translated")}
              onTextReference={(reference, anchor) => void openTextReference(reference, anchor, "translated")}
              onSelect={(selected) => { chooseActive("translated"); setSelection(selected); setAnnotating(false); }}
              onScrollFraction={(p, fraction) => { chooseActive("translated"); syncScroll("translated", p, fraction); }}
              onBlocks={(pageNo, blocks) => { if (blocks.length) api.setBlocks(paper.id, translated.versionId, pageNo, blocks).then(() => setTranslatedBlockRevision((value) => value + 1)).catch(() => undefined); }}
            />
            {translatedPageMissing && <div className="untranslated-mask" role="status">
              <strong>第 {page} 页尚未翻译</strong>
              <p className="muted small">当前译文只包含已选页码范围；切到未译页时不会显示错位的其他页译文。</p>
              <button className="btn tiny primary" onClick={() => void startTranslate(String(page))}><Languages size={13} />翻译当前页</button>
            </div>}
            </div>
          )}
        </div>

        {selection && (
          <FloatingLayer x={selection.anchor?.x ?? window.innerWidth / 2} y={selection.anchor?.y ?? window.innerHeight * 0.32} placement="above" boundsTop={56} onClose={quickResult ? undefined : () => { setSelection(null); setAnnotating(false); }} className="selection-toolbar" label="选区操作">
            <div className="selection-row">
              {HIGHLIGHT_COLORS.map((color) => {
                const selected = annotating && draftColor === color.key;
                return <button key={color.key} className={`color-dot ${color.key}${selected ? " selected" : ""}`}
                  style={selected ? { outline: "2px solid var(--accent)", outlineOffset: 2 } : undefined}
                  aria-pressed={annotating ? selected : undefined}
                  onClick={() => { if (annotating) setDraftColor(color.key); else void addHighlight(color.key); }}
                  title={annotating ? `批注语义：${color.label}（${color.name}）` : `${color.label}（${color.name}）`}
                  aria-label={color.name}><span className="sr-only">{color.name}</span></button>;
              })}
              <span className="toolbar-sep" />
              <button className={annotating ? "tool on" : "tool"} onClick={() => setAnnotating((value) => !value)} title="写批注"><NotebookPen size={15} /><span className="sr-only">批注</span></button>
              {selection.area ? <>
                <button className="tool" title="AI 解读图表" aria-label="AI 解读图表" onClick={() => areaAsk("chart")}><Sparkles size={15} /><span className="sr-only">AI 解读图表</span></button>
                <button className="tool" title="公式转 LaTeX" aria-label="公式转 LaTeX" onClick={() => areaAsk("latex")}><span aria-hidden="true">∑</span><span className="sr-only">公式转 LaTeX</span></button>
                <button className="tool" title="表格抽为 Markdown" aria-label="表格抽为 Markdown" onClick={() => areaAsk("table")}><span aria-hidden="true">▦</span><span className="sr-only">表格抽为 Markdown</span></button>
                <button className="tool" title={selectionText ? "复制框选区域文字" : "框选区域内没有可复制的文字"} aria-label="复制选区文本" disabled={!selectionText} onClick={() => void copySelection()}><Copy size={15} /><span className="sr-only">复制选区文本</span></button>
              </> : <>
                <button className="tool" onClick={() => void translateSelection()} title="就地翻译选段（浮窗预览，不写入对话历史）"><Languages size={15} /><span className="sr-only">翻译</span></button>
                <button className="tool" title="AI 就地解释选段" onClick={() => void quickAsk("explain")}><Sparkles size={15} /><span className="sr-only">解释</span></button>
                <button className="tool" title="核查原文依据" aria-label="核查原文依据" onClick={() => void claimVerifySelection()}><span aria-hidden="true">🔍</span><span className="sr-only">核查原文依据</span></button>
                <button className="tool" title="引用选段提问" onClick={quoteSelection}><MessageSquareQuote size={15} /><span className="sr-only">引用提问</span></button>
                <button className="tool" title="复制选段" onClick={() => void copySelection()}><Copy size={15} /><span className="sr-only">复制</span></button>
              </>}
              <button className="tool subtle" aria-label="关闭选区工具" onClick={() => setSelection(null)}><X size={14} /></button>
            </div>
            {!selection.area && !annotating && contextualChips(selection.quote).length > 0 && <div className="selection-chips">
              {contextualChips(selection.quote).map((chip) => <button key={chip.label} className="chip-action" onClick={() => void quickAsk("explain", chip.question)}>{chip.label}</button>)}
            </div>}
            {annotating && <div className="selection-note">
              <textarea aria-label="批注内容" rows={2} value={annotationDraft} placeholder="写一条批注…" onChange={(event) => setAnnotationDraft(event.target.value)} />
              <button className="btn tiny primary" onClick={async () => { const color = draftColor; await addHighlight(color, annotationDraft); setDraftColor("yellow"); }}>保存批注</button>
            </div>}
            <div className="selection-quote-small">“{selection.quote.slice(0, 90)}{selection.quote.length > 90 ? "…" : ""}”</div>
          </FloatingLayer>
        )}

        {quickResult && (
          <FloatingLayer x={quickResult.x} y={quickResult.y + 18} placement="auto" boundsTop={56}
            onClose={closeQuick} className="quick-answer" label={quickTitle}>
            <div className="quick-answer-head">
              <Sparkles size={14} />
              <strong>{quickTitle}</strong>
              {quickResult.loading && <Loader2 className="spin" size={13} />}
              <button className="icon-btn" aria-label="关闭浮窗" onClick={closeQuick}><X size={13} /></button>
            </div>
            <div className="quick-answer-body">
              {quickResult.kind === "claim" && !quickResult.error && (quickResult.verdict || !quickResult.loading) && (
                <div className="claim-verdict" data-verdict={quickResult.verdict ?? "unknown"} role="status"
                  style={{ ...claimVerdictStyle(quickResult.verdict), padding: "3px 8px", borderRadius: 6, display: "inline-block", marginBottom: 6, fontSize: 12, fontWeight: 600 }}>
                  {quickResult.verdict ? claimVerdictLabel(quickResult.verdict) : "未判定"}
                  <span className="sr-only">（原文依据核查三态结论）</span>
                </div>
              )}
              {quickResult.imageDataUrl && <img className="quick-image" src={quickResult.imageDataUrl} alt="框选区域截图" />}
              {quickResult.error
                ? <p role="alert">{quickResult.error}</p>
                : quickResult.answer
                  ? <p className="quick-answer-text">{quickResult.answer}{quickResult.loading ? <span className="quick-caret">▍</span> : null}</p>
                  : <p className="muted small">{quickPlaceholder}</p>}
            </div>
            <div className="quick-answer-actions">
              <button className="btn tiny" disabled={!quickResult.answer || quickResult.loading} onClick={() => void copyQuick()}><Copy size={13} />复制</button>
              <button className="btn tiny" disabled={!quickResult.answer || quickResult.loading || !selection} onClick={() => void saveQuickAsAnnotation()}><NotebookPen size={13} />存入高亮批注</button>
              <button className="btn tiny primary" onClick={promoteQuickToChat}><MessageSquareQuote size={13} />转入深聊</button>
            </div>
          </FloatingLayer>
        )}

        {preview && (
          <FloatingLayer x={preview.x} y={preview.y} placement="auto" boundsTop={56} onClose={() => setPreview(null)} className="smart-preview" label="引用位置预览">
            <div className="smart-preview-head">
              <span>第 {preview.page} 页 · 位置预览</span>
              <button className="icon-btn" aria-label="关闭预览" onClick={() => setPreview(null)}><X size={13} /></button>
            </div>
            {preview.loading || !preview.src
              ? <div className="smart-preview-loading"><Loader2 className="spin" size={14} />正在生成预览…</div>
              : <img src={preview.src} alt={`第 ${preview.page} 页预览`} />}
            <div className="smart-preview-actions">
              <button className="btn tiny" disabled={!preview.src} onClick={pinPreview}>📌 钉在角落对照</button>
              <button className="btn tiny primary" onClick={() => { jumpTo(preview.side === "translated" ? sourcePageForTranslated(pageMapRef.current, preview.page - 1) + 1 : preview.page, preview.fraction); setPreview(null); }}>↗ 跳转到第 {preview.page} 页</button>
            </div>
          </FloatingLayer>
        )}

        {pinned && (
          <div className="pinned-portal" style={{ left: pinned.x, top: pinned.y }} role="dialog" aria-label="钉选对照窗">
            <div className="pinned-head" onPointerDown={startPinDrag}>
              <span>p.{pinned.page} · 钉选</span>
              <button onClick={() => jumpTo(pinned.side === "translated" ? sourcePageForTranslated(pageMapRef.current, pinned.page - 1) + 1 : pinned.page, pinned.fraction)}>跳转</button>
              <button aria-label="关闭钉选" onClick={() => setPinned(null)}><X size={12} /></button>
            </div>
            <img src={pinned.src} alt={`第 ${pinned.page} 页钉选区域`} />
          </div>
        )}

        {activeAnnotation && (
          <FloatingLayer x={activeAnnotation.x} y={activeAnnotation.y} placement="auto" onClose={() => setActiveAnnotation(null)} className="annotation-popover" label="高亮批注">
            <div className="annotation-head"><span className={`color-dot ${activeAnnotation.annotation.color}`} /><span className="small">第 {(activeAnnotation.annotation.source_page ?? activeAnnotation.annotation.page) + 1} 页</span><button className="icon-btn" aria-label="关闭批注" onClick={() => setActiveAnnotation(null)}><X size={13} /></button></div>
            <p className="annotation-quote">“{activeAnnotation.annotation.quote.slice(0, 160)}…”</p>
            <div className="selection-row">
              {HIGHLIGHT_COLORS.map((color) => <button key={color.key} className={`color-dot ${color.key}`} title={`改为${color.label}（${color.name}）`} aria-label={`改为${color.name}`} onClick={async () => { await api.updateAnnotation(activeAnnotation.annotation.id, { color: color.key }); await reloadAnnotations(); setActiveAnnotation(null); }}><span className="sr-only">{color.name}</span></button>)}
              <button className="tool" title="跳转到原文" onClick={() => { const annotation = activeAnnotation.annotation; const sourcePage = annotation.source_page ?? annotation.page; setActiveAnnotation(null); remember(sourcePage + 1, annotation.rects[0]?.y ?? 0); if (annotation.version_kind === "translated") { setMode("translated"); chooseActive("translated"); goToTranslated(sourcePage + 1, annotation.rects[0]?.y ?? 0); } else { setMode("source"); chooseActive("source"); sourceApi.current?.goTo(sourcePage + 1, annotation.rects[0]?.y ?? 0); } }}><BookOpen size={14} /><span className="sr-only">跳转</span></button>
              <button className="tool danger" title="删除高亮" onClick={async () => { await api.deleteAnnotation(activeAnnotation.annotation.id); await reloadAnnotations(); setActiveAnnotation(null); }}><Trash2 size={14} /><span className="sr-only">删除</span></button>
            </div>
            <textarea aria-label="高亮批注内容" rows={2} value={annotationDraft} placeholder="补充批注…" onChange={(event) => setAnnotationDraft(event.target.value)} />
            <button className="btn tiny" onClick={async () => { await api.updateAnnotation(activeAnnotation.annotation.id, { comment: annotationDraft }); await reloadAnnotations(); setActiveAnnotation(null); onToast("批注已保存"); }}>保存批注</button>
          </FloatingLayer>
        )}

        {sideOpen && (
          <aside className={`side${narrow ? " sheet" : ""}${narrow && sheetFull ? " sheet-full" : ""}`} style={narrow ? undefined : { width: sideWidth, flexBasis: sideWidth }}>
            {narrow
              ? <div className="sheet-grip" aria-hidden="true" onPointerDown={(event) => { sheetDrag.current = { y0: event.clientY }; }} />
              : <div className="side-resizer" role="separator" aria-label="拖动调整侧栏宽度" onPointerDown={() => { dragging.current = true; }} />}
            <div className="side-tabs">
              <button className={tab === "ai" ? "on" : ""} onClick={() => setTab("ai")}><Sparkles size={14} />阅读助手</button>
              <button className={tab === "notes" ? "on" : ""} onClick={() => setTab("notes")}><NotebookPen size={14} />笔记 {annotations.length > 0 && <span className="badge">{annotations.length}</span>}</button>
              {narrow && <button className="icon-btn sheet-toggle" aria-label={sheetFull ? "收起为半屏" : "展开为全屏"} title={sheetFull ? "收起为半屏" : "展开为全屏"} onClick={() => setSheetFull((value) => !value)}>{sheetFull ? <Minimize2 size={15} /> : <Maximize2 size={15} />}</button>}
            </div>

            {tab === "notes" && (
              <div className="notes">
                <section className="note-workspace">
                  <div className="note-head">
                    <h3>整篇阅读笔记</h3>
                    <span className={`note-state ${noteState}`} role="status">
                      {noteState === "saving" ? "保存中…" : noteState === "saved" ? "已保存" : noteState === "error" ? "保存失败" : "600ms 自动保存"}
                    </span>
                  </div>
                  <div className="note-tools">
                    <button className="btn tiny" onClick={applyNoteTemplate}>+ 套用精读模板</button>
                    <button className="btn tiny" onClick={() => insertNoteText(`[p.${page}]`)}>+ 引用当前页 p.{page}</button>
                    <button className={notePreview ? "btn tiny on" : "btn tiny"} aria-pressed={notePreview} onClick={() => setNotePreview((value) => !value)}>{notePreview ? "编辑" : "预览"}</button>
                    <button className="btn tiny" onClick={() => void exportReadingNotes()}>导出精读笔记 .md</button>
                  </div>
                  {notePreview
                    ? <div className="note-preview"><MarkdownAnswer text={(noteDraft || "_（暂无笔记）_").replace(/\[p\.(\d+)\]/g, "[p.$1](#p-$1)")} onPageRef={(target) => jumpTo(target, 0)} /></div>
                    : <textarea ref={noteArea} className="note-editor" aria-label="整篇阅读笔记" rows={9} value={noteDraft}
                      placeholder="边读边写…支持 Markdown，停止输入 600ms 后自动保存"
                      onChange={(event) => { setNoteDraft(event.target.value); scheduleNoteSave(event.target.value); }} />}
                </section>
                <ImportedFiles paperId={paper.id} files={files} onOpen={chooseSource} onError={(message) => { onToast(message); noteSettingsHint(message); }} />
                <p className="muted hint">在 PDF 中选中文字即可就地高亮、批注、翻译或提问；点击批注文字可直接修改。</p>
                <div className="note-annotations-head">
                  <h3>高亮与批注 <span className="muted small">{annotations.length}</span></h3>
                  <div className="color-filter" role="group" aria-label="按语义筛选批注">
                    <button className={colorFilter === null ? "on" : ""} onClick={() => setColorFilter(null)}>全部</button>
                    {HIGHLIGHT_COLORS.map((color) => <button key={color.key} title={`${color.label}（${color.name}）`} className={colorFilter === color.key ? "on" : ""} onClick={() => setColorFilter(colorFilter === color.key ? null : color.key)}><span className={`color-dot small ${color.key}`} />{color.label}</button>)}
                  </div>
                </div>
                {visibleAnnotations.length === 0 && <p className="muted small">{annotations.length ? "当前语义筛选下没有批注。" : "还没有划线或批注。"}</p>}
                {visibleAnnotations.map((annotation) => (
                  <div className="note-item" key={annotation.id}>
                    <div className="note-quote"><span className={`color-dot small ${annotation.color}`} />{annotation.quote.slice(0, 180)}</div>
                    {editingComment?.id === annotation.id ? (
                      <div className="note-comment editing">
                        <textarea aria-label="编辑批注" rows={3} autoFocus value={editingComment.text} onChange={(event) => setEditingComment({ id: annotation.id, text: event.target.value })} />
                        <div className="row-actions">
                          <button className="btn tiny primary" onClick={() => void saveComment(annotation.id, editingComment.text)}>保存批注</button>
                          <button className="btn tiny" onClick={() => setEditingComment(null)}>取消</button>
                        </div>
                      </div>
                    ) : (
                      <button className={`note-comment ${annotation.comment ? "" : "empty"}`} title="点击编辑批注" onClick={() => setEditingComment({ id: annotation.id, text: annotation.comment })}>
                        {annotation.comment || "＋ 添加批注"}
                      </button>
                    )}
                    <div className="note-meta">
                      <span>第 {annotation.page + 1} 页</span>
                      <button className="link" onClick={() => {
                        if (annotation.version_kind === "source" && annotation.version_id && annotation.version_id !== source.versionId) { void chooseSource(annotation.version_id, annotation.page + 1, annotation.rects[0]?.y ?? 0); return; }
                        remember(annotation.page + 1, annotation.rects[0]?.y ?? 0);
                        setMode(annotation.version_kind === "translated" ? "translated" : "source");
                        if (annotation.version_kind === "translated") goToTranslated(annotation.page + 1, annotation.rects[0]?.y ?? 0);
                        else sourceApi.current?.goTo(annotation.page + 1, annotation.rects[0]?.y ?? 0);
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

                {digest ? (
                  <section className="paper-digest">
                    <div className="paper-digest-head">
                      <strong>一页纸导读</strong>
                      <button className="icon-btn" aria-label="重新生成结构化导读" title="重新生成会消耗一次模型额度" disabled={digestBusy} onClick={() => void generateDigest(true)}>{digestBusy ? <Loader2 className="spin" size={13} /> : <RotateCcw size={13} />}</button>
                    </div>
                    <MarkdownAnswer text={digest.markdown.replace(/\[p\.(\d+)\]/g, "[p.$1](#p-$1)")} onPageRef={(target) => jumpTo(target, 0)} />
                    <p className="muted small">生成于 {new Date(digest.generated_at).toLocaleString()}{digest.model ? ` · ${digest.model}` : ""} · 已缓存，重新打开无需再花额度</p>
                  </section>
                ) : (
                  <button className="digest-cta" disabled={digestBusy} onClick={() => void generateDigest(false)}>
                    {digestBusy ? <Loader2 className="spin" size={14} /> : <Sparkles size={14} />}
                    {digestBusy ? "正在生成一页纸导读…" : "✨ 生成结构化导读（5 段 + 页码引用）"}
                  </button>
                )}

                {contextAnchor && (
                  <FloatingLayer x={contextAnchor.x} y={contextAnchor.y} onClose={() => setContextAnchor(null)} ignore={contextButton} className="context-menu-panel" label="上下文设置">
                    <label className="small">提问上下文
                      <select aria-label="提问上下文" value={scope} disabled={aiBusy} onChange={(event) => { setScope(event.target.value); setContextPreview(null); }}>
                        <option value="related">相关页检索与取样</option><option value="page">仅当前页</option><option value="full">全文顺序（最多 32000 字）</option>
                      </select>
                    </label>
                    <label className="small check"><input type="checkbox" checked={includeHistory} onChange={(event) => setIncludeHistory(event.target.checked)} />带入最近 6 轮对话</label>
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
                  {messages.length === 0 && !live && <div className="chat-empty"><Sparkles size={26} /><p>就这篇论文提问，或从选段直接发起解释与翻译。</p><span className="muted small">回答只依据论文原文片段；引用编号可点击回到原文。</span>
                    {onOpenSettings && <button className="btn tiny settings-cta" aria-label="前往配置 API 或登录 Codex" onClick={() => onOpenSettings("ai")}>前往配置 API / 登录 Codex →</button>}
                  </div>}
                </div>

                <div className="composer">
                  {selection && <div className="quote-bar"><MessageSquareQuote size={13} /><span>引用选段：{selection.quote.slice(0, 60)}{selection.quote.length > 60 ? "…" : ""}</span><button className="icon-btn" aria-label="取消引用" onClick={() => setSelection(null)}><X size={12} /></button></div>}
                  <textarea ref={composer} aria-label="论文提问" value={aiQuestion} placeholder="就这篇论文提问，例如：HybridFlow 的 3D 并行如何拆分数据？" rows={2}
                    onChange={(event) => setAiQuestion(event.target.value)}
                    onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); void ask("ask"); } }} />
                  <div className="composer-foot">
                    <span className="muted small">{aiProvider === "codex" ? "Codex 账号额度" : "API 问答服务"} · Enter 发送 / Shift+Enter 换行</span>
                    {aiBusy
                      // Both providers can be cancelled; the API backend now
                      // honours aiAction("cancel").
                      ? <button className="btn tiny" aria-label="停止生成" onClick={() => { if (aiRequest.current) void api.aiAction("cancel", { request_id: aiRequest.current }).catch((e) => setAiError(e.message)); }}><Square size={13} />停止</button>
                      : <button className="btn primary tiny" aria-label="发送问题" disabled={!aiQuestion.trim()} onClick={() => void ask("ask")}><SendIcon /></button>}
                  </div>
                </div>
                {aiError && <div className="error-box" role="alert">{aiError}</div>}
                {aiError && onOpenSettings && settingsTabForError(aiError) && (
                  <button className="btn tiny settings-cta" onClick={() => onOpenSettings(settingsTabForError(aiError)!)}>前往配置 API / 登录 Codex →</button>
                )}
              </div>
            )}
          </aside>
        )}
        {!sideOpen && <button className="side-reopen icon-btn" aria-label="展开侧栏" onClick={() => setSideOpen(true)}><PanelRightOpen size={16} /></button>}
      </div>

      {showTranslateMenu && (
        <FloatingLayer x={window.innerWidth - 60} y={64} onClose={() => { setShowTranslateMenu(false); setTranslateRangeOpen(false); }} className="menu translate-floating" label="翻译选项">
          <button onClick={() => void startTranslate(String(page))}>只翻译当前页（第 {page} 页）</button>
          {translateRangeOpen ? (
            <div className="translate-range">
              <input aria-label="翻译页码范围" placeholder="如 1-5, 8" inputMode="numeric" value={translateRange}
                autoFocus
                onChange={(event) => { setTranslateRange(event.target.value); setTranslateRangeError(""); }}
                onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); startRangeTranslation(); } }} />
              <button className="btn tiny primary" onClick={startRangeTranslation}>开始</button>
            </div>
          ) : (
            <button onClick={() => { setTranslateRangeOpen(true); setTranslateRangeError(""); }}>翻译指定页码范围…</button>
          )}
          {translateRangeError && <p className="small translate-range-error" role="alert">{translateRangeError}</p>}
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

const COLUMN_CENTER_TOLERANCE = 0.22;

/** Normalises a PDF bbox x range to [0, 1] page-width fractions. */
function normalizedXRange(bbox: number[], pageWidth?: number): [number, number] | undefined {
  if (!Array.isArray(bbox) || bbox.length !== 4) return undefined;
  if (!pageWidth || !Number.isFinite(pageWidth) || pageWidth <= 0) return undefined;
  const left = Number(bbox[0]);
  const right = Number(bbox[2]);
  if (!Number.isFinite(left) || !Number.isFinite(right)) return undefined;
  return [Math.min(left, right) / pageWidth, Math.max(left, right) / pageWidth];
}

/**
 * True when a candidate block belongs to the same column as the source block:
 * horizontal overlap covers more than half of the source span, or the two
 * centres are within 0.22 page widths (full-width blocks overlap anyway).
 */
function sameColumn(bbox: number[], sourceX: [number, number], pageWidth: number): boolean {
  const range = normalizedXRange(bbox, pageWidth);
  if (!range) return false;
  const overlap = Math.min(range[1], sourceX[1]) - Math.max(range[0], sourceX[0]);
  const sourceSpan = sourceX[1] - sourceX[0];
  if (sourceSpan > 0 && overlap / sourceSpan > 0.5) return true;
  const center = (range[0] + range[1]) / 2;
  const sourceCenter = (sourceX[0] + sourceX[1]) / 2;
  return Math.abs(center - sourceCenter) < COLUMN_CENTER_TOLERANCE;
}

/**
 * Nearest block by vertical centre. When the source block's normalised x range
 * is supplied, same-column candidates are preferred so that two-column pages
 * never align a left-column paragraph with its right-column neighbour.
 * Falls back to the original Y-only behaviour when no same-column block exists.
 */
function nearestBlock(blocks: Block[], targetY: number, sourceX?: [number, number], pageWidth?: number): Block | undefined {
  const candidates = blocks.filter((block) => Array.isArray(block.bbox) && block.bbox.length === 4);
  const constrained = sourceX !== undefined && pageWidth !== undefined
    ? candidates.filter((block) => sameColumn(block.bbox, sourceX, pageWidth))
    : [];
  const pool = constrained.length > 0 ? constrained : candidates;
  let best: Block | undefined;
  let distance = Number.POSITIVE_INFINITY;
  for (const block of pool) {
    const center = (Number(block.bbox[1]) + Number(block.bbox[3])) / 2;
    const next = Math.abs(center - targetY);
    if (next < distance) { distance = next; best = block; }
  }
  return best;
}

function blockAt(blocks: Block[], x: number, y: number): Block | undefined {
  let best: Block | undefined;
  let area = Number.POSITIVE_INFINITY;
  for (const block of blocks) {
    if (!Array.isArray(block.bbox) || block.bbox.length !== 4) continue;
    const [left, top, right, bottom] = block.bbox.map(Number);
    if (x < left || x > right || y < top || y > bottom) continue;
    const next = (right - left) * (bottom - top);
    if (next < area) { area = next; best = block; }
  }
  return best;
}

function statusLabel(status: string) {
  return ({ queued: "排队", preparing: "准备", parsing: "解析", translating: "翻译", typesetting: "排版", validating: "校验", completed: "完成", failed: "失败", cancelled: "已取消", cancelling: "取消中" } as Record<string, string>)[status] || status;
}
function phaseLabel(job: { status: string; phase?: string }) {
  if (job.status === "queued") return "排队中…";
  return job.phase ? statusLabel(job.phase) + "中…" : "处理中…";
}
