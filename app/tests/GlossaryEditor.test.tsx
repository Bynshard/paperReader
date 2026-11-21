import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import GlossaryEditor, { AI_CS_PRESET_TERMS, glossaryToCsv, normalizeGlossaryTerms, parseGlossaryCsv } from '../src/GlossaryEditor';

const api = vi.hoisted(() => ({ glossary: vi.fn(), saveGlossary: vi.fn() }));
vi.mock('../src/api', () => ({ api }));

const openEditor = () => fireEvent.click(screen.getByRole('button', { name: /专业术语表/ }));

beforeEach(() => {
  api.glossary.mockReset();
  api.saveGlossary.mockReset();
  api.glossary.mockResolvedValue({
    terms: [
      { source: 'Attention', target: '注意力机制', domain: 'AI/CS', enabled: true },
      { source: 'Rollout', target: '轨迹采样' },
    ],
  });
  api.saveGlossary.mockImplementation(async (terms: { length: number }[]) => ({ ok: true, count: terms.length }));
});

describe('GlossaryEditor loading', () => {
  it('starts collapsed, loads terms from the bridge on expand and shows the count', async () => {
    render(<GlossaryEditor />);
    expect(api.glossary).not.toHaveBeenCalled();
    expect(screen.queryByLabelText('第 1 条术语原文')).toBeNull();

    openEditor();
    expect(await screen.findByDisplayValue('Attention')).toBeTruthy();
    expect(api.glossary).toHaveBeenCalledTimes(1);
    expect((screen.getByLabelText('第 2 条术语译法') as HTMLInputElement).value).toBe('轨迹采样');
    expect((screen.getByLabelText('启用第 1 条术语') as HTMLInputElement).checked).toBe(true);
    expect(screen.getByText('2 条')).toBeTruthy();
  });

  it('surfaces a load error without breaking the pane', async () => {
    api.glossary.mockRejectedValue(new Error('bridge offline'));
    render(<GlossaryEditor defaultOpen />);
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', 'bridge offline');
    expect(screen.getByText('0 条')).toBeTruthy();
  });
});

describe('GlossaryEditor editing and saving', () => {
  it('adds, edits, toggles and deletes rows', async () => {
    render(<GlossaryEditor defaultOpen />);
    await screen.findByDisplayValue('Attention');

    fireEvent.click(screen.getByRole('button', { name: /添加术语/ }));
    expect(screen.getByText('3 条')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('第 3 条术语原文'), { target: { value: 'Alignment' } });
    fireEvent.change(screen.getByLabelText('第 3 条术语译法'), { target: { value: '对齐' } });
    fireEvent.change(screen.getByLabelText('第 3 条术语领域'), { target: { value: 'AI/CS' } });
    fireEvent.click(screen.getByLabelText('启用第 2 条术语'));
    expect((screen.getByLabelText('启用第 2 条术语') as HTMLInputElement).checked).toBe(false);

    fireEvent.click(screen.getByRole('button', { name: '删除第 1 条术语' }));
    expect(screen.getByText('2 条')).toBeTruthy();
    expect((screen.getByLabelText('第 1 条术语原文') as HTMLInputElement).value).toBe('Rollout');

    fireEvent.click(screen.getByRole('button', { name: /保存术语表/ }));
    await waitFor(() => expect(api.saveGlossary).toHaveBeenCalledWith([
      { source: 'Rollout', target: '轨迹采样', enabled: false },
      { source: 'Alignment', target: '对齐', domain: 'AI/CS', enabled: true },
    ]));
    expect(await screen.findByText('已保存 2 条术语')).toBeTruthy();
  });

  it('deduplicates by source (case-insensitive) and drops incomplete rows before saving', async () => {
    render(<GlossaryEditor defaultOpen />);
    await screen.findByDisplayValue('Attention');

    // lowercase duplicate of an existing source — first mapping must win
    fireEvent.change(screen.getByLabelText('第 1 条术语译法'), { target: { value: '注意力' } });
    fireEvent.click(screen.getByRole('button', { name: /添加术语/ }));
    fireEvent.change(screen.getByLabelText('第 3 条术语原文'), { target: { value: 'attention' } });
    fireEvent.change(screen.getByLabelText('第 3 条术语译法'), { target: { value: '注意' } });
    // incomplete row: source without target
    fireEvent.click(screen.getByRole('button', { name: /添加术语/ }));
    fireEvent.change(screen.getByLabelText('第 4 条术语原文'), { target: { value: 'Head' } });

    fireEvent.click(screen.getByRole('button', { name: /保存术语表/ }));
    await waitFor(() => expect(api.saveGlossary).toHaveBeenCalledTimes(1));
    expect(api.saveGlossary.mock.calls[0]?.[0]).toEqual([
      { source: 'Attention', target: '注意力', domain: 'AI/CS', enabled: true },
      { source: 'Rollout', target: '轨迹采样', enabled: true },
    ]);
    expect(await screen.findByText('已保存 2 条术语')).toBeTruthy();
    expect(screen.getByText('2 条')).toBeTruthy();
  });

  it('refuses to save when no row has both source and target', async () => {
    api.glossary.mockResolvedValue({ terms: [] });
    render(<GlossaryEditor defaultOpen />);
    await screen.findByText('0 条');
    fireEvent.click(screen.getByRole('button', { name: /添加术语/ }));
    fireEvent.change(screen.getByLabelText('第 1 条术语原文'), { target: { value: 'Token' } });
    fireEvent.click(screen.getByRole('button', { name: /保存术语表/ }));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('请至少填写一条');
    expect(api.saveGlossary).not.toHaveBeenCalled();
  });

  it('reports a save failure from the bridge', async () => {
    api.saveGlossary.mockRejectedValue(new Error('write failed'));
    render(<GlossaryEditor defaultOpen />);
    await screen.findByDisplayValue('Attention');
    fireEvent.click(screen.getByRole('button', { name: /保存术语表/ }));
    expect(await screen.findByText('write failed')).toBeTruthy();
  });
});

describe('GlossaryEditor CSV import/export', () => {
  it('parses a header, quoted commas and blank lines and ignores malformed rows', () => {
    const parsed = parseGlossaryCsv([
      'source,target,domain',
      '"Attention, self",注意力,AI/CS',
      'Rollout,"轨迹,采样"',
      '',
      'Token,词元,AI/CS',
      'Head,',
      '注意,注意力机制',
    ].join('\n'));
    expect(parsed).toEqual([
      { source: 'Attention, self', target: '注意力', domain: 'AI/CS', enabled: true },
      { source: 'Rollout', target: '轨迹,采样', enabled: true },
      { source: 'Token', target: '词元', domain: 'AI/CS', enabled: true },
      { source: '注意', target: '注意力机制', enabled: true },
    ]);
  });

  it('serializes terms to CSV and quotes cells containing commas or quotes', () => {
    const csv = glossaryToCsv([
      { source: 'Attention, self', target: '注意力', domain: 'AI/CS' },
      { source: 'Head', target: '注意力头', enabled: false },
      { source: 'Quote"d', target: '引号' },
    ]);
    expect(csv).toBe([
      'source,target,domain',
      '"Attention, self",注意力,AI/CS',
      'Head,注意力头,',
      '"Quote""d",引号,',
    ].join('\n'));
  });

  it('normalizes and deduplicates terms for the bridge payload', () => {
    expect(normalizeGlossaryTerms([
      { source: ' Token ', target: ' 词元 ' },
      { source: 'token', target: '令牌' },
      { source: 'Head', target: '' },
    ])).toEqual([{ source: 'Token', target: '词元', enabled: true }]);
  });

  it('imports a CSV file through the picker and skips duplicates already loaded', async () => {
    render(<GlossaryEditor defaultOpen />);
    await screen.findByDisplayValue('Attention');
    const file = new File([
      'source,target\nAttention,注意\nHead,注意力头,AI/CS\nAlignment,"对齐, 校准"\n',
    ], 'glossary.csv', { type: 'text/csv' });
    fireEvent.change(screen.getByLabelText('导入术语 CSV 文件'), { target: { files: [file] } });

    expect(await screen.findByText(/已导入 2 条术语（跳过 1 条重复）/)).toBeTruthy();
    expect(screen.getByText('4 条')).toBeTruthy();
    expect((screen.getByLabelText('第 4 条术语译法') as HTMLInputElement).value).toBe('对齐, 校准');
    // the pre-existing Attention mapping is preserved
    expect((screen.getByLabelText('第 1 条术语译法') as HTMLInputElement).value).toBe('注意力机制');
  });

  it('rejects a CSV file with no usable terms', async () => {
    api.glossary.mockResolvedValue({ terms: [] });
    render(<GlossaryEditor defaultOpen />);
    await screen.findByText('0 条');
    const file = new File(['only-one-column\n\n'], 'bad.csv', { type: 'text/csv' });
    fireEvent.change(screen.getByLabelText('导入术语 CSV 文件'), { target: { files: [file] } });
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('CSV 中没有可用术语');
  });

  it('downloads the current rows as CSV', async () => {
    const createObjectURL = vi.fn(() => 'blob:glossary');
    const revokeObjectURL = vi.fn();
    Object.defineProperty(URL, 'createObjectURL', { configurable: true, writable: true, value: createObjectURL });
    Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, writable: true, value: revokeObjectURL });
    const anchorClick = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);

    render(<GlossaryEditor defaultOpen />);
    await screen.findByDisplayValue('Attention');
    fireEvent.click(screen.getByRole('button', { name: /导出 CSV/ }));
    expect(await screen.findByText('已导出 2 条术语 CSV')).toBeTruthy();
    expect(createObjectURL).toHaveBeenCalledTimes(1);
    expect(anchorClick).toHaveBeenCalledTimes(1);
    anchorClick.mockRestore();
  });
});

describe('GlossaryEditor AI/CS presets', () => {
  it('inserts the curated preset set, skips existing sources and saves them', async () => {
    render(<GlossaryEditor defaultOpen />);
    await screen.findByDisplayValue('Attention');

    fireEvent.click(screen.getByRole('button', { name: /导入 AI\/CS 常用预设/ }));
    // the two loaded terms (Attention, Rollout) are already in the preset set
    expect(await screen.findByText(`已加入 ${AI_CS_PRESET_TERMS.length - 2} 条 AI/CS 常用预设（跳过 2 条已存在）；点击「保存术语表」生效`)).toBeTruthy();
    expect(screen.getByText(`${AI_CS_PRESET_TERMS.length} 条`)).toBeTruthy();
    expect((screen.getByLabelText(`第 ${AI_CS_PRESET_TERMS.length} 条术语原文`) as HTMLInputElement).value).toBe('Fine-tuning');
    expect((screen.getByLabelText(`第 ${AI_CS_PRESET_TERMS.length} 条术语译法`) as HTMLInputElement).value).toBe('微调');

    fireEvent.click(screen.getByRole('button', { name: /保存术语表/ }));
    await waitFor(() => expect(api.saveGlossary).toHaveBeenCalledTimes(1));
    const saved = api.saveGlossary.mock.calls[0]?.[0] as { source: string; target: string }[];
    expect(saved).toHaveLength(AI_CS_PRESET_TERMS.length);
    expect(saved.find((term) => term.source === 'Token')).toMatchObject({ source: 'Token', target: '词元' });
    // the pre-existing Attention mapping wins over the preset
    expect(saved.find((term) => term.source === 'Attention')).toMatchObject({ target: '注意力机制' });
  });
});
