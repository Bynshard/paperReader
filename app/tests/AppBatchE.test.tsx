import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import App from '../src/App';

const mocks = vi.hoisted(() => ({
  paperPage: vi.fn(), taxonomy: vi.fn(), appInfo: vi.fn(), getPaper: vi.fn(), syncStatus: vi.fn(), listJobs: vi.fn(),
  onEvent: vi.fn(() => () => undefined), importBibliography: vi.fn(), exportPapers: vi.fn(),
}));
vi.mock('../src/api', () => ({ api: mocks }));
vi.mock('../src/Reader', () => ({
  default: ({ paper, onOpenSettings }: any) => (
    <div>
      <span>Reading {paper.title}</span>
      <button onClick={() => onOpenSettings?.('ai')}>open-ai-settings</button>
      <button onClick={() => onOpenSettings?.('translation')}>open-translation-settings</button>
    </div>
  ),
}));
vi.mock('../src/SettingsModal', () => ({
  default: (props: any) => <div data-testid="settings-modal" data-tab={props.initialTab}>settings:{props.initialTab}</div>,
}));

function paper(id: string) {
  return { id, title: `Paper ${id}`, authors: 'Author', imported_at: 0, updated_at: 0, favorite: false, read_status: 'unread', deleted: false, categories: [], tags: [], has_translation: false };
}

function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  return render(<QueryClientProvider client={client}><App /></QueryClientProvider>);
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.paperPage.mockResolvedValue({ items: [paper('A')], total: 1, offset: 0, limit: 100 });
  mocks.taxonomy.mockResolvedValue({ categories: [], tags: [] });
  mocks.appInfo.mockResolvedValue({ version: '0.1.0', library: '/tmp/lib', headless: false, model: 'gpt', credentialConfigured: false });
  mocks.syncStatus.mockResolvedValue({ configured: false, running: false });
  mocks.listJobs.mockResolvedValue([]);
});

describe('Batch E App integration (FEAT-UX-01)', () => {
  it('opens the settings modal on the general pane from the sidebar', async () => {
    mount();
    await screen.findByText('Paper A');
    fireEvent.click(screen.getByRole('button', { name: '设置与状态' }));
    expect((await screen.findByTestId('settings-modal')).getAttribute('data-tab')).toBe('general');
  });

  it('lets the reader jump straight to the AI / translation settings panes', async () => {
    mocks.getPaper.mockResolvedValue({ ...paper('A'), versions: [] });
    mount();
    fireEvent.doubleClick(await screen.findByText('Paper A'));
    fireEvent.click(await screen.findByText('open-ai-settings'));
    expect((await screen.findByTestId('settings-modal')).getAttribute('data-tab')).toBe('ai');
    fireEvent.click(screen.getByText('open-translation-settings'));
    expect(screen.getByTestId('settings-modal').getAttribute('data-tab')).toBe('translation');
  });
});

describe('Batch E App import and citation flows (FEAT-UX-04)', () => {
  it('imports a .bib file through Library and reports counts as a toast', async () => {
    mocks.importBibliography.mockResolvedValue({ imported: 2, duplicates: 1, failed: 0 });
    mount();
    await screen.findByText('Paper A');
    fireEvent.click(screen.getByRole('button', { name: '导入论文' }));
    fireEvent.click(await screen.findByRole('button', { name: '导入 BibTeX / RIS 文献清单' }));
    const text = '@article{a, title={A}}';
    fireEvent.change(screen.getByLabelText('导入 BibTeX / RIS 文献清单'), { target: { files: [new File([text], 'refs.bib')] } });

    await waitFor(() => expect(mocks.importBibliography).toHaveBeenCalledWith('bibtex', text));
    expect(await screen.findByText('导入文献 2 篇，跳过重复 1 篇')).toBeTruthy();
  });

  it('copies a citation to the clipboard and toasts success', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    mocks.exportPapers.mockResolvedValue({ text: '[1] 作者. 题名[J/OL]. 刊名, 2024. DOI.' });

    mount();
    await screen.findByText('Paper A');
    fireEvent.click(screen.getAllByLabelText(/更多操作/)[0]);
    fireEvent.click(await screen.findByRole('button', { name: '复制 GB/T 7714 引文' }));

    await waitFor(() => expect(mocks.exportPapers).toHaveBeenCalledWith(['A'], 'gbt7714'));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('[1] 作者. 题名[J/OL]. 刊名, 2024. DOI.'));
    expect(await screen.findByText(/已复制 GB\/T 7714 引文：Paper A/)).toBeTruthy();
  });
});
