import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import Library from '../src/Library';
import type { PaperSummary } from '../src/types';

function paper(index: number): PaperSummary {
  return { id: String(index), title: `Paper ${index}`, authors: 'Author', imported_at: index, updated_at: index, favorite: false, read_status: 'unread', deleted: false, categories: [], tags: [], has_translation: false };
}

function baseProps(papers: PaperSummary[]) {
  return {
    papers, total: papers.length, loading: false, sort: 'recent' as const, onSort: vi.fn(), offset: 0, pageSize: 100, onOffset: vi.fn(),
    query: '', onQuery: vi.fn(), onOpen: vi.fn(), onInspect: vi.fn(), onCloseInspect: vi.fn(), onCycleStatus: vi.fn(), onImport: vi.fn(), onZotero: vi.fn(),
    onToggleFavorite: vi.fn(), onTrash: vi.fn(), onTrashMany: vi.fn(), onRestore: vi.fn(), onPurge: vi.fn(), onExport: vi.fn(), onCopyCitation: vi.fn(),
    onBulkExport: vi.fn(), importing: false,
  };
}

async function mountTable(p: ReturnType<typeof baseProps>) {
  render(<Library {...p} />);
  return screen.findByRole('table', { name: '论文增强列表' });
}

describe('Batch E desktop keyboard flow (FEAT-UX-05)', () => {
  beforeEach(() => { vi.spyOn(window, 'confirm').mockReturnValue(true); });

  it('Space opens the Inspector for a highlighted row and closes it when already open', async () => {
    const p = baseProps([paper(1), paper(2)]);
    const { rerender } = render(<Library {...p} />);
    const table = await screen.findByRole('table', { name: '论文增强列表' });
    fireEvent.keyDown(table, { key: ' ' });
    expect(p.onInspect).toHaveBeenCalledWith(p.papers[0]);

    rerender(<Library {...p} inspectedId="1" />);
    fireEvent.keyDown(table, { key: ' ' });
    expect(p.onCloseInspect).toHaveBeenCalledTimes(1);
    expect(p.onInspect).toHaveBeenCalledTimes(1);
  });

  it('Ctrl/Cmd+A selects the whole current page', async () => {
    const p = baseProps([paper(1), paper(2), paper(3)]);
    const table = await mountTable(p);
    fireEvent.keyDown(table, { key: 'a', ctrlKey: true });
    const bar = await screen.findByRole('toolbar', { name: '批量操作' });
    expect(bar.textContent).toContain('已选 3 篇');
    expect((screen.getByLabelText('选择当前页论文') as HTMLInputElement).checked).toBe(true);
  });

  it('Delete trashes the selected rows after confirmation', async () => {
    const p = baseProps([paper(1), paper(2), paper(3)]);
    const table = await mountTable(p);
    fireEvent.keyDown(table, { key: 'a', ctrlKey: true });
    await screen.findByRole('toolbar', { name: '批量操作' });
    fireEvent.keyDown(table, { key: 'Delete' });
    expect(window.confirm).toHaveBeenCalledWith('将所选的 3 篇论文移入回收站？');
    expect(p.onTrashMany).toHaveBeenCalledWith(['1', '2', '3']);
    expect(p.onTrash).not.toHaveBeenCalled();
  });

  it('Backspace trashes the inspected row when nothing is selected', async () => {
    const p = { ...baseProps([paper(1), paper(2)]), inspectedId: '2' };
    const table = await mountTable(p);
    fireEvent.keyDown(table, { key: 'Backspace' });
    expect(p.onTrash).toHaveBeenCalledWith(expect.objectContaining({ id: '2' }));
    expect(p.onTrashMany).not.toHaveBeenCalled();
  });

  it('Delete trashes a single checked row even without an inspected row', async () => {
    const p = baseProps([paper(1), paper(2)]);
    const table = await mountTable(p);
    fireEvent.click(screen.getByLabelText('选择论文 Paper 1'));
    await screen.findByRole('toolbar', { name: '批量操作' });
    fireEvent.keyDown(table, { key: 'Delete' });
    expect(p.onTrash).toHaveBeenCalledWith(expect.objectContaining({ id: '1' }));
    expect(p.onTrashMany).not.toHaveBeenCalled();
  });

  it('Escape clears the selection first, then closes the Inspector', async () => {
    const p = { ...baseProps([paper(1), paper(2)]), inspectedId: '2' };
    const table = await mountTable(p);
    fireEvent.keyDown(table, { key: 'a', ctrlKey: true });
    await screen.findByRole('toolbar', { name: '批量操作' });

    fireEvent.keyDown(table, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('toolbar', { name: '批量操作' })).toBeNull());
    expect(p.onCloseInspect).not.toHaveBeenCalled();

    fireEvent.keyDown(table, { key: 'Escape' });
    expect(p.onCloseInspect).toHaveBeenCalledTimes(1);
  });

  it('Ctrl/Cmd+Shift+C copies the focused paper citation', async () => {
    const p = { ...baseProps([paper(1), paper(2)]), inspectedId: '2' };
    const table = await mountTable(p);
    fireEvent.keyDown(table, { key: 'C', ctrlKey: true, shiftKey: true });
    expect(p.onCopyCitation).toHaveBeenCalledWith(expect.objectContaining({ id: '2' }), 'gbt7714');
  });

  it('does not hijack shortcuts while focus is inside an input', async () => {
    const p = { ...baseProps([paper(1), paper(2)]) };
    const table = await mountTable(p);
    const checkbox = screen.getByLabelText('选择论文 Paper 1');
    fireEvent.keyDown(checkbox, { key: 'Delete' });
    fireEvent.keyDown(checkbox, { key: ' ' });
    expect(p.onTrash).not.toHaveBeenCalled();
    expect(p.onTrashMany).not.toHaveBeenCalled();
    expect(p.onInspect).not.toHaveBeenCalled();
    expect(table).toBeTruthy();
  });

  it('keeps the existing arrow/Enter navigation', async () => {
    const p = baseProps([paper(1), paper(2)]);
    const table = await mountTable(p);
    fireEvent.keyDown(table, { key: 'ArrowDown' });
    expect(p.onInspect).toHaveBeenCalledWith(p.papers[0]);
    fireEvent.keyDown(table, { key: 'Enter' });
    expect(p.onOpen).toHaveBeenCalledWith(p.papers[0]);
  });
});
