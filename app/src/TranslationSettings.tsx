import {useEffect,useState} from 'react';
import {api,type TranslationSettings as Settings} from './api';
export default function TranslationSettings(){
  const [settings,setSettings]=useState<Settings|null>(null),[key,setKey]=useState(''),[busy,setBusy]=useState(false),[error,setError]=useState('');
  useEffect(()=>{void api.translationAction('status').then(v=>setSettings(v as Settings)).catch(e=>setError(e.message));},[]);
  const change=(field:string,value:string|number)=>setSettings(s=>s?{...s,[field]:value}:s);
  const save=async()=>{setBusy(true);setError('');try{setSettings(await api.translationAction('save',{...settings,api_key:key}) as Settings);setKey('');}catch(e){setError((e as Error).message);}finally{setBusy(false);}};
  return <section className="ai-settings translation-settings"><h3>翻译 API 与 PDF 引擎</h3>
    <p className="small muted">支持 OpenAI 兼容的 Chat Completions 接口，用于选区翻译和 API 问答。整篇 PDF 原位翻译另外需要 BabelDOC。</p>
    {settings&&<><label>API Base URL<input aria-label="翻译 API 地址" type="url" placeholder="https://你的服务地址/v1" value={settings.base_url} onChange={e=>change('base_url',e.target.value)}/></label>
      <label>API Key<input aria-label="翻译 API Key" type="password" autoComplete="off" value={key} placeholder={settings.key_configured?'已配置；留空保留当前 Key':'请输入 API Key'} onChange={e=>setKey(e.target.value)}/></label>
      <label>模型 ID<input aria-label="翻译模型 ID" placeholder="填写服务提供的准确模型 ID" value={settings.model} onChange={e=>change('model',e.target.value)}/></label>
      <label>翻译 QPS<input aria-label="翻译 QPS" type="number" min="1" max="20" value={settings.qps} onChange={e=>change('qps',Number(e.target.value))}/></label>
      <label>BabelDOC 可执行文件（可选）<input aria-label="BabelDOC 路径" value={settings.babeldoc} placeholder="留空则从系统 PATH 查找 babeldoc" onChange={e=>change('babeldoc',e.target.value)}/></label>
      <div className="actions"><button className="btn" disabled={busy} onClick={()=>void api.translationAction('pickBabeldoc').then(p=>{if(p)change('babeldoc',String(p));}).catch(e=>setError(e.message))}>选择 BabelDOC</button>
      <button className="btn primary" disabled={busy} onClick={()=>void save()}>保存翻译配置</button>
      {settings.pending_restart&&<button className="btn" disabled={busy} onClick={()=>void api.translationAction('restart').catch(e=>setError(e.message))}>重启并应用配置</button>}</div>
      {settings.pending_restart&&<p role="status">配置已保存，重启软件后生效；请先完成正在进行的导入和任务。</p>}
      <p className="small muted">Key 由系统凭据存储加密，保存在本机应用设置中，不随论文库同步。OCR 在本机进行，无需 API Key。</p>
    </>}{(error||settings?.error)&&<p role="alert">{error||settings?.error}</p>}
  </section>;
}
