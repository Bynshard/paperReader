import { useMemo, useRef, useState } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { ChevronDown, ChevronRight, Dot } from 'lucide-react';
import type { Category } from './types';
import { folderRows, type FolderRow } from './folders';
import { api } from './api';
import FloatingLayer from './FloatingLayer';
import { isPaperDrag, readPaperDragData } from './drag';
type Row = FolderRow & { paper_count?: number };

export default function FolderTree({ items, selected, onSelect, onDropPapers, onChanged }: {
  items: Category[]; selected?: string; onSelect: (id: string, name: string) => void;
  onDropPapers?: (paperIds: string[], categoryId: string) => void;
  onChanged?: () => void;
}) {
  const [closed, setClosed] = useState<Set<string>>(new Set()), scroll = useRef<HTMLDivElement>(null);
  const [over, setOver] = useState<string | null>(null);
  const [menu, setMenu] = useState<{ item: FolderRow; x: number; y: number } | null>(null);
  const [editor, setEditor] = useState<{ mode: "new" | "rename"; item: FolderRow; text: string } | null>(null);
  const rows = useMemo(() => { const all = folderRows(items) as Row[]; const visible: Row[] = []; let hiddenDepth: number | null = null; for (const row of all) { if (hiddenDepth !== null && row.depth > hiddenDepth) continue; hiddenDepth = null; visible.push(row); if (closed.has(row.id)) hiddenDepth = row.depth; } return visible; }, [items, closed]);
  const virtual = useVirtualizer({ count: rows.length, getScrollElement: () => scroll.current, estimateSize: () => 32, overscan: 3, getItemKey: (index) => rows[index].id });
  const changed = () => onChanged?.();
  const run = (task: Promise<unknown>) => { void task.then(changed).catch((error) => window.alert(String((error as Error).message || error))); };
  const closeMenu = () => { setMenu(null); setEditor(null); };
  const saveEditor = () => {
    const value = editor?.text.trim();
    if (!editor || !value) return;
    const { mode, item } = editor;
    closeMenu();
    run(mode === "new" ? api.saveCategory({ name: value, parent_id: item.id }) : api.saveCategory({ id: item.id, name: value, parent_id: item.parent_id ?? null }));
  };
  return <div ref={scroll} className="taxonomy-list folder-tree" role="tree" aria-label="论文目录" style={{ height: Math.min(306, rows.length * 32) }}><div role="none" style={{ height: virtual.getTotalSize(), position: 'relative' }}>{virtual.getVirtualItems().map((virtualRow) => { const item = rows[virtualRow.index]; return <div key={virtualRow.key} role="treeitem" aria-level={item.depth + 1} aria-selected={selected === item.id} aria-expanded={item.hasChildren ? !closed.has(item.id) : undefined}
    className={`folder-row ${selected === item.id ? 'on' : ''} ${over === item.id ? 'drop-target' : ''}`}
    style={{ position: 'absolute', top: 0, left: 0, width: '100%', height: 32, transform: `translateY(${virtualRow.start}px)`, paddingLeft: Math.min(item.depth, 12) * 12 }}
    onDragOver={(event) => { if (!isPaperDrag(event.dataTransfer)) return; event.preventDefault(); event.dataTransfer.dropEffect = 'copy'; setOver(item.id); }}
    onDragLeave={() => setOver((current) => current === item.id ? null : current)}
    onDrop={(event) => { if (!isPaperDrag(event.dataTransfer)) return; event.preventDefault(); setOver(null); const ids = readPaperDragData(event.dataTransfer); if (ids.length) onDropPapers?.(ids, item.id); }}
    onContextMenu={(event) => { event.preventDefault(); setMenu({ item, x: event.clientX, y: event.clientY }); }}>
    <button className="folder-toggle" disabled={!item.hasChildren} aria-label={`${closed.has(item.id) ? '展开' : '折叠'} ${item.path}`} onClick={() => setClosed((old) => { const next = new Set(old); if (next.has(item.id)) next.delete(item.id); else next.add(item.id); return next; })}>{item.hasChildren ? (closed.has(item.id) ? <ChevronRight size={14} /> : <ChevronDown size={14} />) : <Dot size={14} />}</button><button className="folder-name" title={`${item.path}（包含子目录论文）`} onClick={() => onSelect(item.id, item.path)}>{item.name}</button>{item.paper_count ? <span className="nav-count folder-count">{item.paper_count}</span> : null}
  </div>; })}</div>
    {menu && <FloatingLayer x={menu.x} y={menu.y} onClose={closeMenu} className="menu context-menu" label="目录操作">
      <div className="menu-head" title={menu.item.path}>{menu.item.path}</div>
      {editor ? <div className="taxonomy-editor">
        <input aria-label={editor.mode === "new" ? "子目录名称" : "目录名称"} autoFocus value={editor.text}
          onChange={(event) => setEditor({ ...editor, text: event.target.value })}
          onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); saveEditor(); } }} />
        <div className="row-actions"><button className="btn tiny primary" onClick={saveEditor}>保存</button><button className="btn tiny" onClick={() => setEditor(null)}>取消</button></div>
      </div> : <>
        <button onClick={() => setEditor({ mode: "new", item: menu.item, text: "" })}>新建子目录</button>
        <button onClick={() => setEditor({ mode: "rename", item: menu.item, text: menu.item.name })}>重命名</button>
        <button disabled={!menu.item.parent_id} onClick={() => { const id = menu.item.id; closeMenu(); run(api.folderMove(id, null)); }}>移至根目录</button>
        <button className="danger" onClick={() => { const item = menu.item; closeMenu(); if (window.confirm(`删除目录「${item.path}」？其中的论文会保留并移到未分类。`)) run(api.folderDelete(item.id)); }}>删除目录</button>
      </>}
    </FloatingLayer>}
  </div>;
}
