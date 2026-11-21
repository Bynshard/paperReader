import { describe, expect, it } from 'vitest';
import { matchVenueTier } from '../src/venueTier';

describe('offline venue tier lookup', () => {
  it('recognises CCF-A conferences from acronyms and full proceedings titles', () => {
    expect(matchVenueTier('Proceedings of the IEEE/CVF Conference on Computer Vision and Pattern Recognition (CVPR)')?.label).toBe('CCF-A');
    expect(matchVenueTier('NeurIPS')?.name).toBe('NeurIPS');
    expect(matchVenueTier('Advances in Neural Information Processing Systems')?.label).toBe('CCF-A');
    expect(matchVenueTier('OSDI 2024')?.label).toBe('CCF-A');
    expect(matchVenueTier('USENIX Security Symposium')?.label).toBe('CCF-A');
    expect(matchVenueTier('SIGMOD Conference')?.label).toBe('CCF-A');
  });

  it('recognises CCF-B venues and top journals without network access', () => {
    expect(matchVenueTier('ECCV')?.label).toBe('CCF-B');
    expect(matchVenueTier('EMNLP 2023')?.label).toBe('CCF-B');
    expect(matchVenueTier('IEEE Transactions on Pattern Analysis and Machine Intelligence')?.label).toBe('CCF-A');
    expect(matchVenueTier('Nature')?.tone).toBe('top-journal');
    expect(matchVenueTier('Science')?.tone).toBe('top-journal');
  });

  it('labels ICLR as a top meeting and leaves unknown or empty venues untouched', () => {
    expect(matchVenueTier('ICLR')?.label).toBe('顶会');
    expect(matchVenueTier('Journal of Reproducible Widgets')).toBeNull();
    expect(matchVenueTier('')).toBeNull();
    expect(matchVenueTier(null)).toBeNull();
    // A generic "computer science" phrase must not be mistaken for the journal Science.
    expect(matchVenueTier('Department of Computer Science')).toBeNull();
  });
});
