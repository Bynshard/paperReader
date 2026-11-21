import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import { CaseSensitive, ChevronDown, ChevronUp, Loader2, Search, X } from "lucide-react";
import type { FindMatch, PaneApi } from "./PdfPane";

type Props = {
  pane: RefObject<PaneApi | null>;
  onJump: (page: number, bbox?: number[]) => void;
  onResults: (matches: FindMatch[], index: number) => void;
  onClose: () => void;
  /** Prefilled query when the reader was opened from a search hit. */
  initialQuery?: string;
  /** Prefer a hit on this one-based page (the page the user clicked in the library). */
  preferredPage?: number;
};

/** In-document find bar: debounced search, case option, all-hit highlights. */
export default function FindBar({ pane, onJump, onResults, onClose, initialQuery = "", preferredPage }: Props) {
  const [query, setQuery] = useState(initialQuery);
  const [matches, setMatches] = useState<FindMatch[] | null>(null);
  const [index, setIndex] = useState(0);
  const [busy, setBusy] = useState(false);
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [error, setError] = useState("");
  const input = useRef<HTMLInputElement>(null);
  const token = useRef(0);
  const attempts = useRef(0);
  const consumedPreferred = useRef(false);
  const retryTimer = useRef(0);
  const runRef = useRef<(needle: string) => Promise<void>>(async () => undefined);

  useEffect(() => () => window.clearTimeout(retryTimer.current), []);

  useEffect(() => { input.current?.focus(); input.current?.select(); }, []);
  useEffect(() => { if (initialQuery) setQuery(initialQuery); }, [initialQuery]);

  const land = useCallback((rows: FindMatch[], next: number) => {
    const match = rows[next];
    if (match) onJump(match.page, match.bbox);
    onResults(rows, next);
  }, [onJump, onResults]);

  const run = useCallback(async (needle: string) => {
    const current = ++token.current;
    setBusy(true); setError("");
    // The find bar can mount a few frames before pdf.js registers PaneApi.
    // Retry briefly instead of reporting a false "no match".
    if (!pane.current) {
      if (attempts.current < 20) {
        attempts.current += 1;
        retryTimer.current = window.setTimeout(() => { if (current === token.current) void runRef.current(needle); }, 120);
        return;
      }
      setBusy(false); setError("PDF 尚未加载完成，请稍后再试");
      return;
    }
    attempts.current = 0;
    try {
      const rows = (await (caseSensitive ? pane.current.find(needle, { caseSensitive: true }) : pane.current.find(needle))) || [];
      if (current !== token.current) return;
      // A search opened from `p.X 直达` must land on that page's hit, not on the
      // first occurrence (which is often the abstract on page 1).
      const preferred = !consumedPreferred.current && preferredPage
        ? rows.findIndex((row) => row.page === preferredPage)
        : -1;
      consumedPreferred.current = true;
      const next = preferred >= 0 ? preferred : 0;
      setMatches(rows); setIndex(next); land(rows, next);
    } catch (e) {
      if (current !== token.current) return;
      setError((e as Error).message); setMatches([]); onResults([], 0);
    } finally {
      if (current === token.current) setBusy(false);
    }
  }, [caseSensitive, pane, land, onResults, preferredPage]);
  runRef.current = run;

  useEffect(() => {
    const needle = query.trim();
    setMatches(null);
    setIndex(0);
    onResults([], 0);
    attempts.current = 0;
    consumedPreferred.current = false;
    window.clearTimeout(retryTimer.current);
    if (!needle) {
      token.current++;
      return;
    }
    const timer = setTimeout(() => { void runRef.current(needle); }, 300);
    return () => clearTimeout(timer);
  }, [query, caseSensitive, onResults, preferredPage]);

  const step = (delta: number) => {
    const rows = matches || [];
    if (!rows.length) return;
    const next = (index + delta + rows.length) % rows.length;
    setIndex(next); land(rows, next);
  };

  return <div className="find-bar" role="search" aria-label="文内查找">
    <Search size={14} className="find-icon" />
    <input ref={input} aria-label="文内查找关键词" placeholder="在本文中查找…" value={query}
      onChange={(event) => setQuery(event.target.value)}
      onKeyDown={(event) => {
        if (event.key === "Enter") { event.preventDefault(); if (matches && matches.length) step(event.shiftKey ? -1 : 1); else void run(query.trim()); }
        if (event.key === "Escape") onClose();
      }} />
    <button className={caseSensitive ? "icon-btn on" : "icon-btn"} aria-label="区分大小写" aria-pressed={caseSensitive} title="区分大小写" onClick={() => setCaseSensitive((value) => !value)}><CaseSensitive size={15} /></button>
    <span className="find-count" role="status">
      {busy ? <Loader2 className="spin" size={13} /> : matches === null ? "" : matches.length ? `${index + 1}/${matches.length}` : "无匹配"}
    </span>
    <button className="icon-btn" aria-label="上一个匹配" disabled={!matches?.length} onClick={() => step(-1)}><ChevronUp size={15} /></button>
    <button className="icon-btn" aria-label="下一个匹配" disabled={!matches?.length} onClick={() => step(1)}><ChevronDown size={15} /></button>
    <button className="icon-btn" aria-label="关闭查找" onClick={onClose}><X size={14} /></button>
    {error && <span className="find-error" role="alert">{error}</span>}
  </div>;
}
