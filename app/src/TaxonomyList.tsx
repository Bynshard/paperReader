import { useRef } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
export default function TaxonomyList({ items, selected, onSelect, label }: {
  items: {id:string;name:string}[]; selected?: string; onSelect:(id:string,name:string)=>void; label:string;
}) {
  const scroll=useRef<HTMLDivElement>(null);
  const virtual=useVirtualizer({count:items.length,getScrollElement:()=>scroll.current,estimateSize:()=>34,overscan:3,getItemKey:(i)=>items[i].id});
  return <div ref={scroll} className="taxonomy-list" aria-label={label} style={{height:Math.min(204,items.length*34)}}>
    <div style={{height:virtual.getTotalSize(),position:'relative'}}>
      {virtual.getVirtualItems().map((row)=>{const item=items[row.index];return <button key={row.key}
        className={`nav-item small ${selected===item.id?'on':''}`} title={item.name}
        style={{position:'absolute',top:0,left:0,width:'100%',height:34,transform:`translateY(${row.start}px)`,overflow:'hidden',whiteSpace:'nowrap'}}
        onClick={()=>onSelect(item.id,item.name)}>{item.name}</button>;})}
    </div>
  </div>;
}
