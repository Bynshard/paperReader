import {useMemo,useState} from 'react';
import {api} from './api';
import type {Category} from './types';
import {folderRows,canParent} from './folders';
export default function FolderManager({items,onChanged,onClose}:{items:Category[];onChanged:()=>Promise<void>;onClose:()=>void}){
  const [id,setId]=useState(''),[name,setName]=useState(''),[parent,setParent]=useState(''),[busy,setBusy]=useState(false),[error,setError]=useState(''),[message,setMessage]=useState('');
  const rows=useMemo(()=>folderRows(items),[items]);
  const select=(value:string)=>{setId(value);const item=items.find(c=>c.id===value);setName(item?.name||'');setParent(item?.parent_id||'');setError('');setMessage('');};
  const save=async()=>{setBusy(true);setError('');try{const saved=await api.saveCategory({id:id||undefined,name,parent_id:parent||null});await onChanged();setId(saved.id);setMessage('目录已保存');}catch(e){setError((e as Error).message);}finally{setBusy(false);}};
  return <div className="modal-backdrop"><form className="modal folder-manager" onSubmit={e=>{e.preventDefault();void save();}}><h2>管理论文目录</h2><p className="small muted">目录可分层，一篇论文可以属于多个目录。父目录会包含子目录的论文。</p>
    <label>选择操作<select aria-label="编辑目录" value={id} disabled={busy} onChange={e=>select(e.target.value)}><option value="">新建目录</option>{rows.map(c=><option key={c.id} value={c.id}>{c.path}</option>)}</select></label>
    <label>目录名称<input aria-label="目录名称" disabled={busy} required maxLength={100} value={name} onChange={e=>setName(e.target.value)}/></label>
    <label>上级目录<select aria-label="上级目录" disabled={busy} value={parent} onChange={e=>setParent(e.target.value)}><option value="">顶层目录</option>{rows.filter(c=>canParent(items,c.id,id)).map(c=><option key={c.id} value={c.id}>{c.path}</option>)}</select></label>
    {error&&<p role="alert">{error}</p>}{message&&<p role="status">{message}</p>}<div className="modal-actions"><button type="button" className="btn" disabled={busy} onClick={onClose}>关闭</button><button className="btn primary" disabled={busy||!name.trim()}>{id?'保存目录':'新建目录'}</button></div>
  </form></div>;
}
