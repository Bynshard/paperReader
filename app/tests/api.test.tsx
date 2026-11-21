import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHttpBridge } from '../src/api';

type Call = { url: string; init: RequestInit };
let calls: Call[] = [];

function mockFetch(result: unknown, status = 200) {
  const fn = vi.fn(async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return { status, json: async () => ({ ok: status < 400, result }) } as unknown as Response;
  });
  vi.stubGlobal('fetch', fn);
  return fn;
}

beforeEach(() => {
  calls = [];
  sessionStorage.clear();
  localStorage.clear();
  window.history.replaceState(null, '', '/?token=abc123');
});

afterEach(() => {
  vi.unstubAllGlobals();
  window.history.replaceState(null, '', '/');
  sessionStorage.clear();
  localStorage.clear();
});

describe('LAN / PWA bridge', () => {
  it('pairs from ?token, strips it from the address bar and authenticates RPC calls', async () => {
    mockFetch({ pong: true });
    const bridge = createHttpBridge();

    await expect(bridge.call('ping', { echo: 7 })).resolves.toEqual({ pong: true });

    expect(window.location.search).toBe('', 'the token must not stay in the visible URL');
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('/api/rpc');
    const headers = calls[0].init.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer abc123');
    expect(JSON.parse(String(calls[0].init.body))).toEqual({ method: 'ping', params: { echo: 7 } });
    expect(sessionStorage.getItem('moonlight-lan-token')).toBe('abc123');
    expect(localStorage.getItem('moonlight-lan-token')).toBe('abc123');
  });

  it('resolves a paper pdf to a range-capable /api/pdf URL instead of bytes', async () => {
    mockFetch({ version_id: 'v-1', pages: 12 });
    const bridge = createHttpBridge();

    await expect(bridge.readPdf('paper', 'source')).resolves.toEqual({
      versionId: 'v-1',
      pages: 12,
      url: '/api/pdf/v-1?token=abc123',
    });
    const body = JSON.parse(String(calls[0].init.body));
    expect(body.method).toBe('paper_pdf');
    expect(body.params).toEqual({ paper_id: 'paper', kind: 'source', version_id: undefined });
  });

  it('fetches app info through the shared RPC instead of the Electron preload', async () => {
    mockFetch({ version: '0.1.0', library: '/library', headless: true, model: '', credentialConfigured: false });
    const bridge = createHttpBridge();
    await expect(bridge.appInfo()).resolves.toMatchObject({ version: '0.1.0', headless: true });
    expect(JSON.parse(String(calls[0].init.body)).method).toBe('app_info');
  });

  it('subscribes to /api/events with the token and forwards parsed events', async () => {
    const sources: FakeEventSource[] = [];
    class FakeEventSource {
      closed = false;
      readonly listeners = new Map<string, (event: MessageEvent) => void>();
      constructor(readonly url: string) { sources.push(this); }
      addEventListener(type: string, listener: EventListener) { this.listeners.set(type, listener as (event: MessageEvent) => void); }
      removeEventListener(type: string) { this.listeners.delete(type); }
      close() { this.closed = true; }
      emit(data: string) { this.listeners.get('message')?.({ data } as MessageEvent); }
    }
    vi.stubGlobal('EventSource', FakeEventSource);

    const bridge = createHttpBridge();
    const seen: unknown[] = [];
    const off = bridge.onEvent((event) => seen.push(event));

    expect(sources).toHaveLength(1);
    expect(sources[0].url).toBe('/api/events?token=abc123');
    sources[0].emit(JSON.stringify({ event: 'ai_delta', request_id: 'r-1', answer: '你好' }));
    sources[0].emit('not json');
    expect(seen).toEqual([{ event: 'ai_delta', request_id: 'r-1', answer: '你好' }]);

    off();
    expect(sources[0].closed).toBe(true);
  });

  it('previews LAN context through ai_preview so the tablet shows real history', async () => {
    const bridge = createHttpBridge();
    mockFetch({ prompt: 'evidence', history: '用户：q', history_count: 1, context_info: { version_id: 'v' } });
    await expect(bridge.aiAction!('preview', { paper_id: 'p', kind: 'ask', include_history: true })).resolves.toMatchObject({ history_count: 1 });
    expect(JSON.parse(String(calls[0].init.body)).method).toBe('ai_preview');
  });

  it('routes reader AI turns and cancellation through explain/ai_cancel', async () => {
    const bridge = createHttpBridge();
    mockFetch({ answer: 'a', sources: [] });
    await expect(bridge.aiAction!('run', { kind: 'ask', paper_id: 'p', question: 'q', request_id: 'r-1' })).resolves.toEqual({ answer: 'a', sources: [] });
    expect(JSON.parse(String(calls[0].init.body)).method).toBe('explain');
    mockFetch({ ok: true, cancelled: true });
    await bridge.aiAction!('cancel', { request_id: 'r-1' });
    expect(JSON.parse(String(calls[1].init.body))).toEqual({ method: 'ai_cancel', params: { request_id: 'r-1' } });
  });

  it('routes quick explanations through the desktop AI service with an ephemeral flag', async () => {
    const aiAction = vi.fn(async () => ({ answer: 'ok', sources: [] }));
    const call = vi.fn(async () => ({ answer: 'fallback', sources: [] }));
    (window as any).moonlight = { aiAction, call, onEvent: () => () => undefined, appInfo: async () => ({}), pickPdfs: async () => [], readPdf: async () => ({}), pickDirectory: async () => null, revealAttachment: async () => undefined, syncSettings: async () => ({}), configureSync: async () => ({}), saveText: async () => ({ saved: true }) };
    try {
      const { api } = await import('../src/api');
      await expect(api.quickExplain({ paper_id: 'p', question: 'q', request_id: 'r-1' })).resolves.toEqual({ answer: 'ok', sources: [] });
      expect(aiAction).toHaveBeenCalledWith('run', expect.objectContaining({ paper_id: 'p', question: 'q', request_id: 'r-1', ephemeral: true, kind: 'explain' }));
      expect(call).not.toHaveBeenCalled();
    } finally {
      delete (window as any).moonlight;
    }
  });

  it('fails with an actionable message when the tablet was opened without a token', async () => {
    window.history.replaceState(null, '', '/');
    sessionStorage.clear();
    localStorage.clear();
    const bridge = createHttpBridge();
    await expect(bridge.call('ping')).rejects.toThrow(/尚未配对/);
  });

  it('surfaces an expired pairing instead of silently returning empty data', async () => {
    mockFetch({}, 401);
    const bridge = createHttpBridge();
    await expect(bridge.call('ping')).rejects.toThrow(/配对已失效/);
  });

  it('retries a transient 503 twice with backoff and then succeeds', async () => {
    const statuses = [503, 503, 200];
    let index = 0;
    const fn = vi.fn(async () => {
      const status = statuses[index++] ?? 200;
      return {
        status,
        json: async () => (status === 503 ? { ok: false, error: 'server busy' } : { ok: true, result: { pong: true } }),
      } as unknown as Response;
    });
    vi.stubGlobal('fetch', fn);
    const bridge = createHttpBridge();
    await expect(bridge.call('ping')).resolves.toEqual({ pong: true });
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('reports a clear busy error after the two 503 retries are exhausted', async () => {
    const fn = vi.fn(async () => ({ status: 503, json: async () => ({ ok: false, error: 'server busy' }) } as unknown as Response));
    vi.stubGlobal('fetch', fn);
    const bridge = createHttpBridge();
    await expect(bridge.call('ping')).rejects.toThrow(/HTTP 503/);
    expect(fn).toHaveBeenCalledTimes(3);
  });
});
