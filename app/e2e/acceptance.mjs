// Complete Electron/main/preload/Rust/file:// workflow audit in an isolated
// library. Only the OS file chooser, model and translation engine are mocks.
import {_electron} from '@playwright/test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import {execFileSync} from 'node:child_process';
const root=path.resolve(import.meta.dirname,'../..');
const output=path.join(root,'artifacts/validation/acceptance-20261101');
await fs.mkdir(output,{recursive:true});
const temp=await fs.mkdtemp(path.join(os.tmpdir(),'moonlight-desktop-audit-'));
const report={scope:'Real Electron/main/preload/Rust/file:// PDF.js; isolated library; OS file chooser, AI model and translation executable mocked; no model-quality claim',steps:[],page_errors:[]};
const model=http.createServer(async(req,res)=>{
  for await(const chunk of req){};
  res.writeHead(200,{'Content-Type':'application/json'});
  res.end(JSON.stringify({choices:[{message:{content:'本地模拟回答，依据原文片段 [1]。\n\n| 平台 | 带宽 |\n|---|---|\n| DGX H100 | 900 GB/s |\n\n公式：$E=mc^2$'}}]}));
});
await new Promise(resolve=>model.listen(0,'127.0.0.1',resolve));
const fake=path.join(temp,'fake-babeldoc');
await fs.writeFile(fake,`#!${root}/.venv/bin/python\nimport pathlib,shutil,sys,time\na=sys.argv[1:]\nprint('Translating',flush=True)\ntime.sleep(.3)\nout=pathlib.Path(a[a.index('--output')+1]);out.mkdir(parents=True,exist_ok=True)\nshutil.copyfile(a[a.index('--files')+1],out/'audit.zh-CN.mono.pdf')\n`,{mode:0o755});
const env={...process.env};
for(const key of Object.keys(env))if(key.startsWith('MOONLIGHT_'))delete env[key];
Object.assign(env,{XDG_CONFIG_HOME:path.join(temp,'config'),MOONLIGHT_LIBRARY:path.join(temp,'library'),
  MOONLIGHT_UPSTREAM:`http://127.0.0.1:${model.address().port}/v1`,MOONLIGHT_UPSTREAM_KEY:'local-audit-dummy',MOONLIGHT_BABELDOC_BIN:fake});
let app,page;
async function step(name,fn){
  const started=performance.now();
  try{const result=await fn();report.steps.push({name,status:'pass',ms:+(performance.now()-started).toFixed(2),result});console.log(name,'pass');return result;}
  catch(error){report.steps.push({name,status:'fail',error:String(error)});throw error;}
}
async function launch(){
  app=await _electron.launch({args:['--no-sandbox','--disable-gpu','--user-data-dir='+path.join(temp,'profile'),root+'/app'],cwd:root,env,timeout:30000});
  page=await app.firstWindow();page.setDefaultTimeout(15000);
  page.on('pageerror',error=>report.page_errors.push(error.message));
  await page.getByRole('heading',{name:'论文库',exact:true}).waitFor();
}
try{
  await step('actual_desktop_startup',async()=>{await launch();assert.match(page.url(),/^file:/);return {url_scheme:'file',version:await app.evaluate(({app})=>app.getVersion()),user_data_isolated:(await app.evaluate(({app})=>app.getPath('userData'))).startsWith(temp)};});
  await app.evaluate(({dialog},file)=>{dialog.showOpenDialog=async()=>({canceled:false,filePaths:[file]});},path.join(root,'corpus/raw/attn.pdf'));
  await step('import_via_ui_and_native_ipc',async()=>{
    await page.getByRole('button',{name:'导入 PDF',exact:true}).first().click();
    await page.locator('.paper-row').waitFor();
    const result=await page.evaluate(()=>window.moonlight.call('list_papers_page',{}));
    assert.equal(result.total,1);return {papers:result.total};
  });
  const pid=(await page.locator('.paper-row').getAttribute('data-paper-id'));
  await step('nested_folders_bulk_tags_and_parent_filter',async()=>{
    await page.getByRole('button',{name:'新建 / 管理',exact:true}).click();
    await page.getByRole('textbox',{name:'目录名称',exact:true}).fill('验收研究');
    await page.getByRole('button',{name:'新建目录',exact:true}).click();
    await page.getByText('目录已保存',{exact:true}).waitFor();
    const parent=await page.getByLabel('编辑目录').inputValue();
    await page.getByLabel('编辑目录').selectOption('');
    await page.getByRole('textbox',{name:'目录名称',exact:true}).fill('强化学习');
    await page.getByLabel('上级目录').selectOption(parent);
    await page.getByRole('button',{name:'新建目录',exact:true}).click();
    await page.getByText('目录已保存',{exact:true}).waitFor();
    const child=await page.getByLabel('编辑目录').inputValue();
    assert.notEqual(child,parent);
    await page.getByRole('button',{name:'关闭',exact:true}).click();
    await page.getByLabel('选择当前页论文').check();
    await page.getByRole('button',{name:'分类 / 标签',exact:true}).click();
    await page.getByLabel('添加到目录').selectOption(child);
    await page.getByLabel('批量标签').fill('待读, 验收标签');
    await page.getByRole('button',{name:'保存分类与标签',exact:true}).click();
    await page.locator('.folder-name').filter({hasText:'验收研究'}).click();
    await page.locator('.paper-row').waitFor();
    assert.equal(await page.locator('.paper-row').count(),1);
    const data=await page.evaluate(id=>window.moonlight.call('get_paper',{paper_id:id}),pid);
    assert(data.categories.some(c=>c.id===child));assert(data.tags.some(t=>t.name==='验收标签'));
    await page.getByRole('button',{name:'全部论文',exact:true}).click();
  });
  await step('inline_note_search_column_preferences_and_resize',async()=>{
    await page.getByRole('button',{name:'＋ 添加速记',exact:true}).click();
    await page.getByRole('textbox',{name:/一句话速记/}).fill('验收速记：Transformer 注意力机制');
    await page.getByRole('button',{name:'保存速记',exact:true}).click();
    await page.getByRole('button',{name:'验收速记：Transformer 注意力机制',exact:true}).waitFor();
    await page.getByRole('textbox',{name:'论文搜索',exact:true}).fill('验收速记');
    await page.locator('.paper-row').waitFor();
    await page.getByRole('textbox',{name:'论文搜索',exact:true}).fill('NO_SUCH_PAPER_87341');
    await page.getByText('没有匹配的论文',{exact:true}).waitFor();
    await page.getByRole('textbox',{name:'论文搜索',exact:true}).fill('');
    await page.locator('.paper-row').waitFor();
    await page.getByRole('button',{name:'显示列',exact:true}).click();
    await page.locator('.table-column-settings').getByLabel('目录',{exact:true}).check();
    await page.getByRole('columnheader',{name:/目录/}).waitFor();
    const handle=page.getByRole('separator',{name:'调整标题列宽',exact:true});
    const box=await handle.boundingBox();
    await page.mouse.move(box.x+box.width/2,box.y+box.height/2);await page.mouse.down();await page.mouse.move(box.x+80,box.y+box.height/2,{steps:5});await page.mouse.up();
    await page.waitForFunction(()=>JSON.parse(localStorage.getItem('moonlight-library-columns-v1')).sizing.title>350);
    await page.getByRole('button',{name:'显示列',exact:true}).click();
    await page.screenshot({path:path.join(output,'library.png')});
  });
  await step('favorite_via_ui',async()=>{
    await page.getByTitle('星标',{exact:true}).click();
    await page.waitForFunction(async id=>(await window.moonlight.call('get_paper',{paper_id:id})).favorite,pid);
  });
  await step('translation_settings_entry_and_url_validation',async()=>{
    await page.getByRole('button',{name:'设置与状态',exact:true}).click();
    await page.getByRole('heading',{name:'翻译 API 与 PDF 引擎',exact:true}).waitFor();
    assert.equal(await page.getByLabel('翻译 API Key',{exact:true}).inputValue(),'');
    await page.getByLabel('翻译 API 地址',{exact:true}).fill('http://user:password@127.0.0.1/v1');
    await page.getByRole('button',{name:'保存翻译配置',exact:true}).click();
    await page.locator('.translation-settings [role="alert"]').filter({hasText:'不能含账号'}).waitFor();
    await page.getByRole('button',{name:'关闭',exact:true}).click();
  });
  await step('pdf_render_through_file_protocol_and_ipc',async()=>{
    await page.locator('.paper-title').click();
    await page.locator('.pane-source [data-page="1"] canvas[data-rendered="true"]').waitFor({timeout:30000});
    return {canvases:await page.locator('canvas').count()};
  });
  await step('real_offline_ocr_selectable_layer_and_context',async()=>{
    await page.getByRole('button',{name:'OCR 当前页',exact:true}).click();
    await page.getByText('解析完成；空白页或无法识别的页面可能没有正文',{exact:true}).waitFor({timeout:150000});
    const result=await page.evaluate(async id=>{
      const p=await window.moonlight.call('get_paper',{paper_id:id});
      return window.moonlight.call('blocks',{paper_id:id,version_id:p.versions.find(v=>v.kind==='source').id,page:0});
    },pid);
    assert(result.some(b=>b.kind==='ocr'&&/attention/i.test(b.text)));
    await page.locator('.textLayer span[data-ocr="true"]').first().waitFor();
    return {blocks:result.length,characters:result.reduce((n,b)=>n+b.text.length,0)};
  });
  await step('selection_highlight_persistence',async()=>{
    await page.locator('.pane-source .textLayer span').first().evaluate(span=>{
      const range=document.createRange();range.selectNodeContents(span);
      const selection=window.getSelection();selection.removeAllRanges();selection.addRange(range);
      span.closest('.pane-scroll').dispatchEvent(new MouseEvent('mouseup',{bubbles:true}));
    });
    await page.getByRole('button',{name:'黄色高亮',exact:true}).click();
    await page.waitForFunction(async id=>(await window.moonlight.call('list_annotations',{paper_id:id})).length===1,pid);
  });
  await step('ai_rpc_and_source_navigation_mock_model',async()=>{
    await page.getByRole('button',{name:'阅读助手',exact:true}).click();
    await page.getByRole('button',{name:'总结本页',exact:true}).click();
    await page.locator('.ai-answer').waitFor();
    assert.match(await page.locator('.answer-text').textContent(),/本地模拟回答/);
    await page.locator('.answer-text table').waitFor();
    await page.locator('.answer-text .katex').first().waitFor();
    await page.getByTitle('跳转到原文').first().click();
    await page.locator('.evidence-focus').first().waitFor();
  });
  await step('translation_job_and_dual_pdf_mock_engine',async()=>{
    await page.getByRole('button',{name:'翻译全文',exact:true}).click();
    await page.locator('.pane-translated canvas[data-rendered="true"]').first().waitFor({timeout:30000});
    const paper=await page.evaluate(id=>window.moonlight.call('get_paper',{paper_id:id}),pid);
    assert(paper.versions.some(v=>v.kind==='translated'));
    await page.screenshot({path:path.join(output,'desktop.png')});
  });
  await step('restart_real_desktop_retains_library_and_annotations',async()=>{
    await app.close();app=null;await launch();
    await page.locator('.paper-row').waitFor();
    const prefs=await page.evaluate(()=>JSON.parse(localStorage.getItem('moonlight-library-columns-v1')));
    assert.equal(prefs.visibility.categories,true);assert(prefs.sizing.title>350);
    await page.locator('.paper-title').click();
    await page.locator('.pane-source canvas[data-rendered="true"]').first().waitFor({timeout:30000});
    const data=await page.evaluate(async id=>({paper:await window.moonlight.call('get_paper',{paper_id:id}),annotations:await window.moonlight.call('list_annotations',{paper_id:id})}),pid);
    assert.equal(data.annotations.length,1);assert.equal(data.paper.versions.length,2);
    assert.equal(data.paper.short_note,'验收速记：Transformer 注意力机制');
    assert(data.paper.tags.some(t=>t.name==='验收标签'));
    report.ai_history_restored=await page.locator('.ai-answer').count()>0;
    return {versions:data.paper.versions.length,annotations:data.annotations.length};
  });
  await step('trash_restore_via_ui',async()=>{
    await page.getByRole('button',{name:'← 论文库',exact:true}).click();
    await page.getByRole('button',{name:'⋯',exact:true}).click();
    await page.getByRole('button',{name:'移到回收站',exact:true}).click();
    await page.getByRole('button',{name:'回收站',exact:true}).click();
    await page.locator('.paper-row.deleted').waitFor();
    // The row menu can survive a filter change. Do not toggle an already
    // open menu closed and mistake that harness error for a product failure.
    if(!await page.getByRole('button',{name:'恢复',exact:true}).isVisible())
      await page.getByRole('button',{name:'⋯',exact:true}).click();
    await page.getByRole('button',{name:'恢复',exact:true}).click();
    assert.equal((await page.evaluate(id=>window.moonlight.call('get_paper',{paper_id:id}),pid)).deleted,false);
  });
  await step('image_only_pdf_automatic_ocr_fallback',async()=>{
    const scan=path.join(temp,'scan.pdf');
    execFileSync(root+'/.venv/bin/python',['-c',`import pymupdf,sys
src=pymupdf.open(sys.argv[1]);pix=src[0].get_pixmap(matrix=pymupdf.Matrix(2,2))
doc=pymupdf.open();p=doc.new_page(width=src[0].rect.width,height=src[0].rect.height);p.insert_image(p.rect,stream=pix.tobytes('png'))
doc.set_metadata({'title':'Image only acceptance scan'});doc.save(sys.argv[2],deflate=True)
assert not doc[0].get_text().strip()`,path.join(root,'corpus/raw/attn.pdf'),scan]);
    await page.getByRole('button',{name:'全部论文',exact:true}).click();
    await app.evaluate(({dialog},file)=>{dialog.showOpenDialog=async()=>({canceled:false,filePaths:[file]});},scan);
    await page.getByRole('button',{name:'导入 PDF',exact:true}).first().click();
    await page.locator('.paper-title').filter({hasText:'Image only acceptance scan'}).click();
    await page.locator('.pane-source canvas[data-rendered="true"]').first().waitFor();
    await page.getByRole('button',{name:'解析当前页',exact:true}).click();
    await page.getByText('解析完成；空白页或无法识别的页面可能没有正文',{exact:true}).waitFor({timeout:150000});
    await page.locator('.textLayer span[data-ocr="true"]').first().waitFor();
    const data=await page.evaluate(async()=>{
      const papers=await window.moonlight.call('list_papers');
      const p=papers.find(p=>p.title==='Image only acceptance scan');
      return window.moonlight.call('ai_prepare',{paper_id:p.id,question:'What is attention?',scope:'full'});
    });
    assert(/attention/i.test(data.prompt));
    assert(data.warnings.some(w=>/OCR/.test(w)));
    await page.screenshot({path:path.join(output,'scanned-reader.png')});
    return {sources:data.sources.length,context_characters:data.prompt.length};
  });
  assert.equal(report.page_errors.length,0,report.page_errors.join('\n'));
  report.completed=true;
}catch(error){report.error=String(error.stack || error);if(page)report.visible_errors=await page.locator('.page-error,.pane-loading,.error-box').allTextContents().catch(()=>[]);process.exitCode=1;}
finally{
  await app?.close().catch(()=>{});await new Promise(resolve=>model.close(resolve));
  await fs.rm(temp,{recursive:true,force:true});
  await fs.writeFile(path.join(output,'desktop.json'),JSON.stringify(report,null,2)+'\n');
  console.log(JSON.stringify(report,null,2));
}
