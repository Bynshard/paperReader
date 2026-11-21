import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import FolderTree from '../src/FolderTree';
import TaxonomyList from '../src/TaxonomyList';

const api = vi.hoisted(() => ({
  saveCategory: vi.fn(), folderMove: vi.fn(), folderDelete: vi.fn(),
  tagRename: vi.fn(), tagSetColor: vi.fn(), tagDelete: vi.fn(),
}));
vi.mock('../src/api', () => ({ api }));

function dataTransfer(ids: string[]) {
  return {
    types: ['application/x-moonlight-paper-ids'],
    getData: () => JSON.stringify(ids),
    setData: vi.fn(),
    effectAllowed: '',
    dropEffect: 'none',
  } as unknown as DataTransfer;
}

beforeEach(() => {
  vi.clearAllMocks();
  api.saveCategory.mockResolvedValue({});
  api.folderMove.mockResolvedValue({});
  api.folderDelete.mockResolvedValue({});
  api.tagRename.mockResolvedValue({});
  api.tagSetColor.mockResolvedValue({});
  api.tagDelete.mockResolvedValue({});
});

describe('taxonomy drag, counts and context menus', () => {
  it('drops dragged papers onto a folder and shows its paper count', async () => {
    const onDrop = vi.fn();
    const { container } = render(<FolderTree items={[{ id: 'f1', name: 'ML', parent_id: null, paper_count: 3 }]} onSelect={vi.fn()} onDropPapers={onDrop} onChanged={vi.fn()} />);
    const row = container.querySelector('.folder-row')!;
    expect(screen.getByText('3')).toBeTruthy();
    fireEvent.dragOver(row, { dataTransfer: dataTransfer(['p1', 'p2']) });
    fireEvent.drop(row, { dataTransfer: dataTransfer(['p1', 'p2']) });
    expect(onDrop).toHaveBeenCalledWith(['p1', 'p2'], 'f1');
  });

  it('creates a subfolder from the folder context menu', async () => {
    const changed = vi.fn();
    const { container } = render(<FolderTree items={[{ id: 'f1', name: 'ML', parent_id: null, paper_count: 0 }]} onSelect={vi.fn()} onChanged={changed} />);
    vi.spyOn(window, 'prompt').mockReturnValue('NLP');
    fireEvent.contextMenu(container.querySelector('.folder-row')!);
    fireEvent.click(await screen.findByText('新建子目录'));
    fireEvent.change(screen.getByLabelText('子目录名称'), { target: { value: 'NLP' } });
    fireEvent.click(screen.getByText('保存'));
    await waitFor(() => expect(api.saveCategory).toHaveBeenCalledWith({ name: 'NLP', parent_id: 'f1' }));
    expect(changed).toHaveBeenCalled();
  });

  it('drops papers onto a tag and renames it from the context menu', async () => {
    const onDrop = vi.fn();
    render(<TaxonomyList items={[{ id: 't1', name: 'memory', color: '#6fce93', paper_count: 4 }]} label="tags" selected={undefined} onSelect={vi.fn()} onDropPapers={onDrop} onChanged={vi.fn()} />);
    const row = screen.getByText('memory').closest('button')!;
    expect(screen.getByText('4')).toBeTruthy();
    fireEvent.drop(row, { dataTransfer: dataTransfer(['p9']) });
    expect(onDrop).toHaveBeenCalledWith(['p9'], 'memory');
    vi.spyOn(window, 'prompt').mockReturnValue('缓存');
    fireEvent.contextMenu(row);
    fireEvent.click(await screen.findByText('重命名标签'));
    fireEvent.change(screen.getByLabelText('标签名称'), { target: { value: '缓存' } });
    fireEvent.click(screen.getByText('保存'));
    await waitFor(() => expect(api.tagRename).toHaveBeenCalledWith('t1', '缓存'));
  });
});
