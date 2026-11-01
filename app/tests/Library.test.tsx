import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import Library from '../src/Library';
import type { PaperSummary } from '../src/types';
function paper(index: number): PaperSummary {
  return {id:String(index),title:`Paper ${index}`,authors:'Author',imported_at:index,updated_at:index,favorite:false,read_status:'unread',deleted:false,categories:[],tags:[],has_translation:false};
}
function props(papers: PaperSummary[]) {
  return {papers,total:papers.length,loading:false,sort:'recent' as const,onSort:vi.fn(),offset:0,pageSize:100,onOffset:vi.fn(),query:'',onQuery:vi.fn(),onOpen:vi.fn(),onImport:vi.fn(),onToggleFavorite:vi.fn(),onTrash:vi.fn(),onRestore:vi.fn(),onPurge:vi.fn(),onExport:vi.fn(),onZotero:vi.fn(),importing:false};
}
describe('virtual paper library',()=>{
  it('bounds DOM nodes for 100,000 supplied rows and opens the actual row',async()=>{
    const p=props(Array.from({length:100000},(_,i)=>paper(i)));
    const {container}=render(<Library {...p}/>);
    await waitFor(()=>expect(container.querySelectorAll('.paper-row').length).toBeGreaterThan(0));
    expect(container.querySelectorAll('.paper-row').length).toBeLessThan(30);
    fireEvent.click(screen.getByText('Paper 0'));
    expect(p.onOpen).toHaveBeenCalledWith(p.papers[0]);
  });
  it('passes sorting and pagination to the server query owner',()=>{
    const p={...props([paper(99)]),total:100000};
    render(<Library {...p}/>);
    fireEvent.change(screen.getByLabelText('论文排序'),{target:{value:'title'}});
    expect(p.onSort).toHaveBeenCalledWith('title');
    fireEvent.click(screen.getByText('下一页'));
    expect(p.onOffset).toHaveBeenCalledWith(100);
  });
});

describe('library organization controls',()=>{
  it('selects the current page for classification and edits a short note without opening a PDF',async()=>{
    const first={...paper(1),short_note:'旧速记',citation_count:0,citation_source:'Crossref'},second=paper(2);
    const p={...props([first,second]),onOrganize:vi.fn(),onShortNote:vi.fn().mockResolvedValue(undefined)};
    render(<Library {...p}/>);
    fireEvent.click(screen.getByRole('button',{name:'卡片',exact:true}));
    await screen.findByText('Paper 1');
    fireEvent.click(screen.getByLabelText('选择当前页论文'));
    fireEvent.click(screen.getAllByRole('button',{name:'分类 / 标签',exact:true})[0]);expect(p.onOrganize).toHaveBeenCalledWith(['1','2']);
    fireEvent.click(screen.getAllByRole('button',{name:'速记',exact:true})[0]);
    fireEvent.change(screen.getByLabelText('一句话速记 Paper 1'),{target:{value:'一句话记住关键贡献'}});fireEvent.click(screen.getByRole('button',{name:'保存速记'}));
    await waitFor(()=>expect(p.onShortNote).toHaveBeenCalledWith(expect.objectContaining({id:'1',updated_at:1}),'一句话记住关键贡献'));
    expect(p.onOpen).not.toHaveBeenCalled();expect(screen.getByText(/引用 0/)).toBeTruthy();expect(screen.getByText('引用量未知')).toBeTruthy();
  });
});

describe('Style-inspired table view',()=>{
  it('sorts via the server callback and persists visible columns and display mode',async()=>{
    const p={...props([paper(0),paper(1)]),onOrganize:vi.fn(),onShortNote:vi.fn()};
    render(<Library {...p}/>);
    await screen.findByRole('table',{name:'论文增强列表'});
    fireEvent.click(screen.getByRole('button',{name:'引用量',exact:true}));expect(p.onSort).toHaveBeenCalledWith('citations');
    fireEvent.click(screen.getByRole('button',{name:'显示列',exact:true}));
    const checkbox=screen.getByRole('checkbox',{name:'一句话速记',exact:true});fireEvent.click(checkbox);
    await waitFor(()=>expect(JSON.parse(localStorage.getItem('moonlight-library-columns-v1')||'{}').visibility.short_note).toBe(false));
    expect(screen.queryByRole('columnheader',{name:'一句话速记'})).toBeNull();
    fireEvent.click(screen.getByRole('button',{name:'卡片',exact:true}));await waitFor(()=>expect(localStorage.getItem('moonlight-library-view-v1')).toBe('cards'));
  });
});
