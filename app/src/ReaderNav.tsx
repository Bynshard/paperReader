import { useEffect, useRef, useState, type RefObject } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { ChevronDown, ChevronRight, FileText, Images, LayoutGrid, ListTree, Loader2, X } from "lucide-react";
import type { FigureItem, OutlineItem, PaneApi } from "./PdfPane";
import "./reader-gallery.css";

type Props = {
  pane: RefObject<PaneApi | null>;
  pages: number;
  current: number;
  versionKey?: string;
  onJump: (page: number, fraction: number) => void;
  /** Turns a figure card into the reader's pinned corner portal (FEAT-UX-06). */
  onPin?: (page: number, fraction: number, src: string) => void;
  onClose: () => void;
};

/** Left-hand reader navigation: PDF outline, page thumbnails and a figures gallery. */
export default function ReaderNav({ pane, pages, current, versionKey, onJump, onPin, onClose }: Props) {
  const [tab, setTab] = useState<"outline" | "pages" | "figures">("outline");
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
        <button className={tab === "figures" ? "on" : ""} onClick={() => setTab("figures")} title="全文图表画廊"><LayoutGrid size={14} />图表</button>
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
      {tab === "figures" && <FigureGallery pane={pane} versionKey={versionKey} onJump={onJump} onPin={onPin} />}
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

/** Full-text figures & tables gallery (FEAT-UX-06). */
function FigureGallery({ pane, versionKey, onJump, onPin }: {
  pane: RefObject<PaneApi | null>;
  versionKey?: string;
  onJump: (page: number, fraction: number) => void;
  onPin?: (page: number, fraction: number, src: string) => void;
}) {
  const [figures, setFigures] = useState<FigureItem[] | null>(null);
  const [error, setError] = useState("");
  // Render a few cards at a time so a 200-caption scan never blocks the UI.
  const [visible, setVisible] = useState(24);

  useEffect(() => {
    let alive = true;
    let tries = 0;
    const load = () => {
      const api = pane.current;
      if (!api) { if (++tries < 40) setTimeout(load, 150); return; }
      if (typeof api.extractFigures !== "function") { if (alive) setFigures([]); return; }
      api.extractFigures().then((rows) => { if (alive) setFigures(rows); }).catch((e) => { if (alive) { setFigures([]); setError((e as Error).message); } });
    };
    setFigures(null);
    setError("");
    setVisible(24);
    load();
    return () => { alive = false; };
  }, [pane, versionKey]);

  if (figures === null) return <p className="reader-nav-empty"><Loader2 className="spin" size={14} /> 正在扫描全文图表…</p>;
  if (figures.length === 0) return <p className="reader-nav-empty">{error ? `图表提取失败：${error}` : "这份 PDF 没有识别到 Figure / Table / Algorithm 图注。"}</p>;
  return <div className="figure-gallery" aria-label="图表画廊">
    <p className="figure-gallery-count">全文共 {figures.length} 个图表 / 算法</p>
    {figures.slice(0, visible).map((figure) => <FigureCard key={`${figure.page}:${figure.label}`} pane={pane} figure={figure} onJump={onJump} onPin={onPin} />)}
    {figures.length > visible && <button className="btn tiny figure-more" onClick={() => setVisible((value) => value + 24)}>加载更多（{figures.length - visible}）</button>}
  </div>;
}

function FigureCard({ pane, figure, onJump, onPin }: {
  pane: RefObject<PaneApi | null>;
  figure: FigureItem;
  onJump: (page: number, fraction: number) => void;
  onPin?: (page: number, fraction: number, src: string) => void;
}) {
  const [src, setSrc] = useState("");
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let alive = true;
    let tries = 0;
    const load = () => {
      const api = pane.current;
      if (!api) { if (++tries < 30) setTimeout(load, 150); return; }
      api.renderRegion(figure.page, figure.fraction, 240).then((url) => { if (alive) { if (url) setSrc(url); else setFailed(true); } }).catch(() => { if (alive) setFailed(true); });
    };
    load();
    return () => { alive = false; };
  }, [pane, figure.page, figure.fraction]);
  const caption = figure.caption.replace(/^(?:Figure|Fig\.|Table|Algorithm)\s+\d+[.:：]\s*/i, "").trim();
  const pin = async () => {
    if (!onPin) return;
    let url = src;
    if (!url) { try { url = (await pane.current?.renderRegion(figure.page, figure.fraction, 240)) || ""; } catch { url = ""; } }
    onPin(figure.page, figure.fraction, url);
  };
  return <div className="figure-card">
    <button className="figure-open" onClick={() => onJump(figure.page, figure.fraction)} aria-label={`跳转到 ${figure.label}（第 ${figure.page} 页）`}>
      <span className="figure-thumb">
        {src ? <img src={src} alt={`${figure.label} 预览`} loading="lazy" /> : <span className="figure-thumb-empty">{failed ? <FileText size={18} /> : <Loader2 className="spin" size={16} />}</span>}
      </span>
      <span className="figure-meta">
        <strong>{figure.label}</strong>
        <span className="figure-caption" title={figure.caption}>{caption || figure.caption}</span>
        <span className="figure-page">第 {figure.page} 页</span>
      </span>
    </button>
    {onPin && <button className="figure-pin" aria-label={`钉选 ${figure.label}`} title="钉选到角落对照" onClick={() => void pin()}>📌</button>}
  </div>;
}
