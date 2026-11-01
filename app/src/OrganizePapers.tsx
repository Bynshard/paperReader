import {useMemo,useState} from 'react';
import {api} from './api';
import type {Category,Tag} from './types';
import {folderRows} from './folders';
export default function OrganizePapers({ids,categories,tags,onSaved,onClose}:{ids:string[];categories:Category[];tags:Tag[];onSaved:()=>Promise<void>;onClose:()=>void}){
  const [folder,setFolder]=useState(''),[text,setText]=useState(''),[busy,setBusy]=useState(false),[error,setError]=useState('');const rows=useMemo(()=>folderRows(categories),[categories]);
  const save=async()=>{setBusy(true);setError('');try{await api.bulkAssign({paper_ids:ids,category_id:folder||undefined,tags:[...new Set(text.split(/[,，\n]/).map(t=>t.trim()).filter(Boolean))]});await onSaved();onClose();}catch(e){setError((e as Error).message);}finally{setBusy(false);}};
  return <div className="modal-backdrop"><form className="modal folder-manager" onSubmit={e=>{e.preventDefault();void save();}}><h2>分类与标签 · {ids.length} 篇论文</h2><p className="small muted">添加到目录和标签，保留已有归类。移除已有归类可在单篇“编辑资料”中操作。</p><label>添加到目录<select aria-label="添加到目录" disabled={busy} value={folder} onChange={e=>setFolder(e.target.value)}><option value="">不添加目录</option>{rows.map(c=><option key={c.id} value={c.id}>{c.path}</option>)}</select></label>
    <label>添加标签（逗号分隔）<input aria-label="批量标签" disabled={busy} list="existing-paper-tags" value={text} onChange={e=>setText(e.target.value)} placeholder="例如：强化学习，待读"/></label><datalist id="existing-paper-tags">{tags.map(t=><option key={t.id} value={t.name}/>)}</datalist>
    {error&&<p role="alert">{error}</p>}<div className="modal-actions"><button type="button" className="btn" disabled={busy} onClick={onClose}>取消</button><button className="btn primary" disabled={busy||(!folder&&!text.trim())}>保存分类与标签</button></div>
  </form></div>;
}
