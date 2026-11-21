import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import AiSettings from '../src/AiSettings';

const api = vi.hoisted(() => ({
  aiStatus: vi.fn(),
  aiAction: vi.fn(),
  translationAction: vi.fn(),
  onEvent: vi.fn(() => () => undefined),
}));
vi.mock('../src/api', () => ({ api }));

beforeEach(() => {
  vi.clearAllMocks();
  api.aiStatus.mockResolvedValue({ provider: 'api', model: '', chat_model: '', account: null, models: [], loginPending: false });
  api.translationAction.mockResolvedValue({
    base_url: 'https://api.example.com/v1', model: 'qwen-mt', babeldoc: '', qps: 6,
    key_configured: true, pending_restart: false,
  });
  api.aiAction.mockResolvedValue({});
  api.onEvent.mockReturnValue(() => undefined);
});

describe('AI settings provider clarity', () => {
  it('hides Codex login/limits for the API provider and shows the reused API base', async () => {
    render(<AiSettings />);
    expect(await screen.findByText(/api\.example\.com\/v1/)).toBeTruthy();
    expect(screen.queryByText('通过浏览器登录 Codex')).toBeNull();
    expect(screen.queryByText('尚未登录 Codex')).toBeNull();
    expect(screen.getByLabelText('问答专用模型')).toBeTruthy();
    expect(screen.getByText(/翻译模型 qwen-mt/)).toBeTruthy();
  });

  it('saves a separate chat model through configure without touching the translation model', async () => {
    render(<AiSettings />);
    const input = await screen.findByLabelText('问答专用模型');
    fireEvent.change(input, { target: { value: 'gpt-4.1' } });
    fireEvent.click(screen.getByText('保存问答模型'));
    await waitFor(() => expect(api.aiAction).toHaveBeenCalledWith('configure', { provider: 'api', model: '', chat_model: 'gpt-4.1' }));
  });

  it('shows the Codex account area only when the Codex provider is selected', async () => {
    api.aiStatus.mockResolvedValue({ provider: 'codex', model: '', chat_model: '', account: null, models: [], loginPending: false });
    render(<AiSettings />);
    expect(await screen.findByText('尚未登录 Codex')).toBeTruthy();
    expect(screen.getByText('通过浏览器登录 Codex')).toBeTruthy();
    expect(screen.queryByLabelText('问答专用模型')).toBeNull();
  });
});
