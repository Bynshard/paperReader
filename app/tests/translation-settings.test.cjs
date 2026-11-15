const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const os=require('node:os');
const path=require('node:path');
const {createTranslationSettings,TRANSLATION_SETTINGS_ACTIONS}=require('../electron/translation-settings.cjs');
const safeStorage={getSelectedStorageBackend:()=> 'gnome_libsecret',isEncryptionAvailable:()=>true,encryptString:s=>Buffer.from('encrypted:'+Buffer.from(s).toString('base64')),decryptString:b=>Buffer.from(b.toString().slice(10),'base64').toString()};
const config={base_url:'https://provider.example/v1',model:'academic-test',api_key:'fixture-secret-value',babeldoc:'',qps:2};
async function fixture(run){const directory=await fs.mkdtemp(path.join(os.tmpdir(),'translation-settings-'));try{await run(path.join(directory,'settings.json'),directory);}finally{await fs.rm(directory,{recursive:true,force:true});}}
function recorder(handler={}){
  const calls=[];
  return {calls,call:async(method,params,timeout)=>{
    calls.push({method,params,timeout});
    const reply=handler[method];
    if(typeof reply==='function')return reply(params);
    if(reply===undefined)return method==='reload_gateway'?{ok:true,model:params.model}:{ok:true};
    return reply;
  }};
}

test('encrypted configuration round-trips into the sidecar environment without returning a key',()=>fixture(async file=>{
 const {call,calls}=recorder();
 const store=createTranslationSettings({file,safeStorage,env:{},call});await store.load();
 assert.equal(store.summary().key_configured,false);
 const saved=await store.save(config);
 assert.equal(saved.pending_restart,false);
 assert.equal(saved.error,'');
 assert.equal(saved.api_key,undefined);
 assert.deepEqual(calls.map(entry=>entry.method),['reload_gateway']);
 assert.deepEqual(calls[0].params,{base_url:config.base_url,model:config.model,api_key:config.api_key,qps:config.qps,babeldoc:''});
 assert(!(await fs.readFile(file,'utf8')).includes(config.api_key));
 const restored=createTranslationSettings({file,safeStorage,env:{}});await restored.load();
 assert.equal(restored.summary().pending_restart,false);assert.equal(restored.environment().MOONLIGHT_UPSTREAM_KEY,config.api_key);
 assert.equal(restored.environment().MOONLIGHT_MODEL,config.model);
}));

test('saved configuration hot-reloads the gateway without asking for a restart',()=>fixture(async file=>{
 const {call,calls}=recorder({reload_gateway:params=>({ok:true,model:params.model,base_url:params.base_url})});
 const store=createTranslationSettings({file,safeStorage,env:{},call});await store.load();
 const saved=await store.save(config);
 assert.equal(saved.pending_restart,false);
 assert.equal(saved.error,'');
 assert.equal(calls[0].method,'reload_gateway');
 assert.equal(calls[0].params.model,config.model);
 assert.equal(typeof calls[0].timeout,'number');
 // The sidecar contract stays hot: a later save reloads again.
 const second=await store.save({...config,model:'academic-test-v2'});
 assert.equal(second.pending_restart,false);
 assert.deepEqual(calls.map(entry=>entry.method),['reload_gateway','reload_gateway']);
 assert.equal(calls[1].params.model,'academic-test-v2');
}));

test('a failed hot reload keeps pending_restart and reports a readable reason',()=>fixture(async file=>{
 const {call}=recorder({reload_gateway:()=>{throw new Error('sidecar is not running');}});
 const store=createTranslationSettings({file,safeStorage,env:{},call});await store.load();
 const saved=await store.save(config);
 assert.equal(saved.pending_restart,true);
 assert.match(saved.error,/立即生效失败/);
 assert.match(saved.error,/sidecar is not running/);
 const rejected=recorder({reload_gateway:()=>({ok:false,error:'模型网关重建失败：API 地址必须是 http(s) 地址'})});
 const other=createTranslationSettings({file:file+'.other',safeStorage,env:{},call:rejected.call});
 const failed=await other.save(config);
 assert.equal(failed.pending_restart,true);
 assert.match(failed.error,/模型网关重建失败/);
 // The configuration itself is still persisted for the next restart.
 const restored=createTranslationSettings({file,safeStorage,env:{}});await restored.load();
 assert.equal(restored.environment().MOONLIGHT_MODEL,config.model);
}));

test('without a sidecar channel a save still requires a restart',()=>fixture(async file=>{
 const store=createTranslationSettings({file,safeStorage,env:{}});await store.load();
 const saved=await store.save(config);
 assert.equal(saved.pending_restart,true);
 assert.equal(saved.error,'');
 assert.equal(store.environment().MOONLIGHT_UPSTREAM_KEY,config.api_key);
}));

test('test action probes the connection with translation_probe',()=>fixture(async file=>{
 const {call,calls}=recorder({translation_probe:params=>({ok:true,latency_ms:37,model:params.model})});
 const store=createTranslationSettings({file,safeStorage,env:{},call});await store.save(config);calls.length=0;
 const result=await store.test({base_url:config.base_url,model:config.model,api_key:''});
 assert.equal(result.ok,true);
 assert.equal(result.latency_ms,37);
 assert.equal(result.model,config.model);
 assert.equal(calls[0].method,'translation_probe');
 assert.equal(calls[0].params.api_key,config.api_key,'留空 Key 时复用已保存的 Key');
 assert.equal(calls[0].params.base_url,config.base_url);
 // A typed (not yet saved) key and model are forwarded as-is.
 await store.test({base_url:'https://draft.example/v1',model:'draft-model',api_key:'draft-key'});
 assert.deepEqual(calls[1].params,{base_url:'https://draft.example/v1',model:'draft-model',api_key:'draft-key'});
 // Failure diagnostics are values, never throws.
 const failing=recorder({translation_probe:()=>({ok:false,error:'401 Key 无效'})});
 const probe=createTranslationSettings({file:file+'.probe',safeStorage,env:{},call:failing.call});
 assert.deepEqual(await probe.test({}),{ok:false,error:'401 Key 无效'});
 // Without a sidecar channel the action refuses instead of pretending success.
 const offline=createTranslationSettings({file:file+'.offline',safeStorage,env:{}});
 await assert.rejects(offline.test({}),/sidecar 未连接/);
}));

test('checkBabeldoc action forwards the selected executable path',()=>fixture(async(file,directory)=>{
 const binary=path.join(directory,'babeldoc');
 await fs.writeFile(binary,'#!/bin/sh\necho "babeldoc 0.6.0"\n',{mode:0o755});
 const {call,calls}=recorder({check_babeldoc:params=>({ok:true,path:params.path,version:'babeldoc 0.6.0'})});
 const store=createTranslationSettings({file,safeStorage,env:{},call});await store.load();
 await store.save({...config,babeldoc:binary});calls.length=0;
 const found=await store.checkBabeldoc({});
 assert.deepEqual(found,{ok:true,path:binary,version:'babeldoc 0.6.0'});
 assert.equal(calls[0].method,'check_babeldoc');
 assert.deepEqual(calls[0].params,{path:binary});
 // An explicit path wins over the saved one.
 await store.checkBabeldoc({path:'/opt/babeldoc/bin/babeldoc'});
 assert.deepEqual(calls[1].params,{path:'/opt/babeldoc/bin/babeldoc'});
 // Nothing configured: the sidecar decides from PATH/env.
 const bare=recorder({check_babeldoc:()=>({ok:true,path:'/usr/local/bin/babeldoc'})});
 const store2=createTranslationSettings({file:file+'.bare',safeStorage,env:{},call:bare.call});
 assert.deepEqual(await store2.checkBabeldoc({}),{ok:true,path:'/usr/local/bin/babeldoc'});
 assert.deepEqual(bare.calls[0].params,{});
}));

test('translation action whitelist covers diagnostics and rejects unknown actions',()=>fixture(async file=>{
 assert.deepEqual(TRANSLATION_SETTINGS_ACTIONS,['status','save','test','checkBabeldoc']);
 const {call}=recorder();
 const store=createTranslationSettings({file,safeStorage,env:{},call});
 assert.deepEqual(store.actions(),['status','save','test','checkBabeldoc']);
 assert.equal((await store.handle('status')).key_configured,false);
 await assert.rejects(store.handle('pickBabeldoc'),/未知翻译配置操作/);
 await assert.rejects(store.handle('restart'),/未知翻译配置操作/);
 await assert.rejects(store.handle('unknown'),/未知翻译配置操作/);
}));

test('empty key retains only the same endpoint; invalid addresses and rates are rejected',()=>fixture(async file=>{
 const {call}=recorder();
 const store=createTranslationSettings({file,safeStorage,env:{},call});await store.save(config);
 await store.save({...config,api_key:''});assert.equal(store.environment().MOONLIGHT_UPSTREAM_KEY,config.api_key);
 await assert.rejects(store.save({...config,base_url:'https://other.example/v1',api_key:''}),/Key/);
 for(const base_url of ['file:///tmp/a','https://user:password@example.test/v1','https://example.test/v1?key=bad','https://example.test/v1/chat/completions'])await assert.rejects(store.save({...config,base_url}));
 await assert.rejects(store.save({...config,qps:0}));assert.equal(store.summary().base_url,config.base_url);
}));

test('unavailable keychain never writes plaintext or mutates current configuration',()=>fixture(async file=>{
 const {call,calls}=recorder();
 const store=createTranslationSettings({file,safeStorage:{getSelectedStorageBackend:()=> 'basic_text',isEncryptionAvailable:()=>false},env:{},call});
 await assert.rejects(store.save(config),/凭据存储/);assert.equal(store.summary().key_configured,false);await assert.rejects(fs.access(file));
 assert.deepEqual(calls,[]);
}));
