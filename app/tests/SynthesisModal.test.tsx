import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ synthesisMatrix: vi.fn(), saveText: vi.fn() }));
vi.mock('../src/api', () => ({ api: mocks }));

import SynthesisModal from '../src/SynthesisModal';

const matrix = {
  dimensions: ['研究问题', '核心方法'],
  rows: [
    { paper_id: 'p1', title: 'Paper 1', cells: { '研究问题': { text: '研究问题 A', page: 3 }, '核心方法': { text: '方法 A' } } },
    { paper_id: 'p2', title: 'Paper 2', cells: { '研究问题': { text: '研究问题 B' }, '核心方法': { text: '方法 B', page: 0 } } },
  ],
};

function mount(onOpenPaper = vi.fn()) {
  render(<SynthesisModal paperIds={['p1', 'p2']} onOpenPaper={onOpenPaper} onClose={vi.fn()} />);
  return { onOpenPaper };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.synthesisMatrix.mockResolvedValue(matrix);
  mocks.saveText.mockResolvedValue({ saved: true });
});

describe('SynthesisModal matrix (FEAT-AI-02)', () => {
  it('runs the backend default dimensions, renders an editable table and opens the cited page', async () => {
    const { onOpenPaper } = mount();
    fireEvent.click(screen.getByRole('button', { name: '生成矩阵' }));

    expect(await screen.findByRole('table', { name: '文献对比矩阵' })).toBeTruthy();
    expect(mocks.synthesisMatrix).toHaveBeenCalledWith(['p1', 'p2'], undefined);
    expect(screen.getByText('Paper 1')).toBeTruthy();
    expect((screen.getByLabelText('Paper 1 · 研究问题') as HTMLTextAreaElement).value).toBe('研究问题 A');
    expect((screen.getByLabelText('Paper 2 · 核心方法') as HTMLTextAreaElement).value).toBe('方法 B');

    fireEvent.click(screen.getByRole('button', { name: '打开 Paper 1 第 4 页' }));
    expect(onOpenPaper).toHaveBeenCalledWith('p1', 4);
    // page 0 is a real page: one-based, so it opens page 1.
    fireEvent.click(screen.getByRole('button', { name: '打开 Paper 2 第 1 页' }));
    expect(onOpenPaper).toHaveBeenCalledWith('p2', 1);
  });

  it('sends custom dimensions, keeps edits and exports Markdown with page evidence', async () => {
    mount();
    fireEvent.change(screen.getByLabelText('对比维度'), { target: { value: '显存开销, 推理延迟' } });
    fireEvent.click(screen.getByRole('button', { name: '生成矩阵' }));
    await screen.findByRole('table', { name: '文献对比矩阵' });
    expect(mocks.synthesisMatrix).toHaveBeenCalledWith(['p1', 'p2'], ['显存开销', '推理延迟']);

    fireEvent.change(screen.getByLabelText('Paper 1 · 研究问题'), { target: { value: '人工修改后的结论' } });
    fireEvent.click(screen.getByRole('button', { name: '导出 Markdown' }));

    await waitFor(() => expect(mocks.saveText).toHaveBeenCalledTimes(1));
    const [name, body] = mocks.saveText.mock.calls[0] as [string, string];
    expect(name).toMatch(/^论文对比矩阵-\d{4}-\d{2}-\d{2}\.md$/);
    expect(body).toContain('| 论文 |');
    expect(body).toContain('人工修改后的结论 [p.4]');
    expect(await screen.findByText('已导出 Markdown')).toBeTruthy();
  });

  it('exports CSV with quoted cells and fires a CSV save', async () => {
    mocks.synthesisMatrix.mockResolvedValue({
      dimensions: ['主要局限'],
      rows: [{ paper_id: 'p1', title: 'Paper 1', cells: { '主要局限': { text: '样本少, 未开源', page: 7 } } }],
    });
    mount();
    fireEvent.click(screen.getByRole('button', { name: '生成矩阵' }));
    await screen.findByRole('table', { name: '文献对比矩阵' });
    fireEvent.click(screen.getByRole('button', { name: '导出 CSV' }));

    await waitFor(() => expect(mocks.saveText).toHaveBeenCalledTimes(1));
    const [name, body] = mocks.saveText.mock.calls[0] as [string, string];
    expect(name).toMatch(/\.csv$/);
    expect(body.split('\n')[0]).toBe('论文,主要局限');
    expect(body).toContain('"样本少, 未开源 [p.8]"');
  });

  it('shows backend errors and leaves the modal closable', async () => {
    mocks.synthesisMatrix.mockRejectedValueOnce(new Error('未配置模型网关'));
    const onClose = vi.fn();
    render(<SynthesisModal paperIds={['p1', 'p2']} onOpenPaper={vi.fn()} onClose={onClose} />);
    fireEvent.click(screen.getByRole('button', { name: '生成矩阵' }));
    expect((await screen.findByRole('alert')).textContent).toContain('未配置模型网关');
    fireEvent.click(screen.getByRole('button', { name: '关闭' }));
    expect(onClose).toHaveBeenCalled();
  });

  it('reuses the matrix RPC in ask mode with the question as the only column', async () => {
    mocks.synthesisMatrix.mockResolvedValue({ dimensions: ['这些工作如何降低推理显存？'], rows: [{ paper_id: 'p1', title: 'Paper 1', cells: { '这些工作如何降低推理显存？': { text: '分块卸载', page: 2 } } }] });
    render(<SynthesisModal paperIds={['p1', 'p2']} mode="ask" onOpenPaper={vi.fn()} onClose={vi.fn()} />);
    expect(screen.queryByLabelText('对比维度')).toBeNull();
    fireEvent.change(screen.getByLabelText('跨论文问题'), { target: { value: '这些工作如何降低推理显存？' } });
    fireEvent.click(screen.getByRole('button', { name: '提问' }));
    await screen.findByRole('table', { name: '文献对比矩阵' });
    expect(mocks.synthesisMatrix).toHaveBeenCalledWith(['p1', 'p2'], ['这些工作如何降低推理显存？']);
  });
});
