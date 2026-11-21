const fs=require('node:fs/promises');
const path=require('node:path');
const {CodexClient,validateAuthUrl}=require('./codex-client.cjs');
function createAiService({directory,call,openExternal,emit,client,codexBinary}){
  const file=path.join(directory,'ai-settings.json');
  const codex=client||new CodexClient({binary:codexBinary,home:path.join(directory,'codex-home'),cwd:path.join(directory,'codex-chat')});
  let settings={provider:'api',model:'',chat_model:''},loginId=null,busy=false,current=null,settingsError=null;
  let deltaTimer=null,lastDelta=null;
  // The library keeps the chat-only model too: quick explain, digest and the
  // LAN tablet bridge call `explain`/`ai_digest` without going through this
  // service, so the sidecar is the single source of truth for all transports.
  // Best-effort on purpose: an older sidecar without the RPC must never make
  // saving or loading settings fail.
  const syncChatModel=async()=>{try{await call('set_chat_model',{model:settings.chat_model||''},5000);}catch{/* older sidecar or a timeout */}};
  const flushDelta=()=>{clearTimeout(deltaTimer);deltaTimer=null;if(lastDelta){emit({event:'ai_delta',...lastDelta});lastDelta=null;}};
  codex.on('delta',p=>{lastDelta=p;if(!deltaTimer)deltaTimer=setTimeout(flushDelta,50);});
  codex.on('status',p=>emit({event:'ai_status',...p}));
  codex.on('account',p=>{
    if(p.method==='account/login/completed'){
      loginId=null;emit({event:'ai_status',error:p.success?null:(p.error||'登录未完成')});
    }else if(p.method==='account/updated'||p.method==='account/rateLimits/updated')emit({event:'ai_status'});
  });
  const service={
    async load(){try{const v=JSON.parse(await fs.readFile(file,'utf8'));if(!['api','codex'].includes(v.provider)||typeof v.model!=='string'||(v.chat_model!==undefined&&typeof v.chat_model!=='string'))throw new Error('Invalid AI settings');settings={provider:v.provider,model:v.model,chat_model:v.chat_model||''};}catch(e){if(e.code!=='ENOENT'){settingsError='AI 设置无法读取，请重新保存问答服务设置';}}
      // `load()` runs after the sidecar is ready (main.cjs awaits startSidecar
      // first), so the persisted model is mirrored before the first RPC call.
      // An unreadable file is not a valid preference: keep the library value
      // instead of silently clearing it until the user saves again.
      if(!settingsError)await syncChatModel();},
    preferences:()=>({...settings}),
    isBusy:()=>busy,
    async status(){
      let account=null,models=[],limits=null,error=null;
      try{account=await codex.account();if(account){models=await codex.models();try{limits=(await codex.request('account/rateLimits/read')).rateLimits;}catch{/* Limits may be unavailable for this account. */}}}catch(e){error=e.message;}
      return {...settings,account,models,limits,error:settingsError||error,loginPending:!!loginId,busy};
    },
    async configure(p){
      if(busy||loginId)throw new Error('请先完成或停止当前对话/登录');
      if(!['api','codex'].includes(p?.provider)||typeof p.model!=='string'||p.model.length>200)throw new Error('无效的 AI 设置');
      if(p.chat_model!==undefined&&(typeof p.chat_model!=='string'||p.chat_model.length>200))throw new Error('无效的问答模型');
      const next={provider:p.provider,model:p.model,chat_model:typeof p.chat_model==='string'?p.chat_model.trim():settings.chat_model};
      await fs.mkdir(directory,{recursive:true});await fs.writeFile(file+'.tmp',JSON.stringify(next),{mode:0o600});await fs.rename(file+'.tmp',file);settings=next;settingsError=null;
      // Mirror the saved chat model into the library; failure is not fatal (an
      // older sidecar simply keeps the request-level `model` override path).
      await syncChatModel();
      return {...settings};
    },
    async login(){
      if(busy)throw new Error('请先停止当前对话');
      if(loginId)await service.cancelLogin();
      const r=await codex.login();loginId=r.loginId;
      try{await openExternal(validateAuthUrl(r.authUrl));}catch(e){await service.cancelLogin();throw e;}
      return {pending:!!loginId};
    },
    async cancelLogin(){if(loginId){await codex.request('account/login/cancel',{loginId});loginId=null;}return {};},
    async logout(){if(busy)throw new Error('请先停止当前对话');await service.cancelLogin();await codex.start();await codex.request('account/logout');return {};},
    async preview(p){
      const context=await call('ai_prepare',p);
      const version=context.context_info?.version_id||p.version_id;
      // The history switch applies to both providers: the API side (`explain`)
      // reads the same six exchanges, so the preview must not claim "0 轮" and
      // then send six anyway.
      const previous=p.include_history!==false&&p.kind!=='translate'?await call('ai_history',{paper_id:p.paper_id}):[];
      const messages=previous.filter(m=>m.kind!=='translate'&&version&&m.sources?.some(s=>s.version_id===version)).slice(0,6).reverse();
      const history=messages.map(m=>`用户：${m.question.slice(0,4000)}\n助手：${m.answer.slice(0,4000)}`).join('\n');
      return {...context,history,history_count:messages.length};
    },
    async run(p){
      if(settingsError)throw new Error(settingsError);
      if(settings.provider!=='codex'){
        if(p.kind==='translate'){const r=await call('translate_text',{text:p.question},300000);return {answer:r.text,sources:[]};}
        // Optional chat-only model (e.g. a stronger reasoning model while
        // translation stays on a cheap fast model).
        const request=settings.chat_model?{...p,model:settings.chat_model}:p;
        // Older callers omit request_id; keep the plain buffered path for them and
        // only take over the busy lock when this turn can actually be streamed.
        if(!p||typeof p.paper_id!=='string'||typeof p.request_id!=='string'||!/^[a-zA-Z0-9-]{1,80}$/.test(p.request_id))return call('explain',request,300000);
        if(busy)throw new Error('已有对话正在生成，请先停止');
        // The sidecar streams ai_delta events for this request_id while it waits
        // for the answer; stopping flips the same flag it polls between chunks.
        busy=true;current={id:p.request_id,provider:'api',cancelled:false};
        try{
          const result=await call('explain',request,300000);
          if(current.cancelled)throw new Error('已停止生成');
          return result;
        }finally{flushDelta();busy=false;current=null;}
      }
      if(!p||typeof p.paper_id!=='string'||typeof p.question!=='string'||typeof p.request_id!=='string'||!/^[a-zA-Z0-9-]{1,80}$/.test(p.request_id))throw new Error('无效的对话请求');
      // The Codex CLI protocol path is text-only; a cropped figure/table can
      // only go through the OpenAI-compatible API provider (Vision).
      if(typeof p.image_data_url==='string'&&p.image_data_url)throw new Error('Codex 问答暂不支持框选图片解读，请在「设置 → AI 问答服务」切换到 API 服务后重试');
      if(busy)throw new Error('已有对话正在生成，请先停止');
      busy=true;current={id:p.request_id,provider:'codex',cancelled:false};
      try{
        const context=await service.preview(p);
        const history=context.history;
        if(current.cancelled)throw new Error('已停止生成');
        const result=await codex.run(context.prompt,{requestId:p.request_id,model:settings.model,history});
        if(current.cancelled)throw new Error('已停止生成');
        // `ephemeral` (reader quick bubble) must not append to the chats history
        // even though Codex has no other persistence path to skip.
        if(p.ephemeral!==true)await call('ai_save',{...p,answer:result.answer,sources:context.sources,model:`codex:${result.model}`});
        const invalid=[...result.answer.matchAll(/\[(\d+)\]/g)].some(m=>Number(m[1])<1||Number(m[1])>context.sources.length);
        const warnings=[...(context.warnings||[])];
        if(p.kind!=='translate'&&invalid)warnings.push('回答含无法对应当前原文片段的引用，请核对原文');
        if(context.truncated)warnings.push('原文超过上下文上限，仅使用了部分片段');
        return {answer:result.answer,sources:context.sources,warnings,context_info:{...context.context_info,history_count:context.history_count}};
      }finally{flushDelta();busy=false;current=null;}
    },
    cancel:p=>{
      if(!current||current.id!==p?.request_id)return codex.cancel(p?.request_id);
      current.cancelled=true;
      if(current.provider==='codex')return codex.cancel(p?.request_id);
      return call('ai_cancel',{request_id:p.request_id},5000).catch(()=>undefined);
    },
    stop:()=>{clearTimeout(deltaTimer);lastDelta=null;codex.stop();},
  };
  return service;
}
module.exports={createAiService};
