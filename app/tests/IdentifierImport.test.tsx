import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import IdentifierImport from '../src/IdentifierImport';
const {importIdentifier}=vi.hoisted(()=>({importIdentifier:vi.fn()}));
vi.mock('../src/api',()=>({api:{importIdentifier}}));
describe('identifier import',()=>{
  it('imports an arXiv id, reports success and refreshes the library',async()=>{
    importIdentifier.mockResolvedValue({status:'imported',paper_id:'p1',title:'HybridFlow',source:'arxiv'});
    const imported=vi.fn();
    render(<IdentifierImport onClose={vi.fn()} onImported={imported}/>);
    fireEvent.change(screen.getByLabelText('DOI 或 arXiv ID'),{target:{value:'2409.19256'}});
    fireEvent.click(screen.getByRole('button',{name:'开始导入'}));
    await waitFor(()=>expect(importIdentifier).toHaveBeenCalledWith('2409.19256'));
    await waitFor(()=>expect(imported).toHaveBeenCalledWith('已导入：HybridFlow'));
    expect(screen.getByText(/已导入《HybridFlow》/)).toBeTruthy();
  });
  it('shows readable backend errors for a DOI without an open PDF',async()=>{
    importIdentifier.mockResolvedValue({status:'error',code:'import-failed',error:'该 DOI 没有可下载的开放 PDF，可在浏览器下载后拖入导入'});
    render(<IdentifierImport onClose={vi.fn()} onImported={vi.fn()}/>);
    fireEvent.change(screen.getByLabelText('DOI 或 arXiv ID'),{target:{value:'10.1145/3600006.3613139'}});
    fireEvent.click(screen.getByRole('button',{name:'开始导入'}));
    expect(await screen.findByText(/没有可下载的开放 PDF/)).toBeTruthy();
  });
  it('does not duplicate an existing paper',async()=>{
    importIdentifier.mockResolvedValue({status:'duplicate',paper_id:'p2',title:'KV Cache'});
    const imported=vi.fn();
    render(<IdentifierImport onClose={vi.fn()} onImported={imported}/>);
    fireEvent.change(screen.getByLabelText('DOI 或 arXiv ID'),{target:{value:'arXiv:2502.01111v2'}});
    fireEvent.click(screen.getByRole('button',{name:'开始导入'}));
    await waitFor(()=>expect(imported).toHaveBeenCalledWith('已存在这篇论文：KV Cache'));
    expect(screen.getByText(/已存在《KV Cache》/)).toBeTruthy();
  });
});
