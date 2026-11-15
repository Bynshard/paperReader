import { useEffect, useRef, useState, type RefObject } from "react";
import { ChevronDown, ChevronUp, Loader2, Search, X } from "lucide-react";
import type { FindMatch, PaneApi } from "./PdfPane";

type Props = {
  pane: RefObject<PaneApi | null>;
  onJump: (page: number, bbox?: number[]) => void;
  onClose: () => void;
};

/** In-document find bar (Ctrl/Cmd+F): counts matches, jumps and outlines the hit. */
export default function FindBar({ pane, onJump, onClose }: Props) {
  const [query, setQuery] = useState("");
  const [matches, setMatches] = useState<FindMatch[] | null>(null);
  const [index, setIndex] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => { input.current?.focus(); input.current?.select(); }, []);

  const land = (rows: FindMatch[], next: number) => {
    const match = rows[next];
    if (match) onJump(match.page, match.bbox);
  };
  const run = async () => {
    const needle = query.trim();
    if (!needle) { setMatches(null); return; }
    setBusy(true); setError("");
    try {
      const rows = (await pane.current?.find(needle)) || [];
      setMatches(rows); setIndex(0); land(rows, 0);
    } catch (e) {
      setError((e as Error).message); setMatches([]);
    } finally {
      setBusy(false);
    }
  };
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
        if (event.key === "Enter") { event.preventDefault(); if (matches && matches.length) step(event.shiftKey ? -1 : 1); else void run(); }
        if (event.key === "Escape") onClose();
      }} />
    <span className="find-count" role="status">
      {busy ? <Loader2 className="spin" size={13} /> : matches === null ? "" : matches.length ? `${index + 1}/${matches.length}` : "无匹配"}
    </span>
    <button className="icon-btn" aria-label="上一个匹配" disabled={!matches?.length} onClick={() => step(-1)}><ChevronUp size={15} /></button>
    <button className="icon-btn" aria-label="下一个匹配" disabled={!matches?.length} onClick={() => step(1)}><ChevronDown size={15} /></button>
    <button className="icon-btn" aria-label="关闭查找" onClick={onClose}><X size={14} /></button>
    {error && <span className="find-error" role="alert">{error}</span>}
  </div>;
}
