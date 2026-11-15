import { useEffect, useRef, useState, type RefObject } from "react";
import { AlertTriangle, CheckCircle2, ChevronDown, Loader2, ScanText, Square } from "lucide-react";
import { api } from "./api";
import type { PaneApi } from "./PdfPane";
import FloatingLayer from "./FloatingLayer";

type Props = {
  paperId: string; versionId: string; pages: number; page: number; pane: RefObject<PaneApi | null>;
  onIndexed: () => void;
  /** false when the visible page has no native text layer (scanned page). */
  hasText?: boolean;
};

/**
 * Compact indexing status capsule. The full parsing toolbar only appears on demand,
 * keeping the reader header clean for native-text PDFs.
 */
export default function DocumentParsing({ paperId, versionId, pages, page, pane, onIndexed, hasText = true }: Props) {
  const [progress, setProgress] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [indexed, setIndexed] = useState<number | null>(null);
  const [open, setOpen] = useState(false);
  const [anchor, setAnchor] = useState({ x: 0, y: 0 });
  const pill = useRef<HTMLButtonElement>(null);
  const box = useRef<HTMLDivElement>(null);
  const controller = useRef<AbortController | null>(null);
  const alive = useRef(true);

  const refresh = () => (api.textStatus ? api.textStatus(paperId, versionId) : Promise.resolve({ indexed_pages: 0 })).then((status) => { if (alive.current) setIndexed(status.indexed_pages); }).catch(() => undefined);
  useEffect(() => { alive.current = true; void refresh(); return () => { alive.current = false; controller.current?.abort(); }; }, [paperId, versionId]);

  const run = async (all: boolean, forceOcr = false) => {
    if (controller.current) return;
    if (!pane.current) { setError("原文 PDF 尚未加载"); return; }
    const control = new AbortController();
    controller.current = control;
    setBusy(true); setError("");
    try {
      const targets = all ? Array.from({ length: pages }, (_, index) => index + 1) : [page];
      for (const target of targets) {
        if (control.signal.aborted) break;
        setProgress(`解析第 ${target}/${pages} 页`);
        const blocks = await pane.current!.parsePage(target, { forceOcr, signal: control.signal, progress: (message) => { if (alive.current) setProgress(`第 ${target}/${pages} 页：${message}`); } });
        if (control.signal.aborted) break;
        if (blocks.length) await api.setBlocks(paperId, versionId, target - 1, blocks);
        if (alive.current) {
          const visible = pane.current?.getPosition().page || page;
          if (Math.abs(target - visible) <= 2 || target === targets.at(-1)) onIndexed();
          if (Math.abs(target - visible) <= 2 || target % 10 === 0 || target === targets.at(-1)) await refresh();
        }
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
      if (alive.current) setProgress(control.signal.aborted ? "解析已停止，已完成页面已保留" : "解析完成；空白页或无法识别的页面可能没有正文");
    } catch (e) {
      if (alive.current) { if (control.signal.aborted) setProgress("解析已停止，已完成页面已保留"); else setError((e as Error).message); }
    } finally {
      controller.current = null;
      if (alive.current) setBusy(false);
    }
  };

  const scan = hasText === false;
  const openMenu = () => {
    const rect = pill.current?.getBoundingClientRect();
    if (rect) setAnchor({ x: rect.left + rect.width / 2, y: rect.bottom });
    setOpen((value) => !value);
  };

  return (
    <div className="parse-status" ref={box}>
      {scan ? (
        <button ref={pill} className="status-pill warn" disabled={busy} onClick={() => void run(false, true)} title="当前页没有原生文字层，可离线 OCR">
          {busy ? <Loader2 className="spin" size={14} /> : <AlertTriangle size={14} />}
          <span>{busy ? "正在 OCR…" : "扫描页 · 一键 OCR"}</span>
        </button>
      ) : (
        <button ref={pill} className="status-pill ok" onClick={openMenu} aria-expanded={open} title="正文索引状态">
          {busy ? <Loader2 className="spin" size={14} /> : <CheckCircle2 size={14} />}
          <span>{indexed === null ? "检查索引…" : `已索引 ${indexed}/${pages}`}</span>
        </button>
      )}
      <button className="status-chevron" aria-label="更多解析选项" aria-expanded={open} onClick={openMenu}><ChevronDown size={14} /></button>
      {open && (
        <FloatingLayer x={anchor.x} y={anchor.y} onClose={() => setOpen(false)} ignore={box} className="menu parse-menu" label="文档解析选项">
          <button onClick={() => { void run(false); }}><ScanText size={15} />解析当前页</button>
          <button onClick={() => { void run(false, true); }}><ScanText size={15} />OCR 当前页</button>
          <button onClick={() => { void run(true); }}><ScanText size={15} />解析全文（{pages} 页）</button>
          {busy && <button className="danger" onClick={() => controller.current?.abort()}><Square size={14} />停止解析</button>}
          {progress && <p className="menu-status" role="status">{progress}</p>}
          {error && <p className="menu-status error" role="alert">{error}</p>}
        </FloatingLayer>
      )}
    </div>
  );
}
