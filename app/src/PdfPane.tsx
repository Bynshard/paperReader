import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import * as pdfjsLib from "pdfjs-dist";
import "pdfjs-dist/web/pdf_viewer.css";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import type { Annotation } from "./types";

pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrl;
type Rect = Annotation["rects"][number];
type Block = { bbox: number[]; text: string };
export type Selection = { page: number; rects: Rect[]; quote: string; side: "source" | "translated" };
export type PaneApi = {
  // Navigation is silent. Only actual user scrolling emits synchronization events.
  goTo: (page: number, fraction?: number, bbox?: number[]) => void;
  getPosition: () => { page: number; fraction: number };
};
type Props = {
  bytes: Uint8Array; scale: number; annotations: Annotation[];
  initialPage?: number; initialFraction?: number;
  onPageChange?: (page: number) => void;
  onSelect?: (sel: Selection | null) => void;
  onScrollFraction?: (page: number, fraction: number) => void;
  // Storage uses zero-based pages throughout the backend.
  onBlocks?: (page: number, blocks: Block[]) => void;
  registerApi?: (api: PaneApi | null) => void;
  side: "source" | "translated";
};

function groupBlocks(items: any[], viewport: any): Block[] {
  const blocks: Block[] = [];
  // PDF.js supplies the text and geometry. Keep line fragments in reading
  // order without merging across columns or inventing character widths.
  for (const item of items) {
    if (!item.str?.trim()) continue;
    const tx = pdfjsLib.Util.transform(viewport.transform, item.transform);
    const h = Math.hypot(tx[2], tx[3]);
    if (!Number.isFinite(h) || h <= 0) continue;
    const last = blocks.at(-1);
    const x = tx[4], y = tx[5] - h, right = x + item.width;
    if (last && Math.abs(last.bbox[1] - y) < h * 0.5 && x >= last.bbox[2] - 1 && x - last.bbox[2] < h * 1.5) {
      last.text += ` ${item.str}`;
      last.bbox[2] = Math.max(last.bbox[2], right);
      last.bbox[3] = Math.max(last.bbox[3], y + h);
    } else blocks.push({ bbox: [x, y, right, y + h], text: item.str });
  }
  return blocks;
}

const PageView = memo(function PageView({ doc, index, scale, annotations, onSize, onBlocks, focus }: {
  doc: pdfjsLib.PDFDocumentProxy; index: number; scale: number; annotations: Annotation[];
  onSize: (index: number, width: number, height: number) => void;
  onBlocks: (index: number, blocks: Block[]) => void;
  focus?: number[];
}) {
  const mount = useRef<HTMLDivElement>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    let cancelled = false;
    let task: pdfjsLib.RenderTask | undefined;
    let textTask: pdfjsLib.TextLayer | undefined;
    let page: pdfjsLib.PDFPageProxy | undefined;
    // Each render owns its canvas. An old, cancelled task can never draw
    // into a canvas reused by a new zoom level.
    const canvas = document.createElement("canvas");
    const text = document.createElement("div");
    text.className = "textLayer";
    setError("");
    const run = async () => {
      page = await doc.getPage(index + 1);
      if (cancelled) return;
      const natural = page.getViewport({ scale: 1 });
      onSize(index, natural.width, natural.height);
      const viewport = page.getViewport({ scale });
      // Bound actual backing pixels, not just DPR. At 300% on a 2x display
      // an ordinary letter page otherwise allocates ~67 MiB per canvas.
      // CSS/text/annotation coordinates retain the requested zoom level.
      const dpr = Math.min(window.devicePixelRatio || 1, 2,
        Math.sqrt(8_388_608 / (viewport.width * viewport.height)),
        16_384 / Math.max(viewport.width, viewport.height));
      canvas.width = Math.max(1, Math.floor(viewport.width * dpr));
      canvas.height = Math.max(1, Math.floor(viewport.height * dpr));
      canvas.style.width = `${viewport.width}px`;
      canvas.style.height = `${viewport.height}px`;
      mount.current?.append(canvas, text);
      const ctx = canvas.getContext("2d");
      if (!ctx) throw new Error("无法创建 PDF 画布");
      task = page.render({ canvasContext: ctx, viewport, transform: dpr === 1 ? undefined : [dpr, 0, 0, dpr, 0, 0] });
      const content = await page.getTextContent();
      if (cancelled) return;
      onBlocks(index, groupBlocks(content.items, natural));
      textTask = new pdfjsLib.TextLayer({ textContentSource: content, container: text, viewport });
      await Promise.all([task.promise, textTask.render()]);
      if (!cancelled) {
        canvas.dataset.rendered = "true";
        canvas.dataset.scale = String(scale);
      }
    };
    void run().catch((e) => {
      if (!cancelled && e?.name !== "RenderingCancelledException" && e?.name !== "AbortException") setError(String(e.message || e));
    }).finally(() => {
      if (cancelled) { canvas.width = 0; canvas.height = 0; page?.cleanup(); }
    });
    return () => {
      cancelled = true;
      task?.cancel(); textTask?.cancel();
      canvas.remove(); text.remove();
      if (task) void task.promise.catch(() => undefined).finally(() => { canvas.width = 0; canvas.height = 0; page?.cleanup(); });
      else { canvas.width = 0; canvas.height = 0; page?.cleanup(); }
    };
  }, [doc, index, scale, onSize, onBlocks]);
  return <>
    <div className="page-canvas" ref={mount} />
    {error && <div className="page-error" role="alert">{error}</div>}
    <div className="highlightLayer">
      {annotations.flatMap((a) => a.rects.map((r, i) => <div key={`${a.id}:${i}`} className={`highlight ${a.color}`} style={{ left: `${r.x * 100}%`, top: `${r.y * 100}%`, width: `${r.w * 100}%`, height: `${r.h * 100}%` }} />))}
      {focus && focus.length === 4 && <div className="evidence-focus" style={{ left: focus[0]*scale, top: focus[1]*scale, width: (focus[2]-focus[0])*scale, height: (focus[3]-focus[1])*scale }} />}
    </div>
  </>;
});

export default function PdfPane(props: Props) {
  const { bytes, scale, annotations, registerApi, side } = props;
  const latest = useRef(props); latest.current = props;
  const scroll = useRef<HTMLDivElement>(null);
  const [doc, setDoc] = useState<pdfjsLib.PDFDocumentProxy | null>(null);
  const [natural, setNatural] = useState({ w: 612, h: 792 });
  const sizes = useRef(new Map<number, { w: number; h: number }>());
  const [, setSizeRevision] = useState(0);
  const indexed = useRef(new Set<number>());
  const programmatic = useRef(true);
  const frame = useRef(0);
  const [error, setError] = useState("");
  const [focus, setFocus] = useState<{ page: number; bbox: number[] } | null>(null);
  const virtual = useVirtualizer<HTMLDivElement, HTMLDivElement>({
    count: doc?.numPages ?? 0, getScrollElement: () => scroll.current,
    estimateSize: (i) => (sizes.current.get(i)?.h ?? natural.h) * scale,
    overscan: 1, gap: 24, paddingStart: 18, paddingEnd: 40,
  });
  const state = useRef({ virtual, doc, scale, natural });
  state.current = { virtual, doc, scale, natural };
  useEffect(() => {
    let cancelled = false;
    setDoc(null); setError(""); programmatic.current=true; sizes.current.clear(); indexed.current.clear();
    const task = pdfjsLib.getDocument({ data: bytes.slice() });
    void task.promise.then(async (document) => {
      const first = await document.getPage(1);
      const v = first.getViewport({ scale: 1 });
      if (!cancelled) { setNatural({ w: v.width, h: v.height }); setDoc(document); }
    }).catch((e) => { if (!cancelled) setError(String(e.message || e)); });
    return () => { cancelled = true; void task.destroy(); };
  }, [bytes]);
  const onSize = useCallback((index: number, w: number, h: number) => {
    const previous = sizes.current.get(index);
    sizes.current.set(index, { w, h });
    state.current.virtual.resizeItem(index, h * state.current.scale);
    if (previous?.w !== w) setSizeRevision((revision) => revision + 1);
  }, []);
  const onBlocks = useCallback((index: number, blocks: Block[]) => {
    if (!indexed.current.has(index) && latest.current.onBlocks) {
      indexed.current.add(index); latest.current.onBlocks(index, blocks);
    }
  }, []);
  const position = useCallback(() => {
    const { virtual: v } = state.current;
    const offset = scroll.current?.scrollTop ?? 0;
    const items = v.getVirtualItems();
    const item = items.find((i) => i.end > offset) ?? items.at(-1);
    return item ? { page: item.index+1, fraction: Math.max(0, Math.min(1, (offset-item.start)/item.size)) } : { page: 1, fraction: 0 };
  }, []);
  const goTo = useCallback((page: number, fraction = 0, bbox?: number[]) => {
    const { virtual: v, doc: d, natural: n } = state.current;
    if (!d || !scroll.current) return;
    const index = Math.min(d.numPages-1, Math.max(0, page-1));
    const height = sizes.current.get(index)?.h ?? n.h;
    const f = bbox?.length === 4 ? Math.max(0, (bbox[1]-24)/height) : fraction;
    const offset = v.getOffsetForIndex(index, "start")?.[0];
    if (offset === undefined) return;
    programmatic.current = true;
    v.scrollToOffset(offset + Math.max(0, Math.min(1, f))*height*state.current.scale);
    if (bbox?.length === 4) setFocus({ page: index, bbox });
    // Never invoke onPageChange from here: the other pane may be the caller.
  }, []);
  useEffect(() => {
    if (!doc) return;
    virtual.measure();
    registerApi?.({ goTo, getPosition: position });
    return () => registerApi?.(null);
  }, [doc, scale, registerApi, goTo, position, virtual]);
  useEffect(() => {
    if (doc) {
      goTo(latest.current.initialPage ?? 1, latest.current.initialFraction ?? 0);
    }
  }, [doc, goTo]);
  useEffect(() => () => cancelAnimationFrame(frame.current), []);
  const handleScroll = () => {
    if (programmatic.current || frame.current) return;
    frame.current = requestAnimationFrame(() => {
      frame.current = 0;
      if (programmatic.current) return;
      const p = position();
      latest.current.onPageChange?.(p.page);
      latest.current.onScrollFraction?.(p.page, p.fraction);
    });
  };
  const handleSelection = () => {
    const selected = window.getSelection();
    if (!selected || selected.isCollapsed || !selected.rangeCount) return;
    const range = selected.getRangeAt(0);
    const element = (node: Node) => node.nodeType === Node.ELEMENT_NODE ? node as Element : node.parentElement;
    const holder = element(range.startContainer)?.closest<HTMLElement>(".page-holder");
    if (!holder || !scroll.current?.contains(holder) || holder !== element(range.endContainer)?.closest(".page-holder")) return;
    const quote = selected.toString().trim();
    if (!quote) return;
    const bounds = holder.getBoundingClientRect();
    const rects = Array.from(range.getClientRects()).filter((r) => r.width>1 && r.height>1).map((r) => ({
      x: Math.max(0,(r.left-bounds.left)/bounds.width), y: Math.max(0,(r.top-bounds.top)/bounds.height),
      w: Math.min(r.width,bounds.right-r.left)/bounds.width, h: Math.min(r.height,bounds.bottom-r.top)/bounds.height,
    })).filter((r) => r.w>0 && r.h>0);
    if (rects.length) latest.current.onSelect?.({ page: Number(holder.dataset.page), rects, quote, side });
  };
  const byPage = useMemo(() => {
    const map = new Map<number, Annotation[]>();
    for (const a of annotations) { const values=map.get(a.page) ?? []; values.push(a); map.set(a.page,values); }
    return map;
  }, [annotations]);
  const items = virtual.getVirtualItems();
  const width = Math.max(natural.w, ...items.map((i) => sizes.current.get(i.index)?.w ?? natural.w))*scale+32;
  const userInput = () => { programmatic.current = false; };
  return <div className={`pane pane-${side}`}>
    <div className="pane-scroll" ref={scroll} onScroll={handleScroll} onMouseUp={handleSelection}
      onWheelCapture={userInput} onPointerDownCapture={userInput} onKeyDownCapture={userInput} tabIndex={0} aria-label={side === "source" ? "原文 PDF" : "译文 PDF"}>
      {!doc && <div className="pane-loading">{error || "正在载入 PDF…"}</div>}
      <div style={{ height: virtual.getTotalSize(), width: "100%", minWidth: width, position: "relative" }}>
        {doc && items.map((item) => <div key={item.key} className="page-holder" data-page={item.index+1}
          style={{ width: (sizes.current.get(item.index)?.w ?? natural.w)*scale, height: item.size, position: "absolute", top: 0, left: "50%", transform: `translate(-50%, ${item.start}px)`, "--scale-factor": scale } as React.CSSProperties}>
          <PageView doc={doc} index={item.index} scale={scale} annotations={byPage.get(item.index) ?? EMPTY_ANNOTATIONS}
            onSize={onSize} onBlocks={onBlocks} focus={focus?.page === item.index ? focus.bbox : undefined} />
        </div>)}
      </div>
    </div>
  </div>;
}
const EMPTY_ANNOTATIONS: Annotation[] = [];
