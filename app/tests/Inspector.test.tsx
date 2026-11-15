import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import Inspector from '../src/Inspector';
import type { Paper } from '../src/types';
const {savePaper,refreshMetadata}=vi.hoisted(()=>({savePaper:vi.fn(),refreshMetadata:vi.fn()}));
vi.mock('../src/api',()=>({api:{savePaper,refreshMetadata}}));
const paper:Paper={id:'p1',title:'Paper',authors:'A',year:'2024',venue:'ICML',doi:'10.1/x',arxiv:'2409.1',abstract:'abs',imported_at:0,updated_at:5,favorite:false,read_status:'unread',deleted:false,notes:'notes',short_note:'note',categories:[],tags:[],versions:[]};
const categories=[{id:'c1',name:'大模型'},{id:'c2',name:'推理',parent_id:'c1'}];
describe('inspector autosave',()=>{
  it('autosaves edits and category changes to the same paper',async()=>{
    savePaper.mockImplementation(async(input)=>Object.assign({},paper,{updated_at:6,fields:input.fields}));
    render(<Inspector paper={paper} loading={false} categories={categories} onClose={vi.fn()} onOpen={vi.fn()} onSaved={vi.fn()} onToast={vi.fn()}/>);
    fireEvent.change(screen.getByLabelText('详情一句话速记'),{target:{value:'新的速记'}});
    fireEvent.click(screen.getByText('大模型 / 推理'));
    await waitFor(()=>expect(savePaper).toHaveBeenCalled(),{timeout:4000});
    const call=savePaper.mock.calls.at(-1)![0];
    expect(call.paper_id).toBe('p1');
    expect(call.fields.short_note).toBe('新的速记');
    expect(call.category_ids).toContain('c2');
  });
});
