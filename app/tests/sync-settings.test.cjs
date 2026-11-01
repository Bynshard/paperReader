const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const os=require('node:os');
const path=require('node:path');
const {createSyncSettings}=require('../electron/sync-settings.cjs');
const profile={provider:'webdav',endpoint:'https://dav.example.test/',username:'test-user',password:'test-application-password',bucket:'',prefix:'Moonlight'};
// The OS encryptor is substituted here; this tests the credential flow, not OS
// cryptography or keychain availability on a headless machine.
const encrypted={getSelectedStorageBackend:()=> 'gnome_libsecret',isEncryptionAvailable:()=>true,encryptString:(s)=>Buffer.from('cipher:'+Buffer.from(s).toString('base64')),decryptString:(b)=>Buffer.from(b.toString().slice(7),'base64').toString()};
async function temporary(run){const dir=await fs.mkdtemp(path.join(os.tmpdir(),'moonlight-credentials-'));try{await run(path.join(dir,'sync.json'));}finally{await fs.rm(dir,{recursive:true,force:true});}}

test('persists only encrypted credentials and restores without exposing them to renderer',()=>temporary(async(file)=>{
  const calls=[];const store=createSyncSettings({file,safeStorage:encrypted,call:async(method,input)=>calls.push({method,input})});
  const result=await store.save({profile,auto_minutes:0});assert.equal(result.credentials_saved,true);assert.equal(result.profile.password,undefined);
  const text=await fs.readFile(file,'utf8');assert.equal(text.includes(profile.password),false);assert.equal(text.includes('test-user'),false);
  const restored=createSyncSettings({file,safeStorage:encrypted,call:async(method,input)=>calls.push({method,input})});
  await restored.load();assert.equal(calls.at(-1).input.password,profile.password);assert.equal(restored.summary().profile.password,undefined);store.stop();restored.stop();
}));
test('does not use plaintext fallback when the system key store is unavailable',()=>temporary(async(file)=>{
  const store=createSyncSettings({file,safeStorage:{isEncryptionAvailable:()=>false,getSelectedStorageBackend:()=> 'basic_text'},call:async()=>{}});
  const result=await store.save({profile,auto_minutes:0});assert.equal(result.credentials_saved,false);assert.equal(JSON.parse(await fs.readFile(file,'utf8')).encrypted,null);assert.equal((await fs.readFile(file,'utf8')).includes(profile.password),false);store.stop();
}));
test('retains blank credentials for the same target but not another endpoint',()=>temporary(async(file)=>{
  const calls=[];const store=createSyncSettings({file,safeStorage:encrypted,call:async(_method,input)=>{calls.push(input);if(!input.password)throw new Error('missing credential');}});
  await store.save({profile,auto_minutes:0});await store.save({profile:{...profile,password:''},auto_minutes:0});assert.equal(calls.at(-1).password,profile.password);
  await assert.rejects(store.save({profile:{...profile,endpoint:'https://other.example.test/',password:''},auto_minutes:0}),/missing/);assert.equal(calls.at(-1).password,'');store.stop();
}));
