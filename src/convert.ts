import { TEXT } from './strings';
import { Notice } from 'obsidian';
import type { Editor } from 'obsidian';
import type { BlockContext, BlockRange, TurnIntoType } from './types';
import type BlockEditorPlugin from './main';
import type { ColumnsOpts } from './columns-preview';
import {
  BLOCK_COLOR_RE,
  BLOCK_COLOR_SPAN_RE,
  normalizeBlockColor,
  parseBlockColorValue,
} from './block-color';
import { deriveDarkColor, parseColBgMeta } from './col-bg';
import type { ColBg } from './col-bg';
import { getIndent, getLines } from './util';

/** Column shell mark row: `> [!multi-column]` (width parameter `|NN-NN` optional) */
const COL_START_RE = /^>\s*\[!multi-column(?:\|[^\]]*)?\]\s*$/;

/** The first word of the mermaid diagram type declaration (the legal mermaid fence content must start with one of them, and the preceding %% comment is allowed) */
const MERMAID_KINDS = new Set([
  'graph', 'flowchart', 'sequenceDiagram', 'classDiagram', 'stateDiagram',
  'stateDiagram-v2', 'erDiagram', 'gantt', 'pie', 'quadrantChart',
  'requirementDiagram', 'gitGraph', 'mindmap', 'timeline', 'block-beta',
  'sankey', 'journey', 'xychart-beta', 'zenuml', 'architecture-beta',
  'packet-beta', 'kanban', 'example',
]);

/** Determine whether the content looks like a legal mermaid diagram (skip blank lines and %% comment lines, the first valid token must be a diagram type declaration).
 * Used for interception before "converting to mermaid": ordinary text/empty content wrapped into fences will be thrown by the mermaid renderer
 * UnknownDiagramError. */
export function isMermaidContent(content: string): boolean {
  for (const line of content.split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('%%')) continue;
    const word = t.match(/^[A-Za-z][\w-]*/)?.[0] ?? '';
    return MERMAID_KINDS.has(word);
  }
  return false;
}
/** Column structure separated rows: only reference rows of `>` */
const COL_SEP_RE = /^>\s*$/;
/** Any reference line (used for column range boundaries and shell backtracking) */
const QUOTE_RE = /^>\s?/;

/** Column structure parsing results (common to convert.ts text commands) */
interface ParsedColumns {
  /** Shell line number / column last line number (write back the replacement range) */
  shellStart: number;
  shellEnd: number;
  /** Content of each column (reference prefix stripped, empty columns are empty strings) */
  segments: string[];
  /** Percentage of width of each column (empty array when there is no metadata) */
  widths: number[];
  /** Background color of each column (two-color model: light / dark, no background is null) */
  bgs: (ColBg | null)[];
  /** 2D rows: number of columns per row (empty array = single row) */
  rows: number[];
  /** Shell appearance parameters (gap/valign/radius/border) */
  opts: ColumnsOpts;
  /** The absolute line number of each column header (locating the column where the current block is located) */
  colLines: number[];
}

/** Construct column markdown from the text in each column (combined into columns and shared by edit state write-back).
 * bgs[i] is the background of column i (ColBg). If it is empty/null, do not write the `|bg=` parameter;
 * Write `bg=#xxxxxx` in light color; append only if dark color is an explicit override value (≠ automatically deduced)
 * `bg-dark=#yyyyyy` (the automatically derived value is reproduced by the reading end according to the same algorithm, maintaining the old single value format).
 * rowEnds is the row end column index of a two-dimensional row (such as [1,3] means 0-1 / 2-3 two rows), empty array = single row.
 *opts are shell appearance parameters (gap/valign/radius/border). */
export function buildColumnsMarkdown(
  segments: string[],
  widths?: number[],
  bgs?: (ColBg | null)[],
  rowEnds?: number[],
  opts?: ColumnsOpts
): string {
  const n = segments.length;
  // Metadata is written when the width is not evenly divided (single row `|60-40`; multiple rows grouped by row `|60-40/50-50`),
  // Provides Live Preview widget to restore the column width; when there are multiple rows, each row will be judged according to the number of its own columns to determine whether it is evenly divided.
  const params: string[] = [];
  if (widths && widths.length === n) {
    let needsWidth = false;
    if (rowEnds && rowEnds.length) {
      let start = 0;
      for (const re of rowEnds) {
        const group = widths.slice(start, re + 1);
        if (group.some((w) => Math.abs(w - 100 / group.length) > 0.5)) { needsWidth = true; break; }
        start = re + 1;
      }
      if (!needsWidth && start < n) {
        const last = widths.slice(start);
        if (last.some((w) => Math.abs(w - 100 / last.length) > 0.5)) needsWidth = true;
      }
    } else {
      needsWidth = widths.some((w) => Math.abs(w - 100 / n) > 0.5);
    }
    if (needsWidth) {
      if (rowEnds && rowEnds.length) {
        const groups: string[] = [];
        let start = 0;
        for (const re of rowEnds) {
          groups.push(widths.slice(start, re + 1).map((w) => Math.round(w)).join('-'));
          start = re + 1;
        }
        if (start < n) groups.push(widths.slice(start).map((w) => Math.round(w)).join('-'));
        params.push(groups.join('/'));
      } else {
        params.push(widths.map((w) => Math.round(w)).join('-'));
      }
    }
  }
  // H1 appearance parameters: gap / valign / radius / border (written back only after explicit setting, consistent with bg semantics)
  if (opts?.gap != null) params.push(`gap=${opts.gap}`);
  if (opts?.valign) params.push(`valign=${opts.valign}`);
  if (opts?.radius != null) params.push(`radius=${opts.radius}`);
  if (opts?.border) params.push('border');
  const head = params.length ? `> [!multi-column|${params.join('|')}]` : '> [!multi-column]';
  const out: string[] = [head, '>'];
  segments.forEach((seg, i) => {
    if (i > 0) {
      out.push('>');
      // Two-dimensional line boundary: the previous column is the end of the line → write `>> [!colrow]` line mark; another line must be added after the mark
      // Level 1 reference delimiter line `>`. Otherwise, `>> [!colrow]` belongs to the same category as `>> [!col]` in the first column of the next line.
      // A level 2 reference block. Obsidian will treat this column as the content of colrow. It is colrowed in reading mode.
      // The hidden rule (height:0 + child element display:none) is swallowed, which is manifested as "the first column of the next line is lost".
      if (rowEnds?.includes(i - 1)) {
        out.push('>> [!colrow]');
        out.push('>');
      }
    }
    const bg = bgs?.[i];
    if (bg && bg.light) {
      const colParams = [`bg=${bg.light}`];
      // Dark colors that are explicitly overwritten are only dropped into the library; automatically derived values are not written (reproduced by the same algorithm on the reading end)
      if (bg.dark && bg.dark !== deriveDarkColor(bg.light)) colParams.push(`bg-dark=${bg.dark}`);
      out.push(`>> [!col|${colParams.join('|')}]`);
    } else {
      out.push('>> [!col]');
    }
    for (const line of seg.split('\n')) out.push(line.trim() === '' ? '>>' : '>> ' + line);
  });
  return out.join('\n');
}

/** Segmentation results of converting nested lists into columns (plain text calculation, convenient for offline assertion) */
export interface ListColumnsPlan {
  /** The content of each column (common basic indentation has been stripped), the element is the multi-line text in the column */
  segments: string[];
  /**
   * The leading paragraph outside the column (common indentation stripped, usually the parent line when level=1).
   * The parent is the introductory word that governs all children and should not be crammed into a column - that would visually imply
   * It only belongs in that column. The caller should write this before the column. */
  lead?: string;
  /** Why the segmentation result is not available (for menu prompts; `segments` has a value only when it is empty) */
  reason?: 'no-list' | 'need-two' | 'multi-parent';
}

/** List item row determination: `indent + List symbols + space`. Numbers/dots/dashes/plus signs/asterisk all count. */
const LIST_ITEM_RE = /^(\s*)(?:[-*+]|\d+[.)])\s+/;

/** Get line indent width */
function indentWidth(line: string): number {
  return (line.match(/^(\s*)/) || ['', ''])[1].length;
}

/**
 * Split the nested list into multiple columns according to the indentation level (the pure calculation part of `wrapListToColumns`).
 *
 * `level` semantics (split point = indent exactly equal to list items at this level):
 * - `0` "By parent": Each list item in the shallowest level has its own column, and all descendant rows below it follow this column.
 * - `1` "By child": **requires that the entire paragraph has only one parent**, and each of its direct children has its own column.
 * Deeper child rows follow the corresponding children; parent rows are not merged into any column** but are treated as
 * `lead` boot section is written by the caller before the column. Returns `multi-parent` when there are multiple parents
 * --The semantics of that form are inherently ambiguous, so we would rather not convert them.
 *
 * The same semantics as `columnsSegmentCount`: **The lines within the code fence do not participate in the split point determination**,
 * Prevent the code embedded in the list item (the indentation is often deeper) from being misjudged as a deeper level and cutting into the wrong column. */
export function planListColumns(
  lines: string[],
  level = 0
): ListColumnsPlan | null {
  const isItem = (l: string): boolean => LIST_ITEM_RE.test(l);

  // Collect list item subscripts and indentation levels that have occurred
  const itemIdx: number[] = [];
  for (let i = 0; i < lines.length; i++) if (isItem(lines[i])) itemIdx.push(i);
  if (!itemIdx.length) return { segments: [], reason: 'no-list' };

  const indents: number[] = [];
  for (const i of itemIdx) {
    const n = indentWidth(lines[i]);
    if (!indents.includes(n)) indents.push(n);
  }
  indents.sort((a, b) => a - b);
  const cutIndent = indents[Math.min(level, indents.length - 1)];
  const baseIndent = indents[0];

  // level=1 requires a single parent: semantic ambiguity when there are multiple parents, and conversion is refused (to avoid silently losing content)
  let head: string[] = [];
  if (level > 0 && cutIndent !== baseIndent) {
    const parents = itemIdx.filter((i) => indentWidth(lines[i]) === baseIndent);
    if (parents.length > 1) return { segments: [], reason: 'multi-parent' };
    // All lines between the parent line and the first tangent point (including deeper levels) serve as the leading paragraph before the column.
    const firstCut = itemIdx.find((i) => indentWidth(lines[i]) === cutIndent);
    for (let i = 0; i < (firstCut ?? lines.length); i++) {
      if (lines[i].trim() !== '') head.push(lines[i]);
    }
  }

  // Segment by cut point: Hit the cut point to open a new column, and the remaining lines will follow the current column.
  const groups: string[][] = [];
  let cur: string[] | null = null;
  let fenceCh: string | null = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (fenceCh !== null) {
      const m = line.match(/^\s*(`{3,}|~{3,})/);
      if (m && m[1][0] === fenceCh) fenceCh = null;
      if (cur) cur.push(line);
      continue;
    }
    const f = line.match(/^\s*(`{3,}|~{3,})/);
    if (f) {
      fenceCh = f[1][0];
      if (cur) cur.push(line);
      continue;
    }
    // Cut point: The indentation is exactly equal to the list item of the cut level. The first cut point opens the first column, and each subsequent cut point opens a new column.
    if (isItem(line) && indentWidth(line) === cutIndent) {
      groups.push((cur = []));
    }
    if (!cur) continue; // Rows before the split point (parent title area) have been collected separately
    cur.push(line);
  }

  if (groups.length < 2) return { segments: [], reason: 'need-two' };

  // The common basic indentation is stripped off, and the list in the column starts from the top cell (the relative hierarchy is kept intact)
  const dedent = (s: string): string =>
    s
      .split('\n')
      .map((l) => {
        if (l.trim() === '') return '';
        const n = indentWidth(l);
        return ' '.repeat(Math.max(n - cutIndent, 0)) + l.slice(n);
      })
      .join('\n')
      .replace(/\s+$/, '');

  const segments = groups.map((g) => dedent(g.join('\n')));
  // The parent row is returned independently as the leading section before the column, **not merged into any column**
  const lead = head.length ? dedent(head.join('\n')) : '';
  return lead ? { segments, lead } : { segments };
}

/** Block type recognition and "convert to" */
export class BlockConverter {
  constructor(private ctx: BlockEditorPlugin) {}

  stripBlockPrefix(text: string): string {
    return text.replace(
      /^(#{1,6}\s+|[-*+]\s+(?:\[[ xX]\]\s+)?|\d+[.)]\s+|>\s+(?:\[![\w-]+\][+-]?\s*)?)/,
      ''
    );
  }

  convertBlock(editor: Editor, block: BlockRange, type: TurnIntoType, lang = ''): void {
    const start = block.start;
    const src = block.type;
    const total = editor.lineCount();

    // It is already the same kind of "wrapped" block: only the language tags are changed for the code block, and the tables/formulas do not need to be processed.
    if (src === type && ['code', 'table', 'math'].includes(type)) {
      if (type === 'code') {
        const line = editor.getLine(start);
        editor.setLine(start, line.replace(/^(\s*(?:`{3,}|~{3,}))\s*\S*/, '$1' + lang));
      }
      return;
    }

    // Code block / formula block / table -> other types: first remove the shell, and then convert the entire content according to the target type
    // Rearrange (encapsulation/prefix applied to all lines) to avoid operating single-line branches on the first line only and leaving multiple lines of content dangling.
    if (src === 'code' || src === 'math' || src === 'table') {
      const end = Math.min(block.end, total - 1);
      const inner =
        src === 'table'
          ? this.tableToText(editor, start, end)
          : getLines(editor, start + 1, end - 1).join('\n');
      // Mermaid goal: the content must be in legal graph syntax, otherwise it will prompt and terminate (to avoid generating illegal fences)
      if (type === 'mermaid' && !isMermaidContent(inner)) {
        new Notice(TEXT.message0200);
        return;
      }
      editor.replaceRange(
        this.applyWrapOrPrefix(inner, type, lang),
        { line: start, ch: 0 },
        { line: end, ch: editor.getLine(end).length }
      );
      return;
    }

    // Target type that needs to be wrapped
    const wraps: Partial<Record<TurnIntoType, [string, string]>> = {
      code: ['```' + lang, '```'],
      mermaid: ['```mermaid', '```'],
      math: ['$$', '$$'],
    };
    const wrap = wraps[type];
    if (wrap) {
      const content = this.readContent(editor, start);
      // Mermaid goal: If ordinary text/empty content is wrapped into a fence, the renderer will throw an UnknownDiagramError and intercept the prompt.
      if (type === 'mermaid' && !isMermaidContent(content)) {
        new Notice(TEXT.message0201);
        return;
      }
      editor.replaceRange(
        [wrap[0], content, wrap[1]].join('\n'),
        { line: start, ch: 0 },
        { line: start, ch: editor.getLine(start).length }
      );
      return;
    }

    if (type === 'table') {
      editor.replaceRange(
        [
          TEXT.message0202,
          '| --- | --- |',
          '| ' + this.readContent(editor, start) + ' |  |',
        ].join('\n'),
        { line: start, ch: 0 },
        { line: start, ch: editor.getLine(start).length }
      );
      return;
    }

    if (type === 'divider') {
      editor.replaceRange(
        '---',
        { line: start, ch: 0 },
        { line: start, ch: editor.getLine(start).length }
      );
      return;
    }

    const prefixes: Partial<Record<TurnIntoType, string>> = {
      paragraph: '',
      h1: '# ',
      h2: '## ',
      h3: '### ',
      h4: '#### ',
      h5: '##### ',
      h6: '###### ',
      ul: '- ',
      ol: '1. ',
      todo: '- [ ] ',
      quote: '> ',
      toggle: '> [!note]- ',
    };
    // Callout supports submenu to pass in specific type (lang), the default is note
    const prefix = type === 'callout' ? '> [!' + (lang || 'note') + '] ' : prefixes[type];
    if (prefix === undefined) return;

    const line = editor.getLine(start);
    const newLine = getIndent(line) + prefix + this.readContent(editor, start);
    if (newLine !== line) editor.setLine(start, newLine);
  }

  // Multi-select batch conversion: apply block by block from bottom to top to avoid row number invalidation
  convertRanges(editor: Editor, ranges: BlockRange[], type: TurnIntoType, lang = ''): void {
    const sorted = [...ranges].sort((a, b) => b.start - a.start);
    for (const r of sorted) this.convertBlock(editor, r, type, lang);
  }

  // Convert the table into one line of text: discard the separated lines and connect the cells with spaces
  tableToText(editor: Editor, start: number, end: number): string {
    const cells: string[] = [];
    for (let i = start; i <= end; i++) {
      const line = editor.getLine(i);
      if (/^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(line)) continue;
      for (const cell of line.split('|')) {
        const v = cell.trim();
        if (v) cells.push(v);
      }
    }
    return cells.join(' ');
  }

  // The multi-line inner after unpacking is rearranged as a whole according to the target type: the wrapping/prefix is applied to all lines,
  // Avoid code block/formula block/table conversion where only the first row is processed and the remaining rows are left hanging
  private applyWrapOrPrefix(inner: string, type: TurnIntoType, lang: string): string {
    if (type === 'code') return '```' + lang + '\n' + inner + '\n```';
    if (type === 'mermaid') return '```mermaid\n' + inner + '\n```';
    if (type === 'math') return '$$\n' + inner + '\n$$';
    if (type === 'divider') return '---';
    if (type === 'table') {
      const body = inner
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean)
        .map((l) => '| ' + l + ' |')
        .join('\n');
      return TEXT.message0203 + body;
    }
    const lines = inner.split('\n');
    const rest = lines.slice(1);
    switch (type) {
      case 'paragraph':
        return inner;
      case 'h1':
      case 'h2':
      case 'h3':
      case 'h4':
      case 'h5':
      case 'h6':
        // The first line is used as the title, and the remaining lines are used as body paragraphs (keep multiple lines intact)
        return '#'.repeat(Number(type[1])) + ' ' + lines[0] +
          (rest.length ? '\n' + rest.join('\n') : '');
      case 'ul':
        return lines.map((l) => '- ' + l).join('\n');
      case 'ol':
        return lines.map((l, i) => i + 1 + '. ' + l).join('\n');
      case 'todo':
        return lines.map((l) => '- [ ] ' + l).join('\n');
      case 'quote':
        return lines.map((l) => '> ' + l).join('\n');
      case 'callout':
        return '> [!' + (lang || 'note') + '] ' + lines[0] +
          (rest.length ? '\n' + rest.map((l) => '> ' + l).join('\n') : '');
      case 'toggle':
        return '> [!note]- ' + lines[0] +
          (rest.length ? '\n' + rest.map((l) => '> ' + l).join('\n') : '');
      default:
        return inner;
    }
  }

  // The block where the cursor is located is directly converted (used in the command panel, does not rely on the handle)
  convertCurrentBlock(editor: Editor, type: TurnIntoType): void {
    const cursor = editor.getCursor();
    const block = this.ctx.detector.getBlockAtLine(editor, cursor.line);
    if (!block) {
      new Notice(TEXT.message0204);
      return;
    }
    const ctxBlock: BlockContext = { editor, file: null, start: block.start, end: block.end, type: block.type };
    this.convertBlock(editor, ctxBlock, type);
  }

  // Get the first line of the block (remove the indent and block prefix)
  readContent(editor: Editor, lineIndex: number): string {
    const line = editor.getLine(lineIndex);
    return this.stripBlockPrefix(line.slice(getIndent(line).length));
  }

  detectType(line: string): TurnIntoType {
    const s = line.replace(/^\s*/, '');
    if (/^#\s/.test(s)) return 'h1';
    if (/^##\s/.test(s)) return 'h2';
    if (/^###\s/.test(s)) return 'h3';
    if (/^####\s/.test(s)) return 'h4';
    if (/^#####\s/.test(s)) return 'h5';
    if (/^######\s/.test(s)) return 'h6';
    if (/^[-*+]\s+\[[ xX]\]\s/.test(s)) return 'todo';
    if (/^[-*+]\s/.test(s)) return 'ul';
    if (/^\d+[.)]\s/.test(s)) return 'ol';
    const co = s.match(/^>\s*\[!([\w-]+)\]([+-])?\s/);
    if (co) return co[2] ? 'toggle' : 'callout';
    if (/^>\s?/.test(s)) return 'quote';
    if (/^(-{3,}|\*{3,}|_{3,})\s*$/.test(s)) return 'divider';
    return 'paragraph';
  }

  getFenceLang(block: BlockContext): string {
    const line = block.editor.getLine(block.start);
    const match = line.match(/^\s*(?:`{3,}|~{3,})(.*)$/);
    return match ? match[1].trim() : '';
  }

  // The current status of the collapsed block: `[!type]-` collapsed / `[!type]+` expanded; non-collapsed block returns null
  foldStateOf(block: BlockContext): 'collapsed' | 'expanded' | null {
    const s = block.editor.getLine(block.start).replace(/^\s*/, '');
    const m = s.match(/^>\s*\[![\w-]+\]([+-])\s/);
    if (!m) return null;
    return m[1] === '-' ? 'collapsed' : 'expanded';
  }

  // Folding block expanded state switching: swap the first line `-` and `+` of each folding block participating in the operation (single-step undo)
  toggleFoldState(block: BlockContext): void {
    const editor = block.editor;
    const ranges = this.ctx.selection.actionRanges(block);
    let hit = 0;
    for (const r of ranges) {
      const line = editor.getLine(r.start);
      const next = line.replace(/^(\s*>\s*\[![\w-]+\])([+-])(\s)/, (_m, head, sign, sp) =>
        head + (sign === '-' ? '+' : '-') + sp
      );
      if (next !== line) {
        editor.setLine(r.start, next);
        hit++;
      }
    }
    if (!hit) new Notice(TEXT.message0205);
    this.ctx.handle.hideHandle();
  }

  // ----Column (multi-column callout)----

  // Whether the block is a column container
  isColumnsBlock(editor: Editor, block: BlockRange): boolean {
    return COL_START_RE.test(editor.getLine(block.start));
  }

  // Whether the block is inside a column interval (the first line is not the shell mark itself, but goes back to the shell).
  // Used to prevent the original column structure from being truncated when performing "Add Column/Combine into Columns" on the content inside the column.
  insideColumns(editor: Editor, block: BlockRange): boolean {
    if (this.isColumnsBlock(editor, block)) return false;
    for (let i = block.start; i >= 0; i--) {
      const line = editor.getLine(i);
      if (COL_START_RE.test(line)) return true;
      if (!/^\s*>/.test(line)) return false;
    }
    return false;
  }

  // Preview the number of segments that can be cut before combining and dividing into columns (intervals are cut into blank lines, with one column for each segment; ≥ 2 is meaningful).
  // Empty lines inside code fences/math blocks do not count as segmentation points.
  columnsSegmentCount(block: BlockContext): number {
    const editor = block.editor;
    const ranges = this.ctx.selection.actionRanges(block);
    const start = Math.min(...ranges.map((r) => r.start));
    const end = Math.max(...ranges.map((r) => r.end));
    let count = 0;
    let inSeg = false;
    let fenceCh: string | null = null;
    for (let i = start; i <= end; i++) {
      const line = editor.getLine(i);
      if (fenceCh !== null) {
        const m = line.match(/^\s*(`{3,}|~{3,})/);
        if (m && m[1][0] === fenceCh) fenceCh = null;
        continue;
      }
      const f = line.match(/^\s*(`{3,}|~{3,})/);
      if (f) {
        fenceCh = f[1][0];
        if (!inSeg) {
          count++;
          inSeg = true;
        }
        continue;
      }
      if (line.trim() === '') {
        inSeg = false;
        continue;
      }
      if (!inSeg) {
        count++;
        inSeg = true;
      }
    }
    return count;
  }

  // Combine into columns: The entire range is cut into segments by blank lines, and each segment is wrapped into one column (single-step undo).
  // Blank lines inside code fences/math blocks are not cut into segments to prevent multi-line code blocks from being broken up.
  wrapBlockToColumns(block: BlockContext): void {
    const editor = block.editor;
    const ranges = this.ctx.selection.actionRanges(block).slice().sort((a, b) => a.start - b.start);
    const start = ranges[0].start;
    const end = ranges[ranges.length - 1].end;

    const segments: string[][] = [];
    let cur: string[] = [];
    let fenceCh: string | null = null;
    for (const line of getLines(editor, start, end)) {
      if (fenceCh !== null) {
        cur.push(line);
        const m = line.match(/^\s*(`{3,}|~{3,})/);
        if (m && m[1][0] === fenceCh) fenceCh = null;
        continue;
      }
      const f = line.match(/^\s*(`{3,}|~{3,})/);
      if (f) {
        fenceCh = f[1][0];
        cur.push(line);
        continue;
      }
      if (line.trim() === '') {
        if (cur.length) segments.push(cur);
        cur = [];
      } else {
        cur.push(line);
      }
    }
    if (cur.length) segments.push(cur);

    if (segments.length < 2) {
      new Notice(TEXT.message0206);
      return;
    }

    const out = buildColumnsMarkdown(segments.map((seg) => seg.join('\n')));

    // Paste blank lines before and after to ensure that the callout is independent of adjacent blocks.
    const total = editor.lineCount();
    const prefix = start > 0 && editor.getLine(start - 1).trim() !== '' ? [''] : [];
    const suffix = end < total - 1 && editor.getLine(end + 1).trim() !== '' ? [''] : [];
    const text = [...prefix, ...out.split('\n'), ...suffix].join('\n');

    editor.replaceRange(
      text,
      { line: start, ch: 0 },
      { line: end, ch: editor.getLine(end).length }
    );
    this.ctx.handle.hideHandle();
  }

  /**
   * The scope of converting the list into columns: use the selection when making multiple selections, otherwise the **entire list of the same level** where the cursor is located will be
   * Incorporate into the scope (find the starting point of the same indented list item upwards and merge all its sub-items downwards).
   *
   * If you don't do this, the range will only be one line when the cursor is parked on a single sub-item → the column cannot be cut, and the menu item will always be grayed out. */
  private listColumnRange(block: BlockContext): { start: number; end: number } {
    const sel = this.ctx.selection.selection;
    if (sel && sel.editor === block.editor && this.ctx.selection.isInSelection(block) && sel.ranges.length > 1) {
      const rs = sel.ranges.slice().sort((a, b) => a.start - b.start);
      return { start: rs[0].start, end: rs[rs.length - 1].end };
    }
    const editor = block.editor;
    // Up: Go past all shallower ancestor list items and find the top-level item of the list as a starting point.
    // When the cursor is parked on a child item at any depth, the scope covers the "entire list" instead of a single child item.
    let start = block.start;
    let base = indentWidth(editor.getLine(block.start));
    for (let i = block.start - 1; i >= 0; i--) {
      const line = editor.getLine(i);
      const m = LIST_ITEM_RE.exec(line);
      if (m) {
        const ind = m[1].length;
        if (ind < base) {
          // A shallower ancestor list item: it is the top level of this list, included in the scope and continues upward with its indentation
          start = i;
          base = ind;
        } else if (ind === base) {
          // Sibling items: Located at the top level, continue upward to find the real starting point of the list
          start = i;
        }
        // ind > base：deeper children，Belongs to current item，Does not affect the starting point
      } else if (line.trim() === '') break;
      else if (indentWidth(line) >= base) continue; // Indent deeper continuation lines
      else break; // Top text: The list ends here
    }
    return { start, end: block.end };
  }

  /**
   * The number of columns that can be cut out of the nested list (for judgment when the menu is grayed out).
   * `by='parent'` is based on the number of the shallowest list items, `by='child'` is based on the number of sub-items on the first level.
   * If there are less than 2 columns, return 0, indicating that it cannot be converted. */
  listColumnCount(block: BlockContext, by: 'parent' | 'child' = 'parent'): number {
    const r = this.listColumnRange(block);
    const plan = planListColumns(
      getLines(block.editor, r.start, r.end),
      by === 'parent' ? 0 : 1
    );
    return plan ? plan.segments.length : 0;
  }

  /**
   * Convert the nested list to columns: cut into one column each by parent item (`parent`) or by one layer of subitems (`child`).
   * The product reuses `buildColumnsMarkdown`, and pastes blank lines before and after (single-step undo) in the same way as "combine into columns".
   *
   * It is not allowed to add another layer to the existing column; when the number of columns is less than 2, it will prompt and terminate. */
  wrapListToColumns(block: BlockContext, by: 'parent' | 'child' = 'parent'): void {
    const editor = block.editor;
    if (this.isColumnsBlock(editor, block) || this.insideColumns(editor, block)) {
      new Notice(TEXT.message0207);
      return;
    }
    const r = this.listColumnRange(block);

    const plan = planListColumns(
      getLines(editor, r.start, r.end),
      by === 'parent' ? 0 : 1
    );
    if (!plan || plan.segments.length < 2) {
      new Notice(
        plan?.reason === 'multi-parent'
          ? TEXT.message0208
          : by === 'parent'
            ? TEXT.message0209
            : TEXT.message0210
      );
      return;
    }

    const out = buildColumnsMarkdown(plan.segments);
    const total = editor.lineCount();
    const prefix = r.start > 0 && editor.getLine(r.start - 1).trim() !== '' ? [''] : [];
    const suffix = r.end < total - 1 && editor.getLine(r.end + 1).trim() !== '' ? [''] : [];
    // The boot section (the parent when level=1) is written **before** the column and leaves a blank line between it and the column:
    // It leads all the subsections, and cramming it into one column visually misleads the attribution and makes the first column noticeably heavier.
    const lead = plan.lead ? [...plan.lead.split('\n'), ''] : [];
    const text = [...prefix, ...lead, ...out.split('\n'), ...suffix].join('\n');

    editor.replaceRange(
      text,
      { line: r.start, ch: 0 },
      { line: r.end, ch: editor.getLine(r.end).length }
    );
    this.ctx.handle.hideHandle();
  }

  // Cancel column division: peel off the shell and column markers and restore to normal blocks (single-step undo)
  unwrapColumns(block: BlockContext): void {
    const editor = block.editor;
    if (!this.isColumnsBlock(editor, block)) {
      new Notice(TEXT.message0211);
      return;
    }
    const columns: string[][] = [];
    let cur: string[] | null = null;

    const lines = getLines(editor, block.start, block.end);
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (i === 0 && COL_START_RE.test(line)) continue;
      if (COL_SEP_RE.test(line)) {
        if (cur && cur.length) {
          columns.push(cur);
          cur = null;
        }
        continue;
      }
      if (/^>\s*>\s*\[!col(?:\|[^\]]*)?\]/.test(line)) {
        if (cur && cur.length) columns.push(cur);
        cur = [];
        continue;
      }
      // H2 two-dimensional lines: colrow is a line separation mark. When canceling column division, the lines are broken into independent paragraph blocks.
      if (/^>\s*>\s*\[!colrow(?:\|[^\]]*)?\]/.test(line)) {
        if (cur && cur.length) columns.push(cur);
        cur = null;
        continue;
      }
      const m = line.match(/^>\s*>\s?(.*)$/);
      if (m) {
        if (!cur) cur = [];
        cur.push(m[1]);
      }
    }
    if (cur && cur.length) columns.push(cur);
    const parts = columns
      .map((c) => {
        while (c.length && c[c.length - 1].trim() === '') c.pop();
        return c.join('\n');
      })
      .filter((s) => s.length > 0);

    if (!parts.length) {
      new Notice(TEXT.message0212);
      return;
    }
    editor.replaceRange(
      parts.join('\n\n'),
      { line: block.start, ch: 0 },
      { line: block.end, ch: editor.getLine(block.end).length }
    );
    this.ctx.handle.hideHandle();
  }

  // Append an empty column at the end of the column, and the cursor falls on the content line of the new column
  addColumn(block: BlockContext): void {
    const editor = block.editor;
    editor.replaceRange('\n>\n>> [!col]\n>>', {
      line: block.end,
      ch: editor.getLine(block.end).length,
    });
    editor.setCursor({ line: block.end + 3, ch: 2 });
    editor.focus();
    this.ctx.handle.hideHandle();
  }

  // Insert a two-column empty shell below the current block, and the cursor falls into the first column content line
  addEmptyColumns(block: BlockContext): void {
    const editor = block.editor;
    // If there is a content line immediately below, add a blank line to ensure that the callout ends independently.
    const hasNext = block.end + 1 < editor.lineCount();
    const nextLine = hasNext ? editor.getLine(block.end + 1) : '';
    const suffix = hasNext && nextLine.trim() !== '' ? '\n' : '';
    editor.replaceRange(
      '\n> [!multi-column]\n>\n>> [!col]\n>>\n>\n>> [!col]\n>>' + suffix,
      { line: block.end, ch: editor.getLine(block.end).length }
    );
    editor.setCursor({ line: block.end + 4, ch: 2 });
    editor.focus();
    this.ctx.handle.hideHandle();
  }

  // H2: Append a line at the end of the column (the number of columns is the same as the first line, including the `>> [!colrow]` line mark),
  // It is used in the block menu "Add a Row" and the source code state; in the Live Preview editing state, use addRow in the widget.
  appendColumnRow(block: BlockContext): void {
    const editor = block.editor;
    if (!this.isColumnsBlock(editor, block)) {
      new Notice(TEXT.message0213);
      return;
    }
    const lines = getLines(editor, block.start, block.end);
    let firstRowCols = 0;
    for (const l of lines) {
      if (/^>\s*>\s*\[!colrow(?:\|[^\]]*)?\]/.test(l)) break;
      if (/^>\s*>\s*\[!col(?:\|[^\]]*)?\]/.test(l)) firstRowCols++;
    }
    const perRow = Math.max(firstRowCols, 1);
    // Row mark + empty shell for each column (`>` separates the columns), appended at the end of the column
    const rowText =
      '\n>> [!colrow]\n>>\n>' +
      Array.from({ length: perRow }, () => '\n>> [!col]\n>>').join('\n>');
    editor.replaceRange(
      rowText,
      { line: block.end, ch: editor.getLine(block.end).length }
    );
    this.ctx.handle.hideHandle();
  }

  // ----H2 column and column editing enhancements (text commands, block menu entry)----

  /** Locate the column interval and parse the structure: the column block itself or the internal block (the internal block traces back the shell row upwards) */
  private parseColumnsAt(editor: Editor, block: BlockRange): ParsedColumns | null {
    let shellStart = block.start;
    if (!COL_START_RE.test(editor.getLine(block.start))) {
      shellStart = -1;
      for (let i = block.start; i >= 0; i--) {
        const line = editor.getLine(i);
        if (/^((?:>\s*)+)\[!multi-column(?:\|[^\]]*)?\]/.test(line)) {
          shellStart = i;
          break;
        }
        if (!QUOTE_RE.test(line)) break;
      }
      if (shellStart === -1) return null;
    }
    // Column last line = the last quoted line after the shell line
    let shellEnd = shellStart;
    for (let i = shellStart + 1; i < editor.lineCount(); i++) {
      if (!QUOTE_RE.test(editor.getLine(i))) break;
      shellEnd = i;
    }
    return this.parseColumnsRange(editor, shellStart, shellEnd);
  }

  /** Parse the column interval into a structure (column content/width/background/row structure/appearance parameters), and return null if the parsing fails */
  private parseColumnsRange(
    editor: Editor,
    shellStart: number,
    shellEnd: number
  ): ParsedColumns | null {
    const lines = getLines(editor, shellStart, shellEnd);
    const segments: string[] = [];
    const bgs: (ColBg | null)[] = [];
    const colLines: number[] = [];
    const colRels: number[] = [];
    const rowMarks: number[] = [];
    let cur: string[] | null = null;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (i === 0) continue;
      if (COL_SEP_RE.test(line)) continue;
      // H2 two-dimensional row: colrow is a row separation mark
      if (/^>\s*>\s*\[!colrow(?:\|[^\]]*)?\]/.test(line)) {
        if (cur !== null) segments.push(cur.join('\n'));
        cur = null;
        rowMarks.push(i);
        continue;
      }
      if (/^>\s*>\s*\[!col(?:\|[^\]]*)?\]/.test(line)) {
        if (cur !== null) segments.push(cur.join('\n'));
        cur = [];
        colLines.push(shellStart + i);
        colRels.push(i);
        const meta = line.match(/\[!col\|([^\]]*)\]/);
        bgs.push(parseColBgMeta(meta ? meta[1] : ''));
        continue;
      }
      const m = line.match(/^>\s*>\s?(.*)$/);
      if (m) {
        if (!cur) cur = [];
        cur.push(m[1]);
      }
    }
    if (cur !== null) segments.push(cur.join('\n'));
    if (!segments.length) return null;
    // The background number is aligned with the column number (the abnormal structure does not carry the background)
    if (bgs.length !== segments.length) bgs.length = 0;
    // Two-dimensional rows: count the number of columns in each row grouped by colrow row markers (single row without colrow)
    let rows: number[] = [];
    if (rowMarks.length) {
      let start = 0;
      for (const rm of rowMarks) {
        let cnt = 0;
        while (start < colRels.length && colRels[start] < rm) {
          cnt++;
          start++;
        }
        rows.push(cnt);
      }
      rows.push(colRels.length - start);
      if (rows.some((r) => r <= 0)) rows = [];
    }
    // Shell width and appearance parameters (same semantics as scanRegions)
    let widths: number[] = [];
    const opts: ColumnsOpts = {};
    const meta = lines[0].match(/\[!multi-column\|([^\]]*)\]/);
    if (meta) {
      const wm = meta[1].match(/^(\d+(?:-\d+)+(?:\/\d+(?:-\d+)+)*)/);
      if (wm) {
        const groups = wm[1].split('/').map((g) => g.split('-').map((x) => Number(x)));
        const flat = groups.flat();
        if (flat.length === segments.length && flat.every((w) => Number.isFinite(w) && w > 0)) {
          widths = flat;
        }
      }
      const gapM = meta[1].match(/(?:^|\s)gap=(\d+)(?:\s|$)/);
      const valignM = meta[1].match(/(?:^|\s)valign=(top|center|bottom|stretch)(?:\s|$)/);
      const radiusM = meta[1].match(/(?:^|\s)radius=(\d+)(?:\s|$)/);
      const hasBorder = /(?:^|\s)border(?:\s|$)/.test(meta[1]);
      if (gapM) opts.gap = Number(gapM[1]);
      if (valignM) opts.valign = valignM[1] as ColumnsOpts['valign'];
      if (radiusM) opts.radius = Number(radiusM[1]);
      if (hasBorder) opts.border = true;
    }
    return {
      shellStart,
      shellEnd,
      segments,
      widths,
      bgs: bgs.length ? bgs : segments.map(() => null),
      rows,
      opts,
      colLines,
    };
  }

  /** Index of the column where the current block is located (positioned by column number, default to first column) */
  private columnIndexOf(p: ParsedColumns, line: number): number {
    let idx = 0;
    for (let k = 0; k < p.colLines.length; k++) {
      if (p.colLines[k] <= line) idx = k;
      else break;
    }
    return idx;
  }

  /** The row number where column colIdx is located (constantly 0 for a single row) */
  private rowIndexOf(rows: number[], colIdx: number): number {
    if (!rows.length) return 0;
    let acc = 0;
    for (let r = 0; r < rows.length; r++) {
      if (colIdx < acc + rows[r]) return r;
      acc += rows[r];
    }
    return rows.length - 1;
  }

  /** Global column interval [start, end) of row r */
  private rowRange(rows: number[], r: number): [number, number] {
    const start = rows.slice(0, r).reduce((a, b) => a + b, 0);
    return [start, start + rows[r]];
  }

  /** Number of columns per line → end-of-line column index of buildColumnsMarkdown ([1,3] represents two lines of 0-1 / 2-3) */
  private rowsToEnds(rows: number[]): number[] | undefined {
    if (!rows.length) return undefined;
    const ends: number[] = [];
    let acc = 0;
    for (let r = 0; r < rows.length - 1; r++) {
      acc += rows[r];
      ends.push(acc - 1);
    }
    return ends.length ? ends : undefined;
  }

  /** Rewrite the column interval as a whole according to the analysis structure (single-step undo), and return the generated text (for cursor positioning) */
  private writeColumns(editor: Editor, p: ParsedColumns): string {
    const rowEnds = this.rowsToEnds(p.rows);
    const hasOpts = Object.keys(p.opts).length > 0;
    const out = buildColumnsMarkdown(
      p.segments,
      p.widths.length === p.segments.length ? p.widths : undefined,
      p.bgs.length === p.segments.length ? p.bgs : undefined,
      rowEnds,
      hasOpts ? p.opts : undefined
    );
    editor.replaceRange(
      out,
      { line: p.shellStart, ch: 0 },
      { line: p.shellEnd, ch: editor.getLine(p.shellEnd).length }
    );
    this.ctx.handle.hideHandle();
    return out;
  }

  /** The cursor falls into the new column content line (colIdx is the column number written back, 0-based) */
  private focusColumn(editor: Editor, p: ParsedColumns, colIdx: number, out: string): void {
    const outLines = out.split('\n');
    let seen = 0;
    for (let li = 0; li < outLines.length; li++) {
      if (/^>\s*>\s*\[!col(?:\|[^\]]*)?\]/.test(outLines[li])) {
        seen++;
        if (seen === colIdx + 1) {
          editor.setCursor({ line: p.shellStart + li + 1, ch: 2 });
          break;
        }
      }
    }
    editor.focus();
  }

  /** Split the current column: keep the first half of the original column, and take over the second half of the new column (the cutting point is the row of the current block), half the width, and use the background */
  splitColumn(block: BlockContext): void {
    const editor = block.editor;
    const p = this.parseColumnsAt(editor, block);
    if (!p || !p.colLines.length) {
      new Notice(TEXT.message0214);
      return;
    }
    const i = this.columnIndexOf(p, block.start);
    const lines = (p.segments[i] ?? '').split('\n');
    // Cutting point: The relative row of the current block in the column (at least the first row of the original column is retained; when there is only 1 row in the column, the new column is empty)
    const rel = Math.max(0, block.start - (p.colLines[i] + 1));
    const mid = Math.max(1, Math.min(rel, lines.length - 1 || 1));
    const left = lines.slice(0, mid).join('\n');
    const right = lines.slice(mid).join('\n');
    // When there is no width metadata, it is first filled in by equal division to ensure accurate writing back after splitting (consistent with the widget half-and-half semantics)
    if (!p.widths.length) {
      const avg = Math.round((100 / p.segments.length) * 10) / 10;
      p.widths = p.segments.map(() => avg);
    }
    const w = p.widths[i];
    p.segments[i] = left;
    p.segments.splice(i + 1, 0, right);
    p.widths[i] = w / 2;
    p.widths.splice(i + 1, 0, w / 2);
    p.bgs.splice(i + 1, 0, p.bgs[i] ?? null);
    if (p.rows.length) p.rows[this.rowIndexOf(p.rows, i)]++;
    const out = this.writeColumns(editor, p);
    this.focusColumn(editor, p, i + 1, out);
  }

  /** Merge the current column and the adjacent column on the right: the content is spliced in order and the width is merged; cross-row merging of the end column is prohibited */
  mergeColumn(block: BlockContext): void {
    const editor = block.editor;
    const p = this.parseColumnsAt(editor, block);
    if (!p || !p.colLines.length) {
      new Notice(TEXT.message0215);
      return;
    }
    const i = this.columnIndexOf(p, block.start);
    if (p.segments.length <= 1) {
      new Notice(TEXT.message0216);
      return;
    }
    if (p.rows.length) {
      const r = this.rowIndexOf(p.rows, i);
      if (i + 1 >= this.rowRange(p.rows, r)[1]) {
        new Notice(TEXT.message0217);
        return;
      }
    }
    const right = p.segments[i + 1] ?? '';
    p.segments[i] = p.segments[i] + (right.trim() ? '\n' + right : '');
    p.widths[i] = (p.widths[i] ?? 1) + (p.widths[i + 1] ?? 1);
    p.bgs[i] = p.bgs[i] ?? p.bgs[i + 1];
    p.segments.splice(i + 1, 1);
    p.widths.splice(i + 1, 1);
    p.bgs.splice(i + 1, 1);
    if (p.rows.length) p.rows[this.rowIndexOf(p.rows, i)]--;
    this.writeColumns(editor, p);
  }

  /** Insert an empty column between the current column and the next column, and subsequent column widths are rearranged according to the existing allocation strategy (consistent with widget addColumnAt) */
  insertColumn(block: BlockContext): void {
    const editor = block.editor;
    const p = this.parseColumnsAt(editor, block);
    if (!p || !p.colLines.length) {
      new Notice(TEXT.message0218);
      return;
    }
    const i = this.columnIndexOf(p, block.start);
    // The new column occupies 100/n, and the old column is reduced proportionally; when there is no width metadata, the entire block is divided evenly
    const n = p.segments.length + 1;
    const newW = Math.round((100 / n) * 10) / 10;
    const scale = (100 - newW) / 100;
    if (p.widths.length === p.segments.length) {
      p.widths = p.widths.map((w) => Math.round(w * scale * 10) / 10);
      p.widths.splice(i + 1, 0, newW);
    } else {
      p.widths = [];
    }
    p.segments.splice(i + 1, 0, '');
    p.bgs.splice(i + 1, 0, null);
    if (p.rows.length) p.rows[this.rowIndexOf(p.rows, i)]++;
    const out = this.writeColumns(editor, p);
    this.focusColumn(editor, p, i + 1, out);
  }

  /** Move the entire row up/down: Swap the column content, width and background of two adjacent rows, maintaining the width and row structure of each column */
  moveColumnRow(block: BlockContext, dir: -1 | 1): void {
    const editor = block.editor;
    const p = this.parseColumnsAt(editor, block);
    if (!p || !p.colLines.length) {
      new Notice(TEXT.message0219);
      return;
    }
    if (!p.rows.length || p.rows.length <= 1) {
      new Notice(TEXT.message0220);
      return;
    }
    const i = this.columnIndexOf(p, block.start);
    const r = this.rowIndexOf(p.rows, i);
    const t = r + dir;
    if (t < 0 || t >= p.rows.length) {
      new Notice(dir === -1 ? TEXT.message0221 : TEXT.message0222);
      return;
    }
    const [s1, e1] = this.rowRange(p.rows, r);
    const [s2, e2] = this.rowRange(p.rows, t);
    const swap = <T,>(arr: T[]): void => {
      const a = arr.slice(s1, e1);
      const b = arr.slice(s2, e2);
      arr.splice(0, arr.length, ...arr.slice(0, s1), ...b, ...arr.slice(e1, s2), ...a, ...arr.slice(e2));
    };
    const hasW = p.widths.length === p.segments.length;
    const hasB = p.bgs.length === p.segments.length;
    swap(p.segments);
    if (hasW) swap(p.widths);
    if (hasB) swap(p.bgs);
    const tmp = p.rows[r];
    p.rows[r] = p.rows[t];
    p.rows[t] = tmp;
    this.writeColumns(editor, p);
  }

  /** Menu status of the block inside the column: current column index and availability of each operation (returns null if not in the column) */
  columnsMenuState(
    editor: Editor,
    block: BlockRange
  ): { colIdx: number; rows: number[]; canMerge: boolean; canUp: boolean; canDown: boolean } | null {
    const p = this.parseColumnsAt(editor, block);
    if (!p || !p.colLines.length) return null;
    const colIdx = this.columnIndexOf(p, block.start);
    const canMerge =
      p.segments.length > 1 &&
      (!p.rows.length || colIdx + 1 < this.rowRange(p.rows, this.rowIndexOf(p.rows, colIdx))[1]);
    const rIdx = p.rows.length ? this.rowIndexOf(p.rows, colIdx) : 0;
    return {
      colIdx,
      rows: p.rows,
      canMerge,
      canUp: p.rows.length > 1 && rIdx > 0,
      canDown: p.rows.length > 1 && rIdx < p.rows.length - 1,
    };
  }

  /**
   * H4 edge quick column splitting: combine drag block A (multiple selections possible) and target block B into two columns.
   * When side=-1, A is in the left column (drag to the left edge of B), and when side=1, A is in the right column (drag to the right edge of B).
   * Return false when the target is a column shell/column internal block (the caller falls back to normal insertion to avoid truncating the column structure). */
  wrapToEdgeColumns(editor: Editor, a: BlockRange[], b: BlockRange, side: -1 | 1): boolean {
    if (!a.length) return false;
    // Reject when the dragging interval intersects (including equality) with the target interval: the synthesis takes the range according to min/max, which will swallow the middle content
    if (a.some((r) => r.start <= b.end && b.start <= r.end)) return false;
    // The target cannot be a column shell or a column internal block (dragging inside a column will truncate the structure)
    if (this.isColumnsBlock(editor, b) || this.insideColumns(editor, b)) return false;
    const rs = [...a].sort((x, y) => x.start - y.start);
    const lines: string[] = [];
    for (const r of rs) lines.push(...getLines(editor, r.start, r.end));
    const bLines = getLines(editor, b.start, b.end);
    // Reject when the entire target block is a blank line: an empty column will be generated, which is meaningless.
    if (bLines.every((l) => l.trim() === '')) return false;
    // Combine two columns: left = left column text, right = right column text (width default 50-50)
    const left = side === -1 ? lines : bLines;
    const right = side === -1 ? bLines : lines;
    const out = buildColumnsMarkdown([left.join('\n'), right.join('\n')]);

    // Paste blank lines before and after to ensure that the callout is independent of adjacent blocks (consistent with wrapBlockToColumns)
    const start = Math.min(rs[0].start, b.start);
    const end = Math.max(rs[rs.length - 1].end, b.end);
    const total = editor.lineCount();
    const prefix = start > 0 && editor.getLine(start - 1).trim() !== '' ? [''] : [];
    const suffix = end < total - 1 && editor.getLine(end + 1).trim() !== '' ? [''] : [];
    const text = [...prefix, ...out.split('\n'), ...suffix].join('\n');

    editor.replaceRange(
      text,
      { line: start, ch: 0 },
      { line: end, ch: editor.getLine(end).length }
    );
    this.ctx.handle.hideHandle();
    return true;
  }

  /** Parse the color mark of the first line of the block (no mark/illegal color returns null; the span form is written in the last line of the block,
   * When there is no %% in the first line, trace back to the last line and then parse the span) */
  blockColorOf(block: BlockContext): string | null {
    const first = this.parseBlockColor(block.editor.getLine(block.start));
    if (first) return first;
    // The span carrying form is written back to the last line of the block (in the case of a single-line block, the first line is the last line and has been hit by the above)
    if (block.end > block.start) return this.parseBlockColor(block.editor.getLine(block.end));
    return null;
  }

  /** Parse the block color mark in a single line of text (none/illegal returns null; double value syntax takes light color;
   * Compatible with stock %% form and span element carrying form) */
  parseBlockColor(line: string): string | null {
    const m = BLOCK_COLOR_RE.exec(line) ?? BLOCK_COLOR_SPAN_RE.exec(line);
    if (!m) return null;
    return parseBlockColorValue(m[1])?.light ?? null;
  }

  /**
   * Color mark the current block: write empty elements at the end of the line at the end of the block
   * `<span data-block-color="<color>"></span>` carries (reading mode element shape is directly colored),
   * Replace old line ending `%% block-color:<color> %%` write back form; already marked (%% or span)
   * All replace color values. The existing `%%...%%` does not migrate the existing documents, but cleans them when writing back to avoid double marking of the same block.
   * The color attribute value format is consistent with the %% syntax body (supports handwritten `light|dark` dual themes covering dark colors).
   * Write-back within the column callout is not blocked, but it prompts that the reading mode only takes effect in Live Preview. */
  setBlockColor(block: BlockContext, color: string): void {
    const editor = block.editor;
    const norm = normalizeBlockColor(color);
    if (!norm) {
      new Notice(TEXT.message0223 + color);
      return;
    }
    // The %% mark in the first row of the block: clean it up when writing back the span (to avoid repeated coloring of double marks in the same block)
    const first = editor.getLine(block.start);
    const firstNext = first.replace(BLOCK_COLOR_RE, '').replace(/[ \t]+$/u, '');
    if (firstNext !== first) editor.setLine(block.start, firstNext);
    // Target line = the last line of the block: replace the existing span and append (the first line may have been cleaned up above in the case of a single-line block)
    const endIdx = block.end;
    const endLine = editor.getLine(endIdx);
    const next =
      endLine
        .replace(BLOCK_COLOR_SPAN_RE, '')
        .replace(BLOCK_COLOR_RE, '')
        .replace(/[ \t]+$/u, '') + `<span data-block-color="${norm}"></span>`;
    editor.setLine(endIdx, next);
    // Within the column callout: Prompt reading mode is limited by Obsidian rendering and only Live Preview takes effect
    // (It is recommended to use column-by-column bg metadata |bg= to color the entire column); the prompt does not block writeback
    if (this.insideColumns(editor, block)) {
      new Notice(
        TEXT.message0224,
        6000
      );
    }
    this.ctx.handle.hideHandle();
  }

  /** Clear the color mark of the current block (span form or stock %% form; prompt when there is no mark) */
  clearBlockColor(block: BlockContext): void {
    const editor = block.editor;
    let found = false;
    for (let i = block.start; i <= block.end; i++) {
      const line = editor.getLine(i);
      const next = line
        .replace(BLOCK_COLOR_SPAN_RE, () => {
          found = true;
          return '';
        })
        .replace(BLOCK_COLOR_RE, () => {
          found = true;
          return '';
        })
        .replace(/[ \t]+$/u, '');
      if (next !== line) editor.setLine(i, next);
    }
    if (!found) {
      new Notice(TEXT.message0225);
      return;
    }
    this.ctx.handle.hideHandle();
  }
}
