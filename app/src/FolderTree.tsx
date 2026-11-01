import {useMemo,useRef,useState} from 'react';
import {useVirtualizer} from '@tanstack/react-virtual';
import type {Category} from './types';
import {folderRows} from './folders';
export default function FolderTree({items,selected,onSelect}:{items:Category[];selected?:string;onSelect:(id:string,name:string)=>void}){
  const [closed,setClosed]=useState<Set<string>>(new Set()),scroll=useRef<HTMLDivElement>(null);
  const rows=useMemo(()=>{const all=folderRows(items),visible:typeof all=[];let hiddenDepth:number|null=null;for(const row of all){if(hiddenDepth!==null&&row.depth>hiddenDepth)continue;hiddenDepth=null;visible.push(row);if(closed.has(row.id))hiddenDepth=row.depth;}return visible;},[items,closed]);
  const virtual=useVirtualizer({count:rows.length,getScrollElement:()=>scroll.current,estimateSize:()=>34,overscan:3,getItemKey:i=>rows[i].id});
  return <div ref={scroll} className="taxonomy-list folder-tree" role="tree" aria-label="论文目录" style={{height:Math.min(306,rows.length*34)}}><div role="none" style={{height:virtual.getTotalSize(),position:'relative'}}>{virtual.getVirtualItems().map(v=>{const item=rows[v.index];return <div key={v.key} role="treeitem" aria-level={item.depth+1} aria-selected={selected===item.id} aria-expanded={item.hasChildren?!closed.has(item.id):undefined} className={`folder-row ${selected===item.id?'on':''}`} style={{position:'absolute',top:0,left:0,width:'100%',height:34,transform:`translateY(${v.start}px)`,paddingLeft:Math.min(item.depth,12)*12}}>
    <button className="folder-toggle" disabled={!item.hasChildren} aria-label={`${closed.has(item.id)?'展开':'折叠'} ${item.path}`} onClick={()=>setClosed(old=>{const next=new Set(old);if(next.has(item.id))next.delete(item.id);else next.add(item.id);return next;})}>{item.hasChildren?(closed.has(item.id)?'▸':'▾'):'·'}</button><button className="folder-name" title={`${item.path}（包含子目录论文）`} onClick={()=>onSelect(item.id,item.path)}>{item.name}</button>
  </div>;})}</div></div>;
}
