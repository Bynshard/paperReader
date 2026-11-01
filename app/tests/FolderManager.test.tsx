import {render,screen,fireEvent,waitFor} from '@testing-library/react';
import {describe,it,expect,vi} from 'vitest';
import FolderManager from '../src/FolderManager';
import OrganizePapers from '../src/OrganizePapers';
import {folderRows,canParent} from '../src/folders';
const {saveCategory,bulkAssign}=vi.hoisted(()=>({saveCategory:vi.fn(),bulkAssign:vi.fn()}));
vi.mock('../src/api',()=>({api:{saveCategory,bulkAssign}}));
const folders=[{id:'parent',name:'强化学习'},{id:'child',name:'RLHF',parent_id:'parent'}];
describe('library organization',()=>{
 it('shows real paths and prevents assigning a descendant as parent',()=>{expect(folderRows(folders).map(c=>c.path)).toEqual(['强化学习','强化学习 / RLHF']);expect(canParent(folders,'child','parent')).toBe(false);});
 it('creates a subfolder using its actual parent ID',async()=>{
  saveCategory.mockResolvedValue({id:'new',name:'性能',parent_id:'child'});const changed=vi.fn().mockResolvedValue(undefined);
  render(<FolderManager items={folders} onChanged={changed} onClose={vi.fn()}/>);
  fireEvent.change(screen.getByLabelText('目录名称'),{target:{value:'性能'}});fireEvent.change(screen.getByLabelText('上级目录'),{target:{value:'child'}});fireEvent.click(screen.getByRole('button',{name:'新建目录'}));
  await waitFor(()=>expect(saveCategory).toHaveBeenCalledWith({id:undefined,name:'性能',parent_id:'child'}));await screen.findByText('目录已保存');
 });
 it('adds tags and a directory to exactly the selected papers',async()=>{
  bulkAssign.mockResolvedValue({updated:2});const close=vi.fn();render(<OrganizePapers ids={['a','b']} categories={folders} tags={[]} onSaved={vi.fn().mockResolvedValue(undefined)} onClose={close}/>);
  fireEvent.change(screen.getByLabelText('添加到目录'),{target:{value:'child'}});fireEvent.change(screen.getByLabelText('批量标签'),{target:{value:'待读，方法,待读'}});fireEvent.click(screen.getByRole('button',{name:'保存分类与标签'}));
  await waitFor(()=>expect(bulkAssign).toHaveBeenCalledWith({paper_ids:['a','b'],category_id:'child',tags:['待读','方法']}));await waitFor(()=>expect(close).toHaveBeenCalled());
 });
});
