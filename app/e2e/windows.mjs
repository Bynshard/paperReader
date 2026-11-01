// GitHub Windows CI only: unzip the actual release and run it outside the checkout.
import {_electron} from '@playwright/test';
import {listPackage} from '@electron/asar';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
const root=path.resolve(import.meta.dirname,'../..'),output=path.join(root,'artifacts/validation/windows');
await fs.mkdir(output,{recursive:true});
const temp=await fs.mkdtemp(path.join(os.tmpdir(),'Moonlight-Windows-smoke-'));
const report={scope:'Real Windows packaged Electron/Rust/PDF.js; generated PDF; no login or inference',steps:[],page_errors:[]};
let app,page;
try{
 const manifest=JSON.parse(await fs.readFile(path.join(root,'release/manifest-windows.json'),'utf8'));
 execFileSync(process.env.MOONLIGHT_PYTHON||'python',['-c','import zipfile,sys; zipfile.ZipFile(sys.argv[1]).extractall(sys.argv[2])',manifest.archive,temp]);
 const installed=path.join(temp,'Moonlight-win32-x64');
 const entries=listPackage(path.join(installed,'resources/app.asar'));
 for(const asset of ['worker.min.js','eng.traineddata.gz','chi_sim.traineddata.gz','tesseract-core-lstm.wasm'])assert(entries.some(p=>p.endsWith('/dist/ocr/'+asset)),`Missing offline OCR asset: ${asset}`);
 assert(entries.every(p=>!/(node_modules|\.env|auth\.json|library\.db|sync-credentials)/.test(p)));
 const env={...process.env};for(const k of Object.keys(env))if(k.startsWith('MOONLIGHT_'))delete env[k];
 Object.assign(env,{MOONLIGHT_USER_DATA:path.join(temp,'profile'),MOONLIGHT_LIBRARY:path.join(temp,'library')});
 app=await _electron.launch({executablePath:path.join(installed,'moonlight.exe'),cwd:temp,env,timeout:60000});
 page=await app.firstWindow();page.setDefaultTimeout(30000);page.on('pageerror',error=>report.page_errors.push(error.message));
 await page.getByRole('heading',{name:'论文库',exact:true}).waitFor();
 assert.equal(await app.evaluate(({app})=>app.isPackaged),true);report.steps.push('Actual extracted Windows EXE starts');
 await app.evaluate(({dialog},file)=>{dialog.showOpenDialog=async()=>({canceled:false,filePaths:[file]});},path.join(output,'fixture.pdf'));
 await page.getByRole('button',{name:'导入 PDF',exact:true}).first().click();await page.locator('.paper-row').waitFor();
 await page.getByRole('button',{name:'⋯',exact:true}).click();await page.getByRole('button',{name:'编辑资料',exact:true}).click();
 await page.getByLabel('标题',{exact:true}).fill('Windows packaged test');await page.getByLabel('论文笔记').fill('Windows 中文笔记');await page.getByLabel('论文标签').fill('Windows, CI');
 await page.getByRole('button',{name:'保存资料',exact:true}).click();await page.locator('.paper-title').filter({hasText:'Windows packaged test'}).waitFor();
 report.steps.push('Native file chooser, import, metadata, notes and tags');
 await page.locator('.paper-title').click();await page.locator('.pane-source canvas[data-rendered="true"]').first().waitFor();report.steps.push('PDF.js renders through file protocol and native IPC');
 // Forced OCR also verifies the bundled worker, local protocol, WASM and languages.
 await page.getByRole('button',{name:'OCR 当前页',exact:true}).click();
 await page.getByText('解析完成；空白页或无法识别的页面可能没有正文',{exact:true}).waitFor({timeout:150000});
 const ocr=await page.evaluate(async()=>{
   const papers=await window.moonlight.call('list_papers');
   const paper=await window.moonlight.call('get_paper',{paper_id:papers[0].id});
   return window.moonlight.call('blocks',{paper_id:paper.id,version_id:paper.versions.find(v=>v.kind==='source').id,page:0});
 });
 assert(ocr.some(b=>b.kind==='ocr'&&/attention/i.test(b.text)));
 await page.locator('.textLayer span[data-ocr="true"]').first().waitFor();
 report.steps.push('Bundled offline OCR renders a selectable text layer and persists recognized evidence');
 // Uses the bundled official App Server, reads its isolated signed-out account only.
 // Never opens OAuth or sends a paper/model request in CI.
 const account=await page.evaluate(()=>window.moonlight.aiAction('status'));
 assert.equal(account.account,null);assert(!account.error,account.error);report.steps.push('Bundled official Codex App Server initializes and reads signed-out state');
 await page.screenshot({path:path.join(output,'windows-reader.png')});
 assert.deepEqual(report.page_errors,[]);report.completed=true;
}catch(error){report.error=error.stack;await page?.screenshot({path:path.join(output,'windows-failure.png')}).catch(()=>{});process.exitCode=1;}
finally{
 await app?.close().catch(()=>{});await fs.rm(temp,{recursive:true,force:true,maxRetries:5,retryDelay:500});
 await fs.writeFile(path.join(output,'desktop.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
}
