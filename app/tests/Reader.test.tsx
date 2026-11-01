import { useEffect } from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import Reader from '../src/Reader';
import type { Paper } from '../src/types';
const {mocks, panes}=vi.hoisted(()=>({mocks:{pdf:vi.fn(),annotations:vi.fn(),zoteroFiles:vi.fn(),addAnnotation:vi.fn(),setBlocks:vi.fn(),aiRun:vi.fn(),aiHistory:vi.fn(),listJobs:vi.fn(),aiPreferences:vi.fn(),aiAction:vi.fn(),onEvent:vi.fn()},panes:{current:{} as Record<string,any>}}));
vi.mock('../src/api',()=>({api:mocks}));
vi.mock('../src/PdfPane',()=>({default:(props:any)=>{
  panes.current[props.side]=props;
  useEffect(()=>{const a={goTo:vi.fn(),getPosition:()=>({page:3,fraction:0.2})};panes.current[`${props.side}Api`]=a;props.registerApi(a);return()=>props.registerApi(null);},[props.registerApi]);
  return <button onClick={()=>props.onSelect({page:3,rects:[{x:.1,y:.1,w:.1,h:.1}],quote:'selected words',side:props.side})}>select {props.side}</button>;
}}));
const paper:Paper={id:'paper',title:'Example',authors:'Author',imported_at:0,updated_at:0,favorite:false,read_status:'unread',deleted:false,notes:'',categories:[],tags:[],versions:[{id:'src',paper_id:'paper',kind:'source',sha256:'x',rel_path:'x',pages:10,bytes:1,lang:'en',created_at:0},{id:'trans',paper_id:'paper',kind:'translated',sha256:'y',rel_path:'y',pages:10,bytes:1,lang:'zh',created_at:1}]};
beforeEach(()=>{
  vi.clearAllMocks();panes.current={};
  mocks.listJobs.mockResolvedValue([]);mocks.aiHistory.mockResolvedValue([]);mocks.aiPreferences.mockResolvedValue({provider:'codex'});mocks.aiAction.mockResolvedValue({});
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
    expect((screen.getByText('重新翻译') as HTMLButtonElement).disabled).toBe(true);
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
});
