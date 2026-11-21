import { useRef, useState } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import FloatingLayer from './FloatingLayer';
import { api } from './api';
import { isPaperDrag, readPaperDragData } from './drag';
import { tagColor } from './PaperTable';
import type { Tag } from './types';

const TAG_COLORS = ['#f7ce4b', '#6fce93', '#64b2f2', '#ea7f77', '#8158a0', '#366ca0', '#97601f', '#4d6b34'];

export default function TaxonomyList({ items, selected, onSelect, label, onDropPapers, onChanged }: {
  items: Tag[]; selected?: string; onSelect: (id: string, name: string) => void; label: string;
  onDropPapers?: (paperIds: string[], tagName: string) => void;
  onChanged?: () => void;
}) {
  const scroll = useRef<HTMLDivElement>(null);
  const [over, setOver] = useState<string | null>(null);
  const [menu, setMenu] = useState<{ item: Tag; x: number; y: number } | null>(null);
  const [editing, setEditing] = useState<{ item: Tag; text: string } | null>(null);
  const virtual = useVirtualizer({ count: items.length, getScrollElement: () => scroll.current, estimateSize: () => 34, overscan: 3, getItemKey: (i) => items[i].id });
  const run = (task: Promise<unknown>) => { void task.then(() => onChanged?.()).catch((error) => window.alert(String((error as Error).message || error))); };
  const closeMenu = () => { setMenu(null); setEditing(null); };
  const saveRename = () => {
    const value = editing?.text.trim();
    if (!editing || !value || value === editing.item.name) { setEditing(null); return; }
    const id = editing.item.id;
    setEditing(null); setMenu(null);
    run(api.tagRename(id, value));
  };
  const cycleColor = (tag: Tag) => {
    const current = tagColor(tag).toLowerCase();
    const index = TAG_COLORS.findIndex((color) => color.toLowerCase() === current);
    return TAG_COLORS[(index + 1) % TAG_COLORS.length];
  };
  return <div ref={scroll} className="taxonomy-list" aria-label={label} style={{ height: Math.min(204, items.length * 34) }}>
    <div style={{ height: virtual.getTotalSize(), position: 'relative' }}>
      {virtual.getVirtualItems().map((row) => {
        const item = items[row.index];
        return <button key={row.key}
          className={`nav-item small ${selected === item.id ? 'on' : ''} ${over === item.id ? 'drop-target' : ''}`} title={item.name}
          style={{ position: 'absolute', top: 0, left: 0, width: '100%', height: 34, transform: `translateY(${row.start}px)`, overflow: 'hidden', whiteSpace: 'nowrap' }}
          onClick={() => onSelect(item.id, item.name)}
          onDragOver={(event) => { if (!isPaperDrag(event.dataTransfer)) return; event.preventDefault(); event.dataTransfer.dropEffect = 'copy'; setOver(item.id); }}
          onDragLeave={() => setOver((current) => current === item.id ? null : current)}
          onDrop={(event) => { if (!isPaperDrag(event.dataTransfer)) return; event.preventDefault(); setOver(null); const ids = readPaperDragData(event.dataTransfer); if (ids.length) onDropPapers?.(ids, item.name); }}
          onContextMenu={(event) => { event.preventDefault(); setMenu({ item, x: event.clientX, y: event.clientY }); }}>
          <span className="nav-label"><span className="tag-dot" style={{ background: tagColor(item) }} />{item.name}</span>
          {item.paper_count ? <span className="nav-count">{item.paper_count}</span> : null}
        </button>;
      })}
    </div>
    {menu && <FloatingLayer x={menu.x} y={menu.y} onClose={closeMenu} className="menu context-menu" label="标签操作">
      <div className="menu-head" title={menu.item.name}>{menu.item.name}</div>
      {editing ? <div className="taxonomy-editor">
        <input aria-label="标签名称" autoFocus value={editing.text}
          onChange={(event) => setEditing({ ...editing, text: event.target.value })}
          onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); saveRename(); } }} />
        <div className="row-actions"><button className="btn tiny primary" onClick={saveRename}>保存</button><button className="btn tiny" onClick={() => setEditing(null)}>取消</button></div>
      </div> : <>
        <button onClick={() => setEditing({ item: menu.item, text: menu.item.name })}>重命名标签</button>
        <button onClick={() => { const item = menu.item; closeMenu(); run(api.tagSetColor(item.id, cycleColor(item))); }}>切换颜色</button>
        <button className="danger" onClick={() => { const item = menu.item; closeMenu(); if (window.confirm(`删除标签「${item.name}」？论文本身不会被删除。`)) run(api.tagDelete(item.id)); }}>删除标签</button>
      </>}
    </FloatingLayer>}
  </div>;
}
