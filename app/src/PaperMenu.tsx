import { BookOpen, Copy, ExternalLink, FileDown, FolderTree, PencilLine, Quote, RotateCcw, Trash2, Undo2 } from "lucide-react";
import type { PaperSummary } from "./types";

/** Citation formats that can be copied to the clipboard (FEAT-UX-04). */
export type CitationFormat = "gbt7714" | "bibtex";

export type PaperMenuActions = {
  onInspect?: (paper: PaperSummary) => void;
  onOpen: (paper: PaperSummary) => void;
  onEdit?: (paper: PaperSummary) => void;
  onOrganize?: (ids: string[]) => void;
  onExport: (paper: PaperSummary, format: "bibtex" | "ris") => void;
  /** Copy a formatted citation instead of writing a .bib/.ris file. */
  onCopyCitation?: (paper: PaperSummary, format: CitationFormat) => void;
  onTrash: (paper: PaperSummary) => void;
  onRestore: (paper: PaperSummary) => void;
  onPurge: (paper: PaperSummary) => void;
};

export function PaperMenuItems({ paper, actions, close }: { paper: PaperSummary; actions: PaperMenuActions; close: () => void }) {
  if (paper.deleted) {
    return (
      <>
        <button onClick={() => { close(); actions.onRestore(paper); }}><Undo2 size={16} />恢复论文</button>
        <button className="danger" onClick={() => { close(); actions.onPurge(paper); }}><Trash2 size={16} />永久删除</button>
      </>
    );
  }
  return (
    <>
      <button onClick={() => { close(); actions.onInspect?.(paper); }}><BookOpen size={16} />快速预览</button>
      <button onClick={() => { close(); actions.onOpen(paper); }}><ExternalLink size={16} />打开阅读器</button>
      <button onClick={() => { close(); actions.onEdit?.(paper); }}><PencilLine size={16} />编辑资料</button>
      <button onClick={() => { close(); actions.onOrganize?.([paper.id]); }}><FolderTree size={16} />分类 / 标签</button>
      <div className="menu-sep" />
      <button onClick={() => { close(); actions.onExport(paper, "bibtex"); }}><FileDown size={16} />导出 BibTeX</button>
      <button onClick={() => { close(); actions.onExport(paper, "ris"); }}><FileDown size={16} />导出 RIS</button>
      <div className="menu-sep" />
      {/* FEAT-UX-04: one-click citation copy for thesis / Chinese journal workflows. */}
      <button disabled={!actions.onCopyCitation} onClick={() => { close(); actions.onCopyCitation?.(paper, "gbt7714"); }}><Quote size={16} />复制 GB/T 7714 引文</button>
      <button disabled={!actions.onCopyCitation} onClick={() => { close(); actions.onCopyCitation?.(paper, "bibtex"); }}><Copy size={16} />复制 BibTeX</button>
      <div className="menu-sep" />
      <button className="danger" onClick={() => { close(); actions.onTrash(paper); }}><Trash2 size={16} />移到回收站</button>
    </>
  );
}
