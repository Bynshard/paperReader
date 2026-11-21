import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ organizePlan: vi.fn(), bulkAssign: vi.fn(), setShortNote: vi.fn(), updatePaper: vi.fn() }));
vi.mock('../src/api', () => ({ api: mocks }));

import LibraryAgentModal, { applyBatches, type PlanRow } from '../src/LibraryAgentModal';

const categories = [{ id: 'c1', name: '强化学习' }, { id: 'c2', name: '视觉' }];
const tags = [{ id: 't1', name: 'RL' }];
const papers = [{ id: 'p1', title: 'Paper 1', updated_at: 9 }];

function mount(onApplied = vi.fn(), onClose = vi.fn()) {
  render(<LibraryAgentModal paperIds={['p1', 'p2']} papers={papers as never} categories={categories} tags={tags} onApplied={onApplied} onClose={onClose} />);
  return { onApplied, onClose };
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.bulkAssign.mockResolvedValue({ updated: 1 });
  mocks.setShortNote.mockResolvedValue({});
  mocks.updatePaper.mockResolvedValue({});
});

describe('LibraryAgentModal plan/apply (FEAT-AI-04)', () => {
  it('renders the category diff, lets the user uncheck a row and only applies selected rows', async () => {
    mocks.organizePlan.mockResolvedValue({
      plan: [
        { paper_id: 'p1', title: 'Paper 1', before: { categories: [{ id: 'c0', name: '未分类' }] }, after: { category_id: 'c2' }, reason: '主题更接近视觉' },
        { paper_id: 'p2', title: 'Paper 2', before: { category_id: 'c1' }, after: { category_id: 'c1' }, reason: '已经正确' },
      ],
    });
    const { onApplied, onClose } = mount();
    fireEvent.click(screen.getByRole('button', { name: '生成整理计划' }));

    const list = await screen.findByRole('list', { name: '整理变更预览' });
    expect(mocks.organizePlan).toHaveBeenCalledWith(['p1', 'p2'], 'categorize');
    expect(list.textContent).toContain('当前：未分类');
    expect(list.textContent).toContain('计划：视觉');
    expect(list.textContent).toContain('理由：主题更接近视觉');
    expect((screen.getByLabelText('应用 Paper 1 的变更') as HTMLInputElement).checked).toBe(true);

    fireEvent.click(screen.getByLabelText('应用 Paper 2 的变更'));
    fireEvent.click(screen.getByRole('button', { name: '应用已选变更' }));

    await waitFor(() => expect(mocks.bulkAssign).toHaveBeenCalledTimes(1));
    expect(mocks.bulkAssign).toHaveBeenCalledWith({ paper_ids: ['p1'], category_id: 'c2', tags: [] });
    expect(mocks.setShortNote).not.toHaveBeenCalled();
    await waitFor(() => expect(onApplied).toHaveBeenCalledTimes(1));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('applies tag plans through bulkAssign', async () => {
    mocks.organizePlan.mockResolvedValueOnce({
      plan: [{ paper_id: 'p1', title: 'Paper 1', before: { tags: [] }, after: { tags: ['RL', '待读'] }, reason: '主题标签' }],
    });
    const { onApplied } = mount();
    fireEvent.click(screen.getByRole('button', { name: '生成规范标签' }));
    fireEvent.click(screen.getByRole('button', { name: '生成整理计划' }));
    await screen.findByRole('list', { name: '整理变更预览' });
    expect(mocks.organizePlan).toHaveBeenCalledWith(['p1', 'p2'], 'tag');
    fireEvent.click(screen.getByRole('button', { name: '应用已选变更' }));
    await waitFor(() => expect(mocks.bulkAssign).toHaveBeenCalledWith({ paper_ids: ['p1'], tags: ['RL', '待读'] }));
    expect(onApplied).toHaveBeenCalled();
  });

  it('applies short-note plans through setShortNote with the row version', async () => {
    mocks.organizePlan.mockResolvedValueOnce({
      plan: [{ paper_id: 'p1', title: 'Paper 1', before: { short_note: '' }, after: { short_note: '用分块卸载降低显存' }, reason: '概括核心贡献' }],
    });
    const { onApplied } = mount();
    fireEvent.click(screen.getByRole('button', { name: '一句话速记' }));
    fireEvent.click(screen.getByRole('button', { name: '生成整理计划' }));
    await screen.findByRole('list', { name: '整理变更预览' });
    expect(mocks.organizePlan).toHaveBeenLastCalledWith(['p1', 'p2'], 'short_note');
    fireEvent.click(screen.getByRole('button', { name: '应用已选变更' }));
    await waitFor(() => expect(mocks.setShortNote).toHaveBeenCalledWith('p1', '用分块卸载降低显存', 9));
    expect(onApplied).toHaveBeenCalled();
  });

  it('keeps the diff open and reports the error when the plan cannot be generated', async () => {
    mocks.organizePlan.mockRejectedValueOnce(new Error('所选论文没有可用摘要'));
    mount();
    fireEvent.click(screen.getByRole('button', { name: '生成整理计划' }));
    expect((await screen.findByRole('alert')).textContent).toContain('所选论文没有可用摘要');
    expect(screen.queryByRole('list', { name: '整理变更预览' })).toBeNull();
  });

  it('groups identical category changes into one bulk assignment', () => {
    const rows: PlanRow[] = [
      { paper_id: 'a', title: 'A', before: null, after: { category_id: 'c2' }, reason: '' },
      { paper_id: 'b', title: 'B', before: null, after: { category_id: 'c2' }, reason: '' },
      { paper_id: 'c', title: 'C', before: null, after: { category_id: 'c1' }, reason: '' },
    ];
    expect(applyBatches(rows, 'categorize')).toEqual([
      { kind: 'categorize', ids: ['a', 'b'], value: 'c2' },
      { kind: 'categorize', ids: ['c'], value: 'c1' },
    ]);
  });
});
