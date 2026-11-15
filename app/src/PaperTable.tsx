import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { flexRender, getCoreRowModel, useReactTable, type ColumnDef, type VisibilityState, type ColumnSizingState } from "@tanstack/react-table";
import { useVirtualizer } from "@tanstack/react-virtual";
import { BookOpen, MoreHorizontal, Star } from "lucide-react";
import FloatingLayer from "./FloatingLayer";
import { PaperMenuItems, type PaperMenuActions } from "./PaperMenu";
import type { PaperSort, PaperSummary, Tag } from "./types";

export type PaperTableActions = {
  onOpen: (paper: PaperSummary) => void;
  onInspect: (paper: PaperSummary) => void;
  onToggleFavorite: (paper: PaperSummary) => void;
  onOrganize?: (ids: string[]) => void;
  onTag?: (name: string) => void;
  onEdit?: (paper: PaperSummary) => void;
  onTrash: (paper: PaperSummary) => void;
  onRestore: (paper: PaperSummary) => void;
  onPurge: (paper: PaperSummary) => void;
  onExport: (paper: PaperSummary, format: "bibtex" | "ris") => void;
  onCycleStatus: (paper: PaperSummary) => void;
};

type Props = PaperTableActions & {
  papers: PaperSummary[]; total: number; offset: number; query: string; sort: PaperSort; selected: Set<string>;
  inspectedId?: string;
  onSelect: (id: string, checked: boolean) => void; onSelectAll: (checked: boolean) => void; onSort: (sort: PaperSort) => void;
  onNote: (paper: PaperSummary) => void; renderNote: (paper: PaperSummary) => ReactNode; noteId?: string;
  onRefresh: (id: string) => void; refreshing: boolean;
  visibility: VisibilityState; onVisibilityChange: (next: VisibilityState) => void;
  sizing: ColumnSizingState; onColumnSizingChange: (next: ColumnSizingState) => void;
};

export const COLUMN_LABELS: Record<string, string> = { select: "选择", title: "标题", year: "年份", categories: "目录", tags: "标签", short_note: "一句话速记", citations: "引用量", status: "阅读状态", actions: "操作" };
export const HIDEABLE_COLUMNS = ["year", "categories", "tags", "short_note", "citations", "status"];
export const DEFAULT_COLUMN_VISIBILITY: VisibilityState = { categories: false };

const palette = ["#36665a", "#8158a0", "#366ca0", "#97601f", "#9a4d63", "#4d6b34"];
const STATUS_ORDER = { unread: "reading", reading: "read", read: "unread" } as const;
const STATUS_LABEL = { unread: "未读", reading: "在读", read: "已读" } as const;

export function tagColor(tag: Tag) {
  if (/^#[\da-f]{6}$/i.test(tag.color || "")) return tag.color!;
  let hash = 0;
  for (const char of tag.name) hash = (Math.imul(hash, 31) + char.charCodeAt(0)) >>> 0;
  return palette[hash % palette.length];
}

export default function PaperTable(props: Props) {
  const [menu, setMenu] = useState<{ paper: PaperSummary; x: number; y: number } | null>(null);
  const menuTrigger = useRef<HTMLElement | null>(null);
  const scroll = useRef<HTMLDivElement>(null);
  const header = useRef<HTMLDivElement>(null);
  const latest = useRef(props);
  latest.current = props;
  useEffect(() => { scroll.current?.scrollTo({ top: 0 }); setMenu(null); }, [props.sort, props.offset, props.query]);

  const actions: PaperMenuActions = {
    onInspect: (paper) => latest.current.onInspect(paper),
    onOpen: (paper) => latest.current.onOpen(paper),
    onEdit: (paper) => latest.current.onEdit?.(paper),
    onOrganize: (ids) => latest.current.onOrganize?.(ids),
    onExport: (paper, format) => latest.current.onExport(paper, format),
    onTrash: (paper) => latest.current.onTrash(paper),
    onRestore: (paper) => latest.current.onRestore(paper),
    onPurge: (paper) => latest.current.onPurge(paper),
  };

  const columns = useMemo<ColumnDef<PaperSummary>[]>(() => [
    {
      id: "select", header: () => {
        const selectable = latest.current.papers.filter((paper) => !paper.deleted);
        const checked = selectable.length > 0 && selectable.every((paper) => latest.current.selected.has(paper.id));
        return <input type="checkbox" aria-label="选择当前页论文" checked={checked} onChange={(event) => latest.current.onSelectAll(event.target.checked)} onClick={(event) => event.stopPropagation()} />;
      },
      size: 64, minSize: 64, maxSize: 90, enableHiding: false, enableResizing: false,
      cell: ({ row }) => { const paper = row.original; return <div className="table-select">{!paper.deleted && <input type="checkbox" aria-label={`选择论文 ${paper.title}`} checked={latest.current.selected.has(paper.id)} onChange={(event) => latest.current.onSelect(paper.id, event.target.checked)} onClick={(event) => event.stopPropagation()} />}<button className={`icon-btn star ${paper.favorite ? "on" : ""}`} aria-label={paper.favorite ? "取消星标" : "星标"} title="星标" onClick={(event) => { event.stopPropagation(); latest.current.onToggleFavorite(paper); }}><Star size={15} fill={paper.favorite ? "currentColor" : "none"} /></button></div>; },
    },
    {
      id: "title", accessorKey: "title", header: "标题", size: 300, minSize: 180, maxSize: 800, enableHiding: false,
      cell: ({ row }) => { const paper = row.original; return <div className="table-title-cell">
        <button className={`paper-title ${paper.read_status === "unread" ? "unread" : ""}`} title={paper.title}
          onClick={(event) => { if (event.detail > 1) return; latest.current.onInspect(paper); }}
          onDoubleClick={(event) => { event.stopPropagation(); latest.current.onOpen(paper); }}>{paper.title}</button>
        <div className="small muted table-authors" title={paper.authors}>{paper.authors || "未知作者"}{paper.has_translation ? " · 已有译文" : ""}</div>
      </div>; },
    },
    { id: "year", accessorKey: "year", header: "年份", size: 70, minSize: 60, maxSize: 120, cell: ({ getValue }) => getValue<string>() || "—" },
    { id: "citations", header: "引用量", size: 132, minSize: 112, maxSize: 240, cell: ({ row }) => { const paper = row.original; return <div className="table-citations"><span title={paper.citation_updated_at ? `更新：${new Date(paper.citation_updated_at).toLocaleString()}` : "尚未获取"}>{paper.citation_count == null ? "未知" : paper.citation_count.toLocaleString()}</span><small>{paper.citation_source || "未查询"}</small>{!paper.deleted && <button className="btn tiny ghost" disabled={latest.current.refreshing} onClick={(event) => { event.stopPropagation(); latest.current.onRefresh(paper.id); }}>刷新</button>}</div>; } },
    { id: "tags", header: "标签", size: 170, minSize: 90, maxSize: 450, cell: ({ row }) => <div className="table-tags">{row.original.tags.slice(0, 4).map((tag) => { const color = tagColor(tag); return <button key={tag.id} className="chip" style={{ color, background: color + "18", border: `1px solid ${color}44` }} onClick={(event) => { event.stopPropagation(); latest.current.onTag?.(tag.name); }} title={`筛选标签 ${tag.name}`}>{tag.name}</button>; })}{row.original.tags.length > 4 && <span title={row.original.tags.map((tag) => tag.name).join("、")}>+{row.original.tags.length - 4}</span>}<button className="btn tiny ghost" disabled={row.original.deleted} aria-label={`编辑标签 ${row.original.title}`} onClick={(event) => { event.stopPropagation(); latest.current.onOrganize?.([row.original.id]); }}>+</button></div> },
    { id: "short_note", header: "一句话速记", size: 200, minSize: 130, maxSize: 600, cell: ({ row }) => latest.current.noteId === row.id ? latest.current.renderNote(row.original) : <button disabled={row.original.deleted} className="table-inline-edit table-short-note" title={row.original.short_note || "填写这篇论文的一句话总结"} onClick={(event) => { event.stopPropagation(); latest.current.onNote(row.original); }}>{row.original.short_note || "＋ 添加速记"}</button> },
    { id: "categories", header: "目录", size: 150, minSize: 90, maxSize: 400, cell: ({ row }) => <button className="table-inline-edit" disabled={row.original.deleted} onClick={(event) => { event.stopPropagation(); latest.current.onOrganize?.([row.original.id]); }} title={row.original.categories.map((category) => category.name).join("、")}>{row.original.categories.map((category) => category.name).join(" / ") || "添加目录"}</button> },
    { id: "status", header: "阅读状态", size: 92, minSize: 82, maxSize: 140, cell: ({ row }) => { const status = row.original.read_status; return <button className={`reading-state ${status}`} title="点击切换：未读 → 在读 → 已读" aria-label={`切换阅读状态 ${row.original.title}（当前${STATUS_LABEL[status]}）`} onClick={(event) => { event.stopPropagation(); latest.current.onCycleStatus(row.original); }}>{STATUS_LABEL[status]}</button>; } },
    {
      id: "actions", header: "操作", size: 108, minSize: 104, maxSize: 180, enableHiding: false, enableResizing: false,
      cell: ({ row }) => { const paper = row.original; return <div className="table-actions">
        <button className="icon-btn" aria-label={`阅读 ${paper.title}`} title="打开阅读器" onClick={(event) => { event.stopPropagation(); latest.current.onOpen(paper); }}><BookOpen size={16} /></button>
        <button className="icon-btn" aria-label={`更多操作 ${paper.title}`} title="更多操作" aria-haspopup="menu" onClick={(event) => { event.stopPropagation(); menuTrigger.current = event.currentTarget; const rect = event.currentTarget.getBoundingClientRect(); setMenu((open) => open?.paper.id === paper.id ? null : { paper, x: rect.left + rect.width / 2, y: rect.bottom }); }}><MoreHorizontal size={17} /></button>
      </div>; },
    },
  ], []);

  const virtual = useVirtualizer({ count: props.papers.length, getScrollElement: () => scroll.current, estimateSize: () => 66, overscan: 5, getItemKey: (index) => props.papers[index].id });
  const visible = virtual.getVirtualItems();
  const data = useMemo(() => visible.map((item) => props.papers[item.index]), [visible, props.papers]);
  const table = useReactTable({
    data, columns, getCoreRowModel: getCoreRowModel(), getRowId: (row) => row.id, manualSorting: true, manualPagination: true,
    state: { columnVisibility: props.visibility, columnSizing: props.sizing, columnOrder: ["select", "title", "year", "citations", "tags", "short_note", "categories", "status", "actions"] },
    onColumnVisibilityChange: (update) => { const next = typeof update === "function" ? update(props.visibility) : update; props.onVisibilityChange(next); },
    onColumnSizingChange: (update) => { const next = typeof update === "function" ? update(props.sizing) : update; props.onColumnSizingChange(next); },
    columnResizeMode: "onEnd", defaultColumn: { minSize: 60, maxSize: 800 },
  });
  const rows = table.getRowModel().rows;
  const sortFor = (id: string): PaperSort | undefined => id === "title" ? "title" : id === "year" ? "year" : id === "citations" ? "citations" : undefined;

  return <div className="paper-table-wrap">
    <div className="paper-data-table" role="table" aria-label="论文增强列表" aria-rowcount={props.total + 1} aria-colcount={table.getVisibleLeafColumns().length}>
      <div className="paper-table-header-scroll" ref={header}>
        <div className="paper-table-header" role="row" style={{ width: table.getTotalSize() }}>
          {table.getHeaderGroups()[0].headers.map((headerCell) => { const sorting = sortFor(headerCell.id); return <div key={headerCell.id} role="columnheader" aria-sort={sorting && props.sort === sorting ? (sorting === "title" ? "ascending" : "descending") : undefined} className="paper-table-th" style={{ width: headerCell.getSize() }}>
            {sorting ? <button className="table-sort" onClick={() => props.onSort(sorting)}>{COLUMN_LABELS[headerCell.id]}{props.sort === sorting ? (sorting === "title" ? " ↑" : " ↓") : ""}</button> : flexRender(headerCell.column.columnDef.header, headerCell.getContext())}
            {headerCell.column.getCanResize() && <div role="separator" aria-label={`调整${COLUMN_LABELS[headerCell.id]}列宽`} aria-orientation="vertical" className="table-resizer" onMouseDown={headerCell.getResizeHandler()} onTouchStart={headerCell.getResizeHandler()} onDoubleClick={() => headerCell.column.resetSize()} />}
          </div>; })}
        </div>
      </div>
      <div className="paper-table-scroll paper-list" ref={scroll} onScroll={() => { if (header.current && scroll.current) header.current.scrollLeft = scroll.current.scrollLeft; }}>
        <div role="rowgroup" style={{ height: virtual.getTotalSize(), width: table.getTotalSize(), position: "relative" }}>
          {visible.map((item, index) => {
            const row = rows[index];
            if (!row) return null;
            const paper = row.original;
            return <div role="row" aria-rowindex={props.offset + item.index + 2} aria-selected={props.selected.has(row.id)} key={row.id} data-index={item.index} data-paper-id={row.id} data-read-status={paper.read_status} ref={virtual.measureElement}
              className={`paper-row paper-table-row ${props.selected.has(row.id) ? "selected" : ""} ${props.inspectedId === row.id ? "inspected" : ""} ${paper.deleted ? "deleted" : ""}`}
              style={{ position: "absolute", top: 0, left: 0, width: "100%", transform: `translateY(${item.start}px)` }}
              onClick={(event) => { if (event.detail > 1) return; if ((event.target as HTMLElement).closest("button,input,form,a,select,textarea")) return; latest.current.onInspect(paper); }}
              onDoubleClick={(event) => { if ((event.target as HTMLElement).closest("button,input,form,a,select,textarea")) return; latest.current.onOpen(paper); }}
              onContextMenu={(event) => { event.preventDefault(); setMenu({ paper, x: event.clientX, y: event.clientY }); }}>
              {row.getVisibleCells().map((cell) => <div role="cell" className="paper-table-cell" key={cell.id} style={{ width: cell.column.getSize() }}>{flexRender(cell.column.columnDef.cell, cell.getContext())}</div>)}
            </div>;
          })}
        </div>
      </div>
    </div>
    {menu && <FloatingLayer x={menu.x} y={menu.y} onClose={() => setMenu(null)} ignore={menuTrigger} className="menu context-menu" label="论文操作">
      <div className="menu-head" title={menu.paper.title}>{menu.paper.title}</div>
      <PaperMenuItems paper={menu.paper} actions={actions} close={() => setMenu(null)} />
    </FloatingLayer>}
  </div>;
}
