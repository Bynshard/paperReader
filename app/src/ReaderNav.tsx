import { useEffect, useRef, useState, type RefObject } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { ChevronDown, ChevronRight, FileText, Images, ListTree, Loader2, X } from "lucide-react";
import type { OutlineItem, PaneApi } from "./PdfPane";

type Props = {
  pane: RefObject<PaneApi | null>;
  pages: number;
  current: number;
  versionKey?: string;
  onJump: (page: number, fraction: number) => void;
  onClose: () => void;
};

/** Left-hand reader navigation: PDF outline (bookmarks) and page thumbnails. */
export default function ReaderNav({ pane, pages, current, versionKey, onJump, onClose }: Props) {
  const [tab, setTab] = useState<"outline" | "pages">("outline");
  const [outline, setOutline] = useState<OutlineItem[] | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    let alive = true;
    let tries = 0;
    const load = () => {
      const api = pane.current;
      if (!api) { if (++tries < 40) setTimeout(load, 150); return; }
      api.getOutline().then((rows) => { if (alive) setOutline(rows); }).catch((e) => { if (alive) { setOutline([]); setError((e as Error).message); } });
    };
    setOutline(null);
    setError("");
    load();
    return () => { alive = false; };
  }, [pane, pages, versionKey]);

  return (
    <aside className="reader-nav" aria-label="阅读导航">
      <div className="reader-nav-tabs">
        <button className={tab === "outline" ? "on" : ""} onClick={() => setTab("outline")}><ListTree size={14} />目录</button>
        <button className={tab === "pages" ? "on" : ""} onClick={() => setTab("pages")}><Images size={14} />页面</button>
        <button className="icon-btn reader-nav-close" aria-label="收起阅读导航" onClick={onClose}><X size={14} /></button>
      </div>
      {tab === "outline" && (
        <div className="outline" role="tree" aria-label="PDF 目录">
          {outline === null && <p className="reader-nav-empty"><Loader2 className="spin" size={14} /> 正在读取目录…</p>}
          {outline !== null && outline.length === 0 && <p className="reader-nav-empty">{error ? `目录不可用：${error}` : "这份 PDF 没有内嵌书签目录。"}</p>}
          {outline && <OutlineRows items={outline} depth={0} current={current} onJump={onJump} />}
        </div>
      )}
      {tab === "pages" && <PageStrip pane={pane} pages={pages} current={current} onJump={onJump} />}
    </aside>
  );
}

function OutlineRows({ items, depth, current, onJump }: { items: OutlineItem[]; depth: number; current: number; onJump: (page: number, fraction: number) => void }) {
  const [closed, setClosed] = useState<Set<string>>(new Set());
  return <>{items.map((item, index) => {
    const key = `${depth}:${index}:${item.title}`;
    const hasChildren = item.children.length > 0;
    return <div key={key} className="outline-branch">
      <div className={`outline-row ${item.page === current ? "on" : ""}`} style={{ paddingLeft: 8 + Math.min(depth, 6) * 12 }}>
        {hasChildren
          ? <button className="outline-toggle" aria-label={`${closed.has(key) ? "展开" : "折叠"} ${item.title}`} onClick={() => setClosed((old) => { const next = new Set(old); if (next.has(key)) next.delete(key); else next.add(key); return next; })}>{closed.has(key) ? <ChevronRight size={13} /> : <ChevronDown size={13} />}</button>
          : <span className="outline-toggle" />}
        <button className="outline-title" title={`${item.title} · 第 ${item.page} 页`} onClick={() => onJump(item.page, item.fraction)}>{item.title}</button>
        <span className="outline-page">{item.page}</span>
      </div>
      {hasChildren && !closed.has(key) && <OutlineRows items={item.children} depth={depth + 1} current={current} onJump={onJump} />}
    </div>;
  })}</>;
}

function PageStrip({ pane, pages, current, onJump }: { pane: RefObject<PaneApi | null>; pages: number; current: number; onJump: (page: number, fraction: number) => void }) {
  const scroll = useRef<HTMLDivElement>(null);
  const virtual = useVirtualizer({ count: pages, getScrollElement: () => scroll.current, estimateSize: () => 178, overscan: 2 });
  useEffect(() => { if (current >= 1) virtual.scrollToIndex(current - 1, { align: "start" }); }, [current, virtual]);
  return <div className="page-strip" ref={scroll} aria-label="页面缩略图">
    <div style={{ height: virtual.getTotalSize(), position: "relative" }}>
      {virtual.getVirtualItems().map((row) => <div key={row.key} style={{ position: "absolute", top: 0, left: 0, width: "100%", transform: `translateY(${row.start}px)` }}>
        <Thumbnail pane={pane} page={row.index + 1} active={row.index + 1 === current} onClick={() => onJump(row.index + 1, 0)} />
      </div>)}
    </div>
  </div>;
}

function Thumbnail({ pane, page, active, onClick }: { pane: RefObject<PaneApi | null>; page: number; active: boolean; onClick: () => void }) {
  const [src, setSrc] = useState("");
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let alive = true;
    let tries = 0;
    const load = () => {
      const api = pane.current;
      if (!api) { if (++tries < 30) setTimeout(load, 150); return; }
      api.thumbnail(page, 136).then((url) => { if (alive) { if (url) setSrc(url); else setFailed(true); } }).catch(() => { if (alive) setFailed(true); });
    };
    load();
    return () => { alive = false; };
  }, [pane, page]);
  return <button className={`thumb ${active ? "on" : ""}`} onClick={onClick} aria-label={`跳转到第 ${page} 页`}>
    {src ? <img src={src} alt={`第 ${page} 页缩略图`} loading="lazy" /> : <span className="thumb-placeholder">{failed ? <FileText size={18} /> : <Loader2 className="spin" size={16} />}</span>}
    <span className="thumb-page">{page}</span>
  </button>;
}
