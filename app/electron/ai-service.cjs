const fs=require('node:fs/promises');
const path=require('node:path');
const {CodexClient,validateAuthUrl}=require('./codex-client.cjs');
function createAiService({directory,call,openExternal,emit,client,codexBinary}){
  const file=path.join(directory,'ai-settings.json');
  const codex=client||new CodexClient({binary:codexBinary,home:path.join(directory,'codex-home'),cwd:path.join(directory,'codex-chat')});
  let settings={provider:'api',model:''},loginId=null,busy=false,current=null,settingsError=null;
  let deltaTimer=null,lastDelta=null;
  const flushDelta=()=>{clearTimeout(deltaTimer);deltaTimer=null;if(lastDelta){emit({event:'ai_delta',...lastDelta});lastDelta=null;}};
  codex.on('delta',p=>{lastDelta=p;if(!deltaTimer)deltaTimer=setTimeout(flushDelta,50);});
  codex.on('status',p=>emit({event:'ai_status',...p}));
  codex.on('account',p=>{
    if(p.method==='account/login/completed'){
      loginId=null;emit({event:'ai_status',error:p.success?null:(p.error||'登录未完成')});
    }else if(p.method==='account/updated'||p.method==='account/rateLimits/updated')emit({event:'ai_status'});
  });
  const service={
    async load(){try{const v=JSON.parse(await fs.readFile(file,'utf8'));if(!['api','codex'].includes(v.provider)||typeof v.model!=='string')throw new Error('Invalid AI settings');settings={provider:v.provider,model:v.model};}catch(e){if(e.code!=='ENOENT'){settingsError='AI 设置无法读取，请重新保存问答服务设置';}}},
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
      const next={provider:p.provider,model:p.model};
      await fs.mkdir(directory,{recursive:true});await fs.writeFile(file+'.tmp',JSON.stringify(next),{mode:0o600});await fs.rename(file+'.tmp',file);settings=next;settingsError=null;
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
      const previous=settings.provider==='codex'&&p.include_history!==false&&p.kind!=='translate'?await call('ai_history',{paper_id:p.paper_id}):[];
      const messages=previous.filter(m=>m.kind!=='translate'&&version&&m.sources?.some(s=>s.version_id===version)).slice(0,6).reverse();
      const history=messages.map(m=>`用户：${m.question.slice(0,2000)}\n助手：${m.answer.slice(0,4000)}`).join('\n');
      return {...context,history,history_count:messages.length};
    },
    async run(p){
      if(settingsError)throw new Error(settingsError);
      if(settings.provider!=='codex'){if(p.kind==='translate'){const r=await call('translate_text',{text:p.question},300000);return {answer:r.text,sources:[]};}return call('explain',p,300000);}
      if(busy)throw new Error('已有对话正在生成，请先停止');
      if(!p||typeof p.paper_id!=='string'||typeof p.question!=='string'||typeof p.request_id!=='string'||!/^[a-zA-Z0-9-]{1,80}$/.test(p.request_id))throw new Error('无效的对话请求');
      busy=true;current={id:p.request_id,cancelled:false};
      try{
        const context=await service.preview(p);
        const history=context.history;
        if(current.cancelled)throw new Error('已停止生成');
        const result=await codex.run(context.prompt,{requestId:p.request_id,model:settings.model,history});
        if(current.cancelled)throw new Error('已停止生成');
        await call('ai_save',{...p,answer:result.answer,sources:context.sources,model:`codex:${result.model}`});
        const invalid=[...result.answer.matchAll(/\[(\d+)\]/g)].some(m=>Number(m[1])<1||Number(m[1])>context.sources.length);
        const warnings=[...(context.warnings||[])];
        if(p.kind!=='translate'&&invalid)warnings.push('回答含无法对应当前原文片段的引用，请核对原文');
        if(context.truncated)warnings.push('原文超过上下文上限，仅使用了部分片段');
        return {answer:result.answer,sources:context.sources,warnings,context_info:{...context.context_info,history_count:context.history_count}};
      }finally{flushDelta();busy=false;current=null;}
    },
    cancel:p=>{if(current?.id===p?.request_id)current.cancelled=true;return codex.cancel(p?.request_id);},
    stop:()=>{clearTimeout(deltaTimer);lastDelta=null;codex.stop();},
  };
  return service;
}
module.exports={createAiService};
