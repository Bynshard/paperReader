import { useEffect } from 'react';
import { act, render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import Reader from '../src/Reader';
import type { Paper } from '../src/types';
const {mocks, panes}=vi.hoisted(()=>({mocks:{pdf:vi.fn(),annotations:vi.fn(),zoteroFiles:vi.fn(),addAnnotation:vi.fn(),setBlocks:vi.fn(),textStatus:vi.fn(),blocks:vi.fn(),aiRun:vi.fn(),aiHistory:vi.fn(),listJobs:vi.fn(),aiPreferences:vi.fn(),aiAction:vi.fn(),startTranslate:vi.fn(),onEvent:vi.fn()},panes:{current:{} as Record<string,any>}}));
vi.mock('../src/api',()=>({api:mocks}));
vi.mock('../src/PdfPane',()=>({default:(props:any)=>{
  panes.current[props.side]=props;
  useEffect(()=>{const a={goTo:vi.fn(),parsePage:vi.fn().mockResolvedValue([{bbox:[1,2,3,4],text:'Page source text for summary',kind:'text'}]),getPosition:()=>({page:3,fraction:0.2}),find:vi.fn().mockResolvedValue([{page:2,bbox:[1,2,3,4]}]),getOutline:vi.fn().mockResolvedValue([{title:'Introduction',page:1,fraction:0,children:[{title:'Motivation',page:2,fraction:.1,children:[]}]}]),fit:vi.fn(()=>1.2),thumbnail:vi.fn().mockResolvedValue(''),pageSize:vi.fn(()=>({w:600,h:800})),prepareZoom:vi.fn()};panes.current[`${props.side}Api`]=a;props.registerApi(a);return()=>props.registerApi(null);},[props.registerApi]);
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
});
const mount=()=>render(<Reader paper={paper} onBack={vi.fn()} onChanged={vi.fn()} onToast={vi.fn()}/>);
describe('reader regression',()=>{
  it('shows migrated notes and attachments for a metadata-only item',async()=>{
    mocks.zoteroFiles.mockResolvedValue([{id:'missing',title:'Uncached.pdf',content_type:'application/pdf',status:'missing'}]);
    render(<Reader paper={{...paper,versions:[],notes:'Migrated standalone note'}} onBack={vi.fn()} onChanged={vi.fn()} onToast={vi.fn()}/>);
    await screen.findByText('Migrated standalone note');
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
  it('restores saved location without overwriting it on mount',async()=>{
    localStorage.setItem('pos:paper',JSON.stringify({page:7,fraction:.4}));
    const view=mount();await screen.findByText('select source');
    expect(panes.current.sourceApi.goTo).toHaveBeenCalledWith(7,.4);
    view.unmount();expect(JSON.parse(localStorage.getItem('pos:paper')!)).toEqual({page:7,fraction:.4});
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
});
