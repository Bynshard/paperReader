import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import DuplicateFinder from '../src/DuplicateFinder';

const mocks = vi.hoisted(() => ({
  listDuplicates: vi.fn(), getPaper: vi.fn(), mergePapers: vi.fn(), trash: vi.fn(),
}));
vi.mock('../src/api', () => ({ api: mocks }));

function paper(id: string, versions = 0, notes = "") {
  return {
    id, title: `Paper ${id.toUpperCase()}`, authors: 'Author', imported_at: 0, updated_at: 0, favorite: false,
    read_status: 'unread', deleted: false, notes, categories: [], tags: [],
    versions: Array.from({ length: versions }, (_, index) => ({
      id: `${id}-v${index}`, paper_id: id, kind: 'source', sha256: 'x', rel_path: 'paper.pdf', pages: 1, bytes: 1, lang: 'en', created_at: index,
    })),
  };
}

function mount(onChanged = vi.fn()) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  const onClose = vi.fn(), onOpen = vi.fn();
  render(<QueryClientProvider client={client}><DuplicateFinder onClose={onClose} onOpen={onOpen} onChanged={onChanged} /></QueryClientProvider>);
  return { onClose, onOpen, onChanged };
}

const oneGroup = { count: 1, groups: [{ kind: 'doi', key: '10.1000/attention', paper_ids: ['a', 'b'], count: 2 }] };

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(window, 'confirm').mockReturnValue(true);
  mocks.getPaper.mockImplementation(async (id: string) => paper(id, id === 'b' ? 2 : 1, id === 'b' ? 'secondary notes' : ''));
});

describe('Batch E duplicate merge (FEAT-UX-02)', () => {
  it('defaults to the first row, summarises impact and merges the chosen primary', async () => {
    mocks.listDuplicates.mockResolvedValueOnce(oneGroup).mockResolvedValue({ count: 0, groups: [] });
    mocks.mergePapers.mockResolvedValue({ merged: 1 });
    const { onChanged } = mount();

    expect(await screen.findByText('Paper A')).toBeTruthy();
    expect(screen.getByText(/将合入 1 条（2 个 PDF 版本、1 条笔记）/)).toBeTruthy();
    expect((screen.getByLabelText('保留 Paper A 为主条目') as HTMLInputElement).checked).toBe(true);

    fireEvent.click(screen.getByLabelText('保留 Paper B 为主条目'));
    expect(screen.getByText(/将合入 1 条（1 个 PDF 版本）/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '合并为一条' }));

    await waitFor(() => expect(mocks.mergePapers).toHaveBeenCalledWith('b', ['a']));
    expect(window.confirm).toHaveBeenCalledWith(expect.stringContaining('将 1 条重复记录合并到「Paper B」'));
    expect(await screen.findByText(/已合并 1 条重复记录/)).toBeTruthy();
    expect(onChanged).toHaveBeenCalled();
    expect(await screen.findByText('没有发现重复论文。')).toBeTruthy();
  });

  it('does not call the backend when the user cancels the confirmation', async () => {
    (window.confirm as unknown as ReturnType<typeof vi.fn>).mockReturnValue(false);
    mocks.listDuplicates.mockResolvedValue(oneGroup);
    mount();
    expect(await screen.findByText('Paper A')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '合并为一条' }));
    expect(mocks.mergePapers).not.toHaveBeenCalled();
  });

  it('offers a per-row move-to-trash shortcut and refreshes the group list', async () => {
    mocks.listDuplicates.mockResolvedValueOnce(oneGroup).mockResolvedValue({ count: 0, groups: [] });
    mocks.trash.mockResolvedValue({ ok: true });
    const { onChanged } = mount();

    expect(await screen.findByText('Paper A')).toBeTruthy();
    const trashButtons = screen.getAllByRole('button', { name: '移入回收站' });
    expect(trashButtons).toHaveLength(2);
    fireEvent.click(trashButtons[1]);

    await waitFor(() => expect(mocks.trash).toHaveBeenCalledWith('b'));
    expect(await screen.findByText(/已移入回收站：Paper B/)).toBeTruthy();
    expect(onChanged).toHaveBeenCalled();
    expect(await screen.findByText('没有发现重复论文。')).toBeTruthy();
  });

  it('surfaces a merge failure without dropping the group', async () => {
    mocks.listDuplicates.mockResolvedValue(oneGroup);
    mocks.mergePapers.mockRejectedValue(new Error('foreign key constraint'));
    mount();
    expect(await screen.findByText('Paper A')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '合并为一条' }));
    expect(await screen.findByText(/合并失败：foreign key constraint/)).toBeTruthy();
    expect(screen.getByText('Paper A')).toBeTruthy();
  });
});
