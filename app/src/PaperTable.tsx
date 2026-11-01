import {useEffect,useMemo,useRef,useState,type ReactNode} from 'react';
import {flexRender,getCoreRowModel,useReactTable,type ColumnDef,type VisibilityState,type ColumnSizingState} from '@tanstack/react-table';
import {useVirtualizer} from '@tanstack/react-virtual';
import type {PaperSort,PaperSummary,Tag} from './types';
type Props={
  papers:PaperSummary[];total:number;offset:number;query:string;sort:PaperSort;selected:Set<string>;
  onSelect:(id:string,checked:boolean)=>void;onSort:(sort:PaperSort)=>void;onOpen:(paper:PaperSummary)=>void;
  onToggleFavorite:(paper:PaperSummary)=>void;onOrganize?:(ids:string[])=>void;onTag?:(name:string)=>void;
  onEdit?:(paper:PaperSummary)=>void;onTrash:(paper:PaperSummary)=>void;onRestore:(paper:PaperSummary)=>void;onPurge:(paper:PaperSummary)=>void;onExport:(paper:PaperSummary,format:'bibtex'|'ris')=>void;
  onNote:(paper:PaperSummary)=>void;renderNote:(paper:PaperSummary)=>ReactNode;noteId?:string;
  onRefresh:(id:string)=>void;refreshing:boolean;
};
const key='moonlight-library-columns-v1';
const defaults:VisibilityState={categories:false};
const palette=['#36665a','#8158a0','#366ca0','#97601f','#9a4d63','#4d6b34'];
export function tagColor(tag:Tag){if(/^#[\da-f]{6}$/i.test(tag.color||''))return tag.color!;let hash=0;for(const c of tag.name)hash=(Math.imul(hash,31)+c.charCodeAt(0))>>>0;return palette[hash%palette.length];}
function preferences():{visibility:VisibilityState;sizing:ColumnSizingState;view:string}{
  try{const saved=JSON.parse(localStorage.getItem(key)||'{}');
    const visibility=Object.fromEntries(Object.entries(saved.visibility||{}).filter(([,v])=>typeof v==='boolean')) as VisibilityState;
    const sizing=Object.fromEntries(Object.entries(saved.sizing||{}).filter(([,v])=>typeof v==='number'&&Number.isFinite(v)&&v>=28&&v<=800)) as ColumnSizingState;
    return {visibility:{...defaults,...visibility,select:true,title:true,actions:true},sizing,view:['overview','reading','citations','custom'].includes(saved.view)?saved.view:'overview'};
  }catch{return {visibility:defaults,sizing:{},view:'overview'};}
}
export default function PaperTable(props:Props){
  const [initial]=useState(preferences),[visibility,setVisibility]=useState(initial.visibility),[sizing,setSizing]=useState(initial.sizing),[viewName,setViewName]=useState(initial.view),[settings,setSettings]=useState(false),[menu,setMenu]=useState<string|null>(null);
  const scroll=useRef<HTMLDivElement>(null),header=useRef<HTMLDivElement>(null),latest=useRef(props);latest.current=props;
  useEffect(()=>{try{localStorage.setItem(key,JSON.stringify({visibility,sizing,view:viewName}));}catch{}},[visibility,sizing,viewName]);
  useEffect(()=>{scroll.current?.scrollTo({top:0});setMenu(null);},[props.sort,props.offset,props.query]);
  const columns=useMemo<ColumnDef<PaperSummary>[]>(()=>[
    {id:'select',header:'选择',size:68,minSize:68,maxSize:90,enableHiding:false,enableResizing:false,cell:({row})=>{const p=row.original;return <div className="table-select">{!p.deleted&&<input type="checkbox" aria-label={`选择论文 ${p.title}`} checked={latest.current.selected.has(p.id)} onChange={e=>latest.current.onSelect(p.id,e.target.checked)}/>}<button className={`star ${p.favorite?'on':''}`} title="星标" onClick={()=>latest.current.onToggleFavorite(p)}>{p.favorite?'★':'☆'}</button></div>;}},
    {id:'title',accessorKey:'title',header:'标题',size:330,minSize:180,maxSize:800,enableHiding:false,cell:({row})=>{const p=row.original;return <div className="table-title-cell"><button className={`paper-title ${p.read_status==='unread'?'unread':''}`} title={p.title} onClick={()=>latest.current.onOpen(p)}>{p.title}</button><div className="small muted table-authors" title={p.authors}>{p.authors||'未知作者'}{p.has_translation?' · 已有译文':''}</div></div>;}},
    {id:'year',accessorKey:'year',header:'年份',size:70,minSize:60,maxSize:120,cell:({getValue})=>getValue<string>()||'—'},
    {id:'categories',header:'目录',size:150,minSize:90,maxSize:400,cell:({row})=><button className="table-inline-edit" disabled={row.original.deleted} onClick={()=>latest.current.onOrganize?.([row.id])} title={row.original.categories.map(c=>c.name).join('、')}>{row.original.categories.map(c=>c.name).join(' / ')||'添加目录'}</button>},
    {id:'tags',header:'标签',size:170,minSize:90,maxSize:450,cell:({row})=><div className="table-tags">{row.original.tags.slice(0,4).map(tag=>{const color=tagColor(tag);return <button key={tag.id} className="chip" style={{color,background:color+'18',border:`1px solid ${color}44`}} onClick={()=>latest.current.onTag?.(tag.name)} title={`筛选标签 ${tag.name}`}>{tag.name}</button>;})}{row.original.tags.length>4&&<span title={row.original.tags.map(t=>t.name).join('、')}>+{row.original.tags.length-4}</span>}<button className="btn tiny ghost" disabled={row.original.deleted} aria-label={`编辑标签 ${row.original.title}`} onClick={()=>latest.current.onOrganize?.([row.id])}>＋</button></div>},
    {id:'short_note',header:'一句话速记',size:240,minSize:130,maxSize:600,cell:({row})=>latest.current.noteId===row.id?latest.current.renderNote(row.original):<button disabled={row.original.deleted} className="table-inline-edit table-short-note" title={row.original.short_note||'填写这篇论文的一句话总结'} onClick={()=>latest.current.onNote(row.original)}>{row.original.short_note||'＋ 添加速记'}</button>},
    {id:'citations',header:'引用量',size:125,minSize:100,maxSize:240,cell:({row})=>{const p=row.original;return <div className="table-citations"><span title={p.citation_updated_at?`更新：${new Date(p.citation_updated_at).toLocaleString()}`:'尚未获取'}>{p.citation_count==null?'未知':p.citation_count.toLocaleString()}</span><small>{p.citation_source||'未查询'}</small>{!p.deleted&&<button className="btn tiny ghost" disabled={latest.current.refreshing} onClick={()=>latest.current.onRefresh(p.id)}>刷新</button>}</div>;}},
    {id:'status',header:'阅读状态',size:90,minSize:80,maxSize:140,cell:({row})=><span className={`reading-state ${row.original.read_status}`}>{({unread:'未读',reading:'在读',read:'已读'})[row.original.read_status]}</span>},
    {id:'actions',header:'操作',size:126,minSize:126,maxSize:180,enableHiding:false,enableResizing:false,cell:({row})=>{const p=row.original;return <div className="table-actions"><button className="btn tiny" onClick={()=>latest.current.onOpen(p)}>阅读</button><button className="btn tiny ghost" title={`更多操作 ${p.title}`} onClick={()=>setMenu(old=>old===p.id?null:p.id)}>⋯</button></div>;}}
  ],[]);
  const virtual=useVirtualizer({count:props.papers.length,getScrollElement:()=>scroll.current,estimateSize:()=>66,overscan:5,getItemKey:i=>props.papers[i].id});
  const visible=virtual.getVirtualItems();
  // Build TanStack row objects only for the visible window; never materialize
  // a second row model for a huge supplied array. Sorting stays in SQLite.
  const data=useMemo(()=>visible.map(item=>props.papers[item.index]),[visible,props.papers]);
  const table=useReactTable({data,columns,getCoreRowModel:getCoreRowModel(),getRowId:row=>row.id,manualSorting:true,manualPagination:true,state:{columnVisibility:visibility,columnSizing:sizing,columnOrder:['select','title','year','citations','tags','short_note','categories','status','actions']},onColumnVisibilityChange:update=>{setViewName('custom');setVisibility(update);},onColumnSizingChange:update=>{setViewName('custom');setSizing(update);},columnResizeMode:'onEnd',defaultColumn:{minSize:60,maxSize:800}});
  const rows=table.getRowModel().rows;
  const labels:Record<string,string>={select:'选择',title:'标题',year:'年份',categories:'目录',tags:'标签',short_note:'一句话速记',citations:'引用量',status:'阅读状态',actions:'操作'};
  const preset=(value:string)=>{setViewName(value);setSizing({});setVisibility(value==='reading'?{categories:false,citations:false}:value==='citations'?{categories:false,short_note:false,status:false}:{categories:false});};
  const active=props.papers.find(p=>p.id===menu);
  const sortFor=(id:string):PaperSort|undefined=>id==='title'?'title':id==='year'?'year':id==='citations'?'citations':undefined;
  return <div className="paper-table-wrap"><div className="table-view-tools"><label>列表视图 <select aria-label="列表视图预设" value={viewName} onChange={e=>preset(e.target.value)}><option value="custom" disabled>自定义</option><option value="overview">研究概览</option><option value="reading">阅读与速记</option><option value="citations">引用量与标签</option></select></label><button className="btn tiny" aria-expanded={settings} onClick={()=>setSettings(v=>!v)}>显示列</button><span className="small muted">拖动表头边缘调整列宽；点击标题、年份或引用量排序</span></div>
    {settings&&<div className="table-column-settings">{table.getAllLeafColumns().filter(c=>c.getCanHide()).map(c=><label key={c.id}><input type="checkbox" checked={c.getIsVisible()} onChange={c.getToggleVisibilityHandler()}/>{labels[c.id]}</label>)}</div>}
    <div className="paper-data-table" role="table" aria-label="论文增强列表" aria-rowcount={props.total+1} aria-colcount={table.getVisibleLeafColumns().length}>
      <div className="paper-table-header-scroll" ref={header}><div className="paper-table-header" role="row" style={{width:table.getTotalSize()}}>{table.getHeaderGroups()[0].headers.map(h=>{const sorting=sortFor(h.id);return <div key={h.id} role="columnheader" aria-sort={sorting&&props.sort===sorting?(sorting==='title'?'ascending':'descending'):undefined} className="paper-table-th" style={{width:h.getSize()}}>{sorting?<button className="table-sort" onClick={()=>props.onSort(sorting)}>{labels[h.id]}{props.sort===sorting?(sorting==='title'?' ↑':' ↓'):''}</button>:flexRender(h.column.columnDef.header,h.getContext())}{h.column.getCanResize()&&<div role="separator" aria-label={`调整${labels[h.id]}列宽`} aria-orientation="vertical" className="table-resizer" onMouseDown={h.getResizeHandler()} onTouchStart={h.getResizeHandler()} onDoubleClick={()=>h.column.resetSize()}/>}</div>;})}</div></div>
      <div className="paper-table-scroll paper-list" ref={scroll} onScroll={()=>{if(header.current&&scroll.current)header.current.scrollLeft=scroll.current.scrollLeft;}}><div role="rowgroup" style={{height:virtual.getTotalSize(),width:table.getTotalSize(),position:'relative'}}>{visible.map((item,index)=>{const row=rows[index];if(!row)return null;return <div role="row" aria-rowindex={props.offset+item.index+2} aria-selected={props.selected.has(row.id)} key={row.id} data-index={item.index} data-paper-id={row.id} data-read-status={row.original.read_status} ref={virtual.measureElement} className={`paper-row paper-table-row ${props.selected.has(row.id)?'selected':''} ${row.original.deleted?'deleted':''}`} style={{position:'absolute',top:0,left:0,width:'100%',transform:`translateY(${item.start}px)`}} onDoubleClick={e=>{if(!(e.target as HTMLElement).closest('button,input,form,a'))props.onOpen(row.original);}}>{row.getVisibleCells().map(cell=><div role="cell" className="paper-table-cell" key={cell.id} style={{width:cell.column.getSize()}}>{flexRender(cell.column.columnDef.cell,cell.getContext())}</div>)}</div>;})}</div></div>
    </div>
    {active&&<div className="table-context-menu" role="dialog" aria-label="论文操作"><strong>{active.title}</strong>{!active.deleted?<><button onClick={()=>{props.onOrganize?.([active.id]);setMenu(null);}}>分类 / 标签</button><button onClick={()=>{props.onEdit?.(active);setMenu(null);}}>编辑资料</button><button onClick={()=>{props.onExport(active,'bibtex');setMenu(null);}}>导出 BibTeX</button><button onClick={()=>{props.onExport(active,'ris');setMenu(null);}}>导出 RIS</button><button onClick={()=>{props.onTrash(active);setMenu(null);}}>移到回收站</button></>:<><button onClick={()=>{props.onRestore(active);setMenu(null);}}>恢复</button><button onClick={()=>{props.onPurge(active);setMenu(null);}}>永久删除</button></>}<button onClick={()=>setMenu(null)}>关闭</button></div>}
  </div>;
}
