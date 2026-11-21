import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import App from '../src/App';

const mocks = vi.hoisted(() => ({
  paperPage: vi.fn(), taxonomy: vi.fn(), appInfo: vi.fn(), getPaper: vi.fn(), syncStatus: vi.fn(),
  listJobs: vi.fn(), onEvent: vi.fn(() => () => undefined), synthesisMatrix: vi.fn(),
}));
vi.mock('../src/api', () => ({ api: mocks }));
vi.mock('../src/Reader', () => ({
  default: ({ paper, initialPage }: { paper: { title: string }; initialPage?: number }) =>
    <div>Reading {paper.title} page {initialPage ?? 0}</div>,
}));

const paper = (id: string) => ({
  id, title: `Paper ${id}`, authors: 'Author', imported_at: 0, updated_at: 0, favorite: false,
  read_status: 'unread', deleted: false, categories: [], tags: [], has_translation: false,
});

function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  return render(<QueryClientProvider client={client}><App /></QueryClientProvider>);
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.taxonomy.mockResolvedValue({ categories: [], tags: [] });
  mocks.appInfo.mockResolvedValue({});
  mocks.syncStatus.mockResolvedValue({ configured: false, running: false });
  mocks.listJobs.mockResolvedValue([]);
  mocks.onEvent.mockImplementation(() => () => undefined);
  mocks.paperPage.mockResolvedValue({ items: [paper('A'), paper('B')], total: 2, offset: 0, limit: 100 });
  mocks.getPaper.mockImplementation(async (id: string) => ({ ...paper(id), versions: [] }));
});

describe('Batch F library batch bar wiring', () => {
  it('opens the comparison matrix from the batch bar and jumps the reader to a cited page', async () => {
    mocks.synthesisMatrix.mockResolvedValue({
      dimensions: ['研究问题'],
      rows: [{ paper_id: 'A', title: 'Paper A', cells: { '研究问题': { text: '跨论文证据', page: 4 } } }],
    });
    mount();
    fireEvent.click(await screen.findByLabelText('选择当前页论文'));

    const bar = await screen.findByRole('toolbar', { name: '批量操作' });
    expect(within(bar).getByRole('button', { name: '💬 跨论文提问' })).toBeTruthy();
    expect(within(bar).getByRole('button', { name: '📊 生成对比矩阵' })).toBeTruthy();
    expect(within(bar).getByRole('button', { name: '🤖 整理 Agent' })).toBeTruthy();

    fireEvent.click(within(bar).getByRole('button', { name: '📊 生成对比矩阵' }));
    const modal = await screen.findByRole('dialog', { name: '生成对比矩阵' });
    fireEvent.click(within(modal).getByRole('button', { name: '生成矩阵' }));
    await waitFor(() => expect(mocks.synthesisMatrix).toHaveBeenCalledWith(['A', 'B'], undefined));
    await within(modal).findByRole('table', { name: '文献对比矩阵' });

    fireEvent.click(within(modal).getByRole('button', { name: '打开 Paper A 第 5 页' }));
    expect(await screen.findByText('Reading Paper A page 5')).toBeTruthy();
    expect(mocks.getPaper).toHaveBeenCalledWith('A');
    expect(screen.queryByRole('dialog', { name: '生成对比矩阵' })).toBeNull();
  });

  it('opens the reviewable library agent from the batch bar', async () => {
    mount();
    fireEvent.click(await screen.findByLabelText('选择当前页论文'));
    const bar = await screen.findByRole('toolbar', { name: '批量操作' });
    fireEvent.click(within(bar).getByRole('button', { name: '🤖 整理 Agent' }));
    const modal = await screen.findByRole('dialog', { name: '整理 Agent' });
    expect(within(modal).getByRole('button', { name: '自动归类到现有目录' })).toBeTruthy();
    expect(within(modal).getByRole('button', { name: '生成整理计划' })).toBeTruthy();
  });
});
