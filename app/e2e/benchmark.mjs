// Actual production React + PDF.js in Chromium; HTTP test bridge replaces IPC.
// npm run bench:browser -- http://127.0.0.1:5201 /absolute/report.json
import {chromium} from '@playwright/test';
import {mkdir, writeFile} from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';

const origin=process.argv[2] || 'http://127.0.0.1:5201';
assert.match(origin,/^http:\/\/127\.0\.0\.1:\d+$/);
const output=path.resolve(process.argv[3] || '../artifacts/validation/scale-10k/browser.json');
await mkdir(path.dirname(output),{recursive:true});
const samples={};
const report={scope:'Production React/PDF.js + actual Rust core over loopback HTTP, not Electron IPC or physical GPU/display',
  environment:{node:process.version,platform:process.platform},results:samples,failures:[]};
const browser=await chromium.launch({headless:true});
report.environment.browser=browser.version();
function stats(values){
  const sorted=[...values].sort((a,b)=>a-b);
  const p=n=>+sorted[Math.max(0,Math.ceil(sorted.length*n)-1)].toFixed(3);
  return {runs:values.length,median_ms:p(.5),p95_ms:p(.95),p99_ms:p(.99),max_ms:p(1)};
}
try {
  const context=await browser.newContext({viewport:{width:1600,height:1000},deviceScaleFactor:1});
  await context.addInitScript(()=>{
    const call=async(method,params={})=>{
      const response=await fetch('/rpc',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({method,params})});
      const body=await response.json();
      if(body.error)throw new Error(body.error);
      return body.result;
    };
    window.moonlight={call,
      readPdf:async(id,kind)=>{
        const response=await fetch(`/pdf?id=${encodeURIComponent(id)}&kind=${kind}`);
        if(!response.ok)throw new Error('PDF unavailable');
        return {bytes:new Uint8Array(await response.arrayBuffer()),versionId:response.headers.get('X-Version-Id'),pages:Number(response.headers.get('X-Pages'))};
      },appInfo:async()=>({version:'benchmark',library:'isolated benchmark',engine:'rust'}),
      syncSettings:async()=>({profile:null,auto_minutes:0,credentials_saved:false}),
      onEvent:()=>()=>{},pickPdfs:async()=>[],pickDirectory:async()=>null};
    window.__longTasks=[];
    new PerformanceObserver(list=>{
      for(const task of list.getEntries())window.__longTasks.push({start:task.startTime,duration:task.duration});
    }).observe({type:'longtask',buffered:true});
  });
  const page=await context.newPage();
  const errors=[];
  page.on('pageerror',e=>errors.push(e.message));
  const fixtures=await (await context.request.get(`${origin}/fixtures`)).json();
  report.fixture_count=fixtures.count;
  report.dual_fixture=fixtures.dual_fixture;
  const startup=[];
  for(let i=0;i<5;i++){
    const start=performance.now();
    await page.goto(origin);
    await page.locator('.paper-row').first().waitFor();
    startup.push(performance.now()-start);
  }
  samples.library_first_visible=stats(startup);
  console.log('library startup',samples.library_first_visible);
  report.mounted_library_rows=await page.locator('.paper-row').count();
  assert(report.mounted_library_rows<30,'library virtualization is unbounded');
  const search=page.getByRole('textbox',{name:'论文搜索',exact:true});
  const searches=[];
  for(let i=0;i<10;i++){
    const query=`Paper ${String(Math.min(1200,fixtures.count-20)+i).padStart(5,'0')}`;
    const begin=performance.now();
    await search.fill(query);
    await page.locator('.paper-title').filter({hasText:query}).first().waitFor();
    searches.push(performance.now()-begin);
  }
  samples.search_input_to_result=stats(searches);
  console.log('search',samples.search_input_to_result);
  await search.fill('');
  await page.waitForTimeout(300);
  const firstIds={};
  for(const sort of ['title','recent']){
    const response=await context.request.post(`${origin}/rpc`,{data:{method:'list_papers_page',params:{sort,limit:1}}});
    firstIds[sort]=(await response.json()).result.items[0].id;
  }
  const sort=[];
  for(let i=0;i<10;i++){
    const begin=performance.now();
    const order=i%2?'recent':'title';
    const expected=firstIds[order];
    await page.getByLabel('论文排序').selectOption(order);
    await page.waitForFunction(expected=>{
      return document.querySelector('.paper-row')?.getAttribute('data-paper-id')===expected;
    },expected);
    sort.push(performance.now()-begin);
  }
  samples.sort_to_visible=stats(sort);
  console.log('sort',samples.sort_to_visible);
  const cdp=await context.newCDPSession(page);
  await cdp.send('Performance.enable');
  const heap=async()=>{
    await cdp.send('HeapProfiler.collectGarbage');
    const m=await cdp.send('Performance.getMetrics');
    return Object.fromEntries(m.metrics.filter(x=>['JSHeapUsedSize','Nodes','Documents'].includes(x.name)).map(x=>[x.name,x.value]));
  };
  report.memory_before_pdf=await heap();
  const openTimes=[],zoomTimes=[];
  for(let i=0;i<8;i++){
    const fixture=fixtures.papers[i%2];
    // Stable query/ID also lets this harness diagnose old malformed metadata.
    await search.fill(i%2?'HybridFlow':'Attention Is All You Need');
    const target=page.locator(`[data-paper-id="${fixture.paper_id}"] .paper-title`);
    await target.waitFor();
    await page.evaluate(id=>localStorage.removeItem(`pos:${id}`),fixture.paper_id);
    const begin=performance.now();
    await target.click();
    await page.locator('.pane-source [data-page="1"] canvas[data-rendered="true"]').waitFor({timeout:30000});
    if(fixtures.dual_fixture && i%2)await page.locator('.pane-translated [data-page="1"] canvas[data-rendered="true"]').waitFor({timeout:30000});
    openTimes.push(performance.now()-begin);
    console.log('PDF opened',i,openTimes.at(-1));
    assert(await page.locator('canvas').count()<10);
    if(i===0){
      report.first_pdf_screenshot=path.join(path.dirname(output),'reader.png');
      await page.screenshot({path:report.first_pdf_screenshot});
      const zoomStart=performance.now();
      const oldScale=await page.locator('canvas[data-rendered="true"]').first().getAttribute('data-scale');
      await page.locator('.zoom button').last().click();
      await page.waitForFunction(old=>[...document.querySelectorAll('canvas[data-rendered="true"]')].some(c=>c.dataset.scale!==old),oldScale);
      zoomTimes.push(performance.now()-zoomStart);
      // Programmed scrolling at requestAnimationFrame cadence. This measures
      // browser scheduling gaps, NOT physical-display frame presentation.
      report.scroll=await page.evaluate(async()=>{
        const element=document.querySelector('.pane-scroll');
        const deltas=[];let previous=performance.now(),peakCanvases=0,peakPixels=0;
        for(let i=0;i<240;i++){
          await new Promise(resolve=>requestAnimationFrame(now=>{deltas.push(now-previous);previous=now;resolve();}));
          element.scrollTop=(i*45)%(element.scrollHeight-element.clientHeight);
          const canvases=[...document.querySelectorAll('canvas')];
          peakCanvases=Math.max(peakCanvases,canvases.length);
          peakPixels=Math.max(peakPixels,canvases.reduce((n,c)=>n+c.width*c.height,0));
        }
        return {deltas,peakCanvases,peakCanvasMiB:peakPixels*4/1024/1024};
      });
      report.scroll.frame_intervals=stats(report.scroll.deltas);
      delete report.scroll.deltas;
      await cdp.send('Emulation.setDeviceMetricsOverride',{width:1600,height:1000,deviceScaleFactor:2,mobile:false});
      const highZoomStart=performance.now();
      for(let zoom=0;zoom<12;zoom++)await page.locator('.zoom button').last().click();
      await page.locator('canvas[data-rendered="true"][data-scale="3"]').first().waitFor({timeout:30000});
      report.high_zoom=await page.evaluate(()=>{
        const canvases=[...document.querySelectorAll('canvas')];
        return {scale:3,dpr:window.devicePixelRatio,canvases:canvases.length,
          max_page_pixels:Math.max(...canvases.map(c=>c.width*c.height)),
          canvas_mib:canvases.reduce((n,c)=>n+c.width*c.height*4,0)/1024/1024};
      });
      report.high_zoom.draw_ms=performance.now()-highZoomStart;
      await cdp.send('Emulation.clearDeviceMetricsOverride');
    }
    await page.getByRole('button',{name:'← 论文库',exact:true}).click();
    await search.waitFor();
    await page.waitForTimeout(100);
  }
  samples.pdf_open_to_draw_complete=stats(openTimes);
  samples.pdf_zoom_to_draw_complete=stats(zoomTimes);
  report.stress=[];
  for(const fixture of fixtures.stress || []){
    const runs=[];
    for(let i=0;i<3;i++){
      await search.fill(fixture.title);
      const target=page.locator(`[data-paper-id="${fixture.paper_id}"] .paper-title`);
      await target.waitFor();
      const begin=performance.now();await target.click();
      await page.locator('canvas[data-rendered="true"]').first().waitFor({timeout:60000});
      runs.push(performance.now()-begin);
      if(i===0){
        const input=page.locator('.page-nav input');
        await input.fill(String(fixture.pages));await input.press('Enter');
        await page.locator(`[data-page="${fixture.pages}"] canvas[data-rendered="true"]`).waitFor({timeout:60000});
        assert(await page.locator('canvas').count()<10,'long-document rendering is unbounded');
      }
      await page.getByRole('button',{name:'← 论文库',exact:true}).click();
    }
    report.stress.push({name:fixture.name,pages:fixture.pages,first_page:stats(runs)});
  }
  report.memory_after_pdf_cycles=await heap();
  report.remaining_canvases=await page.locator('canvas').count();
  assert.equal(report.remaining_canvases,0,'PDF canvases retained in DOM after closing');
  report.long_tasks=await page.evaluate(()=>({count:window.__longTasks.length,total_ms:window.__longTasks.reduce((n,t)=>n+t.duration,0),max_ms:Math.max(0,...window.__longTasks.map(t=>t.duration))}));
  report.page_errors=errors;
  assert.equal(errors.length,0,errors.join('\n'));
  const budgets={library_first_visible:2000,search_input_to_result:700,sort_to_visible:200,pdf_open_to_draw_complete:3000,pdf_zoom_to_draw_complete:1500};
  report.budgets_ms_p95=budgets;
  report.failures=Object.entries(budgets).filter(([name,budget])=>samples[name].p95_ms>budget).map(([name,budget])=>`${name}: ${samples[name].p95_ms} > ${budget} ms`);
  if(report.high_zoom.max_page_pixels>8388608)report.failures.push('single canvas exceeded 32 MiB pixel budget at high zoom');
  report.completed=true;
  await context.close();
} catch(error){report.error=String(error.stack || error);process.exitCode=1;}
finally{
  await browser.close();
  await mkdir(path.dirname(output),{recursive:true});
  await writeFile(output,JSON.stringify(report,null,2)+'\n');
  console.log(JSON.stringify(report,null,2));
  if(report.failures.length)process.exitCode=1;
}
