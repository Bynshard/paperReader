import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import * as pdfjsLib from "pdfjs-dist";
import "pdfjs-dist/web/pdf_viewer.css";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import {recognizePage} from './ocr';
import type { Annotation } from "./types";

pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrl;
type Rect = Annotation["rects"][number];
export type TextBlock = { bbox: number[]; text: string; kind?:string };
type Block = TextBlock;
export type Selection = { page: number; rects: Rect[]; quote: string; side: "source" | "translated"; anchor?: { x: number; y: number }; area?: boolean };
export type OutlineItem = { title: string; page: number; fraction: number; children: OutlineItem[] };
export type FindMatch = { page: number; bbox: number[] };
export type PaneApi = {
  // Navigation is silent. Only actual user scrolling emits synchronization events.
  goTo: (page: number, fraction?: number, bbox?: number[]) => void;
  getPosition: () => { page: number; fraction: number };
  parsePage: (page:number, options?:{forceOcr?:boolean;signal?:AbortSignal;progress?:(message:string)=>void}) => Promise<Block[]>;
  getOutline: () => Promise<OutlineItem[]>;
  find: (query: string, options?: { caseSensitive?: boolean }) => Promise<FindMatch[]>;
  fit: (mode: "width" | "page") => number;
  prepareZoom?: (focal?: { clientX: number; clientY: number }) => void;
  thumbnail: (page: number, width?: number) => Promise<string>;
};
type Props = {
  bytes: Uint8Array; scale: number; annotations: Annotation[];
  initialPage?: number; initialFraction?: number;
  onPageChange?: (page: number) => void;
  onSelect?: (sel: Selection | null) => void;
  onScrollFraction?: (page: number, fraction: number) => void;
  // Storage uses zero-based pages throughout the backend.
  onBlocks?: (page: number, blocks: Block[]) => void;
  loadOcr?: (page:number) => Promise<Block[]>;
  textRevision?:number;
  registerApi?: (api: PaneApi | null) => void;
  side: "source" | "translated";
  /** Reports whether a rendered page has selectable text (native layer or OCR). */
  onNativeText?: (page: number, hasText: boolean) => void;
  /** Click on an existing highlight rectangle. */
  onHighlightClick?: (annotation: Annotation, anchor: { x: number; y: number }) => void;
  /** Alt+drag rectangular selection (figures, tables, formulas). */
  onAreaSelect?: (selection: Selection) => void;
  /** Internal PDF link / outline destination. */
  onInternalLink?: (page: number, fraction: number) => void;
  /** All in-document find hits (rendered as persistent highlights). */
  findMatches?: FindMatch[];
  activeMatchIndex?: number;
};

type LinkBox = { left: number; top: number; width: number; height: number; url?: string; dest?: unknown };

function itemBBox(item: any, viewport: any): number[] | null {
  const tx = pdfjsLib.Util.transform(viewport.transform, item.transform);
  const h = Math.hypot(tx[2], tx[3]);
  if (!Number.isFinite(h) || h <= 0) return null;
  const x = tx[4], y = tx[5] - h, right = x + Math.max(1, Number(item.width) || 1);
  return [x, y, right, y + h];
}

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

type CachedPage = {
  doc: pdfjsLib.PDFDocumentProxy;
  index: number;
  textRevision?: number;
  page: pdfjsLib.PDFPageProxy;
  natural: { width: number; height: number };
  content: any;
  native: Block[];
  rawLinks: any[];
  saved: Block[];
};

function computeLinks(rawLinks: any[], viewport: pdfjsLib.PageViewport): LinkBox[] {
  const boxes: LinkBox[] = [];
  for (const annotation of rawLinks) {
    if (annotation?.subtype !== "Link" || !Array.isArray(annotation.rect)) continue;
    const [x1, y1, x2, y2] = viewport.convertToViewportRectangle(annotation.rect);
    if (![x1, y1, x2, y2].every(Number.isFinite)) continue;
    boxes.push({
      left: Math.min(x1, x2),
      top: Math.min(y1, y2),
      width: Math.abs(x2 - x1),
      height: Math.abs(y2 - y1),
      url: annotation.url,
      dest: annotation.dest,
    });
  }
  return boxes;
}

const PageView = memo(function PageView({ doc, index, scale, annotations, onSize, onBlocks, loadOcr, textRevision, focus, onNativeText, onHighlightClick, onLink, findHits, activeMatchIndex }: {
  doc: pdfjsLib.PDFDocumentProxy; index: number; scale: number; annotations: Annotation[];
  onSize: (index: number, width: number, height: number) => void;
  onBlocks: (index: number, blocks: Block[]) => void;
  loadOcr?: (page:number) => Promise<Block[]>;
  textRevision?:number;
  focus?: number[];
  onNativeText?: (index: number, hasText: boolean) => void;
  onHighlightClick?: (annotation: Annotation, x: number, y: number) => void;
  onLink?: (dest: unknown) => void;
  findHits?: { bbox: number[]; globalIndex: number }[];
  activeMatchIndex?: number;
}) {
  const mount = useRef<HTMLDivElement>(null);
  const cacheRef = useRef<CachedPage | null>(null);
  const [error, setError] = useState("");
  const [links, setLinks] = useState<LinkBox[]>([]);

  useEffect(() => () => {
    const mountEl = mount.current;
    if (mountEl) {
      for (const node of mountEl.querySelectorAll("canvas")) {
        node.width = 0;
        node.height = 0;
      }
      mountEl.replaceChildren();
    }
    cacheRef.current?.page?.cleanup();
    cacheRef.current = null;
  }, []);

  useEffect(() => {
    let cancelled = false;
    let task: pdfjsLib.RenderTask | undefined;
    let textTask: pdfjsLib.TextLayer | undefined;
    // Double-buffer: keep any previously rendered canvas stretched at the new
    // CSS dimensions until the replacement bitmap & text layer finish drawing,
    // avoiding white flashes during wheel/pinch zoom.
    const canvas = document.createElement("canvas");
    const text = document.createElement("div");
    text.className = "textLayer";
    setError("");
    const existingCache = cacheRef.current;
    if (existingCache && existingCache.doc === doc && existingCache.index === index) {
      const existingCanvas = mount.current?.querySelector("canvas");
      if (existingCanvas) {
        existingCanvas.style.width = `${existingCache.natural.width * scale}px`;
        existingCanvas.style.height = `${existingCache.natural.height * scale}px`;
      }
      if (existingCache.rawLinks.length) {
        setLinks(computeLinks(existingCache.rawLinks, existingCache.page.getViewport({ scale })));
      }
    } else {
      setLinks([]);
      if (existingCache) {
        existingCache.page?.cleanup();
        cacheRef.current = null;
      }
    }

    const run = async () => {
      let cached = cacheRef.current;
      if (!cached || cached.doc !== doc || cached.index !== index || cached.textRevision !== textRevision) {
        const reusePage = cached && cached.doc === doc && cached.index === index ? cached.page : undefined;
        const page = reusePage ?? await doc.getPage(index + 1);
        if (cancelled) { if (!reusePage) page.cleanup(); return; }
        const naturalViewport = page.getViewport({ scale: 1 });
        const natural = { width: naturalViewport.width, height: naturalViewport.height };
        onSize(index, natural.width, natural.height);
        const rawLinks = cached && reusePage
          ? cached.rawLinks
          : (typeof page.getAnnotations === "function" ? await page.getAnnotations({ intent: "display" }).catch(() => [] as any[]) : []);
        if (cancelled) { if (!reusePage) page.cleanup(); return; }
        const content = cached && reusePage ? cached.content : await page.getTextContent();
        if (cancelled) { if (!reusePage) page.cleanup(); return; }
        const native = cached && reusePage ? cached.native : groupBlocks(content.items, naturalViewport);
        const saved = loadOcr ? await loadOcr(index) : [];
        if (cancelled) { if (!reusePage) page.cleanup(); return; }
        cached = { doc, index, textRevision, page, natural, content, native, rawLinks, saved };
        cacheRef.current = cached;
        onNativeText?.(index, native.length > 0 || saved.length > 0);
        if (native.length && !saved.length) onBlocks(index, native);
      }

      const viewport = cached.page.getViewport({ scale });
      if (cached.rawLinks.length) setLinks(computeLinks(cached.rawLinks, viewport));
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
      const ctx = canvas.getContext("2d");
      if (!ctx) throw new Error("无法创建 PDF 画布");
      task = cached.page.render({ canvasContext: ctx, viewport, transform: dpr === 1 ? undefined : [dpr, 0, 0, dpr, 0, 0] });
      if (cached.saved.length) {
        const measure = document.createElement('canvas').getContext('2d');
        for (const block of cached.saved) {
          const [x, y, right, bottom] = block.bbox;
          if (block.bbox.length !== 4 || !block.bbox.every(Number.isFinite) || right <= x || bottom <= y) continue;
          const span = document.createElement('span'), font = Math.max(1, (bottom - y) * scale);
          span.textContent = block.text; span.dataset.ocr = 'true';
          Object.assign(span.style, { left: `${x * scale}px`, top: `${y * scale}px`, fontSize: `${font}px`, fontFamily: 'sans-serif', height: `${font}px`, lineHeight: '1' });
          if (measure) { measure.font = `${font}px sans-serif`; span.style.transform = `scaleX(${(right - x) * scale / Math.max(1, measure.measureText(block.text).width)})`; }
          text.append(span);
        }
      }
      if (cached.native.length && !cached.saved.length) {
        textTask = new pdfjsLib.TextLayer({ textContentSource: cached.content, container: text, viewport });
      }
      await Promise.all([task.promise, textTask?.render()]);
      if (!cancelled) {
        canvas.dataset.rendered = "true";
        canvas.dataset.scale = String(scale);
        const mountEl = mount.current;
        if (mountEl) {
          for (const prev of mountEl.querySelectorAll("canvas")) {
            prev.width = 0;
            prev.height = 0;
          }
          mountEl.replaceChildren(canvas, text);
        }
      }
    };
    void run().catch((e) => {
      if (!cancelled && e?.name !== "RenderingCancelledException" && e?.name !== "AbortException") setError(String(e.message || e));
    });
    return () => {
      cancelled = true;
      task?.cancel();
      textTask?.cancel();
      const releaseOffscreen = () => {
        if (!canvas.isConnected) {
          canvas.width = 0;
          canvas.height = 0;
        }
      };
      if (task) void task.promise.catch(() => undefined).finally(releaseOffscreen);
      else releaseOffscreen();
    };
  }, [doc, index, scale, onSize, onBlocks, loadOcr, textRevision, onNativeText, onLink]);
  return <>
    <div className="page-canvas" ref={mount} />
    {error && <div className="page-error" role="alert">{error}</div>}
    {links.length > 0 && <div className="linkLayer">
      {links.map((box, key) => box.url
        ? <a key={key} className="pdf-link" href={box.url} target="_blank" rel="noopener noreferrer" title={box.url} style={{ left: box.left, top: box.top, width: box.width, height: box.height }} />
        : <button key={key} type="button" className="pdf-link" title="跳转到文中位置" onClick={() => onLink?.(box.dest)} style={{ left: box.left, top: box.top, width: box.width, height: box.height }} />)}
    </div>}
    <div className="highlightLayer">
      {annotations.flatMap((a) => a.rects.map((r, i) => <div key={`${a.id}:${i}`} className={`highlight ${a.color}`} title={a.comment || a.quote} onClick={(event) => { event.stopPropagation(); onHighlightClick?.(a, event.clientX, event.clientY); }} style={{ left: `${r.x * 100}%`, top: `${r.y * 100}%`, width: `${r.w * 100}%`, height: `${r.h * 100}%` }} />))}
      {findHits?.map((hit) => hit.bbox.length === 4 && <div key={`find-${hit.globalIndex}`} className={`find-hit ${activeMatchIndex === hit.globalIndex ? "on" : ""}`} style={{ left: hit.bbox[0] * scale, top: hit.bbox[1] * scale, width: Math.max(2, (hit.bbox[2] - hit.bbox[0]) * scale), height: Math.max(2, (hit.bbox[3] - hit.bbox[1]) * scale) }} />)}
      {focus && focus.length === 4 && <div className="evidence-focus" style={{ left: focus[0]*scale, top: focus[1]*scale, width: (focus[2]-focus[0])*scale, height: (focus[3]-focus[1])*scale }} />}
    </div>
  </>;
});

type ZoomAnchor = {
  fromScale: number;
  pageIdx: number;
  offsetWithinPage: number;
  viewY: number;
  dxFromCenter: number;
  viewX: number;
  keepTop: boolean;
};

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
  const prevScale = useRef(scale);
  const zoomAnchor = useRef<ZoomAnchor | null>(null);
  const pendingZoomScroll = useRef<{ top: number; left: number } | null>(null);
  const lastScroll = useRef({ top: 0, left: 0 });
  const [spacePan, setSpacePan] = useState(false);
  const [panning, setPanning] = useState(false);
  const pan = useRef<{ x: number; y: number; left: number; top: number } | null>(null);
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
    zoomAnchor.current = null; pendingZoomScroll.current = null; prevScale.current = state.current.scale;
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
    if (previous?.w === w && previous?.h === h) return;
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
  const stageWidthFor = useCallback((targetScale: number) => {
    const el = scroll.current;
    let maxW = state.current.natural.w;
    for (const size of sizes.current.values()) if (size.w > maxW) maxW = size.w;
    return Math.max(el?.clientWidth ?? 0, maxW * targetScale + 32);
  }, []);
  const captureZoomAnchor = useCallback((focal?: { clientX: number; clientY: number }, explicitScale?: number): ZoomAnchor | null => {
    const el = scroll.current;
    const { virtual: v, doc: d, scale: currentScale } = state.current;
    if (!el || !d) return null;
    const fromScale = explicitScale ?? currentScale;
    const rect = el.getBoundingClientRect();
    const inside = !!focal &&
      focal.clientX >= rect.left && focal.clientX <= rect.right &&
      focal.clientY >= rect.top && focal.clientY <= rect.bottom;
    const scrollTopNow = explicitScale !== undefined ? lastScroll.current.top : el.scrollTop;
    const scrollLeftNow = explicitScale !== undefined ? lastScroll.current.left : el.scrollLeft;
    const keepTop = !inside && scrollTopNow < 12;
    const viewX = inside && focal ? focal.clientX - rect.left : el.clientWidth / 2;
    const viewY = inside && focal ? focal.clientY - rect.top : (keepTop ? 0 : el.clientHeight / 2);
    const contentY = scrollTopNow + viewY;
    const items = v.getVirtualItems();
    const match =
      items.find((item) => contentY >= item.start && contentY <= item.end) ??
      items.find((item) => item.end >= contentY) ??
      items[0];
    const pageIdx = match ? match.index : Math.max(0, position().page - 1);
    const itemStart = match ? match.start : 18;
    const oldStageW = stageWidthFor(fromScale);
    const dxFromCenter = (scrollLeftNow + viewX) - oldStageW / 2;
    return {
      fromScale,
      pageIdx,
      offsetWithinPage: contentY - itemStart,
      viewY,
      dxFromCenter,
      viewX,
      keepTop,
    };
  }, [position, stageWidthFor]);
  const prepareZoom = useCallback((focal?: { clientX: number; clientY: number }) => {
    zoomAnchor.current = captureZoomAnchor(focal);
  }, [captureZoomAnchor]);
  useLayoutEffect(() => {
    const anchor = zoomAnchor.current;
    zoomAnchor.current = null;
    const element = scroll.current;
    if (!anchor || !element) { prevScale.current = scale; return; }
    const ratio = scale / anchor.fromScale;
    if (!Number.isFinite(ratio) || Math.abs(ratio - 1) < 0.001) { prevScale.current = scale; return; }
    virtual.measure();
    const offset = virtual.getOffsetForIndex(anchor.pageIdx, "start")?.[0];
    const itemTop = offset ?? 18;
    const targetTop = anchor.keepTop ? 0 : itemTop + anchor.offsetWithinPage * ratio - anchor.viewY;
    const stageWidth = stageWidthFor(scale);
    const targetLeft = stageWidth / 2 + anchor.dxFromCenter * ratio - anchor.viewX;
    programmatic.current = true;
    element.scrollTop = Math.max(0, targetTop);
    element.scrollLeft = Math.max(0, targetLeft);
    lastScroll.current = { top: element.scrollTop, left: element.scrollLeft };
    prevScale.current = scale;
  }, [scale, virtual, stageWidthFor]);
  const goTo = useCallback((page: number, fraction = 0, bbox?: number[]) => {
    const { virtual: v, doc: d, natural: n } = state.current;
    if (!d || !scroll.current) return;
    const index = Math.min(d.numPages-1, Math.max(0, page-1));
    const height = sizes.current.get(index)?.h ?? n.h;
    const f = bbox?.length === 4 ? Math.max(0, (bbox[1]-24)/height) : fraction;
    const offset = v.getOffsetForIndex(index, "start")?.[0];
    if (offset === undefined) return;
    const targetTop = offset + Math.max(0, Math.min(1, f))*height*state.current.scale;
    programmatic.current = true;
    v.scrollToOffset(targetTop);
    lastScroll.current = { top: targetTop, left: scroll.current.scrollLeft };
    if (bbox?.length === 4) setFocus({ page: index, bbox });
    // Never invoke onPageChange from here: the other pane may be the caller.
  }, []);
  const parsePage=useCallback(async(pageNumber:number,options:{forceOcr?:boolean;signal?:AbortSignal;progress?:(message:string)=>void}={})=>{
    const document=state.current.doc;
    if(!document)throw new Error('PDF 尚未加载');
    if(pageNumber<1||pageNumber>document.numPages)throw new Error('页码无效');
    const page=await document.getPage(pageNumber),natural=page.getViewport({scale:1});
    const text=groupBlocks((await page.getTextContent()).items,natural);
    if(!options.forceOcr && text.reduce((n,b)=>n+b.text.trim().length,0)>=20){page.cleanup();return text;}
    const cached=await latest.current.loadOcr?.(pageNumber-1);
    if(!options.forceOcr&&cached?.length){page.cleanup();return cached;}
    if(options.signal?.aborted)throw new Error('解析已取消');
    const scale=Math.min(3,Math.sqrt(8_388_608/(natural.width*natural.height)),8192/Math.max(natural.width,natural.height));
    const viewport=page.getViewport({scale}),canvas=window.document.createElement('canvas');
    canvas.width=Math.max(1,Math.ceil(viewport.width));canvas.height=Math.max(1,Math.ceil(viewport.height));
    const ctx=canvas.getContext('2d');if(!ctx)throw new Error('无法创建 OCR 图像');
    const task=page.render({canvasContext:ctx,viewport}),cancel=()=>task.cancel();
    options.signal?.addEventListener('abort',cancel,{once:true});
    try{await task.promise;return await recognizePage(canvas,natural.width,natural.height,options.progress||(()=>{}),options.signal);}
    finally{options.signal?.removeEventListener('abort',cancel);canvas.width=0;canvas.height=0;page.cleanup();}
  },[]);
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
  const onNativeText = useCallback((index: number, hasText: boolean) => { latest.current.onNativeText?.(index, hasText); }, []);
  const onHighlightClick = useCallback((annotation: Annotation, x: number, y: number) => { latest.current.onHighlightClick?.(annotation, { x, y }); }, []);
  const resolveDest = useCallback(async (dest: unknown) => {
    const document = state.current.doc;
    if (!document || dest == null) return;
    try {
      let target: any = dest;
      if (typeof dest === "string") target = await document.getDestination(dest);
      if (!Array.isArray(target)) return;
      const reference = target[0];
      let pageIndex = 0;
      if (reference && typeof reference === "object") pageIndex = await document.getPageIndex(reference);
      else if (typeof reference === "number") pageIndex = Math.max(0, reference - 1);
      const page = await document.getPage(pageIndex + 1);
      const height = page.getViewport({ scale: 1 }).height;
      const top = Number(target[3]);
      const fraction = Number.isFinite(top) ? Math.max(0, Math.min(1, 1 - top / height)) : 0;
      latest.current.onInternalLink?.(pageIndex + 1, fraction);
    } catch { /* malformed destination */ }
  }, []);
  const find = useCallback(async (query: string, options: { caseSensitive?: boolean } = {}): Promise<FindMatch[]> => {
    const document = state.current.doc;
    const rawNeedle = query.trim();
    if (!document || !rawNeedle) return [];
    const needle = options.caseSensitive ? rawNeedle : rawNeedle.toLowerCase();
    const matches: FindMatch[] = [];
    for (let pageNumber = 1; pageNumber <= document.numPages && matches.length < 300; pageNumber++) {
      const page = await document.getPage(pageNumber);
      const natural = page.getViewport({ scale: 1 });
      const content = await page.getTextContent();
      let text = "";
      const spans: { start: number; end: number; bbox: number[] }[] = [];
      for (const item of content.items as any[]) {
        if (!item?.str) continue;
        const bbox = itemBBox(item, natural);
        const start = text.length;
        text += item.str + " ";
        if (bbox) spans.push({ start, end: start + item.str.length, bbox });
      }
      const haystack = options.caseSensitive ? text : text.toLowerCase();
      let from = 0, pageHits = 0;
      while (pageHits < 20) {
        const hit = haystack.indexOf(needle, from);
        if (hit < 0) break;
        const span = spans.find((value) => hit >= value.start && hit < value.end);
        if (span) matches.push({ page: pageNumber, bbox: span.bbox });
        from = hit + needle.length;
        pageHits++;
        if (matches.length >= 300) break;
      }
      page.cleanup();
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    return matches;
  }, []);
  const fit = useCallback((mode: "width" | "page") => {
    const element = scroll.current;
    if (!element) return state.current.scale;
    const index = Math.max(0, position().page - 1);
    const size = sizes.current.get(index) ?? { w: state.current.natural.w, h: state.current.natural.h };
    const width = Math.max(200, element.clientWidth - 36);
    const height = Math.max(200, element.clientHeight - 36);
    const scale = mode === "width" ? width / size.w : Math.min(width / size.w, height / size.h);
    return Math.max(0.4, Math.min(4, Number(scale.toFixed(2))));
  }, [position]);
  const thumbnails = useRef(new Map<string, string>());
  useEffect(() => { thumbnails.current.clear(); }, [bytes]);
  const thumbnail = useCallback(async (pageNumber: number, width = 148) => {
    const document = state.current.doc;
    if (!document) return "";
    const cacheKey = `${pageNumber}:${width}`;
    const cached = thumbnails.current.get(cacheKey);
    if (cached) return cached;
    const page = await document.getPage(pageNumber);
    const viewport = page.getViewport({ scale: width / page.getViewport({ scale: 1 }).width });
    const canvas = window.document.createElement("canvas");
    canvas.width = Math.max(1, Math.ceil(viewport.width));
    canvas.height = Math.max(1, Math.ceil(viewport.height));
    const context = canvas.getContext("2d");
    if (!context) return "";
    try {
      await page.render({ canvasContext: context, viewport }).promise;
      const url = canvas.toDataURL("image/jpeg", 0.72);
      thumbnails.current.set(cacheKey, url);
      return url;
    } finally {
      canvas.width = 0; canvas.height = 0; page.cleanup();
    }
  }, []);
  const getOutline = useCallback(async (): Promise<OutlineItem[]> => {
    const document = state.current.doc;
    if (!document || typeof document.getOutline !== "function") return [];
    const raw = await document.getOutline().catch(() => null);
    if (!raw) return [];
    const walk = async (items: any[]): Promise<OutlineItem[]> => {
      const rows: OutlineItem[] = [];
      for (const item of items) {
        const row: OutlineItem = { title: String(item.title || "未命名章节").replace(/\s+/g, " ").trim(), page: 1, fraction: 0, children: [] };
        try {
          const target: any = typeof item.dest === "string" ? await document.getDestination(item.dest) : item.dest;
          if (Array.isArray(target)) {
            const reference = target[0];
            let pageIndex = 0;
            if (reference && typeof reference === "object") pageIndex = await document.getPageIndex(reference);
            else if (typeof reference === "number") pageIndex = Math.max(0, reference - 1);
            const page = await document.getPage(pageIndex + 1);
            const height = page.getViewport({ scale: 1 }).height;
            const top = Number(target[3]);
            row.page = pageIndex + 1;
            row.fraction = Number.isFinite(top) ? Math.max(0, Math.min(1, 1 - top / height)) : 0;
          }
        } catch { /* keep defaults */ }
        if (Array.isArray(item.items) && item.items.length) row.children = await walk(item.items);
        rows.push(row);
      }
      return rows;
    };
    return walk(raw as any[]);
  }, []);
  const [marquee, setMarquee] = useState<{ left: number; top: number; width: number; height: number; page: number } | null>(null);
  const hover = useRef(false);
  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      if (event.code !== "Space" || event.repeat) return;
      const target = event.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.tagName === "SELECT" || target.isContentEditable)) return;
      if (!hover.current) return;
      event.preventDefault();
      setSpacePan(true);
    };
    const keyup = (event: KeyboardEvent) => { if (event.code === "Space") { setSpacePan(false); pan.current = null; setPanning(false); } };
    const blur = () => { setSpacePan(false); pan.current = null; setPanning(false); };
    window.addEventListener("keydown", keydown);
    window.addEventListener("keyup", keyup);
    window.addEventListener("blur", blur);
    return () => { window.removeEventListener("keydown", keydown); window.removeEventListener("keyup", keyup); window.removeEventListener("blur", blur); };
  }, []);
  const onPanPointerDown = (event: ReactPointerEvent) => {
    const element = scroll.current;
    if (!element || area.current) return;
    if (!(spacePan || event.button === 1)) return;
    event.preventDefault();
    pan.current = { x: event.clientX, y: event.clientY, left: element.scrollLeft, top: element.scrollTop };
    setPanning(true);
    element.setPointerCapture?.(event.pointerId);
  };
  const onPanPointerMove = (event: ReactPointerEvent) => {
    const current = pan.current;
    const element = scroll.current;
    if (!current || !element) return;
    element.scrollLeft = current.left - (event.clientX - current.x);
    element.scrollTop = current.top - (event.clientY - current.y);
  };
  const onPanPointerUp = () => {
    if (!pan.current) return;
    pan.current = null;
    setPanning(false);
  };
  const area = useRef<{ page: number; x0: number; y0: number; bounds: DOMRect } | null>(null);
  const onAreaPointerDown = (event: ReactPointerEvent) => {
    if (!event.altKey || event.button !== 0) return;
    const holder = (event.target as HTMLElement).closest<HTMLElement>(".page-holder");
    const container = scroll.current;
    if (!holder || !container) return;
    event.preventDefault();
    const bounds = holder.getBoundingClientRect();
    area.current = { page: Number(holder.dataset.page), x0: event.clientX, y0: event.clientY, bounds };
    setMarquee({ left: event.clientX, top: event.clientY, width: 0, height: 0, page: area.current.page });
    container.setPointerCapture?.(event.pointerId);
  };
  const onAreaPointerMove = (event: ReactPointerEvent) => {
    const current = area.current;
    if (!current) return;
    setMarquee({ left: Math.min(current.x0, event.clientX), top: Math.min(current.y0, event.clientY), width: Math.abs(event.clientX - current.x0), height: Math.abs(event.clientY - current.y0), page: current.page });
  };
  const onAreaPointerUp = (event: ReactPointerEvent) => {
    const current = area.current;
    if (!current) return;
    area.current = null;
    setMarquee(null);
    const left = Math.max(current.bounds.left, Math.min(current.x0, event.clientX));
    const top = Math.max(current.bounds.top, Math.min(current.y0, event.clientY));
    const right = Math.min(current.bounds.right, Math.max(current.x0, event.clientX));
    const bottom = Math.min(current.bounds.bottom, Math.max(current.y0, event.clientY));
    const width = right - left, height = bottom - top;
    if (width < 6 || height < 6) return;
    latest.current.onAreaSelect?.({
      page: current.page,
      quote: "",
      side,
      area: true,
      rects: [{ x: (left - current.bounds.left) / current.bounds.width, y: (top - current.bounds.top) / current.bounds.height, w: width / current.bounds.width, h: height / current.bounds.height }],
      anchor: { x: left + width / 2, y: top },
    });
  };
  useEffect(() => {
    if (!doc) return;
    virtual.measure();
    registerApi?.({ goTo, getPosition: position, parsePage, getOutline, find, fit, thumbnail, prepareZoom });
    return () => registerApi?.(null);
  }, [doc, scale, registerApi, goTo, position, virtual, parsePage, getOutline, find, fit, thumbnail, prepareZoom]);
  useEffect(() => {
    if (doc) {
      goTo(latest.current.initialPage ?? 1, latest.current.initialFraction ?? 0);
    }
  }, [doc, goTo]);
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
    if (rects.length) {
      const box = range.getBoundingClientRect();
      latest.current.onSelect?.({ page: Number(holder.dataset.page), rects, quote, side, anchor: { x: box.left + box.width / 2, y: box.top } });
    }
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
    <div className={`pane-scroll ${spacePan ? "grab" : ""} ${panning ? "grabbing" : ""}`} ref={scroll} onScroll={handleScroll}
      onMouseUp={(event) => { if (!event.altKey) handleSelection(); }}
      onPointerEnter={() => { hover.current = true; }} onPointerLeave={() => { hover.current = false; }}
      onWheelCapture={userInput} onPointerDownCapture={userInput} onKeyDownCapture={userInput}
      onPointerDown={(event) => { onAreaPointerDown(event); onPanPointerDown(event); }}
      onPointerMove={(event) => { onAreaPointerMove(event); onPanPointerMove(event); }}
      onPointerUp={(event) => { onAreaPointerUp(event); onPanPointerUp(); }}
      onPointerCancel={() => onPanPointerUp()}
      tabIndex={0} aria-label={side === "source" ? "原文 PDF" : "译文 PDF"}>
      {!doc && <div className="pane-loading">{error || "正在载入 PDF…"}</div>}
      <div style={{ height: virtual.getTotalSize(), width: "100%", minWidth: width, position: "relative" }}>
        {doc && items.map((item) => <div key={item.key} className="page-holder" data-page={item.index+1}
          style={{ width: (sizes.current.get(item.index)?.w ?? natural.w)*scale, height: item.size, position: "absolute", top: 0, left: "50%", transform: `translate(-50%, ${item.start}px)`, "--scale-factor": scale } as React.CSSProperties}>
          <PageView doc={doc} index={item.index} scale={scale} annotations={byPage.get(item.index) ?? EMPTY_ANNOTATIONS}
            onSize={onSize} onBlocks={onBlocks} loadOcr={props.loadOcr} textRevision={props.textRevision} focus={focus?.page === item.index ? focus.bbox : undefined}
            onNativeText={onNativeText} onHighlightClick={onHighlightClick} onLink={resolveDest}
            findHits={props.findMatches?.map((match, globalIndex) => ({ ...match, globalIndex })).filter((match) => match.page === item.index + 1)}
            activeMatchIndex={props.activeMatchIndex} />
        </div>)}
      </div>
      {marquee && <div className="area-marquee" style={{ left: marquee.left, top: marquee.top, width: marquee.width, height: marquee.height }}><span>{marquee.page} 页 · 框选批注</span></div>}
    </div>
  </div>;
}
const EMPTY_ANNOTATIONS: Annotation[] = [];
