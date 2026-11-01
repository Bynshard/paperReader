import {useEffect,useState} from 'react';
import {api} from './api';
import {folderRows} from './folders';
import type {Paper,Category} from './types';
export default function PaperEditor({paper,onSaved,onClose}:{paper:Paper;onSaved:(p:Paper)=>void;onClose:()=>void}){
  const [fields,setFields]=useState<Record<string,string>>(()=>Object.fromEntries(['title','authors','year','venue','doi','arxiv','abstract','notes','read_status','short_note'].map(k=>[k,String((paper as unknown as Record<string,unknown>)[k]||'')])));
  const [taxonomy,setTaxonomy]=useState<Category[]>([]),[ids,setIds]=useState(paper.categories.map(c=>c.id));
  const [tags,setTags]=useState(paper.tags.map(t=>t.name).join(', ')),[category,setCategory]=useState(''),[busy,setBusy]=useState(false),[error,setError]=useState('');
  useEffect(()=>{api.taxonomy().then(t=>setTaxonomy(t.categories)).catch(e=>setError(e.message));},[]);
  const save=async()=>{setBusy(true);setError('');try{const fresh=await api.savePaper({paper_id:paper.id,expected_updated_at:paper.updated_at,fields,category_ids:ids,tags:tags.split(/[,，\n]/).map(t=>t.trim()).filter(Boolean)});onSaved(fresh);}catch(e){setError((e as Error).message);}finally{setBusy(false);}};
  const create=async()=>{setBusy(true);try{const item=await api.addCategory(category.trim());setTaxonomy(old=>[...old,item]);setIds(old=>[...old,item.id]);setCategory('');}catch(e){setError((e as Error).message);}finally{setBusy(false);}};
  return <div className="modal-backdrop"><form className="modal paper-editor" onSubmit={e=>{e.preventDefault();void save();}}><h2>编辑论文资料</h2>
    {(['title','authors','year','venue','doi','arxiv'] as const).map((key,i)=><label key={key}>{['标题','作者','年份','期刊或会议','DOI','arXiv'][i]}<input aria-label={['标题','作者','年份','期刊或会议','DOI','arXiv'][i]} required={key==='title'} value={fields[key]} onChange={e=>setFields(f=>({...f,[key]:e.target.value}))}/></label>)}
    <label>阅读状态<select aria-label="阅读状态" value={fields.read_status} onChange={e=>setFields(f=>({...f,read_status:e.target.value}))}><option value="unread">未读</option><option value="reading">在读</option><option value="read">已读</option></select></label>
    <label>分类<select aria-label="论文分类" multiple value={ids} onChange={e=>setIds([...e.target.selectedOptions].map(o=>o.value))}>{folderRows(taxonomy).map(c=><option key={c.id} value={c.id}>{c.path}</option>)}</select></label>
    <div className="row-actions"><input aria-label="新分类" value={category} onChange={e=>setCategory(e.target.value)} placeholder="新建分类"/><button type="button" className="btn" disabled={busy||!category.trim()} onClick={()=>void create()}>新建分类</button></div>
    <label>标签（逗号分隔）<input aria-label="论文标签" value={tags} onChange={e=>setTags(e.target.value)}/></label>
    <label>一句话速记<input aria-label="一句话速记" maxLength={300} placeholder="用一句话记住这篇论文的贡献或用途" value={fields.short_note} onChange={e=>setFields(f=>({...f,short_note:e.target.value}))}/></label>
    <label>摘要<textarea aria-label="论文摘要" value={fields.abstract} onChange={e=>setFields(f=>({...f,abstract:e.target.value}))} rows={3}/></label>
    <label>笔记<textarea aria-label="论文笔记" value={fields.notes} onChange={e=>setFields(f=>({...f,notes:e.target.value}))} rows={6}/></label>
    {error&&<p role="alert">{error}</p>}
    <div className="modal-actions"><button type="button" className="btn" disabled={busy} onClick={onClose}>取消</button><button className="btn primary" type="submit" disabled={busy}>{busy?'保存中…':'保存资料'}</button></div>
  </form></div>;
}
