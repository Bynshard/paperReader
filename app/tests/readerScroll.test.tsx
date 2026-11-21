import { describe, expect, it } from 'vitest';
import { interpolatedTargetFraction } from '../src/readerScroll';

describe('dual-pane scroll alignment', () => {
  it('aligns the paragraph top instead of pushing its centre to the viewport top', () => {
    const from = [0, 100, 400, 160];
    const target = [0, 200, 400, 260]; // 1.5x taller than the source paragraph
    // Source viewport top is exactly at the paragraph start.
    expect(interpolatedTargetFraction(100, from, target, 800)).toBeCloseTo(200 / 800, 6);
    // Middle of the source paragraph maps to the same relative point in the target.
    expect(interpolatedTargetFraction(130, from, target, 800)).toBeCloseTo((200 + 0.5 * 60) / 800, 6);
  });

  it('clamps out-of-range input to the paragraph bounds and page [0,1]', () => {
    const from = [0, 100, 400, 160];
    const target = [0, 700, 400, 800];
    expect(interpolatedTargetFraction(0, from, target, 800)).toBeCloseTo(700 / 800, 6);
    expect(interpolatedTargetFraction(999, from, target, 800)).toBe(1);
  });
});
