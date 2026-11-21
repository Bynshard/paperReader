/**
 * Dual-pane scroll alignment (BUG-03).
 *
 * `position()` reports the fraction of the viewport's TOP edge inside the page,
 * so when mapping to the other pane we must interpolate the same relative point
 * inside the matched paragraph — using the paragraph CENTRE would push the
 * target's centre to the top of the viewport and drift downward every sync.
 */
export type ScrollBox = { bbox: number[]; page: number };

export function interpolatedTargetFraction(
  sourceTopY: number,
  fromBox: number[],
  targetBox: number[],
  targetPageHeight: number,
): number {
  const fromTop = Number(fromBox[1]);
  const fromBottom = Number(fromBox[3]);
  const t = Math.max(0, Math.min(1, (sourceTopY - fromTop) / Math.max(1, fromBottom - fromTop)));
  const targetTop = Number(targetBox[1]) + t * (Number(targetBox[3]) - Number(targetBox[1]));
  return Math.max(0, Math.min(1, targetTop / Math.max(1, targetPageHeight)));
}
