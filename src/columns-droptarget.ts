import type { Editor } from 'obsidian';
import type { BlockRange } from './types';
import { getLines } from './util';

/**
 * Shared drop point calculation for two-way dragging of columns (requirement A: document block → new column in sub-column; requirement B: column → ordinary block outside the column).
 *
 * Why separate modules: The determination directions of the two requirements are opposite, but they must be done on the same column structure
 * Conversion of "DOM hit/document coordinate ↔ column index". Originally these conversions were scattered in drag.ts
 * If you write another copy of each of the four branches in the falling area, it will inevitably drift, so it is concentrated here.
 *
 * Key premise: Live Preview’s self-rendering column is a whole widget (Decoration.replace({block:true}),
 * The column is not a document block. CM6's posAtCoords can only give the replacement position of the entire interval in the column, but cannot get the "column number".
 * Therefore, the hit determination of requirement A must go through DOM (elementFromPoint) and cannot rely on CM coordinates. */

/** Insert between columns with hit radius (px): The closer the pointer is to the gap between the two columns, the priority will be to hit "Insert new column here" */
export const COL_GAP_BAND = 18;

/** Hit area classification */
export type ColHitKind =
  /** Hit the insert band between two columns → insert a new column at insertIndex (between the two columns) */
  | 'gap'
  /** Hit the left half of the column → insert before the column */
  | 'before'
  /** Hit the right half of the column → insert after the column (at the end of the column, it is appended to the end of the line) */
  | 'after';

/** Complete results of a hit within a column */
export interface ColDropHit {
  kind: ColHitKind;
  /** Insertion index: 0 = first, texts.length = append at the end */
  insertIndex: number;
  /** The global index of the hit column (when kind='gap' is the index of the right adjacent column, the gap in the last column is the number of columns) */
  colIndex: number;
  /** DOM box of hit bar (visible area, used for drawing strokes/vertical lines) */
  box: { left: number; right: number; top: number; bottom: number } | null;
}

/** A row of column-based DOM/structure information (retrieved from the widget by the caller) */
export interface ColRowInfo {
  /** The column DOM elements contained in this row (in order of display) */
  cols: HTMLElement[];
  /** The subscript of each column in the widget's global texts (used to convert insertIndex when multiple lines are divided into columns) */
  globalIdx: number[];
}

/** Row/column information of an entire column widget */
export interface ColLayoutInfo {
  rows: ColRowInfo[];
  /** Total number of widget columns */
  total: number;
}

/**
 * Determine hit areas in columns based on geometry.
 *
 *Priority (from high to low):
 * 1. gap - the pointer falls on the gap between the two columns (±COL_GAP_BAND) → inserted between the two columns
 * 2. after - the right half of the column
 * 3. before - the left half of the column (including the left half of the leftmost column = inserted to the front)
 *
 * The priority of gap over half area is deliberate: the insertIndex calculated for the right half area of column 1 and the left half area of column 2 is the same.
 * If the half area is allowed to grab first, the same physical position will have an uncertain behavior of "sometimes hitting the zone and sometimes hitting the half area".
 * The central text area will be merged into the right half area (after) according to the confirmed plan, leaving no white space.
 *
 * @param layout Column DOM layout
 * @param x pointer viewport abscissa
 * @param y pointer viewport ordinate
 * @returns hit area; returns null if the pointer is not in any line */
export function hitColumnsLayout(
  layout: ColLayoutInfo,
  x: number,
  y: number
): ColDropHit | null {
  for (const row of layout.rows) {
    if (!row.cols.length) continue;
    const first = row.cols[0].getBoundingClientRect();
    const last = row.cols[row.cols.length - 1].getBoundingClientRect();
    // Vertical gate: the pointer must fall within the vertical range of the row (the gap between rows does not hit)
    if (y < first.top || y > last.bottom) continue;

    const rects = row.cols.map((c) => c.getBoundingClientRect());
    const toBox = (r: DOMRect) => ({ left: r.left, right: r.right, top: r.top, bottom: r.bottom });

    // 1) Insert tape between columns: hit first
    for (let i = 0; i < rects.length - 1; i++) {
      const boundary = (rects[i].right + rects[i + 1].left) / 2;
      if (Math.abs(x - boundary) > COL_GAP_BAND) continue;
      const gi = row.globalIdx[i + 1];
      return {
        kind: 'gap',
        insertIndex: gi,
        colIndex: gi,
        box: { left: boundary - 1.5, right: boundary + 1.5, top: rects[i].top, bottom: rects[i].bottom },
      };
    }

    // 2)/3) Within the column: left half area before, right half area after (including the outer edge of the leftmost/rightmost column)
    for (let i = 0; i < rects.length; i++) {
      const r = rects[i];
      if (x < r.left || x > r.right) continue;
      const gi = row.globalIdx[i];
      const mid = (r.left + r.right) / 2;
      if (x < mid) {
        return { kind: 'before', insertIndex: gi, colIndex: gi, box: toBox(r) };
      }
      return { kind: 'after', insertIndex: gi + 1, colIndex: gi, box: toBox(r) };
    }

    // The intra-row gap that falls on this row (the gap when the column is squeezed out by flex): after returning to the last column
    const r = rects[rects.length - 1];
    const gi = row.globalIdx[rects.length - 1];
    return { kind: 'after', insertIndex: gi + 1, colIndex: gi, box: toBox(r) };
  }
  return null;
}

/**
 * Split the row information into ColLayoutInfo: colEls is all column elements in the widget (in global order),
 * rowLens is the number of columns in each row (empty array = single row). */
export function buildColLayout(
  colEls: HTMLElement[],
  rowLens: number[]
): ColLayoutInfo {
  const lens = rowLens.length ? rowLens : [colEls.length];
  const rows: ColRowInfo[] = [];
  let si = 0;
  for (const len of lens) {
    const cols = colEls.slice(si, si + len);
    const globalIdx: number[] = [];
    for (let k = 0; k < cols.length; k++) globalIdx.push(si + k);
    rows.push({ cols, globalIdx });
    si += len;
  }
  return { rows, total: colEls.length };
}

/**
 * Convert the line text of the dragged block into "column content" text: strip off the reference prefix of each layer,
 * Keep markdown structure (list indents/titles/code fences as is).
 *
 * The column content in the markdown layer is bare content without the `>> ` prefix (buildColumnsMarkdown adds the prefix when writing back),
 * So it must be stripped once here, otherwise the double prefix of `>> >> text` will appear.
 *
 * Isomorphic to stripToColLevel of scanRegions, but **strip all to naked content** (requires the drag source of A
 * It is always outside the column and has been excluded by the qualification check, so there is no need to retain the relative level).
 *
 * Two easy-to-write errors have been covered by the temp/verify/assert.mjs assertion:
 *
 * 1) You cannot use `replace(/^((?:>\s*)+)/, '')` - `\s*` will also eat the spaces after `>`.
 * Squeeze `>>   sub` (subitem indent 2) into `sub` (indent 0), the list hierarchy is silently destroyed.
 * Therefore, scan character by character: eat the consecutive `>`, followed by ** at most ** spaces, and add back the remaining blanks as they are.
 *
 * 2) Fence detection must be done after stripping the prefix. If detected according to the original text (requirement ``` The front is blank），
 *    `>> ```js`), such fence lines with reference prefixes will never be matched, and the state machine will not be enabled -
 * `[!col]` appearing in the code block will be mistaken for a new column, splitting one column into two columns.
 * The fence content must also be stripped (consistent with the segFence branch of scanRegions to ensure that the written column content
 * Isomorphic to the product of read-side stripToColLevel). */
export function stripQuotePrefixes(lines: string[]): string {
  const out: string[] = [];
  let fenceCh: string | null = null;
  for (const l of lines) {
    if (l.trim() === '') {
      out.push('');
      continue;
    }
    // Peel off the reference layer: eat `>` followed by at most one space, and leave the remaining spaces as they are (preserving the indentation of the list)
    let i = 0;
    while (l[i] === '>') i++;
    let t: string;
    if (i > 0) {
      if (l[i] === ' ') i++;
      t = l.slice(i);
    } else {
      t = l.replace(/^\s+/, '');
    }
    // Fence state machine (determined on the prefix-stripped text, isomorphic to segFence of scanRegions):
    // After the fence is turned on, `[!col]` in the code content cannot be regarded as a new column mark.
    const fence = t.match(/^(`{3,}|~{3,})(.*)$/);
    if (fence) {
      if (fenceCh === null) fenceCh = fence[1][0];
      else if (fence[1][0] === fenceCh && fence[2].trim() === '') fenceCh = null;
    }
    out.push(t);
  }
  return out.join('\n');
}

/**
 * The legal placement point of requirement B: **Any row outside the column range**.
 *
 * The early version only allowed "immediately up/downward", which was too restrictive in actual testing (users reported that "you cannot drag and drop the position at will").
 * Therefore, it is relaxed to: as long as the target line is not within the column interval [shellStart, shellEnd], it is legal.
 * shellEnd + 1 is the separated empty line after the column, which is also legal (= immediately after the column).
 *
 * Historical pit (reserved for return): The widget is `Decoration.replace({block:true})`,
 * The shell row and the last row are not rendered. The pointer can only hit start-1 / end+2 when the pointer is above/below the widget.
 * "Visually adjacent rows". If you press "must === a certain row" to determine, it will never be established. After relaxing to any row outside the range
 *Such geometric problems disappear naturally.
 *
 * @param shellStart Column shell line number (0-based)
 * @param shellEnd The last line number of the column (0-based)
 * @param line target insertion line number (0-based, inserted before the line; === total number of lines means appended to the end of the text)
 * @returns Returns the original value legally, returns null within the range */
export function resolveExtractLine(shellStart: number, shellEnd: number, line: number): number | null {
  if (line < 0) return null;
  if (line < shellStart) return line;
  // The inside of the interval (shell line ~ last line) is illegal; shellEnd+1 (blank line separated) and thereafter are legal
  if (line > shellEnd) return line;
  return null;
}

/**
 * Insert text with free drop point: insert column content `plain` before line `line`
 * (`line === lines.length` means appending to the end of the text), and automatically completes the blank lines on both sides.
 * Ensure that the dragged block is an independent paragraph and will not stick to adjacent blocks.
 *
 * Completion rules are determined by the text context of the insertion point:
 * - The previous neighbor is already a blank line → do not add the leading edge; otherwise, add `\n` (when the previous neighbor is column text, it will also be treated as non-empty)
 * - The next neighbor (line) is a blank line → add `\n`; otherwise add `\n\n`
 * - When appending to the end of the text, there is no line break at the end of the original text, so `\n\n` needs to be added (if the last line is already a blank line, `\n` must be added)
 *
 * @param lines All lines of the original text (0-based)
 * @param region Column interval, used to determine "whether the previous neighbor of the insertion point is column text or an ordinary line" */
export function buildExtractInsertText(
  plain: string,
  lines: string[],
  line: number,
  region: { start: number; end: number; hasBreak: boolean }
): string {
  const body = plain.trim();
  if (!body) return '';
  void region.hasBreak;

  // Append to the end of the text: There is no line break at the end of the original text, you need to complete it yourself
  if (line >= lines.length) {
    const lastEmpty = (lines[lines.length - 1] ?? '') === '';
    return (lastEmpty ? '\n' : '\n\n') + body;
  }

  let prevBlank: boolean;
  if (line === 0) prevBlank = true;
  else if (line > region.end && line === region.end + 1) {
    // Immediately after the last line of the column: the previous neighbor is the column text (not empty), you must fill in the blank line yourself
    prevBlank = false;
  } else prevBlank = (lines[line - 1] ?? '') === '';

  const nextLine = lines[line] ?? '';
  const lead = prevBlank ? '' : '\n';
  const trail = nextLine.trim() === '' ? '\n' : '\n\n';
  return lead + body + trail;
}

/**
 * Convert the column content into text that can be inserted as a normal block (Requirement B: Drag the column out of the column).
 *
 * **Deliberately not stripping prefix**: widget's `texts[i]` has been replaced by scanRegions's stripToColLevel
 * Stripped to the column level (column level), the remaining single `> ` is the **real content in the column** - for example, in a certain column
 * A callout is embedded, and the saved one is `> [!note] xxx`. If you peel off another layer here, it will be nested after dragging it out.
 * callout will be silently compressed into ordinary text (the structure will be lost, and the reference semantics in the original text will disappear).
 *
 * Therefore, this function is only responsible for trimming the trailing blanks, and the blank lines are filled in by the caller according to the direction of the landing point. */
export function columnToPlainBlock(text: string): string {
  return text.replace(/\s+$/, '').replace(/^\n+/, '');
}

/**
 * Calculate the CM6 changes array after the merger of "range rewriting + outside range insertion".
 *
 * Why merge: Both requirements require single-step undo. Column writeback itself is an entire interval rewrite
 * (Semantics of commitDoc), if an insert is dispatched separately, it will become a two-step undo.
 * A single Transaction of CM6 accepts a changes array and can apply multiple edits at one time.
 * Full rollback when undoing - verified with temp/verify-single-trx.mjs:
 * - Array form (range rewriting + zero-width insertion outside the range) is legal
 * - The insertion point will not conflict with the starting point of the range (drag it to the top)
 * - invert() can cleanly restore the original text
 *
 * @param regionFrom starting point of column interval (inclusive)
 * @param regionTo The end of the column interval (exclusive)
 * @param regionText new column range text
 * @param outside Insertion outside the interval (position + text), if not, null
 * @returns can be directly put into the array of state.update({changes}) */
export function buildCombinedChanges(
  regionFrom: number,
  regionTo: number,
  regionText: string,
  outside: { pos: number; text: string } | null
): { from: number; to: number; insert: string }[] {
  const changes: { from: number; to: number; insert: string }[] = [
    { from: regionFrom, to: regionTo, insert: regionText },
  ];
  if (outside && outside.text) changes.push({ from: outside.pos, to: outside.pos, insert: outside.text });
  return changes;
}

/** When there are less than 2 columns left after dragging out, whether it should be downgraded to cancel column division (revert to normal paragraph) */
export function shouldUnwrapAfterExtract(remaining: number): boolean {
  return remaining < 2;
}

/** Get all lines of text of the dragged block (splicing in ascending order of line numbers when multiple selections are made) */
export function collectDraggedLines(editor: Editor, ranges: BlockRange[]): string[] {
  const sorted = [...ranges].sort((a, b) => a.start - b.start);
  const lines: string[] = [];
  for (const r of sorted) lines.push(...getLines(editor, r.start, r.end));
  return lines;
}
