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
export type Selection = {
  page: number; rects: Rect[]; quote: string; side: "source" | "translated";
  anchor?: { x: number; y: number }; area?: boolean; areaText?: string;
  /** Additional page fragments when text selection crosses a page boundary. */
  extraSlices?: { page: number; rects: Rect[] }[];
  /** PNG data URL cropped from the rendered page (marquee/vision). */
  imageDataUrl?: string;
};
/** Cropped page envelope in natural PDF points (never mutates the page size). */
type Crop = { x: number; y: number; w: number; h: number };
export type OutlineItem = { title: string; page: number; fraction: number; children: OutlineItem[] };
export type FindMatch = { page: number; bbox: number[] };
/** Caption/table/algorithm row shown by the reader figures gallery (FEAT-UX-06). */
export type FigureItem = { label: string; caption: string; page: number; fraction: number };
/** One text line of a PDF page, in natural page coordinates. */
export type FigureLine = { text: string; bbox: number[] };
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
  renderRegion: (page: number, fraction: number, width?: number) => Promise<string>;
  /** Figures / tables / algorithms with captions, cached per document. */
  extractFigures: () => Promise<FigureItem[]>;
  pageSize: (page: number) => { w: number; h: number };
};
type Props = {
  /** In-memory PDF bytes (desktop legacy / unit-test path). */
  bytes?: Uint8Array;
  /** Range-capable URL (`moonlight-pdf://` or LAN `/api/pdf/...`); preferred. */
  url?: string;
  scale: number; annotations: Annotation[];
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
  /** Explicit marquee tool: a single-finger/pointer drag draws the box (no Alt). */
  areaMode?: boolean;
  /** Auto-crop margins: clip the page whitespace in the viewport layer only. */
  autoCrop?: boolean;
  /** Reports that a page's cropped envelope changed (Reader refits fit-width). */
  onCropChange?: () => void;
  /** Two-finger pinch commit; the pane previews live with a CSS transform. */
  onPinchScale?: (nextScale: number, focal?: { clientX: number; clientY: number }) => void;
  /** Internal PDF link / outline destination (with click anchor for preview). */
  onInternalLink?: (page: number, fraction: number, anchor?: { x: number; y: number }) => void;
  /**
   * FEAT-AI-01: a click landed on an in-text `Fig. 2` / `Table 1` / `[12]`
   * reference that has no native PDF link. Only plain clicks fire: a drag
   * selection or a pan never resolves a reference.
   */
  onTextReference?: (reference: TextReference, anchor?: { x: number; y: number }) => void;
  /** All in-document find hits (rendered as persistent highlights). */
  findMatches?: FindMatch[];
  activeMatchIndex?: number;
  /** Natural-coordinate rectangle of an aligned paragraph in this pane. */
  alignedBox?: { page: number; bbox: number[] } | null;
  /** Report a paragraph point (natural PDF coordinates) on click/hover. */
  onParagraphPoint?: (point: { page: number; x: number; y: number } | null, kind: "hover" | "click") => void;
};

type LinkBox = { left: number; top: number; width: number; height: number; url?: string; dest?: unknown };

function itemBBox(item: any, viewport: any): number[] | null {
  const tx = pdfjsLib.Util.transform(viewport.transform, item.transform);
  const h = Math.hypot(tx[2], tx[3]);
  if (!Number.isFinite(h) || h <= 0) return null;
  const x = tx[4], y = tx[5] - h, right = x + Math.max(1, Number(item.width) || 1);
  return [x, y, right, y + h];
}

function blockHeight(block: Block): number {
  const [, top, , bottom] = block.bbox.map(Number);
  return Math.max(0, bottom - top);
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

/** Lines that are mostly symbols/digits are formula, table or caption fragments. */
function isFormulaFragment(text: string): boolean {
  const compact = text.replace(/\s+/g, "");
  if (compact.length < 3) return true;
  const letters = compact.match(/\p{L}/gu)?.length ?? 0;
  return letters / compact.length < 0.45;
}

function blockCenterX(block: Block): number {
  return (Number(block.bbox[0]) + Number(block.bbox[2])) / 2;
}

function blockWidth(block: Block): number {
  return Number(block.bbox[2]) - Number(block.bbox[0]);
}

/** Blocks wider than 60% of the page count as full-width content. */
function columnCompatible(a: Block, b: Block, pageWidth: number): boolean {
  const wideA = blockWidth(a) > pageWidth * 0.6;
  const wideB = blockWidth(b) > pageWidth * 0.6;
  if (wideA && wideB) return true;
  if (wideA || wideB) return false;
  const middle = pageWidth / 2;
  return (blockCenterX(a) < middle) === (blockCenterX(b) < middle);
}

function groupBlocks(items: any[], viewport: any): Block[] {
  const lines: Block[] = [];
  // First pass: PDF.js supplies the text and geometry. Keep line fragments in
  // reading order without merging across columns or inventing character widths.
  for (const item of items) {
    if (!item.str?.trim()) continue;
    const tx = pdfjsLib.Util.transform(viewport.transform, item.transform);
    const h = Math.hypot(tx[2], tx[3]);
    if (!Number.isFinite(h) || h <= 0) continue;
    const last = lines.at(-1);
    const x = tx[4], y = tx[5] - h, right = x + item.width;
    if (last && Math.abs(last.bbox[1] - y) < h * 0.5 && x >= last.bbox[2] - 1 && x - last.bbox[2] < h * 1.5) {
      last.text += ` ${item.str}`;
      last.bbox[2] = Math.max(last.bbox[2], right);
      last.bbox[3] = Math.max(last.bbox[3], y + h);
    } else lines.push({ bbox: [x, y, right, y + h], text: item.str });
  }
  if (lines.length < 2) return lines;

  // Second pass: cluster adjacent lines into natural paragraphs. Bucket by
  // column first so row-major text order cannot interleave left and right.
  const pageWidth = Math.max(Number(viewport?.width) || 0, ...lines.map((line) => Number(line.bbox[2]) || 0), 1);
  const middle = pageWidth / 2;
  const medianHeight = median(lines.map(blockHeight).filter((height) => height > 0));
  const ordered = [...lines].sort((a, b) => (Number(a.bbox[1]) - Number(b.bbox[1])) || (Number(a.bbox[0]) - Number(b.bbox[0])));
  const buckets = new Map<string, Block[]>();
  for (const line of ordered) {
    const key = blockWidth(line) > pageWidth * 0.6 ? "span" : blockCenterX(line) < middle ? "left" : "right";
    const bucket = buckets.get(key);
    if (bucket) bucket.push(line); else buckets.set(key, [line]);
  }

  const paragraphs: Block[] = [];
  for (const bucket of buckets.values()) {
    let current: Block | null = null;
    let lastBox: number[] = [];
    let lastHeight = 0;
    let lastText = "";
    const flush = () => { if (current) paragraphs.push(current); current = null; };
    for (const line of bucket) {
      const height = blockHeight(line);
      if (!current) {
        current = { ...line, bbox: [...line.bbox], kind: line.kind };
        lastBox = [...line.bbox]; lastHeight = height; lastText = line.text;
        continue;
      }
      // Two lines merge only when they read as one paragraph: aligned left
      // edge, >50% horizontal overlap, a tight line gap, same column, normal
      // line height and ordinary prose (not formula/table fragments).
      const h = Math.min(lastHeight, height);
      const right = Number(line.bbox[2]);
      const left = Number(line.bbox[0]);
      const overlap = Math.min(lastBox[2], right) - Math.max(lastBox[0], left);
      const overlapBase = Math.min(lastBox[2] - lastBox[0], right - left);
      const dy = Number(line.bbox[1]) - Number(lastBox[3]);
      const leftDelta = Math.abs(lastBox[0] - left);
      const abnormalHeight = medianHeight > 0 && (lastHeight > medianHeight * 2.5 || height > medianHeight * 2.5);
      const mergeable = !abnormalHeight
        && h > 0
        && overlapBase > 0
        && overlap / overlapBase > 0.5
        && leftDelta < h * 2.5
        && dy >= 0 && dy < h * 1.65
        && columnCompatible(current, line, pageWidth)
        && !isFormulaFragment(lastText)
        && !isFormulaFragment(line.text);
      if (mergeable) {
        current.bbox = [
          Math.min(Number(current.bbox[0]), left),
          Math.min(Number(current.bbox[1]), Number(line.bbox[1])),
          Math.max(Number(current.bbox[2]), right),
          Math.max(Number(current.bbox[3]), Number(line.bbox[3])),
        ];
        current.text = `${current.text} ${line.text}`.trim();
        lastBox = [...line.bbox]; lastHeight = height; lastText = line.text;
      } else {
        flush();
        current = { ...line, bbox: [...line.bbox], kind: line.kind };
        lastBox = [...line.bbox]; lastHeight = height; lastText = line.text;
      }
    }
    flush();
  }

  // Blocks feed the AI evidence index, so keep a deterministic reading order:
  // top-to-bottom, then left-to-right.
  return paragraphs.sort((a, b) => (Number(a.bbox[1]) - Number(b.bbox[1])) || (Number(a.bbox[0]) - Number(b.bbox[0])));
}

/** Matches `Figure 1:`, `Fig. 2.`, `Table 3：` and `Algorithm 1.` caption starts. */
const FIGURE_CAPTION_PATTERN = /^(Figure|Fig\.|Table|Algorithm)\s+(\d+)[.:：]\s*/i;
/** The gallery stops after this many rows so a 500-page PDF stays snappy. */
export const FIGURE_SCAN_LIMIT = 200;

function canonicalFigureKind(raw: string): string {
  const kind = raw.replace(/\.$/, "").toLowerCase();
  if (kind === "fig" || kind === "figure") return "Figure";
  if (kind === "table") return "Table";
  return "Algorithm";
}

/**
 * Pure caption parser used by `extractFigures`. `lines` are raw PDF text lines
 * in natural (top-down) page coordinates; each caption line becomes one row
 * whose `fraction` is the caption's vertical position on the page. Duplicate
 * labels on the same page (for example repeated running headers) are ignored.
 */
export function extractFiguresFromPage(page: number, lines: FigureLine[], pageHeight: number): FigureItem[] {
  if (!Number.isInteger(page) || page < 1 || !Number.isFinite(pageHeight) || pageHeight <= 0) return [];
  const rows: FigureItem[] = [];
  const seen = new Set<string>();
  for (const line of lines) {
    const text = String(line?.text ?? "").replace(/\s+/g, " ").trim();
    if (!text) continue;
    const match = text.match(FIGURE_CAPTION_PATTERN);
    if (!match) continue;
    const label = `${canonicalFigureKind(match[1])} ${match[2]}`;
    if (seen.has(label)) continue;
    seen.add(label);
    const top = Array.isArray(line.bbox) ? Number(line.bbox[1]) : Number.NaN;
    const fraction = Number.isFinite(top) ? Math.max(0, Math.min(1, top / pageHeight)) : 0;
    rows.push({ label, caption: text, page, fraction });
  }
  return rows;
}

/** Groups PDF.js text items into raw lines without paragraph clustering. */
function figureLines(items: any[], viewport: any): FigureLine[] {
  const lines: FigureLine[] = [];
  for (const item of items) {
    if (!item?.str?.trim()) continue;
    const bbox = itemBBox(item, viewport);
    if (!bbox) continue;
    const last = lines.at(-1);
    const height = Math.max(1, bbox[3] - bbox[1]);
    if (last && Math.abs(last.bbox[1] - bbox[1]) < height * 0.5 && bbox[0] >= last.bbox[2] - 1 && bbox[0] - last.bbox[2] < height * 1.5) {
      last.text += ` ${item.str}`;
      last.bbox[2] = Math.max(last.bbox[2], bbox[2]);
      last.bbox[3] = Math.max(last.bbox[3], bbox[3]);
    } else lines.push({ bbox, text: item.str });
  }
  return lines;
}

/** FEAT-AI-01: the kinds of in-text references recognised without a PDF link. */
export type TextReferenceKind = "figure" | "table" | "equation" | "section" | "algorithm" | "citation";

/**
 * One reference parsed out of a text-layer line. `queries` are the block-index
 * candidates in priority order (`Figure 2`, `Fig. 2`, …) so the reader can ask
 * the backend for the canonical caption as well as the in-text spelling.
 */
export type TextReference = {
  kind: TextReferenceKind;
  /** Canonical label for the preview/toast: `Figure 2`, `Eq. (3)`, `[12]`. */
  label: string;
  /** Bare number without decoration (`2`, `4.1`, `12`). */
  number: string;
  /** Block-index queries, most specific first. */
  queries: string[];
  /** Matched phrase exactly as written (`Fig. 2`, `[12]`). */
  text: string;
  /** Character offset of the match inside the scanned line. */
  index: number;
  /** Length of the matched phrase. */
  length: number;
};

const REFERENCE_LABEL_PATTERN =
  /\b(Fig(?:ure)?\.?|Tab(?:le)?\.?|Eq(?:uation)?\.?|Sec(?:tion)?\.?|Alg(?:orithm)?\.?)\s*(\(?\s*\d+(?:\.\d+)*\s*\)?)(?![a-z0-9])/i;
const REFERENCE_CITATION_PATTERN = /\[(\d{1,3}(?:\s*,\s*\d{1,3})*)\]/;

function referenceKind(prefix: string): TextReferenceKind {
  const value = prefix.replace(/\.$/, "").toLowerCase();
  if (value.startsWith("fig")) return "figure";
  if (value.startsWith("tab")) return "table";
  if (value.startsWith("eq")) return "equation";
  if (value.startsWith("sec")) return "section";
  return "algorithm";
}

function referenceQueries(kind: TextReferenceKind, number: string, raw: string): string[] {
  switch (kind) {
    case "figure": return [`Figure ${number}`, `Fig. ${number}`, `Fig ${number}`, `Fig.${number}`];
    case "table": return [`Table ${number}`, `Tab. ${number}`, `Tab ${number}`];
    case "algorithm": return [`Algorithm ${number}`, `Alg. ${number}`];
    case "equation": return [`(${number})`, `Eq. ${number}`, `Equation ${number}`];
    case "section": return [`Section ${number}`, `Sec. ${number}`];
    case "citation":
      return raw.split(",").map((value) => value.trim()).filter(Boolean).slice(0, 4).map((value) => `[${value}]`);
  }
}

/**
 * Pure parser behind the no-hyperlink reference jump (FEAT-AI-01). It accepts a
 * whole text-layer line and returns the first `Fig./Figure N`, `Table N`,
 * `Eq./Equation (N)`, `Section N`, `Algorithm N` or `[N]` reference in it.
 * Deliberately conservative so ordinary prose never jumps: `Figure out`,
 * `Table of contents`, `Figures 4 and 5`, `1st` and bare numbers do not match.
 */
export function matchTextReference(line: string): TextReference | null {
  const text = String(line ?? "").replace(/\s+/g, " ").trim();
  if (!text) return null;
  type Hit = { kind: TextReferenceKind; number: string; raw: string; index: number; length: number };
  let hit: Hit | null = null;
  const labelled = REFERENCE_LABEL_PATTERN.exec(text);
  if (labelled) {
    const number = labelled[2].replace(/[()\s]/g, "");
    hit = { kind: referenceKind(labelled[1]), number, raw: number, index: labelled.index, length: labelled[0].length };
  }
  const citation = REFERENCE_CITATION_PATTERN.exec(text);
  if (citation && (!hit || citation.index < hit.index)) {
    hit = { kind: "citation", number: citation[1].replace(/\s+/g, " ").trim(), raw: citation[1].trim(), index: citation.index, length: citation[0].length };
  }
  if (!hit) return null;
  const label = hit.kind === "citation" ? `[${hit.raw}]`
    : hit.kind === "equation" ? `Eq. (${hit.number})`
      : hit.kind === "section" ? `Section ${hit.number}`
        : hit.kind === "figure" ? `Figure ${hit.number}`
          : hit.kind === "table" ? `Table ${hit.number}`
            : `Algorithm ${hit.number}`;
  return {
    kind: hit.kind, label, number: hit.number,
    queries: referenceQueries(hit.kind, hit.number, hit.raw),
    text: text.slice(hit.index, hit.index + hit.length), index: hit.index, length: hit.length,
  };
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

/**
 * Conservative content envelope of a page, in natural PDF points, derived from
 * the text/OCR boxes pdf.js already produced. Returns null when the page looks
 * full-bleed or the box is degenerate, so auto-crop never hides real content.
 */
function contentEnvelope(blocks: Block[], natural: { width: number; height: number }): Crop | null {
  let left = Number.POSITIVE_INFINITY, top = Number.POSITIVE_INFINITY;
  let right = Number.NEGATIVE_INFINITY, bottom = Number.NEGATIVE_INFINITY;
  for (const block of blocks) {
    if (!Array.isArray(block.bbox) || block.bbox.length !== 4) continue;
    const [x, y, r, b] = block.bbox.map(Number);
    if (![x, y, r, b].every(Number.isFinite) || r <= x || b <= y) continue;
    left = Math.min(left, x); top = Math.min(top, y);
    right = Math.max(right, r); bottom = Math.max(bottom, b);
  }
  if (!Number.isFinite(left) || right <= left || bottom <= top) return null;
  const padX = Math.max(6, natural.width * 0.012);
  const padY = Math.max(6, natural.height * 0.012);
  const x = Math.max(0, left - padX), y = Math.max(0, top - padY);
  const w = Math.min(natural.width, right + padX) - x;
  const h = Math.min(natural.height, bottom + padY) - y;
  if (!(w > 0) || !(h > 0)) return null;
  // Nothing to win when the page is already full-bleed; a lone line of text or
  // a page number must never become the whole viewport.
  if (w > natural.width * 0.94 && h > natural.height * 0.94) return null;
  if (w < natural.width * 0.25 || h < natural.height * 0.25) return null;
  return { x: Math.round(x), y: Math.round(y), w: Math.round(w), h: Math.round(h) };
}

/**
 * Per-canvas backing-store budget in pixels.
 *
 * 8 MP keeps ordinary desktop pages small, but the vivo Pad 5 Pro is a 3096×2064
 * (3.1K) panel: whatever DPR the browser reports (2.75–3), its physical long
 * edge is ~3100 px, and at 1.5–2× zoom an 8 MP cap silently drops DPR below 1.5
 * so the 286 PPI text turns soft.  HiDPI panels at ≥2560 physical px get 12 MP;
 * CSS/text/annotation coordinates are unaffected either way.
 */
export function pixelBudget(longEdgeCssPx: number, devicePixelRatio: number): number {
  const physicalLongEdge = Math.max(0, longEdgeCssPx) * Math.max(1, devicePixelRatio);
  return devicePixelRatio >= 2 && physicalLongEdge >= 2560 ? 12_582_912 : 8_388_608;
}

const PageView = memo(function PageView({ doc, index, scale, annotations, onSize, onBlocks, loadOcr, textRevision, focus, onNativeText, onHighlightClick, onLink, findHits, activeMatchIndex, alignedBox, autoCrop, onCrop }: {
  doc: pdfjsLib.PDFDocumentProxy; index: number; scale: number; annotations: Annotation[];
  onSize: (index: number, width: number, height: number) => void;
  onBlocks: (index: number, blocks: Block[]) => void;
  loadOcr?: (page:number) => Promise<Block[]>;
  textRevision?:number;
  focus?: number[];
  onNativeText?: (index: number, hasText: boolean) => void;
  onHighlightClick?: (annotation: Annotation, x: number, y: number) => void;
  onLink?: (dest: unknown, anchor?: { x: number; y: number }) => void;
  findHits?: { bbox: number[]; globalIndex: number }[];
  activeMatchIndex?: number;
  alignedBox?: number[] | null;
  autoCrop?: boolean;
  onCrop?: (index: number, crop: Crop | null) => void;
}) {
  const mount = useRef<HTMLDivElement>(null);
  const cacheRef = useRef<CachedPage | null>(null);
  const naturalRef = useRef<{ width: number; height: number } | null>(null);
  const cropSignature = useRef("");
  const [crop, setCrop] = useState<Crop | null>(null);
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
      // Auto-crop margins: compute the body envelope from the text layer boxes
      // and report it so the holder can clip the whitespace. Page geometry,
      // pdf.js coordinates and normalised 0-1 annotations are untouched.
      naturalRef.current = cached.natural;
      const envelope = autoCrop ? contentEnvelope([...cached.native, ...cached.saved], cached.natural) : null;
      const signature = envelope ? `${envelope.x},${envelope.y},${envelope.w},${envelope.h}` : "";
      if (signature !== cropSignature.current) {
        cropSignature.current = signature;
        setCrop(envelope);
        onCrop?.(index, envelope);
      }
      if (cached.rawLinks.length) setLinks(computeLinks(cached.rawLinks, viewport));
      // Bound actual backing pixels, not just DPR. At 300% on a 2x display
      // an ordinary letter page otherwise allocates ~67 MiB per canvas.
      // CSS/text/annotation coordinates retain the requested zoom level.
      const budget = pixelBudget(
        Math.max(window.screen?.width ?? 0, window.screen?.height ?? 0),
        window.devicePixelRatio || 1,
      );
      const dpr = Math.min(window.devicePixelRatio || 1, 2,
        Math.sqrt(budget / (viewport.width * viewport.height)),
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
  }, [doc, index, scale, onSize, onBlocks, loadOcr, textRevision, onNativeText, onLink, autoCrop, onCrop]);
  const natural = naturalRef.current;
  return <>
    <div className={`page-inner${crop ? " cropped" : ""}`} style={crop && natural ? {
      width: `${natural.width * scale}px`, height: `${natural.height * scale}px`,
      // The inner layer keeps the full page size; clipping happens on the
      // holder, so highlight rects (x * 100%) stay in true page coordinates.
      transform: `translate(${-crop.x * scale}px, ${-crop.y * scale}px)`,
    } : undefined}>
    <div className="page-canvas" ref={mount} />
    {error && <div className="page-error" role="alert">{error}</div>}
    {links.length > 0 && <div className="linkLayer">
      {links.map((box, key) => box.url
        ? <a key={key} className="pdf-link" href={box.url} target="_blank" rel="noopener noreferrer" title={box.url} style={{ left: box.left, top: box.top, width: box.width, height: box.height }} />
        : <button key={key} type="button" className="pdf-link" title="预览并跳转到文中位置" onClick={(event) => onLink?.(box.dest, { x: event.clientX, y: event.clientY })} style={{ left: box.left, top: box.top, width: box.width, height: box.height }} />)}
    </div>}
    <div className="highlightLayer">
      {annotations.flatMap((a) => a.rects.map((r, i) => <div key={`${a.id}:${i}`} className={`highlight ${a.color}`} title={a.comment || a.quote} onClick={(event) => { event.stopPropagation(); onHighlightClick?.(a, event.clientX, event.clientY); }} style={{ left: `${r.x * 100}%`, top: `${r.y * 100}%`, width: `${r.w * 100}%`, height: `${r.h * 100}%` }} />))}
      {findHits?.map((hit) => hit.bbox.length === 4 && <div key={`find-${hit.globalIndex}`} className={`find-hit ${activeMatchIndex === hit.globalIndex ? "on" : ""}`} style={{ left: hit.bbox[0] * scale, top: hit.bbox[1] * scale, width: Math.max(2, (hit.bbox[2] - hit.bbox[0]) * scale), height: Math.max(2, (hit.bbox[3] - hit.bbox[1]) * scale) }} />)}
      {alignedBox && alignedBox.length === 4 && <div className="alignment-focus" style={{ left: alignedBox[0]*scale, top: alignedBox[1]*scale, width: (alignedBox[2]-alignedBox[0])*scale, height: (alignedBox[3]-alignedBox[1])*scale }} />}
      {focus && focus.length === 4 && <div className="evidence-focus" style={{ left: focus[0]*scale, top: focus[1]*scale, width: (focus[2]-focus[0])*scale, height: (focus[3]-focus[1])*scale }} />}
    </div>
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
  const { bytes, url, scale, annotations, registerApi, side } = props;
  const latest = useRef(props); latest.current = props;
  const scroll = useRef<HTMLDivElement>(null);
  const [doc, setDoc] = useState<pdfjsLib.PDFDocumentProxy | null>(null);
  const [natural, setNatural] = useState({ w: 612, h: 792 });
  const sizes = useRef(new Map<number, { w: number; h: number }>());
  /** Auto-crop envelopes per page, in natural points (empty when disabled). */
  const crops = useRef(new Map<number, Crop>());
  const stage = useRef<HTMLDivElement>(null);
  /** Live pointers for the two-finger pinch preview (no React state per frame). */
  const pointers = useRef(new Map<number, { x: number; y: number; type: string }>());
  const pinch = useRef<{ startDist: number; startScale: number; ratio: number; mid: { clientX: number; clientY: number } } | null>(null);
  /** A finger/stylus is down: selectionchange must not pop the toolbar yet. */
  const touchPress = useRef(false);
  const selectionTimer = useRef(0);
  const selectHandler = useRef<() => void>(() => undefined);
  const lastSelectionKey = useRef("");
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
    // A cropped page is shorter, so the virtualizer has to follow the envelope
    // height or every page below it would drift by the cropped whitespace.
    estimateSize: (i) => (crops.current.get(i)?.h ?? sizes.current.get(i)?.h ?? natural.h) * scale,
    overscan: 1, gap: 24, paddingStart: 18, paddingEnd: 40,
  });
  const state = useRef({ virtual, doc, scale, natural });
  state.current = { virtual, doc, scale, natural };
  useEffect(() => {
    let cancelled = false;
    setDoc(null); setError(""); programmatic.current=true; sizes.current.clear(); indexed.current.clear();
    crops.current.clear(); pointers.current.clear(); pinch.current=null;
    zoomAnchor.current = null; pendingZoomScroll.current = null; prevScale.current = state.current.scale;
    // A URL lets pdf.js fetch 64 KiB ranges on demand: the LAN server answers
    // 206 and the `moonlight-pdf://` protocol does the same, so a 100 MB scan
    // is never copied through IPC or duplicated in renderer memory.
    const task = url
      ? pdfjsLib.getDocument({ url, rangeChunkSize: 64 * 1024 })
      : bytes
        ? pdfjsLib.getDocument({ data: bytes.slice() })
        : null;
    if (!task) { setError("没有可用的 PDF 数据"); return; }
    void task.promise.then(async (document) => {
      const first = await document.getPage(1);
      const v = first.getViewport({ scale: 1 });
      if (!cancelled) { setNatural({ w: v.width, h: v.height }); setDoc(document); }
    }).catch((e) => { if (!cancelled) setError(String(e.message || e)); });
    return () => { cancelled = true; void task.destroy(); };
  }, [bytes, url]);
  const onSize = useCallback((index: number, w: number, h: number) => {
    const previous = sizes.current.get(index);
    if (previous?.w === w && previous?.h === h) return;
    sizes.current.set(index, { w, h });
    state.current.virtual.resizeItem(index, (crops.current.get(index)?.h ?? h) * state.current.scale);
    if (previous?.w !== w) setSizeRevision((revision) => revision + 1);
  }, []);
  /** Page reported a new (or cleared) auto-crop envelope. */
  const onCrop = useCallback((index: number, crop: Crop | null) => {
    const previous = crops.current.get(index);
    const same = previous === undefined && crop === null
      || (previous && crop && previous.x === crop.x && previous.y === crop.y && previous.w === crop.w && previous.h === crop.h);
    if (same) return;
    if (crop) crops.current.set(index, crop); else crops.current.delete(index);
    const full = sizes.current.get(index);
    if (full) state.current.virtual.resizeItem(index, (crop?.h ?? full.h) * state.current.scale);
    setSizeRevision((revision) => revision + 1);
    latest.current.onCropChange?.();
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
    if (!item) return { page: 1, fraction: 0 };
    const local = Math.max(0, Math.min(item.size, offset - item.start));
    const crop = crops.current.get(item.index);
    const full = sizes.current.get(item.index);
    if (crop && full?.h) {
      // The holder is clipped, so the visible offset is measured from the crop
      // top. Translate it back to the undivided page: fractions must stay
      // comparable with uncropped readers, annotations and the sync contract.
      const naturalY = crop.y + local / Math.max(1e-6, state.current.scale);
      return { page: item.index + 1, fraction: Math.max(0, Math.min(1, naturalY / full.h)) };
    }
    return { page: item.index + 1, fraction: Math.max(0, Math.min(1, local / Math.max(1, item.size))) };
  }, []);
  const stageWidthFor = useCallback((targetScale: number) => {
    const el = scroll.current;
    let maxW = state.current.natural.w;
    for (const [index, size] of sizes.current) {
      // Cropped pages are narrower: measure the body, not the paper margin, so
      // a fitted page fills the window instead of leaving scrollable gutters.
      const w = crops.current.get(index)?.w ?? size.w;
      if (w > maxW) maxW = w;
    }
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
    // Fractions refer to the full page; the holder starts at the crop top.
    const crop = crops.current.get(index);
    const local = Math.max(0, Math.min(1, f)) * height * state.current.scale - (crop ? crop.y * state.current.scale : 0);
    const targetTop = offset + Math.max(0, local);
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
  const resolveDest = useCallback(async (dest: unknown, anchor?: { x: number; y: number }) => {
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
      latest.current.onInternalLink?.(pageIndex + 1, fraction, anchor);
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
    // Hidden tabs report 0; falling back to 200px would collapse fit-width to
    // the 0.4 minimum (BUG-04). Keep the current scale instead.
    if (element.clientWidth <= 0 || element.clientHeight <= 0) return state.current.scale;
    const index = Math.max(0, position().page - 1);
    const full = sizes.current.get(index) ?? { w: state.current.natural.w, h: state.current.natural.h };
    const crop = crops.current.get(index);
    // Fit the cropped body box so auto-crop really enlarges the text.
    const size = crop ? { w: crop.w, h: crop.h } : full;
    const width = Math.max(200, element.clientWidth - 36);
    const height = Math.max(200, element.clientHeight - 36);
    const scale = mode === "width" ? width / size.w : Math.min(width / size.w, height / size.h);
    return Math.max(0.4, Math.min(4, Number(scale.toFixed(2))));
  }, [position]);
  const pageSize = useCallback((pageNumber: number) => {
    const size = sizes.current.get(Math.max(0, pageNumber - 1));
    return size ? { w: size.w, h: size.h } : { w: state.current.natural.w, h: state.current.natural.h };
  }, []);
  const thumbnails = useRef(new Map<string, string>());
  useEffect(() => { thumbnails.current.clear(); }, [bytes, url]);
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
  /** Render a zoomed crop centred on `fraction` (Sioyek-style smart preview). */
  const renderRegion = useCallback(async (pageNumber: number, fraction: number, width = 380) => {
    const document = state.current.doc;
    if (!document) return "";
    const page = await document.getPage(pageNumber);
    const natural = page.getViewport({ scale: 1 });
    const scale = width / Math.max(1, natural.width);
    const viewport = page.getViewport({ scale });
    const canvas = window.document.createElement("canvas");
    canvas.width = Math.max(1, Math.ceil(viewport.width));
    canvas.height = Math.max(1, Math.ceil(viewport.height));
    const context = canvas.getContext("2d");
    if (!context) return "";
    try {
      await page.render({ canvasContext: context, viewport }).promise;
      const cropHeight = Math.max(1, Math.min(canvas.height, Math.round(width * 0.7)));
      const center = Math.max(0, Math.min(1, fraction)) * canvas.height;
      const top = Math.max(0, Math.min(canvas.height - cropHeight, Math.round(center - cropHeight / 2)));
      const out = window.document.createElement("canvas");
      out.width = canvas.width;
      out.height = cropHeight;
      const outContext = out.getContext("2d");
      if (!outContext || typeof outContext.drawImage !== "function") return "";
      try { outContext.drawImage(canvas, 0, top, canvas.width, cropHeight, 0, 0, canvas.width, cropHeight); }
      catch { return ""; }
      const url = out.toDataURL("image/jpeg", 0.82);
      out.width = 0; out.height = 0;
      return url;
    } finally {
      canvas.width = 0; canvas.height = 0; page.cleanup();
    }
  }, []);
  /** Cached figure/tables captions for the current document (FEAT-UX-06). */
  const figures = useRef<{ doc: unknown; rows: Promise<FigureItem[]> } | null>(null);
  useEffect(() => { figures.current = null; }, [bytes, url]);
  const extractFigures = useCallback(async (): Promise<FigureItem[]> => {
    const document = state.current.doc;
    if (!document) return [];
    const cached = figures.current;
    if (cached?.doc === document) return cached.rows;
    const run = (async () => {
      const rows: FigureItem[] = [];
      const total = Math.min(Number(document.numPages) || 0, 600);
      for (let pageNumber = 1; pageNumber <= total && rows.length < FIGURE_SCAN_LIMIT; pageNumber++) {
        let page: pdfjsLib.PDFPageProxy | null = null;
        try {
          page = await document.getPage(pageNumber);
          const natural = page.getViewport({ scale: 1 });
          const content = await page.getTextContent();
          rows.push(...extractFiguresFromPage(pageNumber, figureLines(content.items as any[], natural), natural.height));
        } catch { /* unreadable page: keep scanning the rest */ }
        finally { page?.cleanup?.(); }
        // Let scrolling and rendering interleave with a long caption scan.
        if (pageNumber % 8 === 0) await new Promise((resolve) => setTimeout(resolve, 0));
      }
      return rows.slice(0, FIGURE_SCAN_LIMIT);
    })();
    figures.current = { doc: document, rows: run };
    // Never cache a rejected scan, otherwise the gallery cannot retry.
    run.catch(() => { if (figures.current?.rows === run) figures.current = null; });
    return run;
  }, []);
  const getOutline = useCallback(async (): Promise<OutlineItem[]> => {    const document = state.current.doc;
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
  const hoverTimer = useRef(0);
  /** Geometry of the un-cropped page layer, in viewport pixels. */
  const pageRect = (holder: HTMLElement): DOMRect => {
    const inner = holder.querySelector<HTMLElement>(".page-inner");
    return (inner ?? holder).getBoundingClientRect();
  };
  const paragraphPoint = (event: { clientX: number; clientY: number; target: EventTarget | null }) => {
    const target = event.target as HTMLElement | null;
    if (!target || target.closest("a,button,.highlight,.pdf-link")) return null;
    const holder = target.closest<HTMLElement>(".page-holder");
    if (!holder) return null;
    const rect = pageRect(holder);
    if (rect.width <= 0 || rect.height <= 0) return null;
    return { page: Number(holder.dataset.page), x: (event.clientX - rect.left) / scale, y: (event.clientY - rect.top) / scale };
  };
  const handleParagraphUp = (event: React.MouseEvent) => {
    if (event.altKey || pan.current) return;
    const selection = window.getSelection();
    if (selection && !selection.isCollapsed && selection.toString().trim()) return;
    const point = paragraphPoint(event);
    if (point) latest.current.onParagraphPoint?.(point, "click");
  };
  const handleParagraphHover = (event: React.MouseEvent) => {
    if (event.buttons || pan.current || area.current || !latest.current.onParagraphPoint) return;
    const point = paragraphPoint(event);
    window.clearTimeout(hoverTimer.current);
    hoverTimer.current = window.setTimeout(() => latest.current.onParagraphPoint?.(point, "hover"), 90);
  };
  /** Press bookkeeping so panning/dragging never resolves a text reference. */
  const refPress = useRef<{ x: number; y: number } | null>(null);
  const refDragged = useRef(false);
  /**
   * FEAT-AI-01: rebuild the PDF text-layer line under a click. pdf.js emits one
   * span per text item, so `Fig.` and `2` are usually separate spans; the line
   * is stitched from the neighbouring spans that share the same vertical band.
   * The caret offset (when the browser provides one) keeps the match precise.
   */
  const textLineAt = (span: HTMLElement, caret: { node: Node; offset: number } | null) => {
    const layer = span.closest<HTMLElement>(".textLayer");
    if (!layer) return null;
    const spans = Array.from(layer.querySelectorAll<HTMLElement>("span"));
    const index = spans.indexOf(span);
    if (index < 0) return null;
    const base = span.getBoundingClientRect();
    const sameLine = (node: HTMLElement) => {
      const rect = node.getBoundingClientRect();
      if (base.height <= 0 || rect.height <= 0) return true; // jsdom / unmeasured
      const overlap = Math.min(base.bottom, rect.bottom) - Math.max(base.top, rect.top);
      return overlap > Math.min(base.height, rect.height) * 0.35;
    };
    const collect = (from: number, step: number) => {
      const nodes: HTMLElement[] = [];
      for (let i = from; i >= 0 && i < spans.length && nodes.length < 8; i += step) {
        const node = spans[i]!;
        if (node === span || !sameLine(node)) break;
        nodes.push(node);
      }
      return nodes;
    };
    const parts = [...collect(index - 1, -1).reverse(), span, ...collect(index + 1, 1)];
    const texts = parts.map((node) => (node.textContent || "").replace(/\s+/g, " ").trim());
    const text = texts.filter(Boolean).join(" ");
    if (!text) return null;
    let offset: number | null = null;
    if (caret) {
      let cursor = 0;
      for (let i = 0; i < parts.length; i += 1) {
        const node = parts[i]!, value = texts[i]!;
        if (offset == null && node.contains(caret.node)) {
          const raw = node.textContent || "";
          const leading = raw.length - raw.trimStart().length;
          offset = cursor + Math.max(0, Math.min(value.length, caret.offset - leading));
        }
        if (value) cursor += value.length + 1;
      }
    }
    return { text, offset };
  };
  /** The in-text reference under a click, if any (`Fig. 2`, `Table 1`, `[12]`). */
  const referenceAt = (event: React.MouseEvent) => {
    if (!latest.current.onTextReference || event.button !== 0 || event.altKey) return null;
    const target = event.target as HTMLElement | null;
    if (!target || target.closest("a,button,.pdf-link,.highlight")) return null;
    if (!target.closest(".page-holder")) return null;
    const doc = window.document as Document & {
      caretRangeFromPoint?: (x: number, y: number) => Range | null;
      caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null;
    };
    let caret: { node: Node; offset: number } | null = null;
    if (typeof doc.caretRangeFromPoint === "function") {
      const range = doc.caretRangeFromPoint(event.clientX, event.clientY);
      if (range) caret = { node: range.startContainer, offset: range.startOffset };
    } else if (typeof doc.caretPositionFromPoint === "function") {
      const position = doc.caretPositionFromPoint(event.clientX, event.clientY);
      if (position) caret = { node: position.offsetNode, offset: position.offset };
    }
    const elementOf = (node: Node | null) => node ? (node.nodeType === Node.ELEMENT_NODE ? node as HTMLElement : node.parentElement) : null;
    const caretSpan = elementOf(caret?.node ?? null)?.closest<HTMLElement>(".textLayer span") ?? null;
    const span = caretSpan ?? target.closest<HTMLElement>(".textLayer span");
    if (!span) return null;
    // A caret can snap to the nearest glyph; reject clicks that land in the
    // page margin instead of on the text box itself.
    if (caret && caretSpan) {
      const rect = caretSpan.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0
        && (event.clientX < rect.left - 4 || event.clientX > rect.right + 4
          || event.clientY < rect.top - 2 || event.clientY > rect.bottom + 2)) return null;
    }
    const line = textLineAt(span, caret);
    if (!line) return null;
    const match = matchTextReference(line.text);
    if (!match) return null;
    // With a real caret only accept the reference right under the pointer:
    // clicking plain prose on the same line must not jump to its figure.
    if (line.offset != null) {
      const start = match.index, end = match.index + match.length;
      if (line.offset < start - 1 || line.offset > end + 1) {
        const own = matchTextReference((span.textContent || "").trim());
        if (!own) return null;
        return { reference: own, anchor: { x: event.clientX, y: event.clientY } };
      }
    }
    return { reference: match, anchor: { x: event.clientX, y: event.clientY } };
  };
  /** Returns true when a reference was resolved (paragraph alignment is skipped). */
  const handleTextReference = (event: React.MouseEvent): boolean => {
    if (!latest.current.onTextReference) return false;
    const pressed = refPress.current;
    refPress.current = null;
    const moved = pressed ? Math.hypot(event.clientX - pressed.x, event.clientY - pressed.y) : 0;
    if (refDragged.current || moved > 6) { refDragged.current = false; return false; }
    const selection = window.getSelection();
    if (selection && !selection.isCollapsed && selection.toString().trim()) return false;
    const found = referenceAt(event);
    if (!found) return false;
    latest.current.onTextReference?.(found.reference, found.anchor);
    return true;
  };
  const area = useRef<{ page: number; holder: HTMLElement; x0: number; y0: number; bounds: DOMRect } | null>(null);
  const onAreaPointerDown = (event: ReactPointerEvent) => {
    // Explicit marquee tool (tablet / stylus), Alt+drag and the stylus barrel
    // button all start a box; plain text selection stays the default.
    const stylus = event.pointerType === "pen" && (event.button === 2 || event.button === 5 || (event.buttons & 32) === 32);
    const requested = event.altKey || latest.current.areaMode || stylus;
    if (!requested || (event.button !== 0 && !stylus)) return;
    const holder = (event.target as HTMLElement).closest<HTMLElement>(".page-holder");
    const container = scroll.current;
    if (!holder || !container) return;
    event.preventDefault();
    const bounds = pageRect(holder);
    area.current = { page: Number(holder.dataset.page), holder, x0: event.clientX, y0: event.clientY, bounds };
    setMarquee({ left: event.clientX, top: event.clientY, width: 0, height: 0, page: area.current.page });
    container.setPointerCapture?.(event.pointerId);
  };
  const onAreaPointerMove = (event: ReactPointerEvent) => {
    const current = area.current;
    if (!current) return;
    setMarquee({ left: Math.min(current.x0, event.clientX), top: Math.min(current.y0, event.clientY), width: Math.abs(event.clientX - current.x0), height: Math.abs(event.clientY - current.y0), page: current.page });
  };
  /** Text inside the marquee, read from the already rendered text layer. */
  const areaTextInside = (holder: HTMLElement, box: { left: number; top: number; right: number; bottom: number }): string => {
    const words: string[] = [];
    for (const span of holder.querySelectorAll<HTMLElement>(".textLayer span")) {
      const rect = span.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) continue;
      const overlapX = Math.min(rect.right, box.right) - Math.max(rect.left, box.left);
      const overlapY = Math.min(rect.bottom, box.bottom) - Math.max(rect.top, box.top);
      // Require most of the glyph to sit inside the box so a diagram caption
      // next to a figure is not dragged in as "selected text".
      if (overlapX <= 0 || overlapY <= 0 || overlapX * overlapY < rect.width * rect.height * 0.5) continue;
      const text = (span.textContent || "").trim();
      if (text) words.push(text);
    }
    return words.join(" ").replace(/\s+/g, " ").trim();
  };
  const cropAreaImage = (holder: HTMLElement, box: { left: number; top: number; right: number; bottom: number }): string => {
    const canvas = holder.querySelector("canvas");
    if (!canvas || !canvas.width || !canvas.height) return "";
    const rect = canvas.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return "";
    const sx = Math.max(0, (box.left - rect.left) / rect.width * canvas.width);
    const sy = Math.max(0, (box.top - rect.top) / rect.height * canvas.height);
    const sw = Math.max(1, Math.min(canvas.width - sx, (box.right - box.left) / rect.width * canvas.width));
    const sh = Math.max(1, Math.min(canvas.height - sy, (box.bottom - box.top) / rect.height * canvas.height));
    const out = window.document.createElement("canvas");
    const maxWidth = 1280;
    const scale = Math.min(1, maxWidth / sw);
    out.width = Math.max(1, Math.round(sw * scale));
    out.height = Math.max(1, Math.round(sh * scale));
    const context = out.getContext("2d");
    // jsdom/canvas-less environments expose a stub 2D context; never break the
    // marquee selection just because a crop cannot be produced.
    if (!context || typeof context.drawImage !== "function") return "";
    try { context.drawImage(canvas, sx, sy, sw, sh, 0, 0, out.width, out.height); }
    catch { out.width = 0; out.height = 0; return ""; }
    const url = out.toDataURL("image/png");
    out.width = 0; out.height = 0;
    return url;
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
    const box = { left, top, right, bottom };
    const quote = areaTextInside(current.holder, box);
    latest.current.onAreaSelect?.({
      page: current.page,
      quote,
      areaText: quote,
      side,
      area: true,
      imageDataUrl: cropAreaImage(current.holder, box),
      rects: [{ x: (left - current.bounds.left) / current.bounds.width, y: (top - current.bounds.top) / current.bounds.height, w: width / current.bounds.width, h: height / current.bounds.height }],
      anchor: { x: left + width / 2, y: top },
    });
  };
  // ---- two-finger pinch preview (CSS transform only, no React state) ----
  const pinchGeometry = () => {
    const values = [...pointers.current.values()];
    if (values.length < 2) return null;
    const [a, b] = values;
    return { distance: Math.hypot(a.x - b.x, a.y - b.y), mid: { clientX: (a.x + b.x) / 2, clientY: (a.y + b.y) / 2 } };
  };
  const resetPinchPreview = () => {
    const element = stage.current;
    if (!element) return;
    element.style.transform = "";
    element.style.transformOrigin = "";
    element.style.willChange = "";
  };
  const trackPointerDown = (event: ReactPointerEvent) => {
    const type = event.pointerType || "mouse";
    pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY, type });
    // Any pressed pointer suppresses the selectionchange toolbar (a mouse drag
    // also pauses mid-selection); touch/stylus additionally own the native
    // long-press selection, which only settles after the finger lifts.
    touchPress.current = true;
    if (pointers.current.size !== 2) return;
    const values = [...pointers.current.values()];
    const secondary = values.some((value) => value.type !== "mouse");
    const geometry = pinchGeometry();
    if (!secondary || !geometry || geometry.distance <= 16) return;
    pinch.current = { startDist: geometry.distance, startScale: state.current.scale, ratio: 1, mid: geometry.mid };
    // A second finger means "zoom", not "draw a box": drop any live marquee.
    if (area.current) { area.current = null; setMarquee(null); }
    const element = stage.current;
    if (element) element.style.willChange = "transform";
  };
  const trackPointerMove = (event: ReactPointerEvent) => {
    const tracked = pointers.current.get(event.pointerId);
    if (!tracked) return;
    tracked.x = event.clientX; tracked.y = event.clientY;
    // Self-heal the press flag if a mouse release happened outside the pane.
    if (tracked.type === "mouse" && event.buttons === 0) touchPress.current = false;
    const gesture = pinch.current;
    const element = stage.current;
    if (!gesture || !element) return;
    const geometry = pinchGeometry();
    if (!geometry || gesture.startDist <= 0) return;
    gesture.mid = geometry.mid;
    gesture.ratio = geometry.distance / gesture.startDist;
    // Clamp the preview to the scale range the reader accepts (0.4 – 4).
    const ratio = Math.max(0.4 / gesture.startScale, Math.min(4 / gesture.startScale, gesture.ratio));
    const rect = element.getBoundingClientRect();
    // Transform around the pinch midpoint so the paper sticks to the fingers;
    // scroll offsets are untouched, the real redraw happens on release.
    element.style.transformOrigin = `${gesture.mid.clientX - rect.left}px ${gesture.mid.clientY - rect.top}px`;
    element.style.transform = `scale(${ratio})`;
  };
  const settleTouchSelection = () => {
    // Native Android selection lands after the finger lifts; give the OS a beat
    // and then emit the selection once (280ms debounce already ran during drag).
    window.clearTimeout(selectionTimer.current);
    selectionTimer.current = window.setTimeout(() => selectHandler.current(), 160);
  };
  const trackPointerUp = (event: ReactPointerEvent) => {
    const tracked = pointers.current.get(event.pointerId);
    const wasTouch = !!tracked && tracked.type !== "mouse";
    pointers.current.delete(event.pointerId);
    const gesture = pinch.current;
    if (gesture && pointers.current.size < 2) {
      pinch.current = null;
      resetPinchPreview();
      if (pointers.current.size === 0) touchPress.current = false;
      const nextScale = gesture.startScale * gesture.ratio;
      if (Number.isFinite(nextScale) && Math.abs(nextScale - gesture.startScale) > 0.01) {
        // Ask the pane to remember the anchor before React changes `scale`, then
        // let the Reader commit the crisp redraw at that focal point.
        prepareZoom(gesture.mid);
        latest.current.onPinchScale?.(nextScale, gesture.mid);
      }
      return;
    }
    if (pointers.current.size === 0) {
      touchPress.current = false;
      if (wasTouch) settleTouchSelection();
    }
  };
  /** Debounced document selectionchange: the only signal a tablet long-press drag emits. */
  useEffect(() => {
    if (typeof document === "undefined") return;
    const schedule = () => {
      const current = window.getSelection();
      if (!current || current.isCollapsed) lastSelectionKey.current = "";
      window.clearTimeout(selectionTimer.current);
      selectionTimer.current = window.setTimeout(() => {
        // Never pop the toolbar while a finger/pen is still pressed.
        if (touchPress.current) return;
        selectHandler.current();
      }, 280);
    };
    document.addEventListener("selectionchange", schedule);
    return () => { document.removeEventListener("selectionchange", schedule); window.clearTimeout(selectionTimer.current); };
  }, []);

  useEffect(() => {
    if (!doc) return;
    virtual.measure();
    registerApi?.({ goTo, getPosition: position, parsePage, getOutline, find, fit, thumbnail, renderRegion, extractFigures, prepareZoom, pageSize });
    return () => registerApi?.(null);
  }, [doc, scale, registerApi, goTo, position, virtual, parsePage, getOutline, find, fit, thumbnail, renderRegion, extractFigures, prepareZoom, pageSize]);
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
    const startHolder = element(range.startContainer)?.closest<HTMLElement>(".page-holder");
    const endHolder = element(range.endContainer)?.closest<HTMLElement>(".page-holder");
    if (!startHolder || !endHolder || !scroll.current?.contains(startHolder) || !scroll.current?.contains(endHolder)) return;
    const quote = selected.toString().trim();
    if (!quote) return;
    const rectsFor = (holder: HTMLElement) => {
      // The un-cropped page layer, so 0-1 rects never shift when auto-crop is on.
      const bounds = pageRect(holder);
      if (bounds.width <= 0 || bounds.height <= 0) return [] as Rect[];
      return Array.from(range.getClientRects()).filter((r) => {
        const cx = (r.left + r.right) / 2, cy = (r.top + r.bottom) / 2;
        return r.width > 1 && r.height > 1 && cx >= bounds.left && cx <= bounds.right && cy >= bounds.top && cy <= bounds.bottom;
      }).map((r) => ({
        x: Math.max(0, (r.left - bounds.left) / bounds.width), y: Math.max(0, (r.top - bounds.top) / bounds.height),
        w: Math.min(r.width, bounds.right - r.left) / bounds.width, h: Math.min(r.height, bounds.bottom - r.top) / bounds.height,
      })).filter((r) => r.w > 0 && r.h > 0);
    };
    const rects = rectsFor(startHolder);
    if (!rects.length) return;
    const page = Number(startHolder.dataset.page);
    const endPage = Number(endHolder.dataset.page);
    // Cross-page selection: keep the first/last page fragments (adjacent pages).
    // Middle pages of a >2-page drag are intentionally ignored rather than
    // silently producing an annotation that no longer matches the quote.
    const extraSlices = endHolder !== startHolder && Math.abs(endPage - page) === 1
      ? (() => { const endRects = rectsFor(endHolder); return endRects.length ? [{ page: endPage, rects: endRects }] : undefined; })()
      : undefined;
    // Both the mouse and the selectionchange paths can report the same range;
    // emit once so the toolbar does not flicker or re-anchor.
    const signature = `${page}:${extraSlices?.[0]?.page ?? ""}:${quote}:${rects.length}:${rects[0].x.toFixed(4)}`;
    if (signature === lastSelectionKey.current) return;
    lastSelectionKey.current = signature;
    const box = range.getBoundingClientRect();
    latest.current.onSelect?.({ page, rects, quote, side, anchor: { x: box.left + box.width / 2, y: box.top }, extraSlices });
  };
  selectHandler.current = handleSelection;
  const byPage = useMemo(() => {
    const map = new Map<number, Annotation[]>();
    for (const a of annotations) { const values=map.get(a.page) ?? []; values.push(a); map.set(a.page,values); }
    return map;
  }, [annotations]);
  const items = virtual.getVirtualItems();
  const widest = items.reduce((max, item) => Math.max(max, crops.current.get(item.index)?.w ?? sizes.current.get(item.index)?.w ?? natural.w), 0);
  const width = (widest || natural.w) * scale + 32;
  const userInput = () => { programmatic.current = false; };
  return <div className={`pane pane-${side}`}>
    <div className={`pane-scroll ${spacePan ? "grab" : ""} ${panning ? "grabbing" : ""}${props.areaMode ? " area-mode" : ""}`} ref={scroll} onScroll={handleScroll}
      onMouseUp={(event) => { if (event.altKey) return; handleSelection(); if (handleTextReference(event)) return; handleParagraphUp(event); }}
      onMouseMove={handleParagraphHover}
      onMouseLeave={() => { window.clearTimeout(hoverTimer.current); latest.current.onParagraphPoint?.(null, "hover"); }}
      onPointerEnter={() => { hover.current = true; }} onPointerLeave={() => { hover.current = false; }}
      onWheelCapture={userInput} onPointerDownCapture={userInput} onKeyDownCapture={userInput}
      onPointerDown={(event) => { refPress.current = { x: event.clientX, y: event.clientY }; refDragged.current = false; trackPointerDown(event); onAreaPointerDown(event); onPanPointerDown(event); }}
      onPointerMove={(event) => { const pressed = refPress.current; if (pressed && Math.hypot(event.clientX - pressed.x, event.clientY - pressed.y) > 6) refDragged.current = true; trackPointerMove(event); onAreaPointerMove(event); onPanPointerMove(event); }}
      onPointerUp={(event) => { trackPointerUp(event); onAreaPointerUp(event); onPanPointerUp(); }}
      onPointerCancel={(event) => { trackPointerUp(event); onPanPointerUp(); }}
      tabIndex={0} aria-label={side === "source" ? "原文 PDF" : "译文 PDF"}>
      {!doc && <div className="pane-loading">{error || "正在载入 PDF…"}</div>}
      <div ref={stage} style={{ height: virtual.getTotalSize(), width: "100%", minWidth: width, position: "relative" }}>
        {doc && items.map((item) => {
          // Clipped pages are shorter/narrower on screen, but the page layer
          // inside keeps the full page so annotations stay in 0-1 coordinates.
          const crop = crops.current.get(item.index);
          const fullWidth = (sizes.current.get(item.index)?.w ?? natural.w) * scale;
          return <div key={item.key} className="page-holder" data-page={item.index+1}
            style={{ width: crop ? crop.w * scale : fullWidth, height: item.size, position: "absolute", top: 0, left: "50%", transform: `translate(-50%, ${item.start}px)`, "--scale-factor": scale } as React.CSSProperties}>
            <PageView doc={doc} index={item.index} scale={scale} annotations={byPage.get(item.index) ?? EMPTY_ANNOTATIONS}
              onSize={onSize} onBlocks={onBlocks} loadOcr={props.loadOcr} textRevision={props.textRevision} focus={focus?.page === item.index ? focus.bbox : undefined}
              onNativeText={onNativeText} onHighlightClick={onHighlightClick} onLink={resolveDest}
              autoCrop={props.autoCrop} onCrop={onCrop}
              findHits={props.findMatches?.map((match, globalIndex) => ({ ...match, globalIndex })).filter((match) => match.page === item.index + 1)}
              activeMatchIndex={props.activeMatchIndex}
              alignedBox={props.alignedBox?.page === item.index + 1 ? props.alignedBox.bbox : null} />
          </div>;
        })}
      </div>
      {marquee && <div className="area-marquee" style={{ left: marquee.left, top: marquee.top, width: marquee.width, height: marquee.height }}><span>{marquee.page} 页 · 框选批注</span></div>}
    </div>
  </div>;
}
const EMPTY_ANNOTATIONS: Annotation[] = [];
