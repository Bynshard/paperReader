import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../src/TranslationSettings', () => ({ default: () => <div data-testid="pane-translation" /> }));
vi.mock('../src/AiSettings', () => ({ default: () => <div data-testid="pane-ai" /> }));
vi.mock('../src/CloudSync', () => ({ default: () => <div data-testid="pane-cloud" /> }));
vi.mock('../src/BackupSettings', () => ({ default: () => <div data-testid="pane-backup" /> }));
vi.mock('../src/LanPairing', () => ({ default: () => <div data-testid="pane-tablet" /> }));
vi.mock('../src/DuplicateFinder', () => ({ default: ({ onClose }: { onClose: () => void }) => <button onClick={onClose}>close-duplicates</button> }));

import SettingsModal, { type TabKey } from '../src/SettingsModal';

const renderModal = (props: { initialTab?: TabKey } = {}) =>
  render(<SettingsModal info={null} onClose={() => undefined} onChanged={() => undefined} {...props} />);

describe('SettingsModal initial tab (FEAT-UX-01)', () => {
  it('defaults to the general tab when initialTab is omitted', () => {
    renderModal();
    expect(screen.getByRole('heading', { name: '通用与论文库' })).toBeTruthy();
    expect(screen.getByRole('button', { name: '通用与论文库' }).getAttribute('aria-current')).toBe('page');
    expect(screen.queryByTestId('pane-translation')).toBeNull();
  });

  it('still switches tabs by clicking the settings nav', () => {
    renderModal();
    fireEvent.click(screen.getByRole('button', { name: '翻译引擎' }));
    expect(screen.getByTestId('pane-translation')).toBeTruthy();
    expect(screen.queryByRole('heading', { name: '通用与论文库' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '平板伴读' }));
    expect(screen.getByTestId('pane-tablet')).toBeTruthy();
    expect(screen.queryByTestId('pane-translation')).toBeNull();
  });

  it.each([
    ['translation', 'pane-translation', '翻译引擎'],
    ['ai', 'pane-ai', 'AI 阅读助手'],
    ['cloud', 'pane-cloud', '云同步'],
    ['backup', 'pane-backup', '备份与恢复'],
    ['tablet', 'pane-tablet', '平板伴读'],
  ] as [TabKey, string, string][])('opens directly on the %s tab', (initialTab, testId, label) => {
    renderModal({ initialTab });
    expect(screen.getByTestId(testId)).toBeTruthy();
    expect(screen.getByRole('button', { name: label }).getAttribute('aria-current')).toBe('page');
    expect(screen.queryByRole('heading', { name: '通用与论文库' })).toBeNull();
  });
});
