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
