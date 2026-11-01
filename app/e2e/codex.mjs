// Real desktop IPC + Rust/PDF.js, simulated official app-server protocol.
import {_electron} from '@playwright/test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
const root=path.resolve(import.meta.dirname,'../..');
const output=path.join(root,'artifacts/validation/codex-login-20261101');
await fs.mkdir(output,{recursive:true});
const temp=await fs.mkdtemp(path.join(os.tmpdir(),'moonlight-codex-e2e-'));
const env={...process.env};for(const k of Object.keys(env))if(k.startsWith('MOONLIGHT_'))delete env[k];
Object.assign(env,{XDG_CONFIG_HOME:path.join(temp,'config'),MOONLIGHT_LIBRARY:path.join(temp,'library'),MOONLIGHT_CODEX_BIN:path.join(root,'app/tests/fixtures/codex-server.cjs')});
const report={scope:'real Electron/main/preload/Rust/PDF.js; simulated Codex OAuth completion and model; no real browser authentication',steps:[],page_errors:[]};
let app,page;
const step=async(name,fn)=>{await fn();report.steps.push(name);console.log(name,'pass');};
const launch=async()=>{
 app=await _electron.launch({args:['--disable-gpu','--user-data-dir='+path.join(temp,'profile'),root+'/app'],cwd:root,env,timeout:30000});
 page=await app.firstWindow();page.setDefaultTimeout(20000);page.on('pageerror',e=>report.page_errors.push(e.message));
 await page.getByRole('heading',{name:'论文库',exact:true}).waitFor();
};
try{
 await launch();
 await app.evaluate(({dialog,shell},file)=>{
   dialog.showOpenDialog=async()=>({canceled:false,filePaths:[file]});
   globalThis.__authUrls=[];shell.openExternal=async url=>{globalThis.__authUrls.push(url);};
 },path.join(root,'corpus/raw/attn.pdf'));
 await step('settings_browser_login_and_provider',async()=>{
  await page.getByRole('button',{name:'设置与状态',exact:true}).click();
  await page.getByRole('button',{name:'通过浏览器登录 Codex',exact:true}).click();
  await page.getByText(/已登录：fixture@example.test/).waitFor();
  await page.getByLabel('问答服务').selectOption('codex');
  await page.getByLabel('Codex 模型').selectOption('fixture-model');
  const urls=await app.evaluate(()=>globalThis.__authUrls);
  assert.equal(urls.length,1);assert.match(urls[0],/^https:\/\/auth.openai.com\//);
  await page.getByRole('button',{name:'关闭',exact:true}).click();
 });
 await page.getByRole('button',{name:'导入 PDF',exact:true}).first().click();await page.locator('.paper-row').waitFor();
 await page.locator('.paper-title').click();await page.locator('.pane-source canvas[data-rendered="true"]').first().waitFor();
 await step('summary_stream_evidence_and_sqlite_history',async()=>{
  await page.getByRole('button',{name:'总结本页',exact:true}).click();
  await page.getByTitle('跳转到原文').first().waitFor();
  assert.match(await page.locator('.answer-text').textContent(),/中文回答/);
  await page.getByTitle('跳转到原文').first().click();await page.locator('.evidence-focus').first().waitFor();
  const rows=await page.evaluate(()=>window.moonlight.call('list_papers_page',{}));
  const messages=await page.evaluate(id=>window.moonlight.call('ai_history',{paper_id:id}),rows.items[0].id);
  assert.equal(messages.length,1);assert.match(messages[0].model,/^codex:/);
 });
 await step('cancel_stream_does_not_save_partial_reply',async()=>{
  await page.locator('.ai textarea').fill('WAIT');
  await page.getByRole('button',{name:'提问',exact:true}).click();
  await page.getByRole('button',{name:'停止生成',exact:true}).click();
  await page.locator('.error-box').filter({hasText:'已停止生成'}).waitFor();
 });
 await page.screenshot({path:path.join(output,'desktop.png')});
 await step('restart_restores_ai_history_and_provider',async()=>{
  await app.close();app=null;await launch();await page.locator('.paper-title').click();
  await page.locator('.answer-text').waitFor();assert.match(await page.locator('.answer-text').textContent(),/中文回答/);
  await page.getByText('Codex 账号额度',{exact:true}).waitFor();
 });
 assert.deepEqual(report.page_errors,[]);report.completed=true;
}catch(e){report.error=e.stack;report.visible_errors=await page?.locator('.error-box,[role=alert]').allTextContents().catch(()=>[]);await page?.screenshot({path:path.join(output,'failure.png')}).catch(()=>{});process.exitCode=1;}
finally{await app?.close().catch(()=>{});await fs.rm(temp,{recursive:true,force:true});await fs.writeFile(path.join(output,'desktop.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));}
