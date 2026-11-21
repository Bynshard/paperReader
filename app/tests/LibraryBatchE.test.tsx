import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import Library from '../src/Library';
import type { PaperSummary } from '../src/types';

function paper(index: number): PaperSummary {
  return { id: String(index), title: `Paper ${index}`, authors: 'Author', imported_at: index, updated_at: index, favorite: false, read_status: 'unread', deleted: false, categories: [], tags: [], has_translation: false };
}

function baseProps(papers: PaperSummary[]) {
  return {
    papers, total: papers.length, loading: false, sort: 'recent' as const, onSort: vi.fn(), offset: 0, pageSize: 100, onOffset: vi.fn(),
    query: '', onQuery: vi.fn(), onOpen: vi.fn(), onInspect: vi.fn(), onCycleStatus: vi.fn(), onImport: vi.fn(), onZotero: vi.fn(),
    onToggleFavorite: vi.fn(), onTrash: vi.fn(), onRestore: vi.fn(), onPurge: vi.fn(), onExport: vi.fn(), onBulkExport: vi.fn(), importing: false,
  };
}

describe('Batch E bibliography import', () => {
  it('opens the picker from the import menu and forwards .bib text to the importer', async () => {
    const onImportBibliography = vi.fn().mockResolvedValue(undefined);
    const onImported = vi.fn();
    render(<Library {...baseProps([paper(1)])} onImportBibliography={onImportBibliography} onImported={onImported} />);
    fireEvent.click(screen.getByRole('button', { name: '导入论文' }));
    fireEvent.click(await screen.findByRole('button', { name: '导入 BibTeX / RIS 文献清单' }));

    const input = screen.getByLabelText('导入 BibTeX / RIS 文献清单') as HTMLInputElement;
    expect(input.type).toBe('file');
    expect(input.accept).toBe('.bib,.ris');

    const text = '@article{vaswani2017, title={Attention Is All You Need}, year={2017}}';
    fireEvent.change(input, { target: { files: [new File([text], 'refs.bib', { type: 'application/x-bibtex' })] } });
    await waitFor(() => expect(onImportBibliography).toHaveBeenCalledWith('bibtex', text));
    expect(onImported).not.toHaveBeenCalled();
  });

  it('detects RIS files and rejects unsupported extensions without calling the backend', async () => {
    const onImportBibliography = vi.fn().mockResolvedValue(undefined);
    const onImported = vi.fn();
    render(<Library {...baseProps([paper(1)])} onImportBibliography={onImportBibliography} onImported={onImported} />);
    const input = screen.getByLabelText('导入 BibTeX / RIS 文献清单') as HTMLInputElement;

    const ris = 'TY  - JOUR\nTI  - A RIS record\nER  - ';
    fireEvent.change(input, { target: { files: [new File([ris], 'refs.ris')] } });
    await waitFor(() => expect(onImportBibliography).toHaveBeenCalledWith('ris', ris));

    fireEvent.change(input, { target: { files: [new File(['notes'], 'notes.txt')] } });
    expect(onImported).toHaveBeenCalledWith('请选择 .bib 或 .ris 文献清单文件');
    expect(onImportBibliography).toHaveBeenCalledTimes(1);
  });

  it('offers GB/T 7714 and BibTeX citation copy from the row menu', async () => {
    const onCopyCitation = vi.fn();
    render(<Library {...baseProps([paper(1)])} onCopyCitation={onCopyCitation} />);
    fireEvent.click((await screen.findAllByLabelText(/更多操作/))[0]);
    fireEvent.click(await screen.findByRole('button', { name: '复制 GB/T 7714 引文' }));
    expect(onCopyCitation).toHaveBeenCalledWith(expect.objectContaining({ id: '1' }), 'gbt7714');

    fireEvent.click(screen.getAllByLabelText(/更多操作/)[0]);
    fireEvent.click(await screen.findByRole('button', { name: '复制 BibTeX' }));
    expect(onCopyCitation).toHaveBeenCalledWith(expect.objectContaining({ id: '1' }), 'bibtex');
  });

  it('disables citation copy when the host does not provide a clipboard callback', async () => {
    render(<Library {...baseProps([paper(1)])} />);
    fireEvent.click((await screen.findAllByLabelText(/更多操作/))[0]);
    expect((await screen.findByRole('button', { name: '复制 GB/T 7714 引文' }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: '复制 BibTeX' }) as HTMLButtonElement).disabled).toBe(true);
  });
});
