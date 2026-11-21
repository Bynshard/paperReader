import { useEffect } from 'react';
import { act, render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import Reader, {claimVerdictLabel, pickReferenceBlock} from '../src/Reader';
import type { Paper } from '../src/types';
const {mocks, panes}=vi.hoisted(()=>({mocks:{pdf:vi.fn(),annotations:vi.fn(),zoteroFiles:vi.fn(),addAnnotation:vi.fn(),setBlocks:vi.fn(),textStatus:vi.fn(),blocks:vi.fn(),aiRun:vi.fn(),aiHistory:vi.fn(),listJobs:vi.fn(),aiPreferences:vi.fn(),aiAction:vi.fn(),startTranslate:vi.fn(),onEvent:vi.fn(),setReadingPosition:vi.fn(),translateText:vi.fn(),quickExplain:vi.fn(),updatePaper:vi.fn(),updateAnnotation:vi.fn(),saveText:vi.fn(),deleteAnnotation:vi.fn(),aiDigest:vi.fn(),searchBlocks:vi.fn(),claimVerify:vi.fn()},panes:{current:{} as Record<string,any>}}));
vi.mock('../src/api',()=>({api:mocks}));
vi.mock('../src/PdfPane',()=>({default:(props:any)=>{
  panes.current[props.side]=props;
  useEffect(()=>{const a={goTo:vi.fn(),parsePage:vi.fn().mockResolvedValue([{bbox:[1,2,3,4],text:'Page source text for summary',kind:'text'}]),getPosition:()=>({page:3,fraction:0.2}),find:vi.fn().mockResolvedValue([{page:2,bbox:[1,2,3,4]}]),getOutline:vi.fn().mockResolvedValue([{title:'Introduction',page:1,fraction:0,children:[{title:'Motivation',page:2,fraction:.1,children:[]}]}]),fit:vi.fn(()=>1.2),thumbnail:vi.fn().mockResolvedValue(''),renderRegion:vi.fn().mockResolvedValue('data:image/png;base64,AAAA'),pageSize:vi.fn(()=>({w:600,h:800})),prepareZoom:vi.fn(),extractFigures:vi.fn().mockResolvedValue([{label:'Figure 1',caption:'Figure 1: Overview of the pipeline',page:4,fraction:.5},{label:'Table 2',caption:'Table 2: Ablation results',page:6,fraction:.25}])};panes.current[`${props.side}Api`]=a;props.registerApi(a);return()=>props.registerApi(null);},[props.registerApi]);
  return <button onClick={()=>props.onSelect({page:3,rects:[{x:.1,y:.1,w:.1,h:.1}],quote:'selected words',side:props.side})}>select {props.side}</button>;
}}));
const paper:Paper={id:'paper',title:'Example',authors:'Author',imported_at:0,updated_at:0,favorite:false,read_status:'unread',deleted:false,notes:'',categories:[],tags:[],versions:[{id:'src',paper_id:'paper',kind:'source',sha256:'x',rel_path:'x',pages:10,bytes:1,lang:'en',created_at:0},{id:'trans',paper_id:'paper',kind:'translated',sha256:'y',rel_path:'y',pages:10,bytes:1,lang:'zh',created_at:1}]};
beforeEach(()=>{
  vi.clearAllMocks();panes.current={};
  mocks.textStatus.mockResolvedValue({indexed_pages:1,pages:10});mocks.blocks.mockResolvedValue([]);
  mocks.listJobs.mockResolvedValue([]);mocks.aiHistory.mockResolvedValue([]);mocks.aiPreferences.mockResolvedValue({provider:'codex'});mocks.aiAction.mockResolvedValue({});mocks.startTranslate.mockResolvedValue({job_id:'job-1'});
  mocks.zoteroFiles.mockResolvedValue([]);
  mocks.pdf.mockImplementation((_id,kind,version)=>Promise.resolve({bytes:new Uint8Array([1]),versionId:version || (kind==='source'?'src':'trans'),pages:10}));
  mocks.annotations.mockResolvedValue([]);mocks.addAnnotation.mockResolvedValue({id:'a'});mocks.setBlocks.mockResolvedValue({});mocks.aiRun.mockResolvedValue({answer:'answer',sources:[]});mocks.onEvent.mockReturnValue(()=>{});
  mocks.setReadingPosition.mockResolvedValue({ok:true});
  mocks.translateText.mockResolvedValue({text:'译文内容'});mocks.quickExplain.mockResolvedValue({answer:'释义内容',sources:[]});
  mocks.updatePaper.mockImplementation(async(_id:string,fields:Record<string,unknown>)=>({...paper,notes:String(fields.notes??paper.notes)}));
  mocks.updateAnnotation.mockResolvedValue({});mocks.saveText.mockResolvedValue({saved:true});mocks.deleteAnnotation.mockResolvedValue({});
  mocks.aiDigest.mockResolvedValue({markdown:'## 一句话总结\n用缓存层解决显存瓶颈 [p.2]',generated_at:1,model:'test'});
  mocks.searchBlocks.mockResolvedValue([]);mocks.claimVerify.mockResolvedValue({verdict:'supported',answer:'原文支持该说法 [1]。',sources:[]});
});
const mount=()=>render(<Reader paper={paper} onBack={vi.fn()} onChanged={vi.fn()} onToast={vi.fn()}/>);
describe('reader regression',()=>{
  it('shows migrated notes in the live note editor for a metadata-only item',async()=>{
    mocks.zoteroFiles.mockResolvedValue([{id:'missing',title:'Uncached.pdf',content_type:'application/pdf',status:'missing'}]);
    render(<Reader paper={{...paper,versions:[],notes:'Migrated standalone note'}} onBack={vi.fn()} onChanged={vi.fn()} onToast={vi.fn()}/>);
    await screen.findByLabelText('整篇阅读笔记');
    expect((screen.getByLabelText('整篇阅读笔记') as HTMLTextAreaElement).value).toBe('Migrated standalone note');
    expect(screen.getByText('Uncached.pdf')).toBeTruthy();
    expect(mocks.pdf).not.toHaveBeenCalled();
  });
  it('reads a secondary PDF and binds AI and annotations to that version',async()=>{
    const multi={...paper,versions:[...paper.versions,{...paper.versions[0],id:'supplement',created_at:2}]};
    render(<Reader paper={multi} onBack={vi.fn()} onChanged={vi.fn()} onToast={vi.fn()}/>);
    await screen.findByText('select source');
    fireEvent.change(screen.getByLabelText('原文附件'),{target:{value:'supplement'}});
    await waitFor(()=>expect(panes.current.source.annotations).toBeTruthy());
    await waitFor(()=>expect((screen.getByLabelText('原文附件') as HTMLSelectElement).value).toBe('supplement'));
    fireEvent.click(screen.getByText('select source'));
    fireEvent.click(screen.getByText('黄色高亮'));
    await waitFor(()=>expect(mocks.addAnnotation).toHaveBeenCalled());
    expect(mocks.addAnnotation.mock.calls[0][0].version_id).toBe('supplement');
    fireEvent.click(screen.getByText('阅读助手'));
    fireEvent.click(screen.getByText('总结本页'));
    await waitFor(()=>expect(mocks.aiRun).toHaveBeenCalled());
    expect(mocks.aiRun.mock.calls[0][0].version_id).toBe('supplement');
    const translateButton = screen.getByText(/重新翻译|翻译全文/) as HTMLButtonElement;
    expect(translateButton.disabled).toBe(false);
  });
  it('saves translated highlights with their actual document version',async()=>{
    mount();fireEvent.click(await screen.findByText('select translated'));
    fireEvent.click(screen.getByText('黄色高亮'));
    await waitFor(()=>expect(mocks.addAnnotation).toHaveBeenCalled());
    expect(mocks.addAnnotation.mock.calls[0][0]).toMatchObject({page:2,version_kind:'translated',version_id:'trans'});
  });
  it('uses zero-based block pages and summary page consistently',async()=>{
    mount();await screen.findByText('select source');
    panes.current.source.onBlocks(2,[{bbox:[1,2,3,4],text:'page three'}]);
    expect(mocks.setBlocks).toHaveBeenCalledWith('paper','src',2,expect.any(Array));
    fireEvent.click(screen.getByText('select source'));
    panes.current.source.onScrollFraction(3,0.2);
    fireEvent.click(screen.getByText('阅读助手'));
    fireEvent.click(screen.getByText('总结本页'));
    await waitFor(()=>expect(mocks.aiRun).toHaveBeenCalled());
    expect(mocks.aiRun.mock.calls[0][0].page).toBe(2);
  });
  it('restores the server-backed reading position and persists page turns',async()=>{
    const restored={...paper,last_read_page:6,last_read_fraction:.4,last_read_mode:'source'};
    const view=render(<Reader paper={restored} onBack={vi.fn()} onChanged={vi.fn()} onToast={vi.fn()}/>);
    await screen.findByText('select source');
    // Zero-based page 6 + fraction .4 resumes as one-based page 7, and the
    // stored mode wins over the implicit "dual when a translation exists".
    expect(panes.current.sourceApi.goTo).toHaveBeenCalledWith(7,.4);
    act(()=>{panes.current.source.onScrollFraction(3,.2);});
    await waitFor(()=>expect(mocks.setReadingPosition).toHaveBeenCalledWith('paper',2,.2,'source'),{timeout:2000});
    // The legacy localStorage copy must be gone for good.
    expect(localStorage.getItem('pos:paper')).toBeNull();
    view.unmount();
    expect(localStorage.getItem('pos:paper')).toBeNull();
  });
  it('keeps AI and copy actions available after an area (marquee) selection',async()=>{
    render(<Reader paper={paper} onBack={vi.fn()} onChanged={vi.fn()} onToast={vi.fn()}/>);
    await screen.findByText('select source');
    act(()=>{panes.current.source.onAreaSelect({page:3,rects:[{x:.1,y:.1,w:.2,h:.2}],quote:'figure caption',areaText:'figure caption',side:'source',area:true,imageDataUrl:'data:image/png;base64,AAAA'});});
    const ask=await screen.findByLabelText('AI 解读图表');
    expect(screen.getByLabelText('复制选区文本')).toHaveProperty('disabled',false);
    expect(screen.queryByText('翻译')).toBeNull();
    fireEvent.click(ask);
    await waitFor(()=>expect(mocks.quickExplain).toHaveBeenCalled());
    expect(mocks.quickExplain.mock.calls[0][0]).toMatchObject({paper_id:'paper',image_data_url:'data:image/png;base64,AAAA'});
    expect(String(mocks.quickExplain.mock.calls[0][0].question)).toContain('解读这个框选区域');
    expect(await screen.findByText('多模态解读')).toBeTruthy();
  });
  it('applies a committed pinch scale through the existing zoom pipeline',async()=>{
    mount();await screen.findByText('select source');
    act(()=>{panes.current.source.onPinchScale(2.4,{clientX:120,clientY:240});});
    await waitFor(()=>expect(panes.current.source.scale).toBe(2.4));
    expect(panes.current.sourceApi.prepareZoom).toHaveBeenCalledWith({clientX:120,clientY:240});
  });
  it('does not synchronize in response to programmatic page callbacks',async()=>{
    mount();await screen.findByText('select source');
    expect(panes.current.source.onPageChange).toBeUndefined();
    expect(panes.current.translated.onPageChange).toBeUndefined();
  });
  it('finds text in the document with Ctrl+F and jumps to a match',async()=>{
    mount();await screen.findByText('select source');
    fireEvent.keyDown(window,{key:'f',ctrlKey:true});
    const input=await screen.findByLabelText('文内查找关键词');
    fireEvent.change(input,{target:{value:'memory'}});
    fireEvent.keyDown(input,{key:'Enter'});
    await waitFor(()=>expect(panes.current.sourceApi.find).toHaveBeenCalledWith('memory'));
    await waitFor(()=>expect(panes.current.sourceApi.goTo).toHaveBeenCalledWith(2,0,[1,2,3,4]));
    expect(await screen.findByText('1/1')).toBeTruthy();
  });
  it('loads the PDF outline beside the pages',async()=>{
    mount();await screen.findByText('select source');
    fireEvent.click(screen.getByRole('button',{name:'目录与页面导航'}));
    await screen.findByText('Introduction');
    expect(panes.current.sourceApi.getOutline).toHaveBeenCalled();
    fireEvent.click(screen.getByText('Motivation'));
    expect(panes.current.sourceApi.goTo).toHaveBeenCalledWith(2,.1,undefined);
  });
  it('searches the translated pane when it is the active side',async()=>{
    mount();await screen.findByText('select translated');
    fireEvent.click(screen.getByText('select translated'));
    fireEvent.keyDown(window,{key:'f',ctrlKey:true});
    const input=await screen.findByLabelText('文内查找关键词');
    fireEvent.change(input,{target:{value:'显存'}});
    fireEvent.keyDown(input,{key:'Enter'});
    await waitFor(()=>expect(panes.current.translatedApi.find).toHaveBeenCalled());
    expect(panes.current.sourceApi.find).not.toHaveBeenCalled();
  });
  it('persists translated text blocks so cross-language retrieval can use them',async()=>{
    mount();await screen.findByText('select translated');
    act(()=>{panes.current.translated.onBlocks(2,[{bbox:[1,2,3,4],text:'译文段落'}]);});
    await waitFor(()=>expect(mocks.setBlocks).toHaveBeenCalledWith('paper','trans',2,expect.any(Array)));
  });
  it('starts a translation for the selected supplementary source attachment',async()=>{
    const multi={...paper,versions:[...paper.versions,{...paper.versions[0],id:'supplement',created_at:2}]};
    render(<Reader paper={multi} onBack={vi.fn()} onChanged={vi.fn()} onToast={vi.fn()}/>);
    await screen.findByText('select source');
    fireEvent.change(screen.getByLabelText('原文附件'),{target:{value:'supplement'}});
    await waitFor(()=>expect((screen.getByLabelText('原文附件') as HTMLSelectElement).value).toBe('supplement'));
    fireEvent.click(await screen.findByText(/翻译全文|重新翻译/));
    await waitFor(()=>expect(mocks.startTranslate).toHaveBeenCalledWith('paper',undefined,'supplement'));
  });
  it('synchronizes dual-pane scrolling by the nearest paragraph instead of raw fractions',async()=>{
    mocks.blocks.mockImplementation(async(_paper:string,version:string)=>version==='src'
      ? [{id:'b1',page:2,block_index:0,kind:'text',bbox:[0,10,120,30],text:'source first'},{id:'b2',page:2,block_index:1,kind:'text',bbox:[0,80,120,100],text:'source second'}]
      : [{id:'t1',page:2,block_index:0,kind:'text',bbox:[0,12,130,34],text:'译文第一段'}]);
    mount();await screen.findByText('select source');
    panes.current.source.onScrollFraction(3,0.1);
    await waitFor(()=>expect(panes.current.translatedApi.goTo).toHaveBeenCalled());
    const calls=panes.current.translatedApi.goTo.mock.calls;
    const last=calls[calls.length-1];
    expect(last[0]).toBe(3);
    expect(last[1]).toBeLessThan(0.05);
  });
  it('applies fit-width to the active pane and keeps the zoom mode responsive',async()=>{
    mount();await screen.findByText('select source');
    fireEvent.click(screen.getByRole('button',{name:'一键适应页宽'}));
    await waitFor(()=>expect(panes.current.sourceApi.fit).toHaveBeenCalledWith('width'));
    await waitFor(()=>expect(panes.current.source.scale).toBe(1.2));
  });
  it('aligns a source paragraph with its translated counterpart in dual mode',async()=>{
    mocks.blocks.mockImplementation(async(_paper:string,version:string)=>version==='src'
      ? [{id:'b1',page:2,block_index:0,kind:'text',bbox:[0,10,120,30],text:'source first'},{id:'b2',page:2,block_index:1,kind:'text',bbox:[0,80,120,100],text:'source second'}]
      : [{id:'t1',page:2,block_index:0,kind:'text',bbox:[0,12,130,34],text:'译文第一段'}]);
    mount();await screen.findByText('select source');
    panes.current.source.onScrollFraction(3,0.2);
    await waitFor(()=>expect(mocks.blocks).toHaveBeenCalledWith('paper','trans',2));
    await new Promise((resolve)=>setTimeout(resolve,60));
    act(()=>{panes.current.source.onParagraphPoint({page:3,x:10,y:20},'click');});
    await waitFor(()=>expect(panes.current.source.alignedBox).toEqual({page:3,bbox:[0,10,120,30]}));
    expect(panes.current.translated.alignedBox).toEqual({page:3,bbox:[0,12,130,34]});
  });
  it('offers current page, custom range and full-text translation before any translation exists',async()=>{
    const untranslated={...paper,versions:[paper.versions[0]]};
    render(<Reader paper={untranslated} onBack={vi.fn()} onChanged={vi.fn()} onToast={vi.fn()}/>);
    await screen.findByText('select source');
    fireEvent.click(screen.getByLabelText('翻译选项'));
    expect(await screen.findByText('只翻译当前页（第 1 页）')).toBeTruthy();
    fireEvent.click(screen.getByText('翻译指定页码范围…'));
    fireEvent.change(screen.getByLabelText('翻译页码范围'),{target:{value:'1-3, 5'}});
    fireEvent.click(screen.getByText('开始'));
    await waitFor(()=>expect(mocks.startTranslate).toHaveBeenCalledWith('paper','1-3, 5','src'));
  });
  it('rejects an invalid custom translation range without starting a job',async()=>{
    mount();await screen.findByText('select source');
    fireEvent.click(screen.getByLabelText('翻译选项'));
    fireEvent.click(screen.getByText('翻译指定页码范围…'));
    fireEvent.change(screen.getByLabelText('翻译页码范围'),{target:{value:'9-3'}});
    fireEvent.click(screen.getByText('开始'));
    expect((await screen.findByRole('alert')).textContent).toContain('起始页不大于结束页');
    expect(mocks.startTranslate).not.toHaveBeenCalled();
  });
  it('returns to one-finger scrolling after a one-shot marquee',async()=>{
    mount();await screen.findByText('select source');
    fireEvent.click(screen.getByLabelText('框选模式'));
    await waitFor(()=>expect(panes.current.source.areaMode).toBe(true),{timeout:1500});
    act(()=>{panes.current.source.onAreaSelect({page:3,rects:[{x:.1,y:.1,w:.2,h:.2}],quote:'figure',side:'source',area:true});});
    await waitFor(()=>expect(panes.current.source.areaMode).toBe(false));
  });
  it('keeps drawing when a double tap locks the continuous marquee and Esc exits',async()=>{
    mount();await screen.findByText('select source');
    fireEvent.click(screen.getByLabelText('框选模式'));
    fireEvent.click(screen.getByLabelText('框选模式'));
    await waitFor(()=>expect(panes.current.source.areaMode).toBe(true));
    expect(screen.getByLabelText('连续框选已锁定')).toBeTruthy();
    act(()=>{panes.current.source.onAreaSelect({page:3,rects:[{x:.1,y:.1,w:.2,h:.2}],quote:'figure',side:'source',area:true});});
    await waitFor(()=>expect(panes.current.source.areaMode).toBe(true));
    fireEvent.keyDown(window,{key:'Escape'});
    await waitFor(()=>expect(panes.current.source.areaMode).toBe(false));
  });
  it('shows an in-place translation bubble without switching tabs or writing chat history',async()=>{
    mount();await screen.findByText('select source');
    fireEvent.click(screen.getByText('笔记'));
    fireEvent.click(screen.getByText('select source'));
    fireEvent.click(screen.getByTitle(/就地翻译选段/));
    expect(await screen.findByText('就地译文')).toBeTruthy();
    expect(await screen.findByText('译文内容')).toBeTruthy();
    expect(mocks.translateText).toHaveBeenCalledWith('selected words');
    expect(screen.getByLabelText('整篇阅读笔记')).toBeTruthy();
    expect(mocks.aiRun).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText('存入高亮批注'));
    await waitFor(()=>expect(mocks.addAnnotation).toHaveBeenCalledWith(expect.objectContaining({quote:'selected words',comment:'译文内容'})));
  });
  it('uses an ephemeral explain call for the in-place explanation bubble',async()=>{    mount();await screen.findByText('select source');
    fireEvent.click(screen.getByText('select source'));
    fireEvent.click(screen.getByTitle('AI 就地解释选段'));
    await waitFor(()=>expect(mocks.quickExplain).toHaveBeenCalled());
    expect(mocks.quickExplain.mock.calls[0][0]).toMatchObject({paper_id:'paper',page:2,kind:'explain',include_history:false});
    expect(await screen.findByText('释义内容')).toBeTruthy();
  });
  it('autosaves the whole-paper Markdown note after the 600ms debounce',async()=>{
    mount();await screen.findByText('select source');
    fireEvent.click(screen.getByText('笔记'));
    const editor=screen.getByLabelText('整篇阅读笔记');
    vi.useFakeTimers();
    try {
      fireEvent.change(editor,{target:{value:'# 结论\n值得复现'}});
      expect(mocks.updatePaper).not.toHaveBeenCalled();
      await act(async()=>{await vi.advanceTimersByTimeAsync(650);});
      expect(mocks.updatePaper).toHaveBeenCalledWith('paper',{notes:'# 结论\n值得复现'});
    } finally { vi.useRealTimers(); }
    expect(await screen.findByText('已保存')).toBeTruthy();
  });
  it('inserts the close-reading template and current page reference into the note',async()=>{
    mount();await screen.findByText('select source');
    fireEvent.click(screen.getByText('笔记'));
    fireEvent.click(screen.getByText('+ 套用精读模板'));
    const editor=screen.getByLabelText('整篇阅读笔记') as HTMLTextAreaElement;
    expect(editor.value).toContain('## 一句话总结 (TL;DR)');
    fireEvent.click(screen.getByText('+ 引用当前页 p.1'));
    expect(editor.value).toContain('[p.1]');
  });
  it('filters annotations by academic colour and edits a comment inline',async()=>{
    mocks.annotations.mockResolvedValue([
      {id:'a1',paper_id:'paper',version_kind:'source',page:1,rects:[{x:.1,y:.1,w:.1,h:.1}],quote:'yellow quote',color:'yellow',comment:'',created_at:1},
      {id:'a2',paper_id:'paper',version_kind:'source',page:2,rects:[{x:.1,y:.1,w:.1,h:.1}],quote:'red quote',color:'red',comment:'old doubt',created_at:2},
    ]);
    mount();await screen.findByText('select source');
    fireEvent.click(screen.getByText('笔记'));
    expect(await screen.findByText('yellow quote')).toBeTruthy();
    fireEvent.click(screen.getByRole('button',{name:'核心结论',exact:true}));
    expect(screen.queryByText('red quote')).toBeNull();
    fireEvent.click(screen.getByText('＋ 添加批注'));
    fireEvent.change(screen.getByLabelText('编辑批注'),{target:{value:'我的批注'}});
    fireEvent.click(screen.getByText('保存批注'));
    await waitFor(()=>expect(mocks.updateAnnotation).toHaveBeenCalledWith('a1',{comment:'我的批注'}));
  });
  it('exports the whole-paper note plus colour-grouped annotations as markdown',async()=>{
    mocks.annotations.mockResolvedValue([
      {id:'a1',paper_id:'paper',version_kind:'source',page:1,rects:[{x:.1,y:.1,w:.1,h:.1}],quote:'yellow quote',color:'yellow',comment:'must cite',created_at:1},
    ]);
    mount();await screen.findByText('select source');
    fireEvent.click(screen.getByText('笔记'));
    fireEvent.change(screen.getByLabelText('整篇阅读笔记'),{target:{value:'# 我的总结\n贡献很清晰'}});
    fireEvent.click(screen.getByText('导出精读笔记 .md'));
    await waitFor(()=>expect(mocks.saveText).toHaveBeenCalled());
    const [name,text]=mocks.saveText.mock.calls[0];
    expect(name).toContain('精读笔记.md');
    expect(text).toContain('# 我的总结');
    expect(text).toContain('yellow quote');
    expect(text).toContain('核心结论');
    expect(text).toContain('must cite');
  });
  it('generates a cached structured digest and follows [p.X] page references',async()=>{
    mount();await screen.findByText('select source');
    fireEvent.click(await screen.findByText(/生成结构化导读/));
    await waitFor(()=>expect(mocks.aiDigest).toHaveBeenCalledWith('paper','src',false));
    expect(await screen.findByText('一页纸导读')).toBeTruthy();
    fireEvent.click(await screen.findByText('p.2'));
    await waitFor(()=>expect(panes.current.sourceApi.goTo).toHaveBeenLastCalledWith(2,0,undefined));
  });
  it('restores a resizable dual-pane split from storage and resets it on double click',async()=>{
    localStorage.setItem('moonlight-reader-split','0.7');
    const view=mount();await screen.findByText('select source');
    const slot=view.container.querySelector('.pane-slot') as HTMLElement;
    expect(slot.style.flex).toContain('70%');
    fireEvent.doubleClick(screen.getByRole('separator',{name:'拖动调整原文与译文宽度'}));
    await waitFor(()=>expect((view.container.querySelector('.pane-slot') as HTMLElement).style.flex).toContain('50%'));
  });
  it('previews an internal reference near the click and pins it as a corner portal',async()=>{
    mount();await screen.findByText('select source');
    act(()=>{void panes.current.source.onInternalLink(4,0.5,{x:200,y:200});});
    expect(await screen.findByText('第 4 页 · 位置预览')).toBeTruthy();
    expect(await screen.findByAltText('第 4 页预览')).toBeTruthy();
    fireEvent.click(screen.getByText(/钉在角落对照/));
    expect(await screen.findByText('p.4 · 钉选')).toBeTruthy();
    expect(screen.getByAltText('第 4 页钉选区域')).toBeTruthy();
  });
  it('saves every page fragment of a cross-page selection',async()=>{
    mount();await screen.findByText('select source');
    act(()=>{panes.current.source.onSelect({page:3,rects:[{x:.1,y:.1,w:.3,h:.1}],quote:'cross page words',side:'source',anchor:{x:10,y:10},extraSlices:[{page:4,rects:[{x:.1,y:.1,w:.3,h:.1}]}]});});
    fireEvent.click(screen.getByText('黄色高亮'));
    await waitFor(()=>expect(mocks.addAnnotation).toHaveBeenCalledTimes(2));
    expect(mocks.addAnnotation.mock.calls[0][0]).toMatchObject({page:2,quote:'cross page words',version_id:'src'});
    expect(mocks.addAnnotation.mock.calls[1][0]).toMatchObject({page:3,quote:'cross page words',version_id:'src'});
  });
  it('shows BabelDOC numeric progress, detail and elapsed time in the job bar',async()=>{
    let listener:(message:any)=>void=()=>undefined;
    mocks.onEvent.mockImplementation((callback:any)=>{listener=callback;return ()=>undefined;});
    mount();await screen.findByText('select source');
    fireEvent.click(screen.getByText('重新翻译'));
    fireEvent.click(await screen.findByText('翻译全文'));
    await waitFor(()=>expect(mocks.startTranslate).toHaveBeenCalled());
    act(()=>listener({event:'job',jobId:'job-1',status:'translating',phase:'translating',progress:42,detail:'Translating 42%'}));
    expect(await screen.findByText(/42%/)).toBeTruthy();
    expect(screen.getByText(/Translating 42%/)).toBeTruthy();
    expect(screen.getByText(/已用时/)).toBeTruthy();
  });
  it('pauses reader shortcuts while its tab is inactive',async()=>{
    const view=render(<Reader paper={paper} active={false} onBack={vi.fn()} onChanged={vi.fn()} onToast={vi.fn()}/>);
    await screen.findByText('select source');
    const calls=panes.current.sourceApi.goTo.mock.calls.length;
    fireEvent.keyDown(window,{key:'PageDown'});
    expect(panes.current.sourceApi.goTo.mock.calls.length).toBe(calls);
    view.unmount();
  });
  it('syncs external notes only when the editor has no unsaved draft',async()=>{
    const view=render(<Reader paper={{...paper,notes:'old note'}} onBack={vi.fn()} onChanged={vi.fn()} onToast={vi.fn()}/>);
    await screen.findByText('select source');
    fireEvent.click(screen.getByText('笔记'));
    expect((screen.getByLabelText('整篇阅读笔记') as HTMLTextAreaElement).value).toBe('old note');
    view.rerender(<Reader paper={{...paper,notes:'old note\n\nAI appended'}} onBack={vi.fn()} onChanged={vi.fn()} onToast={vi.fn()}/>);
    await waitFor(()=>expect((screen.getByLabelText('整篇阅读笔记') as HTMLTextAreaElement).value).toContain('AI appended'));
    const editor=screen.getByLabelText('整篇阅读笔记');
    fireEvent.change(editor,{target:{value:'my unsaved draft'}});
    view.rerender(<Reader paper={{...paper,notes:'another external'}} onBack={vi.fn()} onChanged={vi.fn()} onToast={vi.fn()}/>);
    await waitFor(()=>expect((screen.getByLabelText('整篇阅读笔记') as HTMLTextAreaElement).value).toBe('my unsaved draft'));
  });
  it('renders clickable page references in the note preview',async()=>{
    mount();await screen.findByText('select source');
    fireEvent.click(screen.getByText('笔记'));
    fireEvent.change(screen.getByLabelText('整篇阅读笔记'),{target:{value:'see [p.3] for details'}});
    fireEvent.click(screen.getByText('预览'));
    fireEvent.click(await screen.findByText('p.3'));
    await waitFor(()=>expect(panes.current.sourceApi.goTo).toHaveBeenLastCalledWith(3,0,undefined));
  });
  it('renders internal-link previews from the pane that was clicked',async()=>{
    mount();await screen.findByText('select translated');
    act(()=>{void panes.current.translated.onInternalLink(3,0.25,{x:10,y:10});});
    await waitFor(()=>expect(panes.current.translatedApi.renderRegion).toHaveBeenCalledWith(3,0.25,380));
    expect(panes.current.sourceApi.renderRegion).not.toHaveBeenCalled();
    expect(await screen.findByAltText('第 3 页预览')).toBeTruthy();
  });
  it('searches the translated pane for a Chinese library hit',async()=>{
    render(<Reader paper={paper} initialPage={3} initialSearch="显存瓶颈" onBack={vi.fn()} onChanged={vi.fn()} onToast={vi.fn()}/>);
    await waitFor(()=>expect(panes.current.translatedApi.find).toHaveBeenCalledWith('显存瓶颈'),{timeout:2500});
    expect(panes.current.sourceApi.find).not.toHaveBeenCalled();
  });
  it('searches the translated pane when the hit is bound to a translated version',async()=>{
    render(<Reader paper={paper} initialPage={3} initialSearch="attention" initialVersionId="trans" onBack={vi.fn()} onChanged={vi.fn()} onToast={vi.fn()}/>);
    await waitFor(()=>expect(panes.current.translatedApi.find).toHaveBeenCalledWith('attention'),{timeout:2500});
  });
  it('maps source pages onto a partial translation and shows a translate-this-page mask',async()=>{
    const partial={...paper,versions:[paper.versions[0],{...paper.versions[1],pages:1,page_map:[4]}]};
    render(<Reader paper={partial} initialPage={5} onBack={vi.fn()} onChanged={vi.fn()} onToast={vi.fn()}/>);
    await screen.findByText('select source');
    await waitFor(()=>expect(panes.current.translatedApi.goTo).toHaveBeenLastCalledWith(1,0));
    act(()=>{panes.current.source.onScrollFraction(6,0.1);});
    expect(await screen.findByText('第 6 页尚未翻译')).toBeTruthy();
    expect(screen.getByText('翻译当前页')).toBeTruthy();
  });
  it('stores a highlight from a partial translated pane on its source page',async()=>{
    const partial={...paper,versions:[paper.versions[0],{...paper.versions[1],pages:1,page_map:[4]}]};
    render(<Reader paper={partial} initialPage={5} onBack={vi.fn()} onChanged={vi.fn()} onToast={vi.fn()}/>);
    await screen.findByText('select translated');
    act(()=>{panes.current.translated.onSelect({page:1,rects:[{x:.1,y:.1,w:.2,h:.2}],quote:'translated words',side:'translated',anchor:{x:10,y:10}});});
    fireEvent.click(screen.getByText('黄色高亮'));
    await waitFor(()=>expect(mocks.addAnnotation).toHaveBeenCalledWith(expect.objectContaining({page:4,version_kind:'translated',version_id:'trans'})));
  });
  it('lists figures and tables, jumps to a caption and pins it into the corner portal',async()=>{
    mount();await screen.findByText('select source');
    fireEvent.click(screen.getByRole('button',{name:'目录与页面导航'}));
    fireEvent.click(await screen.findByText('图表'));
    expect(await screen.findByText('Figure 1')).toBeTruthy();
    expect(await screen.findByText('Overview of the pipeline')).toBeTruthy();
    fireEvent.click(screen.getByRole('button',{name:'跳转到 Figure 1（第 4 页）'}));
    await waitFor(()=>expect(panes.current.sourceApi.goTo).toHaveBeenCalledWith(4,.5,undefined));
    fireEvent.click(screen.getByRole('button',{name:'钉选 Figure 1'}));
    expect(await screen.findByText('p.4 · 钉选')).toBeTruthy();
    expect(screen.getByAltText('第 4 页钉选区域')).toBeTruthy();
  });
  it('offers a one-click settings entry from the AI empty state',async()=>{
    const open=vi.fn();
    render(<Reader paper={paper} onBack={vi.fn()} onChanged={vi.fn()} onToast={vi.fn()} onOpenSettings={open}/>);
    await screen.findByText('select source');
    fireEvent.click(screen.getByRole('button',{name:'前往配置 API 或登录 Codex'}));
    expect(open).toHaveBeenCalledWith('ai');
  });
  it('routes credential errors to the AI settings tab',async()=>{
    mocks.aiRun.mockRejectedValueOnce(new Error('尚未配置模型凭据，请先填写 API Key 或登录 Codex'));
    const open=vi.fn();
    render(<Reader paper={paper} onBack={vi.fn()} onChanged={vi.fn()} onToast={vi.fn()} onOpenSettings={open}/>);
    await screen.findByText('select source');
    fireEvent.click(screen.getByText('总结本页'));
    const alert=await screen.findByRole('alert');
    expect(alert.textContent).toContain('凭据');
    const cta=screen.getAllByText('前往配置 API / 登录 Codex →').at(-1)!;
    fireEvent.click(cta);
    expect(open).toHaveBeenCalledWith('ai');
  });
  it('routes a missing BabelDOC translation failure to the translation settings tab',async()=>{
    mocks.startTranslate.mockRejectedValueOnce(new Error('未安装 BabelDOC，请先在翻译设置中安装'));
    const open=vi.fn();
    render(<Reader paper={{...paper,versions:[paper.versions[0]]}} onBack={vi.fn()} onChanged={vi.fn()} onToast={vi.fn()} onOpenSettings={open}/>);
    await screen.findByText('select source');
    fireEvent.click(screen.getByText('翻译全文'));
    const banner=await waitFor(()=>{
      const element=document.querySelector('.reader-settings-banner');
      expect(element).not.toBeNull();
      return element as HTMLElement;
    });
    await waitFor(()=>expect(banner.textContent).toContain('BabelDOC'));
    fireEvent.click(within(banner).getByText('前往配置 API / 登录 Codex →'));
    expect(open).toHaveBeenCalledWith('translation');
  });
  it('maps every backend verdict onto the three-state claim badge',()=>{
    expect(claimVerdictLabel('supported')).toBe('支持');
    expect(claimVerdictLabel('Conditional')).toBe('部分支持');
    expect(claimVerdictLabel('unsupported')).toBe('未提及或矛盾');
    expect(claimVerdictLabel(undefined)).toBe('未判定');
  });
  it('picks the canonical caption / right-aligned equation / reference entry block',()=>{
    const block=(page:number,text:string)=>({id:`b-${page}-${text.length}`,page,block_index:0,kind:'text',bbox:[40,100,560,120],text});
    const reference=(kind:any,number='2'):any=>({kind,label:'x',number,queries:[],text:'x',index:0,length:1});
    const figure=pickReferenceBlock(reference('figure'),[
      block(2,'as shown in Figure 2, the trend is clear'),
      block(4,'Figure 2: Overview of the proposed pipeline'),
    ],10);
    expect(figure?.page).toBe(4);
    const equation=pickReferenceBlock(reference('equation','3'),[
      block(3,'the loss equals (3) plus a regularizer'),
      block(5,'L = sum_i w_i * (3)'),
    ],10);
    expect(equation?.page).toBe(5);
    const citation=pickReferenceBlock(reference('citation','12'),[
      block(1,'prior work [12] studies this claim'),
      block(9,'[12] Smith et al. Attention is all you need.'),
    ],10);
    expect(citation?.page).toBe(9);
  });
  it('resolves a Fig. text reference through the block index and previews the caption',async()=>{
    mocks.searchBlocks.mockResolvedValueOnce([]).mockResolvedValueOnce([
      {id:'b1',page:3,block_index:0,kind:'text',bbox:[40,200,560,214],text:'Fig. 2. Ablation results'},
      {id:'b2',page:5,block_index:0,kind:'text',bbox:[40,600,560,614],text:'as shown in Fig. 2, the trend is clear'},
    ]);
    mount();await screen.findByText('select source');
    act(()=>{void panes.current.source.onTextReference({kind:'figure',label:'Figure 2',number:'2',queries:['Figure 2','Fig. 2'],text:'Fig. 2',index:0,length:6},{x:200,y:300});});
    await waitFor(()=>expect(mocks.searchBlocks).toHaveBeenCalledWith('paper','Figure 2',30));
    expect(mocks.searchBlocks).toHaveBeenCalledWith('paper','Fig. 2',30);
    expect(await screen.findByText('第 4 页 · 位置预览')).toBeTruthy();
    await waitFor(()=>expect(panes.current.sourceApi.renderRegion).toHaveBeenCalledWith(4,207/800,380));
  });
  it('toasts when the clicked text reference has no matching block',async()=>{
    mocks.searchBlocks.mockResolvedValue([]);
    const toast=vi.fn();
    render(<Reader paper={paper} onBack={vi.fn()} onChanged={vi.fn()} onToast={toast}/>);
    await screen.findByText('select source');
    act(()=>{void panes.current.source.onTextReference({kind:'table',label:'Table 9',number:'9',queries:['Table 9'],text:'Table 9',index:0,length:7},{x:1,y:2});});
    await waitFor(()=>expect(toast).toHaveBeenCalledWith(expect.stringContaining('未在原文中找到')));
  });
  it('verifies a selected claim and shows the verdict plus answer in the quick bubble',async()=>{
    mocks.claimVerify.mockResolvedValue({verdict:'conditional',answer:'原文仅在消融实验中部分支持该说法 [2]。',sources:[]});
    mount();await screen.findByText('select source');
    fireEvent.click(screen.getByText('select source'));
    fireEvent.click(await screen.findByRole('button',{name:'核查原文依据'}));
    await waitFor(()=>expect(mocks.claimVerify).toHaveBeenCalledWith('paper','selected words','src'));
    const bubble=await waitFor(()=>{
      const element=document.querySelector('.quick-answer');
      expect(element).not.toBeNull();
      return element as HTMLElement;
    });
    expect(within(bubble).getByText('部分支持')).toBeTruthy();
    expect(within(bubble).getByText(/部分支持该说法/)).toBeTruthy();
    for(const label of ['复制','存入高亮批注','转入深聊']) expect(within(bubble).getByText(label)).toBeTruthy();
  });
});
