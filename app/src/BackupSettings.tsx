import {useState} from 'react';
import {api} from './api';
export default function BackupSettings(){const [busy,setBusy]=useState(false),[message,setMessage]=useState(''),[error,setError]=useState('');
  const run=async(action:'create'|'restore')=>{setBusy(true);setError('');try{const result=await api.backup(action);if(!result.cancelled)setMessage(action==='create'?`备份已创建并附带校验清单：${result.path}`:`已恢复到新库：${result.path}。即将重新启动。`);}catch(e){setError((e as Error).message);}finally{setBusy(false);}};
  return <section className="ai-settings"><h3>备份与恢复</h3><p className="small muted">备份数据库、原文、译文和附件，并校验文件。恢复到新目录后重启，保留原论文库。登录与云同步密码不进入备份。</p><div className="row-actions"><button className="btn" disabled={busy} onClick={()=>void run('create')}>创建完整备份</button><button className="btn" disabled={busy} onClick={()=>void run('restore')}>恢复到新库并重启</button></div>{busy&&<p role="status">正在处理文件，请稍候…</p>}{message&&<p role="status">{message}</p>}{error&&<p role="alert">{error}</p>}</section>;
}
