import { useRef } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
export default function ZoteroCollections({items,selected,onChange}:{
  items:{key:string;name:string;items:number}[];selected:string[];onChange:(keys:string[])=>void;
}) {
  const scroll=useRef<HTMLDivElement>(null);
  const virtual=useVirtualizer({count:items.length,getScrollElement:()=>scroll.current,estimateSize:()=>40,overscan:3,getItemKey:(i)=>items[i].key});
  return <div ref={scroll} aria-label="迁移分类" style={{height:Math.min(240,items.length*40),overflow:'auto'}}>
    <div style={{height:virtual.getTotalSize(),position:'relative'}}>
      {virtual.getVirtualItems().map((row)=>{const c=items[row.index];return <label key={c.key} className="zotero-collection" title={c.name}
        style={{position:'absolute',top:0,left:0,width:'100%',height:40,transform:`translateY(${row.start}px)`,margin:0}}>
        <input type="checkbox" checked={selected.includes(c.key)} onChange={(e)=>onChange(e.target.checked?[...selected,c.key]:selected.filter((key)=>key!==c.key))}/>
        <span style={{overflow:'hidden',whiteSpace:'nowrap',textOverflow:'ellipsis'}}>{c.name}</span><span className="muted small">{c.items} 条</span>
      </label>;})}
    </div>
  </div>;
}
