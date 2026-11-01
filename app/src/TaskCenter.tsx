import {useEffect,useState} from 'react';
import {api} from './api';
import type {LibraryJob} from './types';
const labels:Record<string,string>={queued:'排队中',parsing:'解析中',translating:'翻译中',typesetting:'排版中',validating:'校验中',cancelling:'正在停止',cancelled:'已停止',completed:'已完成',failed:'失败'};
export default function TaskCenter({onClose,onOpen}:{onClose:()=>void;onOpen:(id:string)=>void}){
  const [jobs,setJobs]=useState<LibraryJob[]>([]),[error,setError]=useState(''),[busy,setBusy]=useState(false);
  const refresh=()=>api.listJobs().then(setJobs).catch(e=>setError(e.message));
  useEffect(()=>{void refresh();const timer=setInterval(refresh,2000);const off=api.onEvent(msg=>{if(msg.event==='job')void refresh();});return()=>{clearInterval(timer);off();};},[]);
  const act=async(job:LibraryJob,retry:boolean)=>{setBusy(true);setError('');try{if(retry)await api.startTranslate(job.paper_id,job.pages||undefined);else await api.cancelJob(job.id);await refresh();}catch(e){setError((e as Error).message);}finally{setBusy(false);}};
  return <div className="modal-backdrop"><section className="modal"><h2>任务中心</h2><p className="muted small">最近 100 条翻译任务。异常退出的任务会标记失败，可在此重试。</p>
    {error&&<p role="alert">{error}</p>}{!jobs.length&&<p>暂无翻译任务</p>}
    {jobs.map(j=><div className="task-row" key={j.id}><b>{labels[j.status]||j.status}</b><span className="small">{new Date(j.created_at).toLocaleString()} {j.pages?`页码 ${j.pages}`:'全文'}</span>{j.error&&<p role="status">{j.error}</p>}<div className="row-actions"><button className="btn tiny" onClick={()=>onOpen(j.paper_id)}>打开论文</button>{['failed','cancelled'].includes(j.status)?<button className="btn tiny" disabled={busy} onClick={()=>void act(j,true)}>重试</button>:j.status!=='completed'&&<button className="btn tiny" disabled={busy||j.status==='cancelling'} onClick={()=>void act(j,false)}>停止任务</button>}</div></div>)}
    <div className="modal-actions"><button className="btn" onClick={onClose}>关闭任务中心</button></div>
  </section></div>;
}
