import { describe, expect, it } from 'vitest';
import { annotationsOnTranslatedPages, sourcePageForTranslated, translatedIndex, translatedPageNumber } from '../src/pageMap';

describe('partial translation page map', () => {
  it('maps source pages to translated subpages and back', () => {
    const map = [4, 5, 6, 7];
    expect(translatedIndex(map, 4)).toBe(0);
    expect(translatedPageNumber(map, 5)).toBe(1);
    expect(translatedPageNumber(map, 8)).toBe(4);
    expect(translatedPageNumber(map, 9)).toBeNull();
    expect(sourcePageForTranslated(map, 0)).toBe(4);
    expect(sourcePageForTranslated(map, 3)).toBe(7);
  });

  it('treats null page_map as the identity mapping for full translations', () => {
    expect(translatedIndex(null, 6)).toBe(6);
    expect(translatedPageNumber(null, 7)).toBe(7);
    expect(sourcePageForTranslated(null, 2)).toBe(2);
  });

  it('drops annotations for pages outside a partial translation and remaps the rest', () => {
    const rows = [{ page: 3, quote: 'before' }, { page: 5, quote: 'inside' }, { page: 8, quote: 'after' }];
    expect(annotationsOnTranslatedPages(rows, [4, 5, 6, 7])).toEqual([{ page: 1, source_page: 5, quote: 'inside' }]);
    expect(annotationsOnTranslatedPages(rows, null)).toEqual(rows.map((row) => ({ ...row, source_page: row.page })));
  });
});
