/**
 * Controller horizontal positioning: avoid the collapse icon Obsidian renders for lists/titles in live preview
 * (`.list-collapse-indicator`/`.collapse-indicator`).
 *
 * Background (real bug): The folding icon is drawn in the left margin at the beginning of the line, while the old logic of the handle is fixed in
 * "size + 6px on the left side of the line" - the two fall on the same blank space, visually overlapping into a mess.
 * And the folding point cannot be reached after the handle covers the icon.
 *
 * Modification: Change the right edge of the handle to the "left edge of the folded icon - gap" to let the entire icon out;
 * When there is not enough space on the left side, compress the handle proportionally (instead of letting it press back onto the icon). Mark it if it cannot be placed.
 * squeezed is handed over to the caller for degradation.
 *
 * This module is **pure geometry, does not touch the DOM**, and can be asserted offline in Node (scripts/handle-layout-spec.mjs). */

/** Gap between handle and line start/collapse icon */
export const HANDLE_GAP = 6;
/** Minimum margin between the handle and the left and right edges of the editor (to prevent being cropped by overflow:hidden) */
export const HANDLE_INSET = 2;
/** The minimum side length allowed to be compressed when there is insufficient space */
export const HANDLE_MIN_SIZE = 14;

export interface HandleLeftInput {
  /** Viewport x at the beginning of the line (coordsAtPos(line.from).left) */
  lineLeft: number;
  /** Viewport x at the left edge of the collapse icon; null means there is no visible collapse icon for this row */
  foldLeft: number | null;
  /** .cm-editor Viewport x on the left edge */
  editorLeft: number;
  /** .cm-editor width */
  editorWidth: number;
  /** Handle side length (setting item handleSize, default fallback to 20) */
  handleSize: number;
  /** Override default gap */
  gap?: number;
  /** Override the default minimum white space */
  inset?: number;
  /** Override the default minimum side length */
  minHandleSize?: number;
}

export interface HandleLeftResult {
  /** x relative to the left edge of .cm-editor (clamped within the editor) */
  left: number;
  /** Actual side length used (compressed when there is insufficient space) */
  size: number;
  /** true = compressed, or still overlaps with the collapsed icon after compression (the caller can downgrade accordingly) */
  squeezed: boolean;
}

/** Whether the fold icon is worth avoiding: it must be in the editor and to the left of the beginning of the line, otherwise it will be considered an invalid measurement */
export function isDodgeableFold(foldLeft: number | null, lineLeft: number, editorLeft: number): boolean {
  if (foldLeft == null || !Number.isFinite(foldLeft) || !Number.isFinite(lineLeft)) return false;
  // The rect of the hidden element (display:none) is all 0 and will be blocked by this
  if (foldLeft <= editorLeft) return false;
  // The icon is on the right side of the beginning of the row (abnormal theme/measurement of other elements): do not avoid it, otherwise the handle will fly to the middle of the row
  return foldLeft < lineLeft - 1;
}

export function computeHandleLeft(input: HandleLeftInput): HandleLeftResult {
  const handleSize = Math.max(1, input.handleSize);
  const gap = Math.max(0, input.gap ?? HANDLE_GAP);
  const inset = Math.max(0, input.inset ?? HANDLE_INSET);
  const minSize = Math.min(handleSize, Math.max(6, input.minHandleSize ?? HANDLE_MIN_SIZE));

  const hasFold = isDodgeableFold(input.foldLeft, input.lineLeft, input.editorLeft);
  // Giving way basis: If there is an icon, it will be pasted to the left of the icon; if there is no icon, it will be pasted to the left of the beginning of the line.
  const anchor = hasFold ? (input.foldLeft as number) : input.lineLeft;

  // The available width from the left side of the datum to the left edge of the editor (discounting gaps and whitespace)
  const room = anchor - gap - inset - input.editorLeft;
  const size = room >= handleSize ? handleSize : Math.max(minSize, Math.floor(room));

  const rightLimit = Math.max(inset, input.editorWidth - size - inset);
  const rawLeft = anchor - gap - size - input.editorLeft;
  const left = Math.min(Math.max(rawLeft, inset), rightLimit);

  // After compression or clamping, if the right edge of the handle still crosses the left edge of the icon = there is still overlap
  const overlapped = hasFold && left + size > (input.foldLeft as number) - input.editorLeft + 0.5;
  return { left, size, squeezed: size < handleSize || overlapped };
}
