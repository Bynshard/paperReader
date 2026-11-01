// Run the packaged application outside the checkout. All model traffic is loopback-only.
import {_electron} from '@playwright/test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
const root=path.resolve(import.meta.dirname,'../..'),output=path.join(root,'artifacts/validation/release-20261101');
await fs.mkdir(output,{recursive:true});const temp=await fs.mkdtemp(path.join(os.tmpdir(),'moonlight-release-'));
let executable=process.env.MOONLIGHT_PACKAGED_EXECUTABLE;
if(!executable){
 const meta=JSON.parse(await fs.readFile(path.join(root,'release/manifest.json'),'utf8'));
 const archive=await fs.readFile(meta.archive);assert.equal(createHash('sha256').update(archive).digest('hex'),meta.sha256);
 const install=path.join(temp,'installed');await fs.mkdir(install);execFileSync('tar',['-xzf',meta.archive,'-C',install]);
 executable=path.join(install,'Moonlight-linux-x64/moonlight');
}
const report={scope:'Packaged Linux x64 Electron/ASAR/native core/rclone outside checkout; real PDF.js and SQLite; loopback model and translation engine fixtures; Playwright disables Chromium OS sandbox in this container',steps:[],page_errors:[]};
const model=http.createServer(async(req,res)=>{for await(const _ of req){};res.setHeader('Content-Type','application/json');res.end(JSON.stringify({choices:[{message:{content:'测试回答，依据当前原文 [1]。'}}]}));});await new Promise(r=>model.listen(0,'127.0.0.1',r));
const engine=path.join(temp,'fake-babeldoc'),attempt=path.join(temp,'attempt');
await fs.writeFile(engine,`#!${root}/.venv/bin/python\nimport pathlib,sys,time,shutil\na=sys.argv;out=pathlib.Path(a[a.index('--output')+1]);out.mkdir(parents=True,exist_ok=True)\nm=pathlib.Path(${JSON.stringify(attempt)});first=not m.exists();m.write_text('attempt')\nprint('Translating',flush=True);time.sleep(.3)\nt=out/'fixture.zh-CN.mono.pdf'\nif first:t.write_bytes(b'invalid PDF')\nelse:shutil.copyfile(a[a.index('--files')+1],t)\n`,{mode:0o755});
const env={...process.env};for(const k of Object.keys(env))if(k.startsWith('MOONLIGHT_'))delete env[k];
Object.assign(env,{XDG_CONFIG_HOME:path.join(temp,'config'),MOONLIGHT_LIBRARY:path.join(temp,'original-library'),MOONLIGHT_UPSTREAM_KEY:'local-fixture-only',MOONLIGHT_UPSTREAM:`http://127.0.0.1:${model.address().port}/v1`,MOONLIGHT_BABELDOC_BIN:engine});
let app,page,pid;
async function launch(){app=await _electron.launch({executablePath:executable,args:['--disable-gpu','--user-data-dir='+path.join(temp,'profile')],cwd:temp,env,timeout:30000});page=await app.firstWindow();page.setDefaultTimeout(20000);page.on('pageerror',e=>report.page_errors.push(e.message));await page.getByRole('heading',{name:'论文库',exact:true}).waitFor();}
async function step(name,fn){const start=performance.now();try{await fn();report.steps.push({name,status:'pass',ms:Math.round(performance.now()-start)});console.log(name,'pass');}catch(e){report.steps.push({name,status:'fail',error:String(e)});throw e;}}
try{
 await step('packaged_start_without_checkout_runtime',async()=>{await launch();const info=await app.evaluate(({app})=>({packaged:app.isPackaged,appPath:app.getAppPath(),cwd:process.cwd(),resources:process.resourcesPath}));assert.equal(info.packaged,true);assert.match(info.appPath,/app\.asar$/);assert.equal(info.cwd,temp);report.runtime=info;});
 await app.evaluate(({dialog},file)=>{dialog.showOpenDialog=async()=>({canceled:false,filePaths:[file]});},path.join(root,'corpus/raw/attn.pdf'));
 await step('import_edit_taxonomy_and_notes',async()=>{
  await page.getByRole('button',{name:'导入 PDF',exact:true}).first().click();await page.locator('.paper-row').waitFor();pid=await page.locator('.paper-row').getAttribute('data-paper-id');
  await page.getByRole('button',{name:'⋯',exact:true}).click();await page.getByRole('button',{name:'编辑资料',exact:true}).click();
  await page.getByLabel('标题',{exact:true}).fill('Release verified paper');await page.getByLabel('论文笔记').fill('Manual note before backup');await page.getByLabel('论文标签').fill('release, 中文标签');await page.getByLabel('阅读状态').selectOption('read');
  await page.getByLabel('新分类',{exact:true}).fill('Release collection');await page.getByRole('button',{name:'新建分类',exact:true}).click();await page.getByRole('option',{name:'Release collection',exact:true}).waitFor();
  await page.getByRole('button',{name:'保存资料',exact:true}).click();await page.locator('.paper-title').filter({hasText:'Release verified paper'}).waitFor();
  const p=await page.evaluate(id=>window.moonlight.call('get_paper',{paper_id:id}),pid);assert.equal(p.tags.length,2);assert(p.categories.some(c=>c.name==='Release collection'));assert.equal(p.read_status,'read');
 });
 await page.locator('.paper-title').click();await page.locator('.pane-source canvas[data-rendered="true"]').first().waitFor();
 await step('ai_answer_to_notes_and_export_dialog',async()=>{
  await page.getByRole('button',{name:'总结本页',exact:true}).click();await page.getByTitle('跳转到原文').first().waitFor();await page.getByRole('button',{name:'保存到笔记',exact:true}).click();
  await page.waitForFunction(async id=>(await window.moonlight.call('get_paper',{paper_id:id})).notes.includes('测试回答'),pid);
  const out=path.join(temp,'answer.md');await app.evaluate(({dialog},file)=>{dialog.showSaveDialog=async()=>({canceled:false,filePath:file});},out);await page.getByRole('button',{name:'导出回答',exact:true}).click();await page.waitForTimeout(100);assert.match(await fs.readFile(out,'utf8'),/测试回答/);
 });
 await step('invalid_engine_output_task_failure_and_retry',async()=>{
  await page.getByRole('button',{name:'翻译全文',exact:true}).click();await page.getByRole('button',{name:'任务中心',exact:true}).click();await page.getByRole('button',{name:'重试',exact:true}).waitFor();
  await page.getByRole('button',{name:'重试',exact:true}).click();await page.getByText('已完成',{exact:true}).waitFor();
  const jobs=await page.evaluate(()=>window.moonlight.call('list_jobs',{}));assert.equal(jobs.length,2);assert.equal(jobs.filter(j=>j.status==='completed').length,1);assert.equal(jobs.filter(j=>j.status==='failed').length,1);
  await page.getByRole('button',{name:'打开论文',exact:true}).first().click();await page.locator('.pane-translated canvas[data-rendered="true"]').first().waitFor();
 });
 await step('upgrade_legacy_database_and_keep_user_data',async()=>{
  await page.evaluate(({pid,vid})=>window.moonlight.call('add_annotation',{paper_id:pid,version_id:vid,page:0,quote:'Upgrade annotation',rects:[{x:.1,y:.1,w:.1,h:.1}]}),{pid,vid:(await page.evaluate(id=>window.moonlight.call('get_paper',{paper_id:id}),pid)).versions.find(v=>v.kind==='source').id});
  await app.close();app=null;
  execFileSync(path.join(root,'.venv/bin/python'),['-c',`import sqlite3,sys
c=sqlite3.connect(sys.argv[1])
c.executescript("ALTER TABLE annotations DROP COLUMN version_id; DROP TRIGGER blocks_fts_insert_v2; DROP TRIGGER blocks_fts_delete_v2; DROP TRIGGER blocks_fts_update_v2; DELETE FROM blocks_fts; INSERT INTO blocks_fts(rowid,text,block_id,paper_id,page) SELECT rowid+10000,text,id,paper_id,page FROM blocks;")
c.close()`,path.join(temp,'original-library/library.db')]);
  await launch();await page.locator('.paper-title').click();await page.locator('.pane-translated canvas[data-rendered="true"]').first().waitFor();
  const data=await page.evaluate(async id=>({paper:await window.moonlight.call('get_paper',{paper_id:id}),annotations:await window.moonlight.call('list_annotations',{paper_id:id}),history:await window.moonlight.call('ai_history',{paper_id:id})}),pid);
  assert.equal(data.annotations.length,1);assert.equal(data.history.length,1);assert.equal(data.paper.tags.length,2);assert.equal(data.paper.title,'Release verified paper');
 });
 await step('complete_backup_via_system_directory_dialog',async()=>{
  await page.getByRole('button',{name:'← 论文库',exact:true}).click();await page.getByRole('button',{name:'设置与状态',exact:true}).click();
  const parent=path.join(temp,'backups');await fs.mkdir(parent);await app.evaluate(({dialog},dir)=>{dialog.showOpenDialog=async()=>({canceled:false,filePaths:[dir]});},parent);
  await page.getByRole('button',{name:'创建完整备份',exact:true}).click();await page.getByText(/备份已创建并附带校验清单/).waitFor();
  const names=await fs.readdir(parent);report.backup=path.join(parent,names[0]);assert(names[0].startsWith('MoonlightBackup-'));
 });
 await step('verified_restore_to_new_library_and_restart',async()=>{
  const target=path.join(temp,'restore');await fs.mkdir(target);const marker=path.join(temp,'relaunch-called');
  await app.evaluate(({dialog,app},{source,target,marker})=>{let n=0;dialog.showOpenDialog=async()=>({canceled:false,filePaths:[n++===0?source:target]});app.relaunch=()=>{};},{source:report.backup,target,marker});
  const closed=app.waitForEvent('close',{timeout:30000});await page.getByRole('button',{name:'恢复到新库并重启',exact:true}).click();await closed;app=null;
  await launch();
  const info=await page.evaluate(()=>window.moonlight.appInfo());assert(info.library.startsWith(target));assert(await fs.stat(path.join(temp,'original-library/library.db')));report.restored_new_library=true;
  await page.locator('.paper-title').click();await page.locator('.pane-translated canvas[data-rendered="true"]').first().waitFor();await page.locator('.answer-text').waitFor();
  const p=await page.evaluate(id=>window.moonlight.call('get_paper',{paper_id:id}),pid);assert.equal(p.versions.length,2);assert(p.notes.includes('测试回答'));assert.equal(p.tags.length,2);
  await page.screenshot({path:path.join(output,'packaged-reader.png')});
 });
 assert.deepEqual(report.page_errors,[]);report.completed=true;
}catch(e){report.error=e.stack;report.visible_errors=await page?.locator('.error-box,[role=alert]').allTextContents().catch(()=>[]);await page?.screenshot({path:path.join(output,'failure.png')}).catch(()=>{});process.exitCode=1;}
finally{await app?.close().catch(()=>{});await new Promise(r=>model.close(r));await fs.rm(temp,{recursive:true,force:true});await fs.writeFile(path.join(output,'packaged.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));}
