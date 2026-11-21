import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import App from '../src/App';

const mocks = vi.hoisted(() => ({paperPage:vi.fn(),taxonomy:vi.fn(),appInfo:vi.fn(),getPaper:vi.fn(),zoteroProbe:vi.fn(),zoteroImport:vi.fn(),pickDirectory:vi.fn(),saveText:vi.fn(),syncStatus:vi.fn(),listJobs:vi.fn(),onEvent:vi.fn(()=>()=>{})}));
vi.mock('../src/api', () => ({api:mocks}));
vi.mock('../src/Reader', () => ({default:({paper,active}:any) => <div data-active={active !== false}><span>Reading {paper.title}</span><span data-versions={paper.versions?.length ?? 0} /></div>}));
const paper = (id:string) => ({id,title:`Paper ${id}`,authors:'Author',imported_at:0,updated_at:0,favorite:false,read_status:'unread',deleted:false,categories:[],tags:[],has_translation:false});
function deferred<T>() {
  let resolve!: (value:T)=>void;
  const promise = new Promise<T>((done)=>{resolve=done;});
  return {promise,resolve};
}
function mount() {
  const client=new QueryClient({defaultOptions:{queries:{retry:false,gcTime:0}}});
  return render(<QueryClientProvider client={client}><App/></QueryClientProvider>);
}
beforeEach(()=>{
  vi.clearAllMocks();
  mocks.taxonomy.mockResolvedValue({categories:[],tags:[]});
  mocks.appInfo.mockResolvedValue({});
  mocks.syncStatus.mockResolvedValue({configured:false,running:false});
  mocks.listJobs.mockResolvedValue([]);
});
describe('library asynchronous requests',()=>{
  it('allows a custom Zotero directory and passes migration choices to the backend',async()=>{
    mocks.paperPage.mockResolvedValue({items:[],total:0,offset:0,limit:100});
    mocks.zoteroProbe.mockResolvedValueOnce({found:false,collections:[]}).mockResolvedValue({found:true,data_dir:'/custom/Zotero',source:'sqlite',items:20,collections:[{id:1,key:'1:COLL0001',name:'Research',items:20}]});
    mocks.zoteroImport.mockResolvedValue({imported:20,updated:0,duplicates:0,attachments:22,annotations:5,without_pdf:1,missing_attachments:[{item:'A',attachment:'B',path:'attachments:missing.pdf',reason:'linked_base_directory_required'}],errors:[],warnings:[]});
    mocks.saveText.mockResolvedValue({saved:true});
    mount();fireEvent.click(screen.getByRole('button',{name:'导入论文'}));
    fireEvent.click(await screen.findByText('从 Zotero 导入'));
    await screen.findByText(/未找到 Zotero 数据目录/);
    fireEvent.change(screen.getByLabelText('Zotero 数据目录'),{target:{value:'/custom/Zotero'}});
    fireEvent.click(screen.getByText('读取目录'));
    await screen.findByText('Research');
    fireEvent.click(screen.getByLabelText(/Research/));
    fireEvent.change(screen.getByLabelText('外链附件基础目录'),{target:{value:'/papers'}});
    fireEvent.click(screen.getByText('开始导入'));
    await waitFor(()=>expect(mocks.zoteroImport).toHaveBeenCalledWith({data_dir:'/custom/Zotero',collections:['1:COLL0001'],copy_attachments:true,linked_base_dir:'/papers'}));
    await screen.findByText(/需指定外链基础目录/);
    fireEvent.click(screen.getByText('保存完整迁移报告'));
    expect(mocks.saveText).toHaveBeenCalledWith('zotero-migration-report.json',expect.stringContaining('missing_attachments'));
  });
  it('keeps a late old search from replacing newer results and sends favorite to the backend',async()=>{
    const old=deferred<any>();
    mocks.paperPage.mockImplementation((opts)=>opts.query==='older' ? old.promise : Promise.resolve({items:[paper(opts.query || 'initial')],total:1,offset:0,limit:100}));
    mount();
    await screen.findByText('Paper initial');
    const input=screen.getByRole('textbox', { name: '论文搜索' });
    fireEvent.change(input,{target:{value:'older'}});
    await waitFor(()=>expect(mocks.paperPage).toHaveBeenCalledWith(expect.objectContaining({query:'older'})));
    fireEvent.change(input,{target:{value:'newer'}});
    await screen.findByText('Paper newer');
    await act(async()=>{old.resolve({items:[paper('older')],total:1,offset:0,limit:100});});
    expect(screen.queryByText('Paper older')).toBeNull();
    expect(screen.getByText('Paper newer')).toBeTruthy();
    fireEvent.click(screen.getByText('星标'));
    await waitFor(()=>expect(mocks.paperPage).toHaveBeenCalledWith(expect.objectContaining({favorite:true,limit:100,offset:0})));
  });
  it('opens the most recently selected paper when detail requests resolve out of order',async()=>{
    const first=deferred<any>(),second=deferred<any>();
    mocks.paperPage.mockResolvedValue({items:[paper('A'),paper('B')],total:2,offset:0,limit:100});
    mocks.getPaper.mockImplementation((id)=>id==='A'?first.promise:second.promise);
    mount();
    // Single click previews (Inspector); double click opens the reader.
    fireEvent.doubleClick(await screen.findByText('Paper A'));
    fireEvent.doubleClick(screen.getByText('Paper B'));
    await act(async()=>{second.resolve({...paper('B'),versions:[]});});
    await screen.findByText('Reading Paper B');
    await act(async()=>{first.resolve({...paper('A'),versions:[]});});
    expect(screen.queryByText('Reading Paper A')).toBeNull();
    expect(screen.getByText('Reading Paper B')).toBeTruthy();
  });
  it('keeps multiple readers mounted and switches between workspace tabs without unloading them',async()=>{
    mocks.paperPage.mockResolvedValue({items:[paper('A'),paper('B')],total:2,offset:0,limit:100});
    mocks.getPaper.mockImplementation(async(id:string)=>({...paper(id),versions:[]}));
    mount();
    fireEvent.doubleClick(await screen.findByText('Paper A'));
    await screen.findByText('Reading Paper A');
    fireEvent.click(screen.getByRole('tab',{name:/论文库/}));
    fireEvent.doubleClick(await screen.findByText('Paper B'));
    await screen.findByText('Reading Paper B');
    // Both readers stay mounted; only the active pane is visible.
    expect(screen.getByText('Reading Paper A')).toBeTruthy();
    expect(screen.getByText('Reading Paper A').closest('.workspace-pane')?.hasAttribute('hidden')).toBe(true);
    expect(screen.getByText('Reading Paper A').parentElement?.getAttribute('data-active')).toBe('false');
    fireEvent.click(screen.getByRole('tab',{name:/Paper A/}));
    expect(screen.getByText('Reading Paper A').closest('.workspace-pane')?.hasAttribute('hidden')).toBe(false);
    expect(screen.getByText('Reading Paper A').parentElement?.getAttribute('data-active')).toBe('true');
    fireEvent.click(screen.getByRole('button',{name:'关闭 Paper A'}));
    await waitFor(()=>expect(screen.queryByText('Reading Paper A')).toBeNull());
    expect(screen.getByText('Reading Paper B')).toBeTruthy();
  });
  it('refreshes every open tab when a background job completes',async()=>{
    let listener:(event:any)=>void=()=>undefined;
    mocks.onEvent.mockImplementation((callback:any)=>{listener=callback;return ()=>undefined;});
    mocks.paperPage.mockResolvedValue({items:[paper('A'),paper('B')],total:2,offset:0,limit:100});
    let aVersions=0;
    mocks.getPaper.mockImplementation(async(id:string)=>id==='A'
      ? {...paper('A'),versions:aVersions?[{id:'t',paper_id:'A',kind:'translated',sha256:'x',rel_path:'x',pages:1,bytes:1,lang:'zh',created_at:1}]:[]}
      : {...paper('B'),versions:[]});
    mount();
    fireEvent.doubleClick(await screen.findByText('Paper A'));
    await screen.findByText('Reading Paper A');
    fireEvent.click(screen.getByRole('tab',{name:/论文库/}));
    fireEvent.doubleClick(await screen.findByText('Paper B'));
    await screen.findByText('Reading Paper B');
    aVersions=1;
    await act(async()=>{listener({event:'job',jobId:'j1',status:'completed'});});
    await waitFor(()=>expect(screen.getByText('Reading Paper A').closest('.workspace-pane')?.querySelector('[data-versions="1"]')).toBeTruthy());
  });
});
