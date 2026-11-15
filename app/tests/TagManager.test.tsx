import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import TagManager from '../src/TagManager';
const {tagRename,tagSetColor,tagDelete}=vi.hoisted(()=>({tagRename:vi.fn(),tagSetColor:vi.fn(),tagDelete:vi.fn()}));
vi.mock('../src/api',()=>({api:{tagRename,tagSetColor,tagDelete}}));
const tags=[{id:'t1',name:'KV Cache',color:'#256353'},{id:'t2',name:'量化',color:null}];
describe('tag management',()=>{
  it('renames and recolors a tag in one save',async()=>{
    tagRename.mockResolvedValue({id:'t2',name:'量化推理',color:null});
    tagSetColor.mockResolvedValue({id:'t2',name:'量化推理',color:'#366ca0'});
    const changed=vi.fn().mockResolvedValue(undefined);
    render(<TagManager tags={tags} onChanged={changed} onClose={vi.fn()}/>);
    fireEvent.click(screen.getByText('量化'));
    fireEvent.change(screen.getByLabelText('标签名称'),{target:{value:'量化推理'}});
    fireEvent.click(screen.getByLabelText('使用颜色 #366ca0'));
    fireEvent.click(screen.getByRole('button',{name:'保存标签'}));
    await waitFor(()=>expect(tagRename).toHaveBeenCalledWith('t2','量化推理'));
    await waitFor(()=>expect(tagSetColor).toHaveBeenCalledWith('t2','#366ca0'));
    expect(changed).toHaveBeenCalled();
  });
  it('deletes a tag after confirmation without deleting papers',async()=>{
    tagDelete.mockResolvedValue({ok:true,deleted:'t1',papers_unassigned:4});
    vi.spyOn(window,'confirm').mockReturnValue(true);
    const changed=vi.fn().mockResolvedValue(undefined);
    render(<TagManager tags={tags} onChanged={changed} onClose={vi.fn()}/>);
    fireEvent.click(screen.getByText('KV Cache'));
    fireEvent.click(screen.getByRole('button',{name:'删除标签'}));
    await waitFor(()=>expect(tagDelete).toHaveBeenCalledWith('t1'));
    expect(changed).toHaveBeenCalled();
  });
});
