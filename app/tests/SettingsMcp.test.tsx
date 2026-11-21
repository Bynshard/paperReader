import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/TranslationSettings', () => ({ default: () => <div data-testid="pane-translation" /> }));
vi.mock('../src/AiSettings', () => ({ default: () => <div data-testid="pane-ai" /> }));
vi.mock('../src/CloudSync', () => ({ default: () => <div data-testid="pane-cloud" /> }));
vi.mock('../src/BackupSettings', () => ({ default: () => <div data-testid="pane-backup" /> }));
vi.mock('../src/LanPairing', () => ({ default: () => <div data-testid="pane-tablet" /> }));
vi.mock('../src/DuplicateFinder', () => ({ default: () => <div data-testid="duplicate-finder" /> }));

import SettingsModal, { mcpConfigText } from '../src/SettingsModal';

const writeText = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  writeText.mockResolvedValue(undefined);
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
});

describe('SettingsModal MCP card (FEAT-AI-03)', () => {
  it('shows a JSON snippet rooted at the configured library and copies it', async () => {
    render(<SettingsModal info={{ library: '/home/user/Paper Library' } as never} onClose={vi.fn()} onChanged={vi.fn()} />);

    expect(screen.getByRole('heading', { name: 'MCP Server（外部 IDE 联动）' })).toBeTruthy();
    const snippet = screen.getByLabelText('MCP 配置 JSON').textContent || '';
    const parsed = JSON.parse(snippet);
    expect(parsed).toEqual({
      mcpServers: { moonlight: { command: 'moonlight-core', args: ['--root', '/home/user/Paper Library', '--mcp'] } },
    });

    fireEvent.click(screen.getByRole('button', { name: '复制 MCP 配置' }));
    expect(writeText).toHaveBeenCalledWith(snippet);
    expect(await screen.findByRole('status')).toBeTruthy();
    expect(screen.getByText('已复制到剪贴板')).toBeTruthy();
  });

  it('falls back to the <library> placeholder when app_info has no library yet', () => {
    render(<SettingsModal info={null} onClose={vi.fn()} onChanged={vi.fn()} />);
    const parsed = JSON.parse(screen.getByLabelText('MCP 配置 JSON').textContent || '');
    expect(parsed.mcpServers.moonlight.args).toEqual(['--root', '<library>', '--mcp']);
    expect(mcpConfigText()).toContain('"<library>"');
  });
});
