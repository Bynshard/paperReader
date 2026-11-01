import {render,screen,fireEvent,waitFor} from '@testing-library/react';
import {describe,it,expect,vi} from 'vitest';
import TranslationSettings from '../src/TranslationSettings';
const {action}=vi.hoisted(()=>({action:vi.fn()}));
vi.mock('../src/api',()=>({api:{translationAction:action}}));
describe('translation API configuration',()=>{
 it('provides editable API settings, clears the key after saving and shows explicit restart',async()=>{
  const initial={base_url:'',model:'',babeldoc:'',qps:2,key_configured:false,pending_restart:false};
  action.mockImplementation(async(name:string,input:any)=>name==='status'?initial:name==='save'?{...initial,...input,api_key:undefined,key_configured:true,pending_restart:true}:{});
  render(<TranslationSettings/>);
  fireEvent.change(await screen.findByLabelText('翻译 API 地址'),{target:{value:'https://provider.example/v1'}});
  fireEvent.change(screen.getByLabelText('翻译 API Key'),{target:{value:'fixture-secret'}});
  fireEvent.change(screen.getByLabelText('翻译模型 ID'),{target:{value:'academic-model'}});
  fireEvent.click(screen.getByRole('button',{name:'保存翻译配置'}));
  await screen.findByRole('button',{name:'重启并应用配置'});
  await waitFor(()=>expect((screen.getByLabelText('翻译 API Key') as HTMLInputElement).value).toBe(''));
  expect(action).toHaveBeenCalledWith('save',expect.objectContaining({base_url:'https://provider.example/v1',model:'academic-model',api_key:'fixture-secret'}));
 });
});
