import {render,screen,fireEvent,waitFor} from '@testing-library/react';
import {beforeEach,describe,it,expect,vi} from 'vitest';
import CloudSync from '../src/CloudSync';
const mocks=vi.hoisted(()=>({syncSettings:vi.fn(),configureSync:vi.fn(),syncStatus:vi.fn(),syncStart:vi.fn(),syncTest:vi.fn(),syncCancel:vi.fn(),syncConflicts:vi.fn(),syncResolve:vi.fn()}));
vi.mock('../src/api',()=>({api:mocks}));
beforeEach(()=>{
  vi.clearAllMocks();mocks.syncSettings.mockResolvedValue({profile:null,credentials_saved:false,auto_minutes:0});
  mocks.configureSync.mockResolvedValue({profile:{provider:'webdav'},credentials_saved:true,auto_minutes:0});
  mocks.syncStatus.mockResolvedValue({configured:false,running:false,conflicts:0});mocks.syncStart.mockResolvedValue({id:'sync'});mocks.syncTest.mockResolvedValue({id:'test'});mocks.syncCancel.mockResolvedValue({});mocks.syncResolve.mockResolvedValue({});mocks.syncConflicts.mockResolvedValue([]);
});
describe('cloud sync settings',()=>{
  it('saves a WebDAV app password through the privileged bridge and clears the input',async()=>{
    render(<CloudSync onChanged={vi.fn()}/>);
    await screen.findByText(/凭据仅用于本次会话/);
    fireEvent.change(screen.getByLabelText('WebDAV 用户名'),{target:{value:'test-user'}});
    fireEvent.change(screen.getByLabelText('WebDAV 应用密码'),{target:{value:'test-app-password'}});
    fireEvent.click(screen.getByText('保存并同步'));
    await waitFor(()=>expect(mocks.syncStart).toHaveBeenCalled());
    expect(mocks.configureSync).toHaveBeenCalledWith(expect.objectContaining({provider:'webdav',endpoint:'https://dav.jianguoyun.com/dav/',username:'test-user',password:'test-app-password'}),0);
    expect((screen.getByLabelText('WebDAV 应用密码') as HTMLInputElement).value).toBe('');
  });
  it('offers OSS and Qiniu presets without treating a bucket as WebDAV',async()=>{
    render(<CloudSync onChanged={vi.fn()}/>);
    await screen.findByText(/凭据仅用于本次会话/);
    fireEvent.change(screen.getByLabelText('同步服务'),{target:{value:'aliyun'}});
    expect((screen.getByLabelText('同步服务地址') as HTMLInputElement).value).toBe('https://oss-cn-hangzhou.aliyuncs.com');
    expect(screen.queryByLabelText('WebDAV 应用密码')).toBeNull();
    fireEvent.change(screen.getByLabelText('同步服务'),{target:{value:'qiniu'}});
    expect((screen.getByLabelText('同步服务地址') as HTMLInputElement).value).toBe('https://s3.cn-east-1.qiniucs.com');
    expect(screen.getByLabelText('同步 SecretKey')).toBeTruthy();
  });
  it('shows both versions of a note conflict and resolves the explicit choice',async()=>{
    mocks.syncStatus.mockResolvedValue({configured:true,running:false,conflicts:1});
    mocks.syncConflicts.mockResolvedValueOnce([{id:'conflict',key:'paper:p',local:{paper:{title:'Paper',notes:'My note'}},remote:{paper:{title:'Paper',notes:'Remote note'}},paths:['/paper/notes']}]).mockResolvedValue([]);
    const changed=vi.fn();render(<CloudSync onChanged={changed}/>);
    fireEvent.click(await screen.findByText('查看待处理冲突（1）'));
    await screen.findByText(/My note/);expect(screen.getByText(/Remote note/)).toBeTruthy();
    fireEvent.click(screen.getByText('采用云端冲突内容'));
    await waitFor(()=>expect(mocks.syncResolve).toHaveBeenCalledWith('conflict','remote'));await waitFor(()=>expect(changed).toHaveBeenCalled());
  });
});
