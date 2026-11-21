/**
 * Partial-page translations (BUG-01).
 *
 * `versions.page_map` is a JSON array of 0-based SOURCE page indexes, e.g.
 * `[7]` for “translate page 8” or `[4,5,6,7]` for `5-8`. `null` means the
 * translation covers every page and is an identity map.
 */
export type PageMap = readonly number[] | null | undefined;

export function hasPageMap(map: PageMap): map is readonly number[] {
  return Array.isArray(map) && map.length > 0;
}

/** Source (0-based) → translated-subset index (0-based), or null if untranslated. */
export function translatedIndex(map: PageMap, sourcePageZero: number): number | null {
  if (!hasPageMap(map)) return sourcePageZero >= 0 ? sourcePageZero : null;
  const index = map.indexOf(sourcePageZero);
  return index >= 0 ? index : null;
}

/** Source (1-based) → translated-subset page (1-based), or null if untranslated. */
export function translatedPageNumber(map: PageMap, sourcePageOneBased: number): number | null {
  const index = translatedIndex(map, sourcePageOneBased - 1);
  return index == null ? null : index + 1;
}

/** Translated-subset index (0-based) → source (0-based). Identity for full translations. */
export function sourcePageForTranslated(map: PageMap, translatedPageZero: number): number {
  if (!hasPageMap(map)) return translatedPageZero;
  return map[translatedPageZero] ?? translatedPageZero;
}

/** Map stored (source-page) annotations onto a translated pane's subpage indexes. */
export function annotationsOnTranslatedPages<T extends { page: number }>(rows: T[], map: PageMap): (T & { source_page: number })[] {
  if (!hasPageMap(map)) return rows.map((row) => ({ ...row, source_page: row.page }));
  const mapped: (T & { source_page: number })[] = [];
  for (const row of rows) {
    const index = map.indexOf(row.page);
    if (index >= 0) mapped.push({ ...row, page: index, source_page: row.page });
  }
  return mapped;
}
