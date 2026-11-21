/**
 * Shared drag payload for “drag papers onto a folder/tag”.
 * One string-array JSON keeps table rows, cards and taxonomy targets decoupled.
 */
export const PAPER_DRAG_TYPE = "application/x-moonlight-paper-ids";

export function setPaperDragData(dataTransfer: DataTransfer, ids: string[]) {
  dataTransfer.setData(PAPER_DRAG_TYPE, JSON.stringify(ids));
  dataTransfer.setData("text/plain", ids.join(","));
  dataTransfer.effectAllowed = "copyMove";
}

export function readPaperDragData(dataTransfer: DataTransfer): string[] {
  try {
    const parsed = JSON.parse(dataTransfer.getData(PAPER_DRAG_TYPE) || "[]");
    return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === "string" && !!id) : [];
  } catch {
    return [];
  }
}

export function isPaperDrag(dataTransfer: DataTransfer): boolean {
  return Array.from(dataTransfer.types || []).includes(PAPER_DRAG_TYPE);
}
