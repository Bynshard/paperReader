const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const os=require('node:os');
const path=require('node:path');
const {createTranslationSettings}=require('../electron/translation-settings.cjs');
const safeStorage={getSelectedStorageBackend:()=> 'gnome_libsecret',isEncryptionAvailable:()=>true,encryptString:s=>Buffer.from('encrypted:'+Buffer.from(s).toString('base64')),decryptString:b=>Buffer.from(b.toString().slice(10),'base64').toString()};
const config={base_url:'https://provider.example/v1',model:'academic-test',api_key:'fixture-secret-value',babeldoc:'',qps:2};
async function fixture(run){const directory=await fs.mkdtemp(path.join(os.tmpdir(),'translation-settings-'));try{await run(path.join(directory,'settings.json'));}finally{await fs.rm(directory,{recursive:true,force:true});}}
test('encrypted configuration round-trips into the sidecar environment without returning a key',()=>fixture(async file=>{
 const store=createTranslationSettings({file,safeStorage,env:{}});await store.load();
 assert.equal(store.summary().key_configured,false);
 const saved=await store.save(config);assert.equal(saved.pending_restart,true);assert.equal(saved.api_key,undefined);
 assert(!(await fs.readFile(file,'utf8')).includes(config.api_key));
 const restored=createTranslationSettings({file,safeStorage,env:{}});await restored.load();
 assert.equal(restored.summary().pending_restart,false);assert.equal(restored.environment().MOONLIGHT_UPSTREAM_KEY,config.api_key);
 assert.equal(restored.environment().MOONLIGHT_MODEL,config.model);
}));
test('empty key retains only the same endpoint; invalid addresses and rates are rejected',()=>fixture(async file=>{
 const store=createTranslationSettings({file,safeStorage,env:{}});await store.save(config);
 await store.save({...config,api_key:''});assert.equal(store.environment().MOONLIGHT_UPSTREAM_KEY,config.api_key);
 await assert.rejects(store.save({...config,base_url:'https://other.example/v1',api_key:''}),/Key/);
 for(const base_url of ['file:///tmp/a','https://user:password@example.test/v1','https://example.test/v1?key=bad','https://example.test/v1/chat/completions'])await assert.rejects(store.save({...config,base_url}));
 await assert.rejects(store.save({...config,qps:0}));assert.equal(store.summary().base_url,config.base_url);
}));
test('unavailable keychain never writes plaintext or mutates current configuration',()=>fixture(async file=>{
 const store=createTranslationSettings({file,safeStorage:{getSelectedStorageBackend:()=> 'basic_text',isEncryptionAvailable:()=>false},env:{}});
 await assert.rejects(store.save(config),/凭据存储/);assert.equal(store.summary().key_configured,false);await assert.rejects(fs.access(file));
}));
