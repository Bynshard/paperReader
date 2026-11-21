const {test}=require('node:test');
const {spawn}=require('node:child_process');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {once}=require('node:events');
const {CodexClient,validateAuthUrl}=require('../electron/codex-client.cjs');
const {createAiService}=require('../electron/ai-service.cjs');
function fixture(t){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'moonlight-codex-test-'));
 const fixtureFile=path.join(__dirname,'fixtures/codex-server.cjs');
 const client=new CodexClient({home:path.join(dir,'home'),cwd:path.join(dir,'chat'),binary:fixtureFile,timeout:5000,
   spawnProcess:(_binary,args,options)=>spawn(process.execPath,[fixtureFile,...args],options)});
 t.after(async()=>{const child=client.child;const closed=child&&child.exitCode===null?once(child,'close'):Promise.resolve();client.stop();await closed;fs.rmSync(dir,{recursive:true,force:true});});
 return {dir,client};
}
async function login(client){const event=once(client,'account');await client.login();await event;}
test('official browser login, live model/limits, streaming notification races, logout',async t=>{
 const {client}=fixture(t);assert.equal(await client.account(),null);
 await login(client);assert.equal((await client.account()).plan,'plus');
 assert.equal((await client.models())[0].id,'fixture-model');
 const deltas=[];client.on('delta',e=>deltas.push(e.answer));
 const r=await client.run('总结原文',{requestId:'r-1'});
 assert.equal(r.answer,'中文回答 [1]');assert.deepEqual(deltas,['中文','中文回答 [1]']);
 await client.request('account/logout');assert.equal(await client.account(),null);
});
test('signed-out calls never start an inference',async t=>{const {client}=fixture(t);await assert.rejects(client.run('hello',{requestId:'x'}),/先.*登录/);assert.equal(client.active,null);});
test('cancel interrupts the real protocol turn and releases active lock',async t=>{
 const {client}=fixture(t);await login(client);
 const run=client.run('WAIT',{requestId:'cancel-me'});const assertion=assert.rejects(run,/已停止/);
 while(!client.active?.turnId)await new Promise(r=>setTimeout(r,5));
 await assert.rejects(client.run('other',{requestId:'other'}),/已有/);
 await client.cancel('cancel-me');await assertion;assert.equal(client.active,null);
 assert.equal((await client.run('ok',{requestId:'after'})).answer,'中文回答 [1]');
});
test('process crash rejects pending turn and can restart',async t=>{const {client}=fixture(t);await login(client);await assert.rejects(client.run('CRASH',{requestId:'crash'}),/退出/);assert.equal(await client.account(),null);});
test('only exact official HTTPS auth origins can open',()=>{assert.match(validateAuthUrl('https://auth.openai.com/authorize?state=x'),/^https:/);for(const s of ['http://auth.openai.com','https://auth.openai.com.evil.test','file:///tmp/a','https://u:p@chatgpt.com','https://chatgpt.com:444/auth'])assert.throws(()=>validateAuthUrl(s));});
test('service persists settings/history, never saves cancelled output, isolates per-paper context',async t=>{
 const {dir,client}=fixture(t),rows=[],calls=[],urls=[];
 const call=async(method,p)=>{calls.push(method);if(method==='ai_prepare')return {prompt:p.question,sources:[{version_id:'v',n:1}]};if(method==='ai_history')return rows;if(method==='ai_save'){rows.unshift({...p,id:'saved'});return {};}throw new Error(method);};
 const options={directory:dir,client,call,openExternal:u=>urls.push(u),emit:()=>{}};
 const svc=createAiService(options);await svc.load();const logged=once(client,'account');await svc.login();await logged;
 await svc.configure({provider:'codex',model:'fixture-model'});
 const r=await svc.run({paper_id:'p',version_id:'v',question:'hello',kind:'ask',request_id:'one'});
 assert.equal(r.answer,'中文回答 [1]');assert.equal(rows.length,1);assert.deepEqual(calls.filter(m=>m!=='set_chat_model'),['ai_prepare','ai_history','ai_save']);assert.ok(calls.filter(m=>m==='set_chat_model').length>=2,'load/configure mirror chat_model into the library');assert.equal(urls.length,1);
 const again=createAiService(options);await again.load();assert.equal((await again.status()).provider,'codex');
 const run=svc.run({paper_id:'p',question:'WAIT',kind:'ask',request_id:'two'});const rejected=assert.rejects(run,/停止/);
 while(!client.active?.turnId)await new Promise(r=>setTimeout(r,5));await svc.cancel({request_id:'two'});await rejected;assert.equal(rows.length,1);
 assert.doesNotMatch(fs.readFileSync(path.join(dir,'ai-settings.json'),'utf8'),/token|email|authUrl/);
});
test('API selection preserves existing translation response shape',async t=>{const {dir,client}=fixture(t);const svc=createAiService({directory:dir,client,call:async()=>({text:'译文'}),openExternal:()=>{},emit:()=>{}});assert.deepEqual(await svc.run({kind:'translate',question:'a'}),{answer:'译文',sources:[]});});

test('API provider can use a separate chat model and persists it without changing translation',async t=>{
 const {dir,client}=fixture(t);const calls=[];
 const call=async(method,p)=>{calls.push([method,p]);return {answer:'a',sources:[]};};
 const svc=createAiService({directory:dir,client,emit:()=>{},openExternal:()=>{},call});
 await svc.load();
 await svc.configure({provider:'api',model:'',chat_model:'reasoner'});
 assert.equal(svc.preferences().chat_model,'reasoner');
 await svc.run({paper_id:'p',question:'q',kind:'ask',request_id:'r-1'});
 assert.equal(calls.at(-1)[0],'explain');
 assert.equal(calls.at(-1)[1].model,'reasoner');
 const again=createAiService({directory:dir,client,emit:()=>{},openExternal:()=>{},call});
 await again.load();
 assert.equal(again.preferences().chat_model,'reasoner');
 await again.configure({provider:'api',model:'',chat_model:''});
 await again.run({paper_id:'p',question:'q',kind:'ask',request_id:'r-2'});
 assert.equal(calls.at(-1)[1].model,undefined,'empty override keeps the translation model');
});

test('context preview honours the history switch for the API provider too',async t=>{
 const {dir,client}=fixture(t);let historyReads=0;
 const svc=createAiService({directory:dir,client,emit:()=>{},openExternal:()=>{},call:async(method)=>{
   if(method==='ai_prepare')return {prompt:'local evidence',sources:[{version_id:'v'}],context_info:{version_id:'v'}};
   if(method==='ai_history'){historyReads++;return [{question:'current',answer:'current answer',kind:'ask',sources:[{version_id:'v'}]}];}
   throw new Error(method);
 }});
 await svc.configure({provider:'api',model:''});
 const on=await svc.preview({paper_id:'p',kind:'ask'});
 assert.equal(on.history_count,1,'API mode sends the same six exchanges as Codex');
 assert.match(on.history,/current/);
 const off=await svc.preview({paper_id:'p',kind:'ask',include_history:false});
 assert.equal(off.history_count,0);
 assert.equal(historyReads,1,'disabled history must not even read ai_history');
});

test('unreadable settings block inference until explicitly repaired, preferences do not start Codex',async t=>{
 const {dir,client}=fixture(t);fs.writeFileSync(path.join(dir,'ai-settings.json'),'{bad');
 let calls=0;const svc=createAiService({directory:dir,client,call:async()=>{calls++;return {};},openExternal:()=>{},emit:()=>{}});
 await svc.load();assert.equal(svc.preferences().provider,'api');assert.equal(client.child,null);
 assert.equal(calls,0,'an unreadable settings file must not clobber the library chat_model');
 await assert.rejects(svc.run({kind:'ask'}),/设置无法读取/);assert.equal(calls,0,'a blocked turn must not reach the sidecar');
 await svc.configure({provider:'api',model:''});await svc.run({kind:'ask'});assert.equal(calls,2,'configure mirrors chat_model, then the turn calls explain');
});

test('context preview includes only current-version history and supports explicitly disabling history without model calls',async t=>{
 const {dir,client}=fixture(t);let historyReads=0;
 const svc=createAiService({directory:dir,client,emit:()=>{},openExternal:()=>{},call:async(method)=>{
   if(method==='ai_prepare')return {prompt:'local evidence',sources:[{version_id:'v'}],context_info:{version_id:'v'}};
   if(method==='ai_history'){historyReads++;return [{question:'current',answer:'current answer',sources:[{version_id:'v'}]},{question:'other',answer:'other answer',sources:[{version_id:'other'}]}];}
   throw new Error(method);
 }});
 await svc.configure({provider:'codex',model:''});
 const preview=await svc.preview({paper_id:'p',kind:'ask'});assert.equal(preview.history_count,1);assert.match(preview.history,/current/);assert.doesNotMatch(preview.history,/other/);assert.equal(client.child,null);
 const disabled=await svc.preview({paper_id:'p',kind:'ask',include_history:false});assert.equal(disabled.history_count,0);assert.equal(historyReads,1);assert.equal(client.child,null);
});

test('load and configure mirror chat_model into the sidecar so quick explain/digest/LAN share it',async t=>{
 const {dir,client}=fixture(t);const calls=[];
 const call=async(method,p)=>{calls.push([method,p]);return {};};
 const svc=createAiService({directory:dir,client,call,openExternal:()=>{},emit:()=>{}});
 const mirrors=()=>calls.filter(([method])=>method==='set_chat_model');
 await svc.load();
 assert.deepEqual(mirrors().at(-1),[ 'set_chat_model',{model:''} ],'load mirrors the on-disk (default) setting');
 await svc.configure({provider:'api',model:'',chat_model:'reasoner'});
 assert.deepEqual(mirrors().at(-1)[1],{model:'reasoner'},'saving the chat model persists it in the library');
 await svc.configure({provider:'api',model:''});
 assert.deepEqual(mirrors().at(-1)[1],{model:'reasoner'},'omitting chat_model keeps the saved one');
 const persisted=createAiService({directory:dir,client,call,openExternal:()=>{},emit:()=>{}});
 await persisted.load();
 assert.deepEqual(calls.filter(([method])=>method==='set_chat_model').at(-1)[1],{model:'reasoner'},'a restart re-syncs the saved model');
});

test('settings still save and load when the sidecar does not know set_chat_model',async t=>{
 const {dir,client}=fixture(t);
 const stale=async()=>{throw new Error('unknown method set_chat_model');};
 const svc=createAiService({directory:dir,client,call:stale,openExternal:()=>{},emit:()=>{}});
 await svc.load();
 assert.deepEqual(await svc.configure({provider:'api',model:'m',chat_model:'c'}),{provider:'api',model:'m',chat_model:'c'});
 const again=createAiService({directory:dir,client,call:stale,openExternal:()=>{},emit:()=>{}});
 await again.load();
 assert.equal(again.preferences().chat_model,'c','an old sidecar must not break loading either');
});

test('codex quick bubble (ephemeral) answers without writing chat history',async t=>{
 const {dir,client}=fixture(t),saves=[];
 const call=async(method,p)=>{if(method==='ai_prepare')return {prompt:p.question,sources:[{version_id:'v'}]};if(method==='ai_history')return [];if(method==='ai_save'){saves.push(p);return {};}if(method==='set_chat_model')return {ok:true};throw new Error(method);};
 const svc=createAiService({directory:dir,client,call,openExternal:()=>{},emit:()=>{}});
 await svc.load();const logged=once(client,'account');await svc.login();await logged;
 await svc.configure({provider:'codex',model:'fixture-model'});
 const r=await svc.run({paper_id:'p',version_id:'v',question:'hello',kind:'ask',request_id:'e-1',ephemeral:true});
 assert.equal(r.answer,'中文回答 [1]');
 assert.equal(saves.length,0,'ephemeral codex turns must skip ai_save');
 assert.ok(Array.isArray(r.warnings));
 await svc.run({paper_id:'p',version_id:'v',question:'again',kind:'ask',request_id:'e-2'});
 assert.equal(saves.length,1,'a normal codex turn still writes history');
});

test('codex provider rejects image crops with an actionable Chinese error',async t=>{
 const {dir,client}=fixture(t);let called=0;
 const svc=createAiService({directory:dir,client,call:async()=>{called++;return {};},openExternal:()=>{},emit:()=>{}});
 await svc.load();
 await svc.configure({provider:'codex',model:'fixture-model'});
 await assert.rejects(svc.run({paper_id:'p',question:'看看这张图',kind:'ask',request_id:'img-1',image_data_url:'data:image/png;base64,AAAA'}),/API 服务/);
 assert.equal(client.child,null,'rejecting an image must not spawn the Codex CLI');
 assert.equal(called,2,'only the two settings mirrors reach the sidecar');
});
