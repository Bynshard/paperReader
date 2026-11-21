import { render, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import FindBar from '../src/FindBar';
import type { PaneApi } from '../src/PdfPane';
import type { RefObject } from 'react';

const rows = [
  { page: 1, bbox: [1, 2, 3, 4] },
  { page: 6, bbox: [5, 6, 7, 8] },
];
function paneFor(find: () => Promise<typeof rows>) {
  return { current: { find } as unknown as PaneApi } as RefObject<PaneApi | null>;
}

describe('find bar preferred page', () => {
  it('lands on the library search hit page instead of the first occurrence', async () => {
    const onJump = vi.fn();
    render(<FindBar pane={paneFor(async () => rows)} initialQuery="attention" preferredPage={6} onJump={onJump} onResults={vi.fn()} onClose={vi.fn()} />);
    await waitFor(() => expect(onJump).toHaveBeenCalledWith(6, [5, 6, 7, 8]));
  });

  it('falls back to the first occurrence when the preferred page has no hit', async () => {
    const onJump = vi.fn();
    render(<FindBar pane={paneFor(async () => rows)} initialQuery="attention" preferredPage={9} onJump={onJump} onResults={vi.fn()} onClose={vi.fn()} />);
    await waitFor(() => expect(onJump).toHaveBeenCalledWith(1, [1, 2, 3, 4]));
  });

  it('waits for PaneApi registration before reporting a match', async () => {
    let resolveFind: ((value: typeof rows) => void) | undefined;
    const pane = { current: null } as RefObject<PaneApi | null>;
    const onJump = vi.fn();
    render(<FindBar pane={pane} initialQuery="attention" preferredPage={6} onJump={onJump} onResults={vi.fn()} onClose={vi.fn()} />);
    // Simulate pdf.js registering its API a tick after the bar mounts.
    setTimeout(() => {
      pane.current = {
        find: () => new Promise<typeof rows>((resolve) => { resolveFind = resolve; }),
      } as unknown as PaneApi;
    }, 80);
    await waitFor(() => expect(pane.current).not.toBeNull(), { timeout: 2000 });
    await waitFor(() => expect(resolveFind).toBeTypeOf('function'), { timeout: 2000 });
    resolveFind?.(rows);
    await waitFor(() => expect(onJump).toHaveBeenCalledWith(6, [5, 6, 7, 8]), { timeout: 2000 });
  });
});
