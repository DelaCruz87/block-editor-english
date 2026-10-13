import { TEXT } from './strings';
import { Notice } from 'obsidian';
import type { Editor } from 'obsidian';
import type { BlockContext, BlockRange } from './types';
import type BlockEditorPlugin from './main';
import { getCM, getIndent, getLines, keepViewport, shiftIndent } from './util';
import { renumberOrdered, collectLayerStarts, layerKeyOf } from './list-number';

/** List mark (the upper limit of the serial number is 9 digits, consistent with CommonMark) */
const LIST_MARK_RE = /^[\t ]*(?:>[\t ]*)*(?:[-*+]|\d{1,9}[.)])[\t ]+/;

/**
 * Expand [from, to] outward to the "list segment" boundary - all consecutive list items of the same level key are included.
 *
 * The reason why external expansion is necessary: When moving across lists, the items belonging to the target list after the drop point are outside the original span.
 * Without expansion, their serial numbers cannot be repaired (a broken number will be inserted in the middle).
 *
 * The starting number is not determined here - `collectLayerStarts(Before moving span)` is responsible,
 * This function is only responsible for determining "which rows belong to the same list". */
function expandToListSpan(editor: Editor, from: number, to: number): { from: number; to: number } {
  const keyOf = (i: number) => layerKeyOf(editor.getLine(i));
  const isItem = (i: number) => LIST_MARK_RE.test(editor.getLine(i));

  const anchorKey = keyOf(from);
  let lo = from;
  let hi = to;

  for (let i = from; i >= 0; i--) {
    if (!isItem(i) || keyOf(i) !== anchorKey) break;
    lo = i;
  }
  for (let i = to + 1; i < editor.lineCount(); i++) {
    if (!isItem(i) || keyOf(i) !== anchorKey) break;
    hi = i;
  }
  return { from: lo, to: hi };
}

/** Block operations: move, delete, insert, indent, copy content, create copies and move across documents */
export class BlockOps {
  constructor(private ctx: BlockEditorPlugin) {}

  // Move the entire line in ranges before insertLine. Rewrite the entire section once to ensure only one step of undoing
  // When quotePrefix is non-empty, it will uniformly add the quote prefix to the moved lines (drag into the quote/callout nest), and is mutually exclusive with nestCol.
  moveRanges(
    editor: Editor,
    ranges: BlockRange[],
    insertLine: number,
    nestCol: number | null = null,
    quotePrefix: string | null = null
  ): void {
    if (!ranges.length) return;
    const sorted = [...ranges].sort((a, b) => a.start - b.start);
    const total = editor.lineCount();
    const insertAt = Math.min(Math.max(insertLine, 0), total);

    // When moving across lists, the items belonging to the target list after the drop point are outside the original span, and the serial number cannot be repaired without extending it.
    const expanded = expandToListSpan(
      editor,
      Math.min(insertAt, ...sorted.map((r) => r.start)),
      Math.max(insertAt - 1, ...sorted.map((r) => r.end))
    );
    const minLine = expanded.from;
    const maxLine = expanded.to;
    if (maxLine < minLine) return;

    const span = getLines(editor, minLine, maxLine);
    const offsets = sorted.map((r) => ({ from: r.start - minLine, to: r.end - minLine }));
    const kept = span.filter((_, i) => !offsets.some((o) => i >= o.from && i <= o.to));

    // The drop point is converted to the line number "after removal"
    let at = insertAt - minLine;
    for (const o of offsets) {
      if (o.to < insertAt - minLine) at -= o.to - o.from + 1;
    }
    at = Math.max(0, Math.min(at, kept.length));

    const moved: string[] = [];
    for (const r of sorted) moved.push(...getLines(editor, r.start, r.end));
    if (nestCol != null && moved.length) {
      const base = (moved[0].match(/^(\s*)/) || ['', ''])[1].length;
      if (base !== nestCol) {
        for (let i = 0; i < moved.length; i++) moved[i] = shiftIndent(moved[i], nestCol - base);
      }
    } else if (quotePrefix != null && moved.length) {
      // Reference nesting: uniformly add prefix at the beginning of the line (the original indentation is retained after `> `)
      for (let i = 0; i < moved.length; i++) moved[i] = quotePrefix + moved[i];
    }

    const out = kept.slice(0, at).concat(moved, kept.slice(at));
    const oldText = span.join('\n');

    // Ordered list renumbering: Live Preview displays the source code numbers. After moving, the numbers must be continued along the new position.
    // The starting number is taken from the layer snapshot **before moving** - otherwise the remaining 2. B after "1. A" is towed away
    // Will bring the whole section to 2/3/4.
    const renumbered = renumberOrdered(out, {
      layerStarts: collectLayerStarts(span),
    });
    const newText = renumbered.lines.join('\n');
    if (oldText === newText) return;

    // Viewport Lock: Whole section rewriting will cause CM6 to recalculate the viewport according to changes (full page jumps after moving blocks/columns/rows),
    // Pin scrollTop to keep the view at the current editing position.
    keepViewport(getCM(editor), () => {
      editor.replaceRange(
        newText,
        { line: minLine, ch: 0 },
        { line: maxLine, ch: editor.getLine(maxLine).length }
      );
    });
  }

  // Insert a copy of ranges before insertLine (drag + Alt) without moving the original block
  copyRanges(
    editor: Editor,
    ranges: BlockRange[],
    insertLine: number,
    nestCol: number | null = null,
    quotePrefix: string | null = null
  ): void {
    const sorted = [...ranges].sort((a, b) => a.start - b.start);
    if (!sorted.length) return;
    const lines: string[] = [];
    for (const r of sorted) lines.push(...getLines(editor, r.start, r.end));
    this.insertLines(editor, lines, insertLine, nestCol, quotePrefix);
  }

  // Before inserting several lines of text into insertLine, you can press nestCol to align the indentation of the first line (sub-lines remain relatively indented),
  // Or press quotePrefix to uniformly supplement the quote prefix (drag into quote/callout nesting)
  insertLines(
    editor: Editor,
    lines: string[],
    insertLine: number,
    nestCol: number | null = null,
    quotePrefix: string | null = null
  ): void {
    if (!lines.length) return;
    const moved = lines.slice();
    if (nestCol != null) {
      const base = (moved[0].match(/^(\s*)/) || ['', ''])[1].length;
      if (base !== nestCol) {
        for (let i = 0; i < moved.length; i++) moved[i] = shiftIndent(moved[i], nestCol - base);
      }
    } else if (quotePrefix != null) {
      for (let i = 0; i < moved.length; i++) moved[i] = quotePrefix + moved[i];
    }
    const total = editor.lineCount();
    const insertAt = Math.min(Math.max(insertLine, 0), total);

    // Insertion will squeeze the items in the same list after the drop point, and the serial numbers must be rearranged along the new position → span will expand to the entire list segment.
    // When the drop point falls at the end of the document, it is anchored by the last line (it belongs to the target list).
    const anchorLine = Math.min(insertAt, total - 1);
    const expanded = expandToListSpan(editor, anchorLine, anchorLine);
    const from = expanded.from;
    const to = expanded.to;
    const at = Math.max(0, Math.min(insertAt - from, to - from + 1));
    const span = getLines(editor, from, to);
    const out = span.slice(0, at).concat(moved, span.slice(at));

    // The copy is numbered according to its location; the starting number is also taken from the snapshot before the transfer.
    const renumbered = renumberOrdered(out, { layerStarts: collectLayerStarts(span) });
    const newText = renumbered.lines.join('\n');
    const oldText = span.join('\n');
    if (oldText === newText) return;

    // Viewport lock: Insert/copy are both editing operations, and the view stops at the current editing position (no jump due to viewport recalculation)
    keepViewport(getCM(editor), () => {
      editor.replaceRange(
        newText,
        { line: from, ch: 0 },
        { line: to, ch: editor.getLine(to).length }
      );
    });
  }

  // Cross-document movement: text is inserted into the target document and deleted from the source document. Each of the two documents generates a one-step revocation.
  moveRangesTo(
    targetEditor: Editor,
    sourceEditor: Editor,
    ranges: BlockRange[],
    insertLine: number,
    nestCol: number | null = null,
    quotePrefix: string | null = null
  ): void {
    const sorted = [...ranges].sort((a, b) => a.start - b.start);
    if (!sorted.length) return;
    const lines: string[] = [];
    for (const r of sorted) lines.push(...getLines(sourceEditor, r.start, r.end));
    if (!lines.length) return;
    this.insertLines(targetEditor, lines, insertLine, nestCol, quotePrefix);
    this.removeRanges(sourceEditor, sorted);
  }

  /**
   * Delete several row ranges. Rewrite the entire section once - this ensures that deleting multiple sections only results in one-step undo.
   * You can also renumber the ordered list in the same paragraph of text (the serial number will be broken after deleting the middle item).
   * span extends outward to the boundary of the list segment to avoid repairing only to the vicinity of the deleted line and missing subsequent items. */
  removeRanges(editor: Editor, ranges: BlockRange[]): void {
    if (!ranges.length) return;
    const sorted = [...ranges].sort((a, b) => a.start - b.start);
    const total = editor.lineCount();

    const expanded = expandToListSpan(
      editor,
      Math.min(...sorted.map((r) => r.start)),
      Math.max(...sorted.map((r) => r.end))
    );
    const from = expanded.from;
    const to = Math.min(expanded.to, total - 1);
    if (to < from) return;

    const span = getLines(editor, from, to);
    const kept = span.filter(
      (_, i) => !sorted.some((r) => from + i >= r.start && from + i <= r.end)
    );
    const oldText = span.join('\n');
    // After deletion, the first row may become the original 2./3.. Use the layer snapshot before the transfer to restore the starting value.
    const newText = renumberOrdered(kept, { layerStarts: collectLayerStarts(span) }).lines.join(
      '\n'
    );
    if (oldText === newText) return;

    // Viewport lock: Delete the same editing operation, and the view stops at the current editing position (no jump due to viewport recalculation)
    keepViewport(getCM(editor), () => {
      editor.replaceRange(
        newText,
        { line: from, ch: 0 },
        { line: to, ch: editor.getLine(to).length }
      );
    });
  }

  // Drag in an ordinary paragraph/title: Only list items under Markdown have a parent-child structure, so the first line of the target is "listed"
  // (Add `- ` prefix), and insert the dragged block into its indented sub-item; if the first line of the dragged block is an ordinary paragraph (not a list/
  // title/reference/fence, etc.), also add `- ` to make it a sublist item. Rewrite the entire paragraph once and undo it in one step.
  // Keep source block when copy=true (Alt drag).
  nestUnderPlainBlock(
    editor: Editor,
    ranges: BlockRange[],
    targetLine: number,
    nestCol: number,
    copy: boolean
  ): void {
    if (!ranges.length) return;
    const sources = [...ranges].sort((a, b) => a.start - b.start);
    // The target row falls within the dragged range: not processed (defense, normality is guaranteed by the caller)
    if (sources.some((r) => targetLine >= r.start && targetLine <= r.end)) return;

    const minLine = Math.min(targetLine, sources[0].start);
    const maxLine = Math.max(targetLine, sources[sources.length - 1].end);
    const span = getLines(editor, minLine, maxLine);
    const inSource = (abs: number): boolean =>
      sources.some((r) => abs >= r.start && abs <= r.end);

    const kept: string[] = [];
    const keptAbs: number[] = [];
    for (let i = 0; i < span.length; i++) {
      const abs = minLine + i;
      if (!copy && inSource(abs)) continue;
      kept.push(span[i]);
      keptAbs.push(abs);
    }

    const tIdx = keptAbs.indexOf(targetLine);
    if (tIdx < 0) return;
    // Listing of the first line of the target: retain the indentation and original block mark (such as the title `#`) followed by the `- ` prefix
    const tLine = kept[tIdx];
    const tIndent = getIndent(tLine);
    kept[tIdx] = tIndent + '- ' + tLine.slice(tIndent.length);

    // The dragged line: the entire indentation is to nestCol; when the first line is an ordinary paragraph, it is changed to "indent + `- ` + text"
    // (Otherwise, Markdown will treat it as a continuation of the previous item and not an independent sub-block)
    const moved: string[] = [];
    for (const r of sources) moved.push(...getLines(editor, r.start, r.end));
    const base = getIndent(moved[0]).length;
    const delta = nestCol - base;
    const listifyMoved = sources[0].type === 'line';
    for (let i = 0; i < moved.length; i++) {
      if (i === 0 && listifyMoved) {
        moved[0] = ' '.repeat(nestCol) + '- ' + moved[0].slice(base);
      } else if (delta !== 0) {
        moved[i] = shiftIndent(moved[i], delta);
      }
    }

    const out = kept.slice(0, tIdx + 1).concat(moved, kept.slice(tIdx + 1));
    const oldText = span.join('\n');
    const newText = out.join('\n');
    if (oldText === newText) return;

    keepViewport(getCM(editor), () => {
      editor.replaceRange(
        newText,
        { line: minLine, ch: 0 },
        { line: maxLine, ch: editor.getLine(maxLine).length }
      );
    });
    this.ctx.handle.hideHandle();
  }

  /**
   * Make an in-place copy of the block. The copy strips off the block ID to avoid duplicate IDs in the same article;
   * When the block ID is separated into rows, the ID still points to the original block after the copy is inserted into the ID row.
   *
   * Rewrite the entire section once: multi-block copies only produce one-step undo, and the ordered list can be renumbered in the same section
   * (The copy row label is volatile, and the serial number is continued along the new position). */
  duplicateBlock(block: BlockContext): void {
    const editor = block.editor;
    const ranges = [...this.ctx.selection.actionRanges(block)].sort((a, b) => a.start - b.start);
    if (!ranges.length) return;

    // After which row is the copy of each block inserted (after the ID row when the block ID is a separate row)
    const copies: { after: number; lines: string[] }[] = [];
    let lo = Infinity;
    let hi = -1;
    for (const { start, end } of ranges) {
      const idLine = this.ctx.ids.findOwnLineIdLine(editor, end);
      const insertAfter = idLine !== null ? idLine : end;
      let text = getLines(editor, start, end).join('\n');
      const stripped = text
        .split('\n')
        .filter((l) => !/^\s*\^[A-Za-z0-9-]+\s*$/.test(l))
        .map((l) => l.replace(/\s\^[A-Za-z0-9-]+\s*$/, ''));
      if (stripped.join('\n').trim() !== '') text = stripped.join('\n');
      copies.push({ after: insertAfter, lines: text.split('\n') });
      lo = Math.min(lo, start);
      hi = Math.max(hi, insertAfter);
    }
    if (!copies.length || hi < lo) return;

    const expanded = expandToListSpan(editor, lo, hi);
    const from = expanded.from;
    const to = expanded.to;
    const span = getLines(editor, from, to);

    const out: string[] = [];
    for (let i = 0; i < span.length; i++) {
      out.push(span[i]);
      for (const c of copies) {
        if (from + i !== c.after) continue;
        for (const l of c.lines) out.push(l);
      }
    }

    const oldText = span.join('\n');
    const newText = renumberOrdered(out, { layerStarts: collectLayerStarts(span) }).lines.join(
      '\n'
    );
    if (oldText === newText) return;

    keepViewport(getCM(editor), () => {
      editor.replaceRange(
        newText,
        { line: from, ch: 0 },
        { line: to, ch: editor.getLine(to).length }
      );
    });
    this.ctx.handle.hideHandle();
  }

  // Create a copy of the block where the cursor is located (used in the command panel, does not rely on the handle)
  duplicateCurrentBlock(editor: Editor): void {
    const cursor = editor.getCursor();
    const block = this.ctx.detector.getBlockAtLine(editor, cursor.line);
    if (!block) return;
    this.duplicateBlock({ editor, file: null, start: block.start, end: block.end, type: block.type });
  }

  moveBlockVertically(block: BlockContext, dir: number): void {
    const editor = block.editor;
    const ranges = [...this.ctx.selection.actionRanges(block)].sort((a, b) => a.start - b.start);
    if (dir < 0) {
      if (ranges[0].start === 0) return;
      this.moveRanges(editor, ranges, ranges[0].start - 1);
    } else {
      const last = ranges[ranges.length - 1].end;
      if (last >= editor.lineCount() - 1) return;
      this.moveRanges(editor, ranges, last + 2);
    }
    this.ctx.handle.hideHandle();
  }

  moveCurrentBlock(editor: Editor, dir: number): void {
    const cursor = editor.getCursor();
    const block = this.ctx.detector.getBlockAtLine(editor, cursor.line);
    if (!block) return;
    this.moveBlockVertically({ editor, file: null, start: block.start, end: block.end, type: block.type }, dir);
  }

  deleteBlock(block: BlockContext): void {
    // Delete from bottom to top to avoid invalid line numbers
    this.removeRanges(block.editor, this.ctx.selection.actionRanges(block));
    this.ctx.handle.hideHandle();
  }

  // Open a blank line above/below the block and place the cursor, then you can write directly
  insertBlock(block: BlockContext, where: 'above' | 'below'): void {
    const editor = block.editor;
    const total = editor.lineCount();
    let line: number;

    if (where === 'above') {
      line = block.start;
      editor.replaceRange('\n', { line, ch: 0 });
    } else if (block.end >= total - 1) {
      line = total;
      editor.replaceRange('\n', { line: total - 1, ch: editor.getLine(total - 1).length });
    } else {
      line = block.end + 1;
      editor.replaceRange('\n', { line, ch: 0 });
    }

    editor.setCursor({ line, ch: 0 });
    editor.focus();
    this.ctx.handle.hideHandle();
  }

  indentCurrentBlock(editor: Editor, dir: number): void {
    const cursor = editor.getCursor();
    const block = this.ctx.detector.getBlockAtLine(editor, cursor.line);
    if (!block) return;

    const lines = getLines(editor, block.start, block.end);
    const step = this.ctx.settings.indentStep > 0 ? this.ctx.settings.indentStep : this.detectIndentStep(editor);
    if (dir > 0) {
      for (let i = 0; i < lines.length; i++) lines[i] = shiftIndent(lines[i], step);
    } else {
      const base = getIndent(lines[0]).length;
      if (base === 0) return;
      const delta = -Math.min(base, step);
      for (let i = 0; i < lines.length; i++) lines[i] = shiftIndent(lines[i], delta);
    }

    editor.replaceRange(
      lines.join('\n'),
      { line: block.start, ch: 0 },
      { line: block.end, ch: editor.getLine(block.end).length }
    );
    editor.setCursor({ line: cursor.line, ch: Math.min(cursor.ch, editor.getLine(cursor.line).length) });
  }

  // The smallest positive indentation in the full text is treated as one level. If it cannot be found, use 4 spaces.
  detectIndentStep(editor: Editor): number {
    let min = 0;
    for (let i = 0; i < editor.lineCount(); i++) {
      const n = getIndent(editor.getLine(i)).length;
      if (n > 0 && (min === 0 || n < min)) min = n;
    }
    return min > 0 && min <= 8 ? min : 4;
  }

  blockLength(block: BlockContext): number {
    const editor = block.editor;
    const end = Math.min(block.end, editor.lineCount() - 1);
    if (end < block.start) return 0;
    return getLines(editor, block.start, end).join('').replace(/\s/g, '').length;
  }

  copyBlockContent(block: BlockContext): void {
    const editor = block.editor;
    const ranges = this.ctx.selection.actionRanges(block);
    let text = ranges.map((r) => getLines(editor, r.start, r.end).join('\n')).join('\n');
    // The fence can only be peeled off when "just copy this code block"; it cannot be peeled off when multiple blocks are selected and merged into one section, otherwise the first and last lines will be deleted by mistake.
    const single = ranges.length === 1 && ranges[0].start === block.start && ranges[0].end === block.end;
    if (block.type === 'code' && single) {
      const lines = text.split('\n');
      if (lines.length >= 2) text = lines.slice(1, -1).join('\n');
    }
    navigator.clipboard.writeText(text).then(() => new Notice(TEXT.message0259)).catch(() => new Notice(TEXT.message0260));
    this.ctx.handle.hideHandle();
  }
}
