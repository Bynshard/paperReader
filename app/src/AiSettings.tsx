import {useEffect,useState} from 'react';
import {api,type AiStatus} from './api';
export default function AiSettings(){
  const [state,setState]=useState<AiStatus|null>(null),[error,setError]=useState(''),[busy,setBusy]=useState(false);
  const refresh=()=>api.aiStatus().then(setState).catch(e=>setError(e.message));
  useEffect(()=>{void refresh();return api.onEvent(msg=>{if((msg.event as string)==='ai_status'){if('error'in msg&&msg.error)setError(String(msg.error));void refresh();}});},[]);
  const action=async(name:string,input?:unknown)=>{setBusy(true);setError('');try{await api.aiAction(name,input);await refresh();}catch(e){setError((e as Error).message);}finally{setBusy(false);}};
  const limits=[state?.limits?.primary,state?.limits?.secondary].filter(Boolean);
  return <section className="ai-settings"><h3>AI 对话 · Codex</h3>
    <p className="small muted">通过官方 Codex 登录使用账号对应的额度。提问时会发送相关原文和最近 6 轮对话；额度与模型权限由账号决定。整篇 PDF 翻译仍需单独配置翻译引擎。</p>
    <label>问答服务 <select aria-label="问答服务" disabled={busy||!state} value={state?.provider||'api'} onChange={e=>void action('configure',{provider:e.target.value,model:state?.model||''})}>
      <option value="api">现有 API 服务</option><option value="codex">Codex 账号额度</option></select></label>
    <p>{state?.account?`已登录：${state.account.email} · ${state.account.plan||'ChatGPT'}`:'尚未登录 Codex'}</p>
    <div className="actions"><button className="btn" disabled={busy||state?.loginPending} onClick={()=>void action('login')}>通过浏览器登录 Codex</button>
      {state?.loginPending&&<button className="btn" disabled={busy} onClick={()=>void action('cancelLogin')}>取消登录</button>}
      {state?.account&&<button className="btn" disabled={busy} onClick={()=>void action('logout')}>退出本软件登录</button>}
      <button className="btn" disabled={busy} onClick={()=>void refresh()}>刷新状态</button></div>
    {state?.loginPending&&<p role="status">等待你在浏览器完成认证…</p>}
    {state?.account&&<label>对话模型 <select aria-label="Codex 模型" value={state.model} disabled={busy} onChange={e=>void action('configure',{provider:state.provider,model:e.target.value})}>
      <option value="">Codex 默认模型</option>{state.models.map(m=><option key={m.id} value={m.id}>{m.name}</option>)}
    </select></label>}
    {limits.map((l,i)=><p className="small" key={i}>额度窗口 {l!.windowDurationMins} 分钟：已用 {l!.usedPercent}% · 重置时间 {new Date(l!.resetsAt*1000).toLocaleString()}</p>)}
    {state?.account&&limits.length===0&&<p className="small muted">服务未返回额度信息，可尝试刷新。</p>}
    <p className="small muted">登录仅用于本软件，退出不会影响 Codex 桌面端。凭据由官方 CLI 管理，不随论文库同步。</p>
    {(error||state?.error)&&<p role="alert">{error||state?.error}</p>}
  </section>;
}
