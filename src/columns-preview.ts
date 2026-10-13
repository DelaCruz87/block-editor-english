import { TEXT } from './strings';
import { Decoration, EditorView, ViewPlugin, WidgetType } from '@codemirror/view';
import type { DecorationSet, ViewUpdate } from '@codemirror/view';
import { Prec, StateEffect, StateField } from '@codemirror/state';
import type { Extension, Range, Transaction } from '@codemirror/state';
import { Component, MarkdownRenderer, editorInfoField, editorLivePreviewField } from 'obsidian';
import type { App } from 'obsidian';
import type BlockEditorPlugin from './main';
import type { BlockEditorSettings } from './settings';
import { buildColumnsMarkdown } from './convert';
import { deriveDarkColor, parseColBgMeta, setColBgVars } from './col-bg';
import type { ColBg } from './col-bg';
import { getCM, keepViewport, colValignToCss } from './util';
import { safeDecoCompute } from './cm6-deco-guard';
import { buildColLayout, buildCombinedChanges, buildExtractInsertText, columnToPlainBlock, resolveExtractLine, shouldUnwrapAfterExtract } from './columns-droptarget';
import type { ColLayoutInfo } from './columns-droptarget';

/** Debug logs: Review requirements avoid console logs and retain no-op to maintain call points */
function colLog(..._args: unknown[]): void {}

/** Code fence starting line (``` or ~~~, 3 or more); the fence state machine is shared with the scan loop to avoid line-by-line repeated construction */
const FENCE_RE = /^\s*(`{3,}|~{3,})/;
/** hex color (#rgb / #rrggbb / #rrggbbaa), used for color selection input verification */
const HEX_COLOR_RE = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;

/** Widget collection in editing state: blur may not be triggered when switching tabs/closing the document, so you need to write back in detail */
const editingWidgets = new Set<ColumnsWidget>();

/** Write all column contents still in editing state back to the document (active-leaf-change / quit / onunload call) */
export function flushEditingColumns(): void {
  for (const w of [...editingWidgets]) {
    w.flushEdit();
    editingWidgets.delete(w);
  }
}

/* ===== Column editing state ⇄ Obsidian editor command bridge =====
 *
 * Problem: When performing a text editing operation in a column, the action will not fall to the column, but to the document outside the column:
 * - Shortcut key/right-click "Text Format" to bold, highlight, etc.: markup syntax is written outside the column (the next line of the column);
 * - Right-click "Cut/Paste": the content is taken over by the CM editor (falls into the document instead of the column);
 * - Right-click "Select All": select the entire document instead of the column content.
 *
 * Root cause: The column editing state is a normal <textarea>, and it is located inside .cm-content of CM6:
 * 1) Format commands: shortcut keys and the "Text Format" menu eventually call Obsidian's
 * Editor.toggleMarkdownFormatting(format), this method acts on the CM editor selection,
 * The text of the textarea is not in the CM document → the syntax falls outside the columns.
 * 2) Cut/paste: Obsidian listens for paste/cut on window, and its "native editing element" determination
 * Only covers <input> and contentEditable (<textarea> is not listed), so from textarea
 * The clipboard event that bubbles up is taken over and applied to the CM editor.
 * 3) Select all: The menu item is implemented by Editor.setSelection (whole article scope), which also works on the CM editor.
 *
 * Fix: Redirect these paths to column textarea at their respective convergence points--
 * 1) Editor.toggleMarkdownFormatting → rewrite textarea selection (mark pair);
 * 2) copy/cut/paste event stopPropagation on textarea (only prevents upward bubbling,
 * does not preventDefault), returns the browser's native clipboard behavior for textarea;
 * 3) Editor.setSelection changes to select the full text of the textarea when receiving the "whole range" request;
 * 4) Command API (getSelection/replaceSelection/replaceRange/getRange/
 *getCursor/setCursor/posToOffset/offsetToPos/somethingSelected) →
 * Dropped into textarea to enable enhanced commands such as "Insert Template/Wrap Selection" of third-party plug-ins to work on columns.
 * The above patches apply to the Editor prototype (global): all converge according to "The caller is the editor to which this column belongs".
 * Calls with the same name in other split-screen editors are not affected and fall back to the original implementation.
 * When the editing state ends, the target is released and the behavior returns to native.
 * Not supported: completion/association classes (EditorSuggest and CM6 extensions require real editor views), and
 * Directly use editor.cm to operate the CM6 plug-in - textarea cannot be bridged without CM6 running. */

/** The column textarea currently being edited and its Obsidian editor (enter the editing state to register,
 *Exit/out of focus logout). Editor prototype patch is global: the editor to which it belongs must be recorded so that the bridge is only for
 * The call to this editor takes effect, otherwise other split-screen editors that call the API with the same name will be redirected to this column by mistake. */
let columnEditTarget: { ta: HTMLTextAreaElement; owner: unknown } | null = null;

/** Register/unregister the column editing target (called by the editing life cycle of ColumnsWidget);
 * owner is the Obsidian editor instance to which the column belongs; if it cannot be obtained, pass null (no convergence according to ownership). */
export function setColumnEditTarget(ta: HTMLTextAreaElement | null, owner: unknown = null): void {
  columnEditTarget = ta ? { ta, owner } : null;
}

/** Currently available column editing targets (old instances that have left the DOM are considered invalid) */
function activeColumnTarget(): { ta: HTMLTextAreaElement; owner: unknown } | null {
  const t = columnEditTarget;
  return t && t.ta.isConnected ? t : null;
}

/** Whether the caller is the editor who registered this column. When owner is unknown (null), it will be taken over.
 * Ensure that the function does not degrade when the attribution information cannot be obtained. */
function isTargetEditor(target: { owner: unknown }, self: unknown): boolean {
  return target.owner == null || target.owner === self;
}

/** textarea native editing event guard: prevent copy/cut/paste and Mod+A from bubbling to the editor layer.
 * Only stopPropagation (not preventDefault), the browser's native clipboard for textarea /
 * Select all behavior is not affected. */
function guardTextareaEditing(ta: HTMLTextAreaElement): void {
  for (const type of ['copy', 'cut', 'paste']) {
    ta.addEventListener(type, (e) => e.stopPropagation());
  }
  ta.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === 'a') e.stopPropagation();
  });
}

/** The number of lines of the textarea in the editing state follows the content: the textarea is not natively adaptive, and `rows` determines its inherent height.
 * As the inherent height of the pocket when it is not mounted (scrollHeight cannot be obtained). */
function syncTextareaRows(ta: HTMLTextAreaElement): void {
  const lines = Math.max(2, ta.value.split('\n').length);
  if (ta.rows !== lines) ta.rows = lines;
}

/** Make the editable textarea highly adaptable to the content (textarea is not natively adaptive).
 * The column is a column flex container, and the textarea uses flex:0 0 auto, so the explicit height here is
 * The source of the height of the column determines the height of the entire row - ensure that the entire block in the editing state is based on the column with the most content.
 * instead of being truncated by min-height into about 3 lines. When not mounted, scrollHeight cannot be obtained and skipped (at this time
 * Covered by the inherent height of syncTextareaRows). */
function autosizeTextarea(ta: HTMLTextAreaElement): void {
  if (!ta.isConnected) return;
  ta.setCssStyles({ height: 'auto' });
  const h = ta.scrollHeight;
  // No typesetting environment (such as jsdom / element is invisible) scrollHeight is 0: keep auto, and the inherent height is determined by rows
  if (h > 0) ta.style.height = h + 'px';
}

/** format parameter (consistent with Obsidian editor command) → inline markup pair */
const FORMAT_MARKERS: Record<string, [string, string]> = {
  bold: ['**', '**'],
  italic: ['*', '*'],
  strikethrough: ['~~', '~~'],
  highlight: ['==', '=='],
  code: ['`', '`'],
  comment: ['%%', '%%'],
};

/** Apply mark pairs to the textarea selection: cancel if it is wrapped; wrap if there is a selection; insert if there is no selection and put the cursor in the middle */
function applyMarkerToTextarea(ta: HTMLTextAreaElement, open: string, close: string): void {
  // The inline mark in the displayed value may be an invisible character (sentinel): first restore it to the real character and then judge/wrap it
  // (Replace with equal length, the selection subscript remains unchanged); at the end, press the cursor position to hide again
  const v = desentinelize(ta.value);
  const s = ta.selectionStart;
  const e = ta.selectionEnd;
  const sel = v.slice(s, e);
  if (sel.length >= open.length + close.length && sel.startsWith(open) && sel.endsWith(close)) {
    const inner = sel.slice(open.length, sel.length - close.length);
    ta.value = v.slice(0, s) + inner + v.slice(e);
    ta.selectionStart = s;
    ta.selectionEnd = s + inner.length;
  } else if (sel) {
    ta.value = v.slice(0, s) + open + sel + close + v.slice(e);
    ta.selectionStart = s + open.length;
    ta.selectionEnd = e + open.length;
  } else {
    ta.value = v.slice(0, s) + open + close + v.slice(e);
    ta.selectionStart = ta.selectionEnd = s + open.length;
  }
  // Reuse the textarea's input to monitor the synchronized widget memory text (the document writeback is still performed when it is out of focus)
  ta.dispatchEvent(new Event('input', { bubbles: true }));
  ta.focus({ preventScroll: true });
  syncMarkerDisplay(ta);
}

/** Obsidian position (line/ch, both 0-based) → text offset; out-of-bounds clamping to the end of the text */
function posToOffsetIn(text: string, pos: { line?: number; ch?: number } | null | undefined): number {
  if (!pos || typeof pos.line !== 'number') return 0;
  const lines = text.split('\n');
  const line = Math.max(0, Math.min(pos.line, lines.length - 1));
  let off = 0;
  for (let i = 0; i < line; i++) off += lines[i].length + 1;
  const ch = typeof pos.ch === 'number' ? Math.max(0, Math.min(pos.ch, lines[line].length)) : 0;
  return off + ch;
}

/** text offset → Obsidian position (line/ch, both 0 base) */
function offsetToPosIn(text: string, offset: number): { line: number; ch: number } {
  const off = Math.max(0, Math.min(offset, text.length));
  const head = text.slice(0, off);
  const line = (head.match(/\n/g) ?? []).length;
  const ch = off - (head.lastIndexOf('\n') + 1);
  return { line, ch };
}

/** Replace [from, to) with text and apply it to the column textarea (for command API bridging):
 * Write real characters + The cursor falls after the inserted content + Multiplex input to monitor the synchronized memory text and height. */
function applyTextToTextarea(ta: HTMLTextAreaElement, from: number, to: number, text: string): void {
  const v = desentinelize(ta.value);
  const a = Math.max(0, Math.min(from, v.length));
  const b = Math.max(a, Math.min(to, v.length));
  ta.value = v.slice(0, a) + text + v.slice(b);
  const caret = a + text.length;
  ta.setSelectionRange(caret, caret);
  // Reuse the textarea's input to monitor the synchronized widget memory text (the document writeback is still performed when it is out of focus)
  ta.dispatchEvent(new Event('input', { bubbles: true }));
  ta.focus({ preventScroll: true });
  syncMarkerDisplay(ta);
}

/** Patched Editor prototype (to avoid wrapping the same prototype repeatedly) */
const patchedEditorProtos = new WeakSet<object>();
/** Prototype patch record: used for restoration when uninstalling to avoid rewriting the Editor prototype behavior after the plug-in is uninstalled */
const editorProtoPatches: {
  proto: Record<string, unknown>;
  origFormat: unknown;
  origSetSelection: unknown;
  patchedSetSelection: boolean;
  /** {method name, original implementation} of command API bridge, restored one by one when uninstalling */
  extra?: { name: string; orig: unknown }[];
}[] = [];

/** The bridge processor returns this value = This call will not be taken over by the bridge and will be returned to the original implementation. */
const BRIDGE_MISS = Symbol('column-bridge-miss');

/** The setSelection request is exactly "select the entire document" (the implementation of "select all" in the Obsidian editor menu) */
function isWholeDocSelection(editor: unknown, from: unknown, to: unknown): boolean {
  const f = from as { line?: number; ch?: number } | null;
  const t = to as { line?: number; ch?: number } | null;
  if (!f || !t || f.line !== 0 || f.ch !== 0 || typeof t.line !== 'number') return false;
  try {
    const api = editor as { lineCount(): number; getLine(n: number): string };
    const last = api.lineCount() - 1;
    return t.line === last && t.ch === api.getLine(last).length;
  } catch {
    return false;
  }
}

/** Install editor command bridge (idempotent; requires an active editor instance to get the prototype) */
export function installColumnsFormatBridge(app: App): void {
  const editor = (app.workspace.activeEditor as { editor?: unknown } | null)?.editor;
  if (!editor) return;
  const proto = Object.getPrototypeOf(editor) as Record<string, unknown> | null;
  if (!proto || patchedEditorProtos.has(proto)) return;
  const origFormat = proto.toggleMarkdownFormatting;
  if (typeof origFormat !== 'function') return;
  proto.toggleMarkdownFormatting = function (this: unknown, format: string) {
    const target = activeColumnTarget();
    const marker = FORMAT_MARKERS[format];
    if (target && marker && isTargetEditor(target, this)) {
      applyMarkerToTextarea(target.ta, marker[0], marker[1]);
      return;
    }
    return (origFormat as (f: string) => unknown).call(this, format);
  };
  // Right-click menu "Select All": When the editor receives a "whole article range" selection request, it selects the full text area of the column instead.
  const origSetSelection = proto.setSelection;
  const patchedSetSelection = typeof origSetSelection === 'function';
  if (patchedSetSelection) {
    proto.setSelection = function (this: unknown, from: unknown, to?: unknown) {
      const target = activeColumnTarget();
      if (target && isTargetEditor(target, this) && isWholeDocSelection(this, from, to)) {
        target.ta.focus({ preventScroll: true });
        target.ta.select();
        return;
      }
      return (origSetSelection as (f: unknown, t?: unknown) => unknown).call(this, from, to);
    };
  }

  // ===== Command API Bridge =====
  // The "Editing Enhancement" of third-party plug-ins can operate the "current editor" through the Editor API (inserting templates, wrapping selections,
  // Positioning rewrite, etc.). In-column editing is a normal textarea, not a CM6 view. These calls originally fell outside the column.
  // on the document. Here, the text view is redirected to the textarea in the column (only takes effect in the editing state, and will fall back when not edited)
  // Original implementation); position/offset are always interpreted in the coordinate system of "text in this column".
  // Boundary: The document-level API (getValue/setValue/getLine/lineCount, etc.) does not change and still points to the real document;
  // Directly use editor.cm (CM6 view) or EditorSuggest (completion/association) plug-ins without taking this bridge.
  const extra: { name: string; orig: unknown }[] = [];
  const patchMethod = (
    name: string,
    fn: (ta: HTMLTextAreaElement, args: unknown[]) => unknown
  ): void => {
    const orig = proto[name];
    if (typeof orig !== 'function') return;
    proto[name] = function (this: unknown, ...args: unknown[]) {
      const target = activeColumnTarget();
      if (target && isTargetEditor(target, this)) {
        const out = fn(target.ta, args);
        if (out !== BRIDGE_MISS) return out;
      }
      return (orig as (...a: unknown[]) => unknown).apply(this, args);
    };
    extra.push({ name, orig });
  };

  patchMethod('getSelection', (ta) => desentinelize(ta.value.slice(ta.selectionStart, ta.selectionEnd)));
  patchMethod('somethingSelected', (ta) => ta.selectionStart !== ta.selectionEnd);
  patchMethod('replaceSelection', (ta, args) => {
    const text = args[0];
    if (typeof text !== 'string') return BRIDGE_MISS;
    applyTextToTextarea(ta, ta.selectionStart, ta.selectionEnd, text);
    return undefined;
  });
  patchMethod('replaceRange', (ta, args) => {
    const text = args[0];
    const from = args[1] as { line?: number; ch?: number } | null;
    if (typeof text !== 'string' || !from) return BRIDGE_MISS;
    const v = desentinelize(ta.value);
    const a = posToOffsetIn(v, from);
    const to = args[2] as { line?: number; ch?: number } | null;
    applyTextToTextarea(ta, a, to ? posToOffsetIn(v, to) : a, text);
    return undefined;
  });
  patchMethod('getRange', (ta, args) => {
    const from = args[0] as { line?: number; ch?: number } | null;
    const to = args[1] as { line?: number; ch?: number } | null;
    if (!from || !to) return BRIDGE_MISS;
    const v = desentinelize(ta.value);
    const a = posToOffsetIn(v, from);
    const b = posToOffsetIn(v, to);
    return v.slice(Math.min(a, b), Math.max(a, b));
  });
  patchMethod('getCursor', (ta, args) => {
    const which = args[0];
    const off =
      which === 'from' || which === 'anchor'
        ? ta.selectionStart
        : ta.selectionEnd; // Default (including 'to' / 'head') selects the end of the region
    return offsetToPosIn(desentinelize(ta.value), off);
  });
  patchMethod('setCursor', (ta, args) => {
    const v = desentinelize(ta.value);
    const pos = args[0];
    const ch = args[1];
    const off =
      typeof pos === 'number' && typeof ch === 'number'
        ? posToOffsetIn(v, { line: pos, ch })
        : posToOffsetIn(v, pos as { line?: number; ch?: number } | null);
    ta.focus({ preventScroll: true });
    ta.setSelectionRange(off, off);
    syncMarkerDisplay(ta);
    return undefined;
  });
  patchMethod('posToOffset', (ta, args) =>
    posToOffsetIn(desentinelize(ta.value), args[0] as { line?: number; ch?: number } | null)
  );
  patchMethod('offsetToPos', (ta, args) =>
    offsetToPosIn(desentinelize(ta.value), typeof args[0] === 'number' ? args[0] : 0)
  );

  patchedEditorProtos.add(proto);
  editorProtoPatches.push({ proto, origFormat, origSetSelection, patchedSetSelection, extra });
}

/** Restore the rewrite of Editor prototype by installColumnsFormatBridge (called when the plug-in is uninstalled) */
export function uninstallColumnsFormatBridge(): void {
  for (const p of editorProtoPatches) {
    p.proto.toggleMarkdownFormatting = p.origFormat;
    if (p.patchedSetSelection) p.proto.setSelection = p.origSetSelection;
    for (const e of p.extra ?? []) p.proto[e.name] = e.orig;
    patchedEditorProtos.delete(p.proto);
  }
  editorProtoPatches.length = 0;
}


/** Column shell mark rows (supports any layer reference prefix; the width parameter `|NN-NN` is optional, evenly divided when missing) */
const COL_START_RE = /^((?:>\s*)+)\[!multi-column(?:\|[^\]]*)?\][^\n]*$/;
/** Any quoted line */
const QUOTE_RE = /^>\s?/;
/** Wide match: for diagnostic purposes */
const COL_LOOSE_RE = /\[!multi-column(?:\|[^\]]*)?\]/;

/** Column shell appearance parameters (H1): gap column spacing / valign vertical alignment / radius rounded corner / border border.
 * Only explicitly set items take effect (default fallback for setting default CSS variables on body). */
export interface ColumnsOpts {
  gap?: number;
  valign?: 'top' | 'center' | 'bottom' | 'stretch';
  radius?: number;
  border?: boolean;
}

interface ColumnsRegion {
  /**Start mark line number (0-based) */
  startLine: number;
  /** Last line number (0-based) */
  endLine: number;
  /** Starting tag line from (widget positioning key) */
  startPos: number;
  /** Last line to (block replacement range) */
  endPos: number;
  /** endPos whether the end newline is swallowed (newlines need to be added when inserting text back) */
  hasBreak: boolean;
  /** Percentage of width of each column (from tag metadata; if there are multiple rows, they are stored flat in row order) */
  widths?: number[];
  /** Background color of each column (two-color model: light / dark, null if no background; length consistent with segments) */
  bgs?: (ColBg | null)[];
  /** Shell appearance parameters (from multi-column metadata; H1) */
  opts?: ColumnsOpts;
  /** Two-dimensional row: number of columns in each row (multiple rows when `>> [!colrow]` row mark exists, empty array = single row) */
  rows?: number[];
  /** markdown text for each column */
  segments: string[];
}

interface ColumnsState {
  /** Whether the first calculation has been completed (create cannot get the document, the first transaction must be forced to calculate) */
  initialized: boolean;
  regions: ColumnsRegion[];
  decorations: DecorationSet;
}

/** Forced recalculation of decorations (StateField needs to be recalculated when the editor is first mounted or settings are switched) */
const forceRecompute = StateEffect.define<null>();

/** The status of the latest build (read by diagnostic command) */
const lastDiagnostics: {
  regions: number;
  markerLines: number;
  livePreview: boolean | null;
  note: string;
  segmentsPreview: string[];
} = { regions: 0, markerLines: 0, livePreview: null, note: '', segmentsPreview: [] };
export function getColumnsDiagnostics(): typeof lastDiagnostics {
  return { ...lastDiagnostics, segmentsPreview: [...lastDiagnostics.segmentsPreview] };
}

/** Count the number of reference prefix levels at the beginning of a line (`>> > text` → 3; `> text` → 1; no prefix → 0) */
function countQuoteDepth(text: string): number {
  const m = text.match(/^(?:>\s*)+/);
  if (!m) return 0;
  let depth = 0;
  for (let i = 0; i < m[0].length; i++) if (m[0][i] === '>') depth++;
  return depth;
}

/** Strip prefixes by reference depth: strip only to the column level (colDepth layer), retaining relative prefixes within the column.
 * When there is a column, colDepth = the number of shell layers + 1 (`>>`), when there is no column = the number of shell layers (`>`).
 * `>>> [!note]` (column level 2) → reserved `> [!note]`; `>> text` → `text`;
 * The lines starting with `>` in the code block (`>> > code`) → retain `> code` and do not strip them by mistake. */
function stripToColLevel(text: string, colDepth: number): string {
  const m = text.match(/^(?:>\s*)+/);
  if (!m) return text;
  const depth = countQuoteDepth(text);
  if (depth <= colDepth) return text.slice(m[0].length);
  const keep = depth - colDepth;
  // Find the first `>` to keep (th depth - keep + 1), keep it intact to the end of the prefix,
  // to retain the original space format (`>>> ` → `> `) to avoid losing spaces during splicing
  const firstKeep = depth - keep + 1;
  let startIdx = -1;
  let seen = 0;
  for (let i = 0; i < m[0].length; i++) {
    if (m[0][i] === '>') {
      seen++;
      if (seen === firstKeep) {
        startIdx = i;
        break;
      }
    }
  }
  const kept = startIdx === -1 ? '' : m[0].slice(startIdx);
  return kept + text.slice(m[0].length);
}

/** Calculate the endPos of the column interval and whether to swallow the end newline (H6 incremental translation multiplexing; the semantics are exactly the same as the original push) */
function computeEndPos(
  doc: { lines: number; length: number; line(n: number): { from: number; to: number; text: string } },
  endLine: number
): { endPos: number; hasBreak: boolean } {
  const hasBreak = endLine + 1 < doc.lines;
  let endPos: number;
  let replacedBreak = false; // endPos has swallowed the newline at the end (newline needs to be added when inserting text when writing back)
  if (hasBreak && (endLine + 2 < doc.lines || doc.line(endLine + 2).text !== '')) {
    // There are still lines of content after the column division: swallow the last line of the column and wrap it, ending at the beginning of the next line
    endPos = doc.line(endLine + 2).from;
    replacedBreak = true;
  } else if (hasBreak) {
    // After the column is divided, only the last blank line remains (Option 1): Do not swallow the last line break bit, and the last blank line remains outside the widget and can be docked.
    endPos = doc.length - 1;
  } else {
    // The column is the last line of the document (there is always \n at the end of the Obsidian editor doc, and this branch is not actually triggered)
    endPos = doc.line(endLine + 1).to;
  }
  return { endPos, hasBreak: replacedBreak };
}

/**
 * Scan the column interval in the document (marks within the code fence are not effective).
 * Depth-independent: Column header = any reference line containing [!col] in the range; the content is stripped of all reference prefixes.
 * stats optional: Count the number of rows containing column mark words (for diagnosis) to avoid the second full row traversal. */
function scanRegions(
  doc: {
    lines: number;
    length: number;
    line(n: number): { from: number; to: number; text: string };
  },
  stats?: { markerLines: number }
): ColumnsRegion[] {
  return scanRegionsIn(doc, stats, 0, doc.lines - 1);
}

/** Backtrack up to 300 lines above the starting point of the interval to determine whether the starting point is within the unclosed code fence */
function findOpenFence(
  doc: { lines: number; line(n: number): { from: number; to: number; text: string } },
  startLine: number
): string | null {
  const from = Math.max(0, startLine - 300);
  let fenceCh: string | null = null;
  for (let i = from; i < startLine; i++) {
    const text = doc.line(i + 1).text;
    if (fenceCh !== null) {
      const m = text.match(FENCE_RE);
      if (m && m[1][0] === fenceCh) fenceCh = null;
      continue;
    }
    const f = text.match(FENCE_RE);
    if (f) fenceCh = f[1][0];
  }
  return fenceCh;
}

/** Interval scan: only find column shells within [startLine, endLine] (H6 incremental rescan).
 * Fence status backtracking: The starting point of the interval may fall within the unclosed code fence, and up to 300 lines of statistics can be traced back.
 * The fence is not closed to prevent the sample column text within the fence from being misrecognized (covering common scenarios). */
function scanRegionsIn(
  doc: {
    lines: number;
    length: number;
    line(n: number): { from: number; to: number; text: string };
  },
  stats: { markerLines: number } | undefined,
  startLine: number,
  endLine: number
): ColumnsRegion[] {
  const regions: ColumnsRegion[] = [];
  let start = -1;
  let fenceCh = findOpenFence(doc, startLine);

  const push = (endLine: number) => {
    if (start === -1) return;
    // Shell reference depth: `> [!multi-column]` → 1, deeper when nested in other callouts.
    // Column level depth = shell depth + 1 (subcolumn `[!col]` has one more reference than the shell);
    // The entire structure content without col is hung directly under the shell, column level = shell depth.
    const shellDepth = countQuoteDepth(doc.line(start + 1).text);
    const dividers: number[] = [];
    const rowMarks: number[] = [];
    const bgs: (ColBg | null)[] = [];
    // Synchronously sense code fences when identifying column headers and row marks: `[!col]` / `[!colrow]` appearing within the fence
    // Text (such as code examples) is not treated as a new column/line
    let divFence: string | null = null;
    for (let i = start + 1; i <= endLine; i++) {
      const text = doc.line(i + 1).text;
      if (divFence !== null) {
        const m = text.match(FENCE_RE);
        if (m && m[1][0] === divFence) divFence = null;
        continue;
      }
      const f = text.match(FENCE_RE);
      if (f) {
        divFence = f[1][0];
        continue;
      }
      if (!QUOTE_RE.test(text)) continue;
      if (/\[!colrow(?:\|[^\]]*)?\]/.test(text)) {
        rowMarks.push(i);
        continue;
      }
      if (/\[!col(?:\|[^\]]*)?\]/.test(text)) {
        dividers.push(i);
        // Parse the background color metadata of each column: `> [!col|bg=#ffe8e8]` → ColBg (dark color is automatically derived only when bg is used)
        const m = text.match(/\[!col\|([^\]]*)\]/);
        bgs.push(parseColBgMeta(m ? m[1] : ''));
      }
    }
    // Two-dimensional row segmentation: group by row when colrow is present (cut into segments by column header within the row);
    // Without colrow, the entire block is a single line (backwards compatible with old notes).
    const rowBounds = rowMarks.length ? [start, ...rowMarks, endLine + 1] : [start, endLine + 1];
    const segments: string[] = [];
    const rows: number[] = [];
    // When there is a col sub-column, skip the k=0 segment in the row (the structural blank row between the beginning of the row and the first col, not the column);
    // Without col, the entire row (k=0) is the only content segment.
    const colDepth = shellDepth + (dividers.length > 0 ? 1 : 0);
    for (let ri = 0; ri < rowBounds.length - 1; ri++) {
      const rowStart = rowBounds[ri];
      const rowEnd = rowBounds[ri + 1];
      const rowDivs = dividers.filter((d) => d > rowStart && d < rowEnd);
      const bounds = [rowStart, ...rowDivs, rowEnd];
      const firstSeg = rowDivs.length > 0 ? 1 : 0;
      for (let k = firstSeg; k < bounds.length - 1; k++) {
        const lines: string[] = [];
        // Aware code fence: lines within the fence also strip prefixes by column level (retaining the relative part),
        // Avoid lines starting with `>` within a code block from being stripped as references.
        let segFence: string | null = null;
        for (let i = bounds[k] + 1; i < bounds[k + 1]; i++) {
          const text = doc.line(i + 1).text;
          if (!QUOTE_RE.test(text)) continue;
          const stripped = stripToColLevel(text, colDepth);
          if (segFence !== null) {
            lines.push(stripped);
            const m = stripped.match(FENCE_RE);
            if (m && m[1][0] === segFence) segFence = null;
            continue;
          }
          const f = stripped.match(FENCE_RE);
          if (f) segFence = f[1][0];
          lines.push(stripped);
        }
        while (lines.length && lines[lines.length - 1].trim() === '') lines.pop();
        // Each column segment is retained as a segments element (an empty string) even if it is empty:
        // The newly added empty column (no content after `> [!col]`) must be added to the number of widget columns.
        // Otherwise, the number of widget columns < the actual number of columns in the document, the new columns will not be visible in the Live Preview.
        // The blank line cleaning logic at the end of the paragraph remains in the previous line while.
        segments.push(lines.join('\n'));
      }
      rows.push(bounds.length - 1 - firstSeg);
    }
    // The widget is only rendered when there is a col subcolumn (even if it is completely empty) or there is a non-empty content segment:
    // Isolated multi-column tags (without any col and no content) are not rendered to avoid replacing the tag rows from interfering with editing (consistent with the original behavior).
    if (segments.length && (dividers.length > 0 || segments.some((s) => s.trim() !== ''))) {
      // The scope convention is consistent with the Obsidian rendering block: swallow the trailing newline if there are still content lines after the column.
      // ([mark the beginning of the line, the beginning of the next line)); if it stops at the end of this line, it will be blocked by the outer native rendering block.
      // Decoration is included entirely and discarded by CM6.
      // Option 1 (the cursor can be crossed when there is no content below the column): When the column is the last content of the document, endPos
      // Keep the line break bit at the end without swallowing it to ensure that there is always a dockable cursor bit after the widget - only the remaining line breaks after column splitting
      // When there is a blank line at the end, the blank line at the end is from === doc.length, and replacing it there will make the widget stick to
      // At the end of the article, ArrowDown remains in place and clicks are ignored; it is changed to doc.length - 1
      // (the trailing newline character bit), and the trailing blank line can be docked by leaving it outside the widget.
      // (H6 extracts computeEndPos, and incremental translation reuses the same semantics)
      const endInfo = computeEndPos(doc, endLine);
      const endPos = endInfo.endPos; // endPos has swallowed the newline at the end (newline needs to be added when inserting text when writing back)
      const replacedBreak = endInfo.hasBreak;
      let widths: number[] | undefined;
      let opts: ColumnsOpts | undefined;
      const meta = doc.line(start + 1).text.match(/\[!multi-column\|([^\]]*)\]/);
      if (meta) {
        // Used when the number of width parameters (multi-line `60-40/50-50`, single-line `60-40`) is consistent with the number of columns
        const wm = meta[1].match(/^(\d+(?:-\d+)+(?:\/\d+(?:-\d+)+)*)/);
        if (wm) {
          const groups = wm[1].split('/').map((g) => g.split('-').map((x) => Number(x)));
          const flat = groups.flat();
          if (flat.length === segments.length && flat.every((w) => Number.isFinite(w) && w > 0)) {
            widths = flat;
          }
        }
        // H1 appearance parameters: gap / valign / radius / border (explicitly set before consumption)
        const gapM = meta[1].match(/(?:^|\s)gap=(\d+)(?:\s|$)/);
        const valignM = meta[1].match(/(?:^|\s)valign=(top|center|bottom|stretch)(?:\s|$)/);
        const radiusM = meta[1].match(/(?:^|\s)radius=(\d+)(?:\s|$)/);
        const hasBorder = /(?:^|\s)border(?:\s|$)/.test(meta[1]);
        if (gapM || valignM || radiusM || hasBorder) {
          opts = {};
          if (gapM) opts.gap = Number(gapM[1]);
          if (valignM) opts.valign = valignM[1] as ColumnsOpts['valign'];
          if (radiusM) opts.radius = Number(radiusM[1]);
          if (hasBorder) opts.border = true;
        }
      }
      regions.push({
        startLine: start,
        endLine,
        startPos: doc.line(start + 1).from,
        endPos,
        hasBreak: replacedBreak,
        widths,
        // It is used only when there is a col sub-column and the number of parsed bg is consistent with the number of column segments (the whole block structure without col does not have bg)
        bgs: dividers.length > 0 && bgs.length === segments.length ? bgs : undefined,
        opts,
        // Two-dimensional row: the number of columns in each row when there are multiple rows (not carried in a single row, widgets are divided equally according to the number of columns)
        rows: rowMarks.length > 0 && rows.length > 1 ? rows : undefined,
        segments,
      });
    }
  };

  for (let i = startLine; i <= endLine; i++) {
    const text = doc.line(i + 1).text;
    if (stats && COL_LOOSE_RE.test(text)) stats.markerLines++;
    if (fenceCh !== null) {
      const m = text.match(FENCE_RE);
      if (m && m[1][0] === fenceCh) fenceCh = null;
      continue;
    }
    const f = text.match(FENCE_RE);
    if (f) {
      fenceCh = f[1][0];
      continue;
    }
    if (COL_START_RE.test(text)) {
      if (start !== -1) push(i - 1);
      start = i;
      continue;
    }
    if (start === -1) continue;
    if (!QUOTE_RE.test(text)) {
      push(i - 1);
      start = -1;
    }
  }
  if (start !== -1) push(endLine);
  return regions;
}

/* ===== Click positioning: render snapshot click coordinates → source code character offset =====
 *
 * The non-editing state is the HTML snapshot output by MarkdownRenderer (read-only, no cursor), and the editing state is the display
 * Original Markdown <textarea>. The layout of the two is different (bold, titles, and lists will change the line height and horizontal direction)
 * position), so "click coordinates → source code offset" can only be approximated (the exact landing point of native Obsidian depends on
 * The visible surface and the editable surface are the same CM6 view). Method:
 * 1) Get the text node and offset at the clicked location; click to a blank space (non-text) or outside the content area → no editing;
 * 2) Remove the Markdown tag in the source code to obtain "plain text projection" (bringing back the source code subscript mapping) to click the point
 * The nearby rendered text is the anchor point positioned in the projection, converted into source code offset;
 * 3) When the anchor point positioning fails, estimate the beginning of the source code line based on the vertical ratio of the click point in the content area to avoid deviation of the landing point. */

/** Minimal declaration of non-standard API (only Chromium has caretRangeFromPoint, lib.dom is not included;
 * Note that this file has imported the Range type of CodeMirror, and the full name of the DOM Range must be written) */
type CaretRangeApi = { caretRangeFromPoint?: (x: number, y: number) => ReturnType<Document['caretRangeFromPoint']> };

/** Whether the environment supports coordinates → text position query (test environments such as jsdom do not support it and need to be downgraded) */
function hasCaretApi(doc: Document): boolean {
  return (
    typeof (doc as unknown as CaretRangeApi).caretRangeFromPoint === 'function' ||
    typeof doc.caretPositionFromPoint === 'function'
  );
}

/** Click the text node at the coordinates and offset within the node */
function caretAtPoint(doc: Document, x: number, y: number): { node: Node; offset: number } | null {
  const r = (doc as unknown as CaretRangeApi).caretRangeFromPoint?.(x, y);
  if (r) return { node: r.startContainer, offset: r.startOffset };
  const p = doc.caretPositionFromPoint?.(x, y);
  return p ? { node: p.offsetNode, offset: p.offset } : null;
}

/** Source code → Plain text projection: Skip Markdown markup characters (the ](url) of links/images are also skipped);
 * map[i] = projects the subscript of the i-th character in the source code */
function plainProjection(src: string): { plain: string; map: number[] } {
  const drop = new Set(['*', '_', '~', '=', '`', '#', '>', '[', ']', '|']);
  let plain = '';
  const map: number[] = [];
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (c === ']' && src[i + 1] === '(') {
      const close = src.indexOf(')', i);
      if (close !== -1) {
        i = close;
        continue;
      }
    }
    if (c === '\n' || c === '\r' || drop.has(c)) continue;
    plain += c;
    map.push(i);
  }
  return { plain, map };
}

/** Ignore whitespace normalization: norm = remove whitespace text, idx[k] = norm[k] subscript in the original string */
function looseMap(s: string): { norm: string; idx: number[] } {
  let norm = '';
  const idx: number[] = [];
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r') continue;
    norm += c;
    idx.push(i);
  }
  return { norm, idx };
}

/** Estimate the offset of the source line start based on the vertical ratio of the click point in the content area (anchor positioning failure/cover when media hits) */
function estimateOffsetByRatio(content: HTMLElement, source: string, y: number): number {
  const rect = content.getBoundingClientRect();
  const ratio = rect.height > 0 ? Math.min(1, Math.max(0, (y - rect.top) / rect.height)) : 0;
  const lines = source.split('\n');
  const target = Math.round(ratio * (lines.length - 1));
  let off = 0;
  for (let li = 0; li < target && li < lines.length; li++) off += lines[li].length + 1;
  return off;
}

/** Whether the non-text node hit by the click belongs to embedded media (picture/video/audio/canvas/embedded file, etc.).
 * This type of element does not have text nodes, and the source code offset needs to be estimated according to the click position to enter editing. It cannot be skipped as a blank space. */
function hitIsMedia(node: Node, content: HTMLElement): boolean {
  const el = node.nodeType === 1 ? (node as Element) : node.parentElement;
  // Hitting the container itself (clicking until the column is blank) does not count as media
  if (!el || el === content) return false;
  const media = el.closest('img, video, audio, canvas, svg, .internal-embed, .media-embed, .file-embed');
  return !!media && (media === content || content.contains(media));
}

/** Click coordinates → source code offset; return null = click to blank space (do not enter editing to avoid accidental touches) */
function sourceOffsetFromPoint(content: HTMLElement, source: string, x: number, y: number): number | null {
  const doc = content.ownerDocument;
  const empty = !source.trim();
  // The environment has no coordinate query capability (jsdom test): Unable to locate, enter editing directly (equivalent to the old behavior)
  if (!hasCaretApi(doc)) return 0;
  const hit = caretAtPoint(doc, x, y);
  // Click to the blank space / hit the element node / outside the content area: the entire empty column can be clicked; hit the embedded media (pictures/videos, etc.)
  // When there is no text node), the offset is estimated according to the click position to enter editing; other non-text hits (real blank) are not triggered.
  // Note: nodeType 3 = TEXT_NODE, whatToShow 4 = SHOW_TEXT, use literals to avoid dependencies
  // Node / NodeFilter global (test environments such as jsdom do not mount these two globals)
  if (!hit || !content.contains(hit.node) || hit.node.nodeType !== 3) {
    if (empty) return 0;
    if (hit && content.contains(hit.node) && hitIsMedia(hit.node, content)) {
      return estimateOffsetByRatio(content, source, y);
    }
    return null;
  }

  // Character offset of click point in rendered text
  let renderedOffset = hit.offset;
  const walker = doc.createTreeWalker(content, 4);
  for (let n = walker.nextNode(); n && n !== hit.node; n = walker.nextNode()) {
    renderedOffset += n.textContent?.length ?? 0;
  }

  // Use the rendered text near the click point as the anchor point and position it in the source code plain text projection.
  const rendered = content.textContent ?? '';
  const start = Math.max(0, renderedOffset - 24);
  const needle = rendered.slice(start, renderedOffset + 24);
  const { plain, map } = plainProjection(source);
  if (map.length) {
    const pm = looseMap(plain);
    const nn = looseMap(needle);
    const at = nn.norm ? pm.norm.indexOf(nn.norm) : -1;
    if (at >= 0) {
      // The number of valid characters before the click position within the anchor point → the corresponding position in the projection → source code offset
      const before = looseMap(needle.slice(0, renderedOffset - start)).norm.length;
      const plainIdx = pm.idx[Math.min(at + before, pm.idx.length - 1)];
      return map[plainIdx] ?? 0;
    }
  }

  // Bottom line: Estimate the beginning of the source code line based on the vertical ratio of the click point in the content area
  return estimateOffsetByRatio(content, source, y);
}

/* ===== Invisible mark (sentinel): hide inline formatting mark in editing mode =====
 *
 * Target: The cursor of the textarea in the editing state is not in a certain in-line format range (**bold** / ==highlight== /
 * ~~Delete~~ / `code` / italics), the mark characters in this interval are not displayed, making the text look and feel different from rendering
 * Consistent snapshots to avoid "text offset" caused by inline markers. The appearance, widget layout, and writeback pipeline remain unchanged.
 *
 * Method: Replace the mark characters with zero-width invisible characters of equal length (the length remains unchanged ⇒ The selection subscript is the source code
 * subscript, no offset map required). Only change the value of the editable textarea:
 * value display value = sentinelize(source code, cursor start, cursor end)
 * Write back / input / clipboard = desentinelize(value)
 * When the cursor (or selection) touches a certain interval (including the beginning and the end), the interval mark will return to the real character display. */

/** mark character → equal-length invisible character (U+2060-U+2064, zero width, still occupies one cursor stop) */
const MARKER_SENTINELS: Record<string, string> = {
  '*': '\u2061',
  '_': '\u2062',
  '~': '\u2063',
  '=': '\u2064',
  '`': '\u2060',
};

/** Invisible characters → original marked characters (restored when writing back) */
const SENTINEL_TO_MARKER: Record<string, string> = {
  '\u2061': '*',
  '\u2062': '_',
  '\u2063': '~',
  '\u2064': '=',
  '\u2060': '`',
};

/** Inline format mark interval: [start, end) is the entire span (including the first and last marks), and pre is the length of the preceding and following marks.
 * Content with + semantics (at least 1 non-whitespace character) ⇒ empty pairs (**** / ____, etc.) do not participate in matching,
 * Neither hidden nor silently deleted, consistent with native. */
type InlinePattern = { pre: number; re: RegExp };
const INLINE_FORMAT_PATTERNS: InlinePattern[] = [
  { pre: 3, re: /\*\*\*(?=\S)[^\n]*?\S\*\*\*/g }, // ***Bold italic***
  { pre: 2, re: /\*\*(?=\S)[^\n]*?\S\*\*/g }, // **Bold**
  { pre: 1, re: /\*(?=\S)[^*\n]*?\S\*/g }, // *italics*
  { pre: 2, re: /(?<!\w)__(?=\S)[^\n]*?\S__(?!\w)/g }, // __Bold__
  { pre: 1, re: /(?<!\w)_(?=\S)[^_\n]*?\S_(?!\w)/g }, // _italic_
  { pre: 2, re: /==(?=\S)[^\n]*?\S==/g }, // ==Highlight==
  { pre: 2, re: /~~(?=\S)[^\n]*?\S~~/g }, // ~~strikethrough~~
  { pre: 1, re: /`(?=\S)[^`\n]*?\S`/g }, // `inline code`
];

type InlineSpan = { start: number; end: number; pre: number };

/** Collect the inline format range of a line and remove overlaps (starting point ascending order, length descending order greedy, long mark first) */
function findInlineSpans(line: string): InlineSpan[] {
  const found: InlineSpan[] = [];
  for (const p of INLINE_FORMAT_PATTERNS) {
    p.re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = p.re.exec(line)) !== null) {
      found.push({ start: m.index, end: m.index + m[0].length, pre: p.pre });
      if (m[0].length === 0) p.re.lastIndex++;
    }
  }
  found.sort((a, b) => a.start - b.start || b.end - a.end);
  const kept: InlineSpan[] = [];
  let lastEnd = -1;
  for (const s of found) {
    if (s.start < lastEnd) continue;
    kept.push(s);
    lastEnd = s.end;
  }
  return kept;
}

/** Source code → Display value: Cursor/selection [activeFrom, activeTo] untouched format interval,
 * The mark characters are replaced by invisible characters of equal length (length is 1:1 ⇒ the selection subscript is the source code subscript) */
function sentinelize(source: string, activeFrom: number, activeTo: number): string {
  const lines = source.split('\n');
  let out = '';
  let base = 0; // The offset of the beginning of the current line in source
  for (let li = 0; li < lines.length; li++) {
    const line = lines[li];
    // marks[i] = the format interval to which the subscripted character belongs (only marks the character itself, excluding the interval content)
    const marks: (InlineSpan | null)[] = new Array<InlineSpan | null>(line.length).fill(null);
    for (const sp of findInlineSpans(line)) {
      for (let k = 0; k < sp.pre; k++) {
        marks[sp.start + k] = sp;
        marks[sp.end - 1 - k] = sp;
      }
    }
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      const sp = marks[i];
      const sent = MARKER_SENTINELS[c];
      if (sp && sent) {
        const active = activeFrom <= base + sp.end && activeTo >= base + sp.start;
        out += active ? c : sent;
      } else {
        out += c;
      }
    }
    base += line.length + 1;
    if (li < lines.length - 1) out += '\n';
  }
  return out;
}

/** Display value → Source code: Invisible characters are restored to original mark characters */
function desentinelize(display: string): string {
  return display.replace(/[\u2060-\u2064]/g, (ch) => SENTINEL_TO_MARKER[ch] ?? ch);
}

/** Refresh the textarea display value according to the current cursor/selection: the marks that need to be restored/hidden are written back if they are different from the current status.
 * (The length remains unchanged, and the selection is restored after writing back to avoid unnecessary reconstruction; it is skipped by the caller during input method combination) */
function syncMarkerDisplay(ta: HTMLTextAreaElement): void {
  const next = sentinelize(desentinelize(ta.value), ta.selectionStart, ta.selectionEnd);
  if (next === ta.value) return;
  const s = ta.selectionStart;
  const e = ta.selectionEnd;
  ta.value = next;
  ta.setSelectionRange(s, e);
}

/**
 * Interactive column widget (browsing and editing in one):
 * - Each column: ⠿ handle (drag to sort / click to pop up the command menu) + render content (click the text to edit)
 * - Between columns: separator bar (drag to adjust width)
 * - Command menu: Add column (insert after current column)/Delete column (disabled when 1 column is left)
 * Structure/content changes are written directly back to the document (single-step undo); no independent editing mode required. */
/** Widget content signature: Any change in content/width/background/row structure/appearance parameters requires the widget to be rebuilt.
 * The get key() of the widget is shared with the decoration construction to avoid inconsistent cache judgment caused by the drift of the two implementations. */
function columnsContentKey(
  segments: string[],
  widths: number[] | undefined,
  bgs: (ColBg | null)[] | undefined,
  rows: number[] | undefined,
  opts: ColumnsOpts | undefined
): string {
  return (
    segments.join('\u0000') +
    '#' +
    (widths?.join(',') ?? '') +
    '#' +
    (bgs?.map((b) => (b ? b.light + '/' + b.dark : '')).join(',') ?? '') +
    '#' +
    (rows?.join(',') ?? '') +
    '#' +
    JSON.stringify(opts ?? {})
  );
}

/** Column default appearance setting signature: The widget cache key is shared with WidgetType.key. Change gap / radius / in settings
 * Either valign / border will change the signature, forcing the widget to be rebuilt (inline align-self,
 * The border width, etc. will be refreshed accordingly) to avoid reusing the old DOM and causing the settings to not take effect. */
function settingsAppearanceKey(s: BlockEditorSettings): string {
  return `#${s.columnsValign}|${s.columnsGap}|${s.columnsRadius}|${s.columnsBorder}`;
}

class ColumnsWidget extends WidgetType {
  texts: string[] = [];
  widths: number[] = [];
  bgs: (ColBg | null)[] = [];
  opts: ColumnsOpts = {};
  /** 2D rows: number of columns per row (empty array = single row) */
  rows: number[] = [];
  region: ColumnsRegion;
  private editCol: number | null = null;
  /** The cursor offset that will land on the textarea after entering the editing state (used for click positioning; consumed once when rendering is completed) */
  private pendingCaret: number | null = null;
  /** The life cycle of the edit state selectionchange listener (rebuild each render, old listener is logged out) */
  private editAbort: AbortController | null = null;
  private textareas: HTMLTextAreaElement[] = [];
  private colEls: HTMLElement[] = [];
  /** Rendering height of the front bar when entering the editing state: Make the initial height of the textarea consistent with the rendering state and eliminate switching jumps */
  private preEditHeight = 0;
  private root: HTMLElement | null = null;
  /** Short life cycle components for snapshot rendering and mounting: unload before each renderInner rebuild to avoid
   * Use the main plug-in instance as component (long life cycle will accumulate leaks). */
  private renderChild: Component | null = null;
  private parentView: EditorView | null = null;
  private focusCol = -1;
  private menuEl: HTMLElement | null = null;
  private colorPickerEl: HTMLElement | null = null;
  /** Requirement B: Drop point insertion line when dragging out a column (hung on .cm-editor, rebuilt/removed with dragging) */
  private outLineEl: HTMLElement | null = null;

  /** Content signature: The decoration layer will rebuild the widget when the content/width/background color/row structure/appearance parameters change.
   * Additional inclusion of column default appearance settings (gap/radius/valign/border): when the user changes it in the settings,
   * If only the shell parameters are used for judgment, the cache will be hit and the old DOM will be reused, resulting in inline alignSelf and the border not being updated. */
  get key(): string {
    return columnsContentKey(this.texts, this.widths, this.bgs, this.rows, this.opts)
      + settingsAppearanceKey(this.ctx.settings);
  }

  /** Dispatch is prohibited during CM updates: event-triggered writebacks are uniformly delayed until microtask execution */
  private later(fn: (view: EditorView) => void): void {
    const view = this.parentView;
    if (!view) return;
    queueMicrotask(() => {
      try {
        fn(view);
      } catch (e) {
        console.error(TEXT.message0046, e);
      }
    });
  }

  constructor(
    private ctx: BlockEditorPlugin,
    region: ColumnsRegion,
    private path: string,
    /** Belonging Obsidian editor instance: Convergence global Editor prototype patches to this column */
    private ownerEditor: unknown = null
  ) {
    super();
    this.region = region;
    this.texts = [...region.segments];
    this.widths = region.widths ? [...region.widths] : [];
    this.bgs = region.bgs ? [...region.bgs] : [];
    this.opts = region.opts ? { ...region.opts } : {};
    this.rows = region.rows ? [...region.rows] : [];
  }

  eq(other: WidgetType): boolean {
    return other === this;
  }

  /**
   * viewport row height defense (one of the root causes of CM6 chain 1):
   * When estimatedHeight is not implemented, CM6 will put this block before the initial layout/asynchronous rendering is completed.
   * The widget is regarded as a 0-height block. If the content height changes subsequently (MarkdownRenderer fills asynchronously),
   * The row height mapping is misaligned with the actual layout, mousedown → posAtCoords will be calculated based on the misaligned mapping
   * Out of bounds pos → doc.lineAt(pos) → lineInner collapsed (undefined.length).
   * Provide stable lower bound estimate to allow margin for CM6 initial row height mapping, before requestMeasure correction
   * Clicking no longer goes out of bounds. */
  get estimatedHeight(): number {
    // Estimated height per row (horizontal group of columns): Column skeleton 64px + Estimated number of rows of content × 24px row height.
    // Get the maximum number of text wrapping lines in all columns (Markdown rendering will include ul/li/p, etc., the actual height
    // Usually not less than the plain text estimate), err on the side of higher than lower: overestimation only makes the click position slightly off, but not out of bounds.
    // Underestimation will make the CM6 line height cache too small → posAtCoords maps out of bounds pos → lineInner crashes.
    const rows = this.rows.length ? this.rows.length : 1;
    let maxLines = 1;
    for (const t of this.texts) {
      let lines = 1;
      for (let i = 0; i < t.length; i++) if (t.charCodeAt(i) === 10) lines++;
      if (lines > maxLines) maxLines = lines;
    }
    return Math.max(48, rows * (64 + maxLines * 24));
  }

  /** Estimated height of single column content: Estimated based on the number of lines of text in the column itself.
   * Previously, the entire set of estimates (the highest number of column lines) was used to set the min-height for each column, and the short columns were occupied.
   * The height is raised to be flush with the highest column, and min-height has a higher priority than align-self, resulting in
   * The short column under top/center/bottom alignment cannot shrink to the height of the content. */
  private colContentEstimatedHeight(i: number): number {
    const t = this.texts[i] ?? '';
    let lines = 1;
    for (let k = 0; k < t.length; k++) if (t.charCodeAt(k) === 10) lines++;
    return Math.max(28, lines * 24);
  }

  ignoreEvent(): boolean {
    return true;
  }

  /**
   * Layout information for external (drag.ts) to make drop hits: column DOM elements of each row + global subscript.
   * The reason for using DOM instead of CM coordinates is explained at the top of columns-droptarget.ts. */
  getLayoutInfo(): ColLayoutInfo {
    return buildColLayout(this.colEls, this.rows);
  }

  /** The range of document lines in the current column interval (used by Requirement B to determine the legal landing point of "immediately upstream/downstream") */
  getLineRange(): { start: number; end: number } {
    return { start: this.region.startLine, end: this.region.endLine };
  }

  /** The offset of the starting point of the interval in the CM6 document (positioning regionFrom when merging and writing back) */
  getRegionStartPos(): number {
    return this.region.startPos;
  }

  /** Offset of interval end point in CM6 document (exclusive) */
  getRegionEndPos(): number {
    return this.region.endPos;
  }

  /** Whether the newline is swallowed at the end of the interval (it is decided whether to add '\n' when writing back) */
  hasBreak(): boolean {
    return this.region.hasBreak;
  }

  toDOM(view: EditorView): HTMLElement {
    this.parentView = view;
    const wrap = createEl('div');
    wrap.className = 'block-editor-columns-widget';
    wrap.dataset.regionStart = String(this.region.startPos);
    this.root = wrap;
    widgetByRoot.set(wrap, this);
    // Note: toDOM is called during the DOM update process of CM6. At this time, the build has not been completed and the read
    // scrollTop is not trusted (will be clamped to 0). You cannot use render() with viewport locking here - otherwise
    // The "0 behind the clamp" will be restored as the current anchor point, which means the entire page will be scrolled to the top after undoing/recalculating.
    // This path is handed over to CM6's own scroll anchoring processing; operations that require locking are handled by the caller's commitDoc.
    this.renderInner();
    return wrap;
  }

  /** Write back the document after the structure or content is changed (single-step undo) */
  private commitDoc(): void {
    const view = this.parentView;
    if (!view) return;
    const text =
      buildColumnsMarkdown(
        this.texts,
        this.widths,
        this.bgs,
        this.rowEnds,
        Object.keys(this.opts).length ? this.opts : undefined
      ) + (this.region.hasBreak ? '\n' : '');
    // Idempotent check: dispatch is not initiated when the range content is consistent with the text to be written.
    // Unconditional whole region replacement will trigger Obsidian metadataCache to link to the file.
    // Asynchronous re-parsing, zoom in "switch to reading mode immediately after editing the column" embed unresolved
    // Race window (first render in reading mode displays bold file name fallback).
    const curText = view.state.doc.sliceString(this.region.startPos, this.region.endPos);
    if (curText === text) return;
    // Viewport lock: writing back will trigger a full rescan + widget reconstruction, and CM6’s viewport recalculation according to changes will make the entire article
    // The document scroll bar jumps away from the current editing position; pin the scrollTop here and stay at the original position after the operation.
    keepViewport(view, () => {
      view.dispatch({
        changes: { from: this.region.startPos, to: this.region.endPos, insert: text },
      });
    });
  }

  /** Number of columns per line → end-of-line column index of buildColumnsMarkdown ([1,3] represents two lines of 0-1 / 2-3) */
  private get rowEnds(): number[] | undefined {
    if (!this.rows.length) return undefined;
    const ends: number[] = [];
    let acc = 0;
    for (let r = 0; r < this.rows.length - 1; r++) {
      acc += this.rows[r];
      ends.push(acc - 1);
    }
    return ends.length ? ends : undefined;
  }

  /**
   * Column markdown interval text corresponding to the current memory state (including the trailing newline of hasBreak).
   * Provides external drag and drop paths to assemble single transaction changes of "range rewriting + outside range insertion". */
  buildRegionText(): string {
    return (
      buildColumnsMarkdown(
        this.texts,
        this.widths,
        this.bgs,
        this.rowEnds,
        Object.keys(this.opts).length ? this.opts : undefined
      ) + (this.region.hasBreak ? '\n' : '')
    );
  }

  /**
   * Insert a column at the specified global column position (requirement A: drag the document block into the column).
   * Only the memory status is changed without writing back - the writing back is merged into a single transaction by the caller, ensuring single-step undo.
   *
   * @param insertIndex global insertion index (0 = first, texts.length = last)
   * @param text New column content (bare markdown with reference prefix stripped)
   * @returns Whether the insertion is successful (false when out of bounds or empty content) */
  insertColumnAt(insertIndex: number, text: string): boolean {
    const at = Math.max(0, Math.min(insertIndex, this.texts.length));
    if (!text.trim()) return false;
    const n = this.texts.length + 1;
    const newW = Math.round((100 / n) * 10) / 10;
    const scale = (100 - newW) / 100;
    // The existing width is scaled down so that the new column takes up 100/n; when there is no width metadata, it is left to be evenly divided.
    if (this.widths.length === this.texts.length) {
      this.widths = this.widths.map((w) => Math.round(w * scale * 10) / 10);
      this.widths.splice(at, 0, newW);
    }
    this.texts.splice(at, 0, text);
    this.bgs.splice(at, 0, null);
    // Multiple rows and columns: The number of columns in the row where the insertion point is located +1 (no new rows are added, only the row is widened)
    if (this.rows.length) {
      const r = this.rowIndexOf(at);
      this.rows[r]++;
    }
    return true;
  }

  /**
   * Remove the specified column and return its content (requirement B: drag the column out of the column).
   * Only changes the memory status without writing it back - the same as insertColumnAt, merged into a single transaction by the caller.
   *
   * The width is divided proportionally among the remaining columns; when there is 1 column left, the width metadata is cleared (cooperate with the caller to downgrade to cancel column division).
   *
   * @returns The text of the removed column; if the subscript is illegal, return null */
  removeColumnAt(i: number): string | null {
    if (i < 0 || i >= this.texts.length) return null;
    const removed = this.texts[i];
    this.texts.splice(i, 1);
    this.bgs.splice(i, 1);
    if (this.widths.length === this.texts.length + 1) {
      this.widths.splice(i, 1);
      const sum = this.widths.reduce((a, b) => a + b, 0) || 1;
      this.widths = this.widths.map((w) => Math.round((w / sum) * 100 * 10) / 10);
    } else {
      this.widths = [];
    }
    if (this.rows.length) {
      const r = this.rowIndexOf(i);
      this.rows[r]--;
      // The column in the row is deleted and there are other rows: remove the row (the row structure remains ≥1 row)
      if (this.rows[r] <= 0 && this.rows.length > 1) this.rows.splice(r, 1);
    }
    return removed;
  }

  /** Number of remaining columns (Requirement B determines whether to downgrade to cancel column division) */
  columnCount(): number {
    return this.texts.length;
  }

  /**
   * All remaining columns are spelled into ordinary paragraph text (used when downgrading to cancel column division).
   * The semantics are consistent with unwrapColumns of convert.ts: columns are separated by blank lines and reference prefixes are stripped off. */
  buildUnwrappedText(): string {
    return this.texts
      .map((t) => t.replace(/\s+$/, ''))
      .filter((t) => t.length > 0)
      .join('\n\n');
  }

  /** Rebuild the widget DOM (dedicated to the interactive operation entrance: menu/drag/enter and exit editing).
   * Viewport lock: DOM reconstruction will change the actual measured height of the widget. When CM6 recalculates the viewport, the entire document scroll bar will
   * Jump away from the current editing position; pin scrollTop to stop the view in place.
   * Only used at call points "outside CM6 update" - scrollTop read during CM6 update process (toDOM)
   * Untrustworthy, this path goes directly to renderInner(). */
  private render(): void {
    keepViewport(this.parentView, () => this.renderInner());
  }

  /** Uninstall the short-life cycle components mounted by snapshot rendering and leave them empty (called when the widget is rebuilt/deprecated) */
  private disposeRenderChild(): void {
    if (this.renderChild) {
      try {
        this.renderChild.unload();
      } catch (e) {
        console.error(TEXT.message0047, e);
      }
      this.renderChild = null;
    }
  }

  /** Called when the widget is eliminated from the cache/document switching/switch is turned off: unload the snapshot rendering component */
  destroy(): void {
    this.disposeRenderChild();
  }

  /** Unified finishing after structure/content changes: write back document + rebuild DOM.
   * Delay writeback to microtasks (disable dispatch during CM updates). */
  private mutate(): void {
    queueMicrotask(() => this.commitDoc());
    this.render();
  }

  private renderInner(): void {
    const wrap = this.root;
    if (!wrap) return;
    // Uninstall the short-life cycle components mounted in the previous round of snapshot rendering before rebuilding the DOM (to avoid long-term survival with the main plug-in instance)
    this.disposeRenderChild();
    // Unregister the selectionchange listener of the old edit state textarea before rebuilding the DOM (to avoid leakage/crosstalk)
    if (this.editAbort) {
      this.editAbort.abort();
      this.editAbort = null;
    }
    const focusTarget = this.editCol;
    wrap.textContent = '';
    this.textareas = [];
    this.colEls = [];
    this.closeMenu();
    this.closeColorPicker();
    // Unregister the format command target when rendering in non-editing state (it will re-register when creating a textarea)
    if (this.editCol === null) setColumnEditTarget(null);

    // Two-dimensional row grouping: Render by row when there are rows (one flex row per row), otherwise all columns will be rendered in a single row
    const rowLens = this.rows.length ? this.rows : [this.texts.length];
    let si = 0;
    for (let ri = 0; ri < rowLens.length; ri++) {
      const row = createEl('div');
      row.className = 'block-editor-columns-row';
      if (ri < rowLens.length - 1) row.classList.add('block-editor-columns-row-mid');
      wrap.appendChild(row);

      // H1 appearance parameters → CSS variables (var() consumption of styles.css, sub-column inheritance;
      // Unset items fall back to the set default value variable on the body); border adds a stroke to the entire row of sub-columns class
      if (this.opts.gap != null) wrap.style.setProperty('--be-col-gap', this.opts.gap + 'px');
      if (this.opts.valign) wrap.style.setProperty('--be-col-valign', colValignToCss(this.opts.valign));
      if (this.opts.radius != null) wrap.style.setProperty('--be-col-radius', this.opts.radius + 'px');
      if (this.opts.border) row.classList.add('block-editor-columns-border');

      const rowLen = rowLens[ri];
      for (let j = 0; j < rowLen; j++, si++) {
        const i = si;
        // Separator bar between columns (drag to adjust width), no addition to the first column of the row
        if (j > 0) {
          const resizer = createEl('div');
          resizer.className = 'block-editor-col-resizer';
          resizer.title = TEXT.message0048;
          resizer.addEventListener('mousedown', (e) => this.startResize(e, i - 1, row, resizer));
          row.appendChild(resizer);
        }

        const col = createEl('div');
        col.className = 'block-editor-col-editor';
        // Weighted elastic width: The separator bar and + button occupy a fixed space, and the columns share the remaining width according to their weight.
        // If there is no width metadata, it will be divided evenly by the number of columns (otherwise, 'undefined 1 0%' will be discarded by the browser, and the column width will be reduced to the content width)
        const colWidth = this.widths[i] ?? 100 / this.texts.length;
        col.style.flex = colWidth + ' 1 0%';
        // The cross-axis alignment of the column is directly written inline align-self to avoid the problem that CSS variable inheritance may fail:
        // The shell valign= parameter takes precedence, otherwise the set default value is used.
        // stretch → column fills the row height (equal height); flex-start/center/flex-end → column height = content height, aligned according to top/middle/bottom.
        const v = this.opts.valign ?? this.ctx.settings.columnsValign;
        col.style.alignSelf = colValignToCss(v);
        // Background color of each column: two-color model → inline --col-bg-light/--col-bg-dark (if there is no background, the variable will be removed, and the CSS will be transparent)
        setColBgVars(col, this.bgs[i]);

        // Drag the sorting handle: drag to sort, click (displacement is less than the threshold) to pop up the command menu
        const grip = createEl('div');
        grip.className = 'block-editor-col-grip';
        grip.textContent = '⠿';
        grip.title = TEXT.message0049;
        grip.addEventListener('mousedown', (e) => this.gripDown(e, i));
        col.appendChild(grip);

        if (this.editCol === i) {
          // Editing state: textarea, write back out of focus.
          // value is "display value": inline formatting tags in which the cursor is not located are hidden with equal length invisible characters
          // (Initial activeFrom/activeTo = -1 ⇒ All hidden, restored by syncMarkerDisplay after the drop point is set)
          const ta = createEl('textarea');
          ta.className = 'block-editor-col-textarea';
          ta.value = sentinelize(this.texts[i], -1, -1);
          ta.spellcheck = false;
          // The number of lines determines the inherent height: when entering the editing mode, expand according to the number of lines of content (otherwise, long content will be cut into about 3 lines)
          syncTextareaRows(ta);
          // Register as editor command target: Mod+B / right-click "Text Format", etc. to redirect to this textarea;
          // Register the editor at the same time to prevent the bridge from mistaking API calls with the same name in other split screens.
          setColumnEditTarget(ta, this.ownerEditor);
          // Clipboard and select all events do not bubble up to the CM6 / Obsidian editor layer and are returned to textarea native processing
          guardTextareaEditing(ta);
          // Refresh the mark display according to the new position when the cursor moves (including typing/arrow keys/clicking); skip during input method combination
          // (Rebuilding the value during combination will interrupt the candidate), and then fill it in again after the combination is completed.
          let composing = false;
          ta.addEventListener('compositionstart', () => {
            composing = true;
          });
          ta.addEventListener('compositionend', () => {
            composing = false;
            syncMarkerDisplay(ta);
            autosizeTextarea(ta);
          });
          const ac = new AbortController();
          this.editAbort = ac;
          document.addEventListener(
            'selectionchange',
            () => {
              if (composing) return;
              if (document.activeElement !== ta) return;
              // Cursor state only (rebuilding value during selection dragging will interfere with native drag selection, and needs to be specific to the cursor)
              if (ta.selectionStart !== ta.selectionEnd) return;
              syncMarkerDisplay(ta);
            },
            { signal: ac.signal }
          );
          ta.addEventListener('input', () => {
            this.texts[i] = desentinelize(ta.value);
            // Synchronize height when adding or deleting rows (textarea is not natively adaptive)
            syncTextareaRows(ta);
            autosizeTextarea(ta);
          });
          // Display value contains invisible characters: revert to real markup when copying/cutting and writing to clipboard
          ta.addEventListener('copy', (e) => {
            const s = ta.selectionStart;
            const en = ta.selectionEnd;
            if (s === en) return;
            e.clipboardData?.setData('text/plain', desentinelize(ta.value.slice(s, en)));
            e.preventDefault();
          });
          ta.addEventListener('cut', (e) => {
            const s = ta.selectionStart;
            const en = ta.selectionEnd;
            if (s === en) return;
            e.clipboardData?.setData('text/plain', desentinelize(ta.value.slice(s, en)));
            e.preventDefault();
            const val = ta.value.slice(0, s) + ta.value.slice(en);
            ta.value = val;
            ta.setSelectionRange(s, s);
            this.texts[i] = desentinelize(val);
            syncMarkerDisplay(ta);
          });
          ta.addEventListener('blur', () => {
            // Defocus may occur during CM update (triggered by DOM rebuild), writeback must be delayed to microtask
            this.later(() => {
              if (this.editCol === i) {
                this.texts[i] = desentinelize(ta.value);
                this.editCol = null;
                editingWidgets.delete(this);
                setColumnEditTarget(null);
                queueMicrotask(() => this.commitDoc());
              }
              this.render();
            });
          });
          ta.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') {
              e.preventDefault();
              e.stopPropagation();
              this.later(() => {
                this.editCol = null;
                editingWidgets.delete(this);
                setColumnEditTarget(null);
                queueMicrotask(() => this.commitDoc());
                this.render();
              });
            }
          });
          col.appendChild(ta);
          this.textareas.push(ta);
          // Initialize the textarea with the rendering state height to eliminate the height jump when entering the editing state:
          // The rendered content is about 28px high (1 line), and the textarea CSS min-height is 90px. Direct replacement will jump ~62px.
          if (this.preEditHeight > 0) {
            ta.style.height = this.preEditHeight + 'px';
            ta.style.minHeight = this.preEditHeight + 'px';
          }
        } else {
          // Rendering state: MarkdownRenderer snapshot, click the text to enter the column editing (the cursor falls near the click point)
          const content = createEl('div');
          content.className = 'block-editor-col-content';
          content.addEventListener('mousedown', (e) => {
            // Left click only and no modifier keys
            if (e.button !== 0 || e.shiftKey || e.ctrlKey || e.metaKey || e.altKey) return;
            // Links (including tag a.tag, embedded a.internal-link): do not enter editing. enterEdit will rebuild
            // DOM, after the anchor is removed, click will no longer be dispatched → the link will become invalid. There is no preventDefault,
            // Without rebuilding, click the link back to Browser/Obsidian for processing.
            if ((e.target as Element | null)?.closest?.('a')) return;
            // Already editing other columns: Do not intercept this click, leave it to textarea to write back to this edit (click again to enter this column)
            if (this.editCol !== null && this.editCol !== i) return;
            const pos = sourceOffsetFromPoint(content, this.texts[i], e.clientX, e.clientY);
            if (pos === null) return; // Click on the blank space: no trigger, avoid accidental touch
            e.preventDefault();
            this.enterEdit(i, pos);
          });
          col.appendChild(content);
          // Synchronous placeholder height: estimated based on the number of rows in the column itself. MarkdownRenderer is
          // Asynchronous rendering, if the content before filling is 0/28px short, the first actual measurement of CM6 will record the short height.
          // Height → viewport row height mapping misalignment → posAtCoords calculation out of bounds when clicking/scrolling
          // pos → lineInner collapse(undefined.length). min-height supports the height consistent with the estimate
          // height, so that the first actual measurement is close to the final value.
          // Note that it must be estimated by column: if the highest column of the entire group is used for estimation, min-height will overwhelm align-self.
          // Short columns are raised when top/center/bottom aligned.
          content.style.minHeight = this.colContentEstimatedHeight(i) + 'px';
          // Empty column: Do not render empty content, add placeholder class (CSS provides min-height clickable area + "Click to edit this column" prompt)
          if (!this.texts[i] || !this.texts[i].trim()) {
            content.classList.add('block-editor-col-empty');
          } else {
            if (!this.renderChild) this.renderChild = new Component();
            MarkdownRenderer.render(this.ctx.app, this.texts[i], content, this.path, this.renderChild)
              .then(() => {
                // Multi-level requestMeasure: immediately + next frame + 300ms (overrides asynchronous images/fonts
                // height change after loading), ensure that the viewport row height cache converges to the true height as soon as possible,
                // Shorten the misalignment window of "measured short height → content becomes taller".
                const rm = (): void => this.parentView?.requestMeasure();
                rm();
                window.requestAnimationFrame(rm);
                window.setTimeout(rm, 300);
              })
              .catch(() => {
                content.setText(TEXT.message0050);
              });
          }
        }

        this.colEls.push(col);
        row.appendChild(col);
      }
    }

    // The editing height is fit according to the content: At this time, the DOM is mounted and the scrollHeight can be measured.
    // The explicit height determines the height of the column, so that the overall height is based on the column with the most content.
    for (const ta of this.textareas) autosizeTextarea(ta);

    if (focusTarget !== null && this.textareas[0]) {
      const ta = this.textareas[0];
      // preventScroll: Focus will cause the browser to scroll the entire editing area to the textarea, causing the page to jump elsewhere.
      ta.focus({ preventScroll: true });
      // Click to enter editing: Place the cursor on the source code offset corresponding to the clicked position (out-of-bounds clamping)
      const caret = this.pendingCaret;
      this.pendingCaret = null;
      if (caret !== null) {
        // The displayed value is the same length as the source code ⇒ The source code offset is the value subscript
        const p = Math.max(0, Math.min(caret, ta.value.length));
        ta.setSelectionRange(p, p);
      }
      // After the landing point is determined, restore the inline mark there according to the cursor position (the rest remains hidden)
      syncMarkerDisplay(ta);
    }
  }

  /** Enter the editing state; caretPos is the source code offset where the cursor will land (click to locate, if not passed, it will be the same as the old behavior) */
  private enterEdit(i: number, caretPos: number | null = null): void {
    if (this.editCol !== null) return;
    // Make sure the format command bridge is installed before entering the editing state (the prototype can only be obtained when there is an active editor)
    installColumnsFormatBridge(this.ctx.app);
    // Capture the current bar rendering height. The initial height of the textarea shall be based on this to eliminate switching jumps.
    this.preEditHeight = this.colEls[i]?.offsetHeight ?? 0;
    this.editCol = i;
    this.pendingCaret = caretPos;
    editingWidgets.add(this);
    this.render();
  }

  /** Write the currently edited content back to the document immediately; the old instance of DOM that has been destroyed is abandoned directly.
   * When switching tabs/closing the document, blur may not be triggered and is called by flushEditingColumns. */
  flushEdit(): void {
    if (this.editCol === null) return;
    // After the decoration layer is rebuilt, the old instance has been separated from the document, and writing back will fall into the invalid view and give up directly.
    if (this.root && !this.root.isConnected) {
      this.editCol = null;
      setColumnEditTarget(null);
      return;
    }
    const ta = this.textareas[this.editCol];
    if (ta) this.texts[this.editCol] = desentinelize(ta.value);
    this.editCol = null;
    setColumnEditTarget(null);
    try {
      this.commitDoc();
    } catch {
      /* View has been destroyed，Writeback failure can be ignored（The original text is still in the editor document） */
    }
    // Rebuild the DOM synchronously after forcibly ending editing: otherwise the remaining textarea is no longer in the editing state (editCol=null).
    // If you continue to type, only the text in the memory will be updated. When it is out of focus, it will no longer be written back. Words will be lost silently.
    if (this.root?.isConnected) this.render();
  }

  /** The line number of the current column (constantly 0 for a single line) */
  private rowIndexOf(colIdx: number): number {
    if (!this.rows.length) return 0;
    let acc = 0;
    for (let r = 0; r < this.rows.length; r++) {
      if (colIdx < acc + this.rows[r]) return r;
      acc += this.rows[r];
    }
    return this.rows.length - 1;
  }

  /** Global column interval [start, end) of row r */
  private rowRange(r: number): [number, number] {
    const start = this.rows.slice(0, r).reduce((a, b) => a + b, 0);
    return [start, start + this.rows[r]];
  }

  /** Insert a column after the current column (afterIndex); the old column is scaled down and the new column occupies 100/n */
  private addColumnAt(afterIndex: number): void {
    const n = this.texts.length + 1;
    const newW = Math.round((100 / n) * 10) / 10;
    const scale = (100 - newW) / 100;
    this.widths = this.widths.map((w) => Math.round(w * scale * 10) / 10);
    this.widths.splice(afterIndex + 1, 0, newW);
    this.texts.splice(afterIndex + 1, 0, '');
    this.bgs.splice(afterIndex + 1, 0, null);
    if (this.rows.length) this.rows[this.rowIndexOf(afterIndex)]++;
    this.mutate();
  }

  /** Delete the specified column; the width of the deleted column is divided proportionally to the remaining columns (the sum returns to 100); it will not be executed when there is 1 column left. */
  private removeColumn(i: number): void {
    if (this.texts.length <= 1) return;
    this.texts.splice(i, 1);
    this.bgs.splice(i, 1);
    if (this.widths.length > 1) {
      this.widths.splice(i, 1);
      const sum = this.widths.reduce((a, b) => a + b, 0) || 1;
      this.widths = this.widths.map((w) => Math.round((w / sum) * 100 * 10) / 10);
    } else {
      this.widths = [];
    }
    if (this.rows.length) {
      const r = this.rowIndexOf(i);
      this.rows[r]--;
      // The column in the row is deleted and there are other rows: remove the row (the row structure remains ≥1 row)
      if (this.rows[r] <= 0 && this.rows.length > 1) this.rows.splice(r, 1);
    }
    this.mutate();
  }

  /** H2: Split the i-th column into two columns (the text is halved by line, the width is halved, and the background is used) */
  private splitColumnAt(i: number): void {
    const t = this.texts[i] ?? '';
    const lines = t.split('\n');
    const mid = Math.max(1, Math.ceil(lines.length / 2));
    const left = lines.slice(0, mid).join('\n');
    const right = lines.slice(mid).join('\n');
    const w = this.widths[i] ?? 100 / this.texts.length;
    this.texts[i] = left;
    this.texts.splice(i + 1, 0, right);
    this.widths.splice(i + 1, 0, w / 2);
    this.widths[i] = w / 2;
    this.bgs.splice(i + 1, 0, this.bgs[i] ?? null);
    if (this.rows.length) this.rows[this.rowIndexOf(i)]++;
    this.mutate();
  }

  /** H2: Merge the i-th column with the next column (cross-row merging of the last column is prohibited; it will not be executed when there is 1 column left) */
  private mergeColumns(i: number): void {
    if (this.texts.length <= 1) return;
    if (this.rows.length && i + 1 >= this.rowRange(this.rowIndexOf(i))[1]) return;
    const right = this.texts[i + 1];
    this.texts[i] = this.texts[i] + (right.trim() ? '\n' + right : '');
    this.widths[i] = (this.widths[i] ?? 1) + (this.widths[i + 1] ?? 1);
    this.bgs[i] = this.bgs[i] ?? this.bgs[i + 1];
    this.texts.splice(i + 1, 1);
    this.widths.splice(i + 1, 1);
    this.bgs.splice(i + 1, 1);
    if (this.rows.length) this.rows[this.rowIndexOf(i)]--;
    this.mutate();
  }

  /** H2: Append a line at the end of the column (the number of columns is the same as the first line, including the `>> [!colrow]` line mark) */
  private appendRow(): void {
    const perRow = this.rows.length ? this.rows[0] : this.texts.length;
    for (let k = 0; k < perRow; k++) {
      this.texts.push('');
      this.widths.push(Math.round((100 / perRow) * 10) / 10);
      this.bgs.push(null);
    }
    // A single line of old notes (rows is empty) becomes two-dimensional after appending the first line: both the first line + the new line are recorded;
    // Otherwise, rows=[N] will be treated as a single row of N columns, and rowEnds will be empty, causing the writeback to lose the colrow mark.
    this.rows = this.rows.length ? [...this.rows, perRow] : [perRow, perRow];
    this.mutate();
  }

  /** H2: Delete the entire row (remove all columns of the row; return to single-row mode when only 1 row is left after deletion, and strip off the colrow mark) */
  private removeRowAt(r: number): void {
    if (this.rows.length <= 1) return;
    const [s, e] = this.rowRange(r);
    this.texts.splice(s, e - s);
    this.widths.splice(s, e - s);
    this.bgs.splice(s, e - s);
    this.rows.splice(r, 1);
    if (this.rows.length === 1) this.rows = [];
    this.mutate();
  }

  /** H2: Move the entire row up/down (swap the column, width, background and row width arrays of two adjacent rows) */
  private moveRow(r: number, dir: -1 | 1): void {
    const t = r + dir;
    if (t < 0 || t >= this.rows.length) return;
    const [s1, e1] = this.rowRange(r);
    const [s2, e2] = this.rowRange(t);
    // Adjacent rows e1 === s2 always holds, and the two row blocks are directly exchanged.
    const swap = <T,>(arr: T[]): void => {
      const a = arr.slice(s1, e1);
      const b = arr.slice(s2, e2);
      arr.splice(0, arr.length, ...arr.slice(0, s1), ...b, ...arr.slice(e1, s2), ...a, ...arr.slice(e2));
    };
    swap(this.texts);
    swap(this.widths);
    swap(this.bgs);
    const tmp = this.rows[r];
    this.rows[r] = this.rows[t];
    this.rows[t] = tmp;
    this.mutate();
  }

  // Press and hold the column separator bar and drag: adjust the width of two adjacent columns (the sum remains unchanged, minimum 10%)
  private startResize(e: MouseEvent, i: number, row: HTMLElement, resizer: HTMLElement): void {
    e.preventDefault();
    e.stopPropagation();
    resizer.classList.add('is-active');
    const startX = e.clientX;
    const rowWidth = Math.max(row.getBoundingClientRect().width, 1);
    const w1 = this.widths[i] ?? 100 / this.region.segments.length;
    const w2 = this.widths[i + 1] ?? 100 / this.region.segments.length;
    const colEls = [this.colEls[i], this.colEls[i + 1]];
    const onMove = (ev: MouseEvent) => {
      const delta = ((ev.clientX - startX) / rowWidth) * 100;
      let n1 = Math.max(10, Math.min(85, w1 + delta));
      const n2 = Math.max(10, w1 + w2 - n1);
      n1 = w1 + w2 - n2;
      this.widths[i] = Math.round(n1 * 10) / 10;
      this.widths[i + 1] = Math.round(n2 * 10) / 10;
      if (colEls[0]) {
        // Unify the grow weighted formula with render() to avoid jumps caused by inconsistency between the layout mode during dragging and after reconstruction.
        colEls[0].style.flex = this.widths[i] + ' 1 0%';
        colEls[0].style.removeProperty('max-width');
      }
      if (colEls[1]) {
        colEls[1].style.flex = this.widths[i + 1] + ' 1 0%';
        colEls[1].style.removeProperty('max-width');
      }
    };
    // Unified entrance to the end: both mouseup and window blur (events are lost when the pointer moves out of the window/switching applications),
    // Avoid mousemove / mouseup listeners lingering when mouseup is lost
    const finish = (): void => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', finish);
      window.removeEventListener('blur', finish);
      resizer.classList.remove('is-active');
      this.later((view) => this.commitDoc());
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', finish);
    window.addEventListener('blur', finish);
  }

  // Press and hold the handle on the top of the bar: the displacement exceeds the threshold and enters drag sorting; letting go before the threshold is exceeded is regarded as a click, and a command menu pops up.
  // Threshold differentiation solves the conflict between "drag handle" and "menu entry".
  private gripDown(e: MouseEvent, from: number): void {
    e.preventDefault();
    e.stopPropagation();
    const THRESHOLD = 5;
    const startX = e.clientX;
    const startY = e.clientY;
    let dragging = false;
    let hover = -1;
    /** Requirement B: The current legal "drag out of the column" drop point line number (null = no legal drop point, no prompt will be displayed) */
    let outLine: number | null = null;
    // Diagnostic log: There are many layers in the landing point determination of requirement B (hit bar/inside widget/outside editor/invalid line number),
    // Any link that returns null will be "silent and unresponsive". Keep the prefix log so that users can directly stick to the console to locate the step.
    const dbg = (...a: unknown[]): void => {
      console.log('[block-editor] col-drag:', ...a);
    };
    dbg('gripDown', { from, cols: this.colEls.length, start: this.region.startLine, end: this.region.endLine });
    const clearDrop = () => this.colEls.forEach((c) => c.classList.remove('block-editor-col-drop'));
    /** Drag-and-drop stroke of the source column: Let the user see "This column has been captured" */
    const setDragging = (on: boolean): void => {
      const c = this.colEls[from];
      if (c) c.classList.toggle('block-editor-col-dragging', on);
    };
    const detach = (): void => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      window.removeEventListener('blur', onCancel);
    };
    /**
     * Only remove the DOM of the drop point line, **do not move** the outLine state.
     *
     * Must be separated from clearOutLine: showOutLine must remove the previous line before redrawing it. If it is reused
     * clearOutLine (it also sets outLine to null), it will be after "just calculating the legal landing point"
     * Immediately clear the state - onMove calculates the same value every time and is cleared to null each time.
     * finalOutLine is always null when you let go, and extraction will never be triggered.
     * The performance is as follows: outLine 94 is printed repeatedly in the log (each time is counted as a "value change"), but it is null when up. */
    const removeOutLineEl = (): void => {
      if (this.outLineEl) {
        this.outLineEl.remove();
        this.outLineEl = null;
      }
    };
    /** Hide the insertion line after dragging out the drop point and clear the drop point status (only used when dragging ends/drop point becomes illegal) */
    const clearOutLine = (): void => {
      removeOutLineEl();
      outLine = null;
    };
    /**
     * Requirement B: Calculate the legal landing point when the pointer is outside the widget.
     * Only recognize the immediate ascending/descending rows of column blocks - the rest (between columns, inside other blocks, further rows)
     * It is absolutely illegal, no prompt will be displayed, and it will be canceled if you let go. */
    const computeOutLine = (ev: MouseEvent): number | null => {
      const view = this.parentView;
      if (!view) return null;
      // The pointer is still within the widget → not dragging out of the scene (either the order of columns is changed, or it is invalid)
      if (this.root && document.elementFromPoint?.(ev.clientX, ev.clientY)?.closest?.('.block-editor-columns-widget') === this.root) {
        return null;
      }
      // The pointer is not in any markdown editor → no drop point
      if (!editorDomAtPoint(ev.clientX, ev.clientY, view)) return null;
      const pos = view.posAtCoords({ x: ev.clientX, y: ev.clientY });
      if (pos == null) return null;
      const { start, end } = this.getLineRange();
      const doc = view.state.doc;
      const l = doc.lineAt(pos);
      // Editor convention: when the pointer falls on the upper half of a line → it is inserted before the line; when the pointer falls on the lower half → it is inserted after the line.
      // In this way, each row has two optional landing points, which can be positioned freely according to the rules of "any row outside the range".
      const top = view.coordsAtPos(l.from)?.top;
      const bottom = view.coordsAtPos(l.to)?.bottom;
      const mid = top != null && bottom != null ? (top + bottom) / 2 : null;
      const after = mid != null && ev.clientY >= mid;
      const target = (l.number - 1) + (after ? 1 : 0);
      return resolveExtractLine(start, end, target);
    };
    /** Draw and drag out the insertion line (paste it on .cm-editor, crop it with overflow:hidden) */
    const showOutLine = (ev: MouseEvent, line: number): void => {
      const view = this.parentView;
      if (!view || !view.dom) return;
      const doc = view.state.doc;
      const editorRect = view.dom.getBoundingClientRect();
      const contentRect = view.contentDOM.getBoundingClientRect();
      // Append to end: line drawn at the bottom of the last line
      if (line >= doc.lines) {
        const last = doc.line(doc.lines);
        const c = view.coordsAtPos(last.to);
        if (!c) return;
        removeOutLineEl();
        const el = createEl('div');
        el.className = 'block-editor-indicator block-editor-col-outline';
        el.style.left = `${contentRect.left - editorRect.left}px`;
        el.style.width = `${Math.max(contentRect.width, 40)}px`;
        el.style.top = `${(c.bottom ?? c.top) - editorRect.top - 1}px`;
        view.dom.appendChild(el);
        this.outLineEl = el;
        return;
      }
      const l = doc.line(line + 1);
      const c = view.coordsAtPos(l.from);
      if (!c) return;
      // Only remove the DOM of the previous line: you cannot use clearOutLine(), otherwise the newly calculated outLine will be cleared to null
      removeOutLineEl();
      const el = createEl('div');
      // The display and concealment are handled by .block-editor-col-outline itself (display:block, see styles.css),
      // The appearance base class .block-editor-indicator does not contain display - the two drop-point lines share the appearance but
      // Display and concealment are independent of each other, and changing the base class will not affect this. Only the dynamic geometry that changes with the pointer is written here.
      el.className = 'block-editor-indicator block-editor-col-outline';
      el.style.left = `${contentRect.left - editorRect.left}px`;
      el.style.width = `${Math.max(contentRect.width, 40)}px`;
      el.style.top = `${c.top - editorRect.top - 1}px`;
      view.dom.appendChild(el);
      this.outLineEl = el;
    };
    const onMove = (ev: MouseEvent) => {
      if (!dragging && Math.hypot(ev.clientX - startX, ev.clientY - startY) <= THRESHOLD) return;
      if (!dragging) {
        dragging = true;
        setDragging(true);
        dbg('drag start');
      }
      const el = document.elementFromPoint?.(ev.clientX, ev.clientY)?.closest('.block-editor-col-editor');
      hover = el ? this.colEls.indexOf(el as HTMLElement) : -1;
      this.colEls.forEach((c, k) => c.classList.toggle('block-editor-col-drop', k === hover && hover !== from));
      // Hit the column → change the order between columns and clear the drag-out prompt; miss → try to calculate the drag-out landing point
      if (hover !== -1) clearOutLine();
      else {
        const line = computeOutLine(ev);
        // Only log when the landing point changes to avoid refreshing the screen every time mousemove
        if (line !== outLine) dbg('outLine', line, { hover });
        outLine = line;
        if (line === null) clearOutLine();
        else showOutLine(ev, line);
      }
    };
    // Cancel dragging and unbinding when out of focus (pointer moves out of window/switching applications) to avoid monitoring residue
    const onCancel = (): void => {
      detach();
      clearDrop();
      setDragging(false);
      clearOutLine();
    };
    const onUp = (ev: MouseEvent) => {
      detach();
      clearDrop();
      setDragging(false);
      // The drop point line number must be captured before clearOutLine(): clearOutLine will set outLine to null.
      // If the order is reversed, the following extraction branch will always read null (shown as "can't drag it out no matter how hard it is dragged").
      const finalOutLine = outLine;
      clearOutLine();
      dbg('up', { finalOutLine, hover, dragging, alt: ev.altKey });
      if (!dragging) {
        // Click (without dragging): pop up command menu
        this.showColMenu(ev, from);
        return;
      }
      // Requirement B takes priority: drag to the legal landing point outside the column → the column breaks away from the column and becomes a normal block
      if (finalOutLine !== null && hover === -1) {
        const done = this.extractColumnTo(from, finalOutLine, ev.altKey);
        dbg('extract', done);
        if (done) return;
      }
      const el = document.elementFromPoint?.(ev.clientX, ev.clientY)?.closest('.block-editor-col-editor') as HTMLElement | null;
      const to = el ? this.colEls.indexOf(el) : -1;
      if (to !== -1 && to !== from) {
        this.later((view) => {
          const [t] = this.texts.splice(from, 1);
          this.texts.splice(to, 0, t);
          const [w] = this.widths.splice(from, 1);
          this.widths.splice(to, 0, w);
          const [b] = this.bgs.splice(from, 1);
          this.bgs.splice(to, 0, b);
          this.mutate();
          void view;
        });
      }
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    window.addEventListener('blur', onCancel);
  }

  /**
   * Implementation of requirement B: Move the i-th column out of the sub-column and insert it as a normal block before the line line.
   *
   * Single-step undo: "Interval rewrite (one column less)" + "Insert outside the interval (ordinary block)" merge into the same
   * Transaction, the reason is the same as commitColumnDrop.
   *
   * Boundary rules (confirmed with user):
   * - After dragging out, there is only 1 column left → Automatically downgrade to cancel column division, and the entire paragraph will be restored to a normal paragraph
   * - The width of the dragged column is distributed proportionally to the remaining columns (removeColumnAt internal processing)
   * - Empty columns are prohibited from being dragged out (there will be no content even if dragged out)
   * - The column at the end of a row can be dragged out of the sub-column (cross-row merging is handled by mergeColumns and is not blocked here)
   *
   * @param line target insertion line number (0-based, inserted before the line)
   * @param copy Alt = Copy to outside the column, the column will remain
   * @returns Whether it has been submitted */
  private extractColumnTo(i: number, line: number, copy: boolean): boolean {
    const view = this.parentView;
    if (!view) return false;
    const text = this.texts[i] ?? '';
    if (!text.trim()) return false;
    const plain = columnToPlainBlock(text).trim();
    if (!plain) return false;

    const doc = view.state.doc;
    const regionFrom = this.region.startPos;
    const regionTo = this.region.endPos;
    const lines: string[] = [];
    for (let k = 1; k <= doc.lines; k++) lines.push(doc.line(k).text);

    // Free drop point: line means "insert before line", line === doc.lines means append to the end of the text
    const insert = buildExtractInsertText(plain, lines, line, {
      start: this.region.startLine,
      end: this.region.endLine,
      hasBreak: this.region.hasBreak,
    });
    if (!insert) return false;
    const lineFrom = line >= doc.lines ? doc.length : doc.line(line + 1).from;

    // Alt copy: The column structure remains unchanged, only insert outside the interval
    if (copy) {
      keepViewport(view, () => {
        view.dispatch({ changes: buildCombinedChanges(regionFrom, regionTo, this.buildRegionText(), { pos: lineFrom, text: insert }) });
      });
      return true;
    }

    const removed = this.removeColumnAt(i);
    if (removed === null) return false;

    // 1 column left → Downgrade to uncolumn: Replace the entire paragraph with the plain text of the remaining columns.
    // The placement point is no longer limited, so the merge transaction of "range rewriting + outside range insertion" is carried out as usual.
    // It is not possible to spell the dragged content into the region text like in earlier versions (in that case it can only be inserted in the immediate position).
    const regionText = shouldUnwrapAfterExtract(this.columnCount())
      ? this.buildUnwrappedText() + (this.region.hasBreak ? '\n' : '')
      : this.buildRegionText();

    keepViewport(view, () => {
      view.dispatch({ changes: buildCombinedChanges(regionFrom, regionTo, regionText, { pos: lineFrom, text: insert }) });
    });
    this.render();
    return true;
  }

  // ---- grip command menu: set background color / add column / delete column (horizontal pure icon) ----
  /** lucide style inline icon (not dependent on Obsidian setIcon, also available in test environment) */
  private static iconEl(paths: string[]): SVGSVGElement {
    const svg = createSvg('svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('width', '14');
    svg.setAttribute('height', '14');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '2');
    svg.setAttribute('stroke-linecap', 'round');
    svg.setAttribute('stroke-linejoin', 'round');
    for (const d of paths) {
      const p = createSvg('path');
      p.setAttribute('d', d);
      svg.appendChild(p);
    }
    return svg;
  }

  private static readonly ICON_PALETTE = [
    'M12 22a10 10 0 1 1 10-10c0 2.21-1.79 4-4 4h-2.5c-1.1 0-2 .9-2 2 0 .55.23 1.05.59 1.41.37.36.59.86.59 1.41 0 1.1-.9 2-2 2z',
    'M7 12a1 1 0 1 0 0-2 1 1 0 0 0 0 2z',
    'M12 7a1 1 0 1 0 0-2 1 1 0 0 0 0 2z',
    'M17 12a1 1 0 1 0 0-2 1 1 0 0 0 0 2z',
  ];
  private static readonly ICON_PLUS = ['M5 12h14', 'M12 5v14'];
  private static readonly ICON_X = ['M18 6 6 18', 'M6 6l12 12'];
  private static readonly ICON_SPLIT = ['M8 3v18', 'M16 3v18'];
  private static readonly ICON_MERGE = ['M8 7l-4 5 4 5', 'M16 7l4 5-4 5'];
  private static readonly ICON_ROW_UP = ['M18 15l-6-6-6 6'];
  private static readonly ICON_ROW_DOWN = ['M6 9l6 6 6-6'];

  private closeMenu(): void {
    if (this.menuEl) {
      this.menuEl.remove();
      this.menuEl = null;
    }
  }

  private closeColorPicker(): void {
    if (this.colorPickerEl) {
      this.colorPickerEl.remove();
      this.colorPickerEl = null;
    }
  }

  /** Write the background color of a certain column and synchronize it to the document and rendering (color is null to clear the background).
   * Only set light colors: dark colors are automatically derived by the algorithm and written into the memory model (not dropped into the library, reproducible on the reading end);
   * To explicitly cover dark colors, use applyBgDark. */
  private applyBg(i: number, color: string | null): void {
    this.bgs[i] = color ? { light: color, dark: deriveDarkColor(color) } : null;
    this.mutate();
  }

  /** Overwrite/clear the dark theme background of a certain column: when dark is null, it returns to the automatically derived value */
  private applyBgDark(i: number, dark: string | null): void {
    const cur = this.bgs[i];
    if (!cur?.light) return;
    this.bgs[i] = { light: cur.light, dark: dark ?? deriveDarkColor(cur.light) };
    this.mutate();
  }

  private showColMenu(e: MouseEvent, i: number): void {
    this.closeMenu();
    this.closeColorPicker();
    const menu = createEl('div');
    menu.className = 'block-editor-col-menu';
    menu.style.left = e.clientX + 'px';
    menu.style.top = e.clientY + 'px';

    const bgBtn = createEl('button');
    bgBtn.className = 'block-editor-col-menu-item';
    bgBtn.title = TEXT.message0051;
    bgBtn.appendChild(ColumnsWidget.iconEl(ColumnsWidget.ICON_PALETTE));
    bgBtn.addEventListener('click', () => {
      this.closeMenu();
      this.openColorPicker(i, e.clientX, e.clientY);
    });

    const addBtn = createEl('button');
    addBtn.className = 'block-editor-col-menu-item';
    addBtn.title = TEXT.message0052;
    addBtn.appendChild(ColumnsWidget.iconEl(ColumnsWidget.ICON_PLUS));
    addBtn.addEventListener('click', () => {
      this.closeMenu();
      this.addColumnAt(i);
    });

    const delBtn = createEl('button');
    delBtn.className = 'block-editor-col-menu-item';
    delBtn.title = TEXT.message0053;
    const single = this.texts.length <= 1;
    if (single) {
      delBtn.disabled = true;
      delBtn.title = TEXT.message0054;
    }
    delBtn.appendChild(ColumnsWidget.iconEl(ColumnsWidget.ICON_X));
    delBtn.addEventListener('click', () => {
      this.closeMenu();
      this.removeColumn(i);
    });

    // H2 row and column editing enhancements: split column/merge to next column/append a row/move row up/move row down
    const splitBtn = createEl('button');
    splitBtn.className = 'block-editor-col-menu-item';
    splitBtn.title = TEXT.message0055;
    splitBtn.appendChild(ColumnsWidget.iconEl(ColumnsWidget.ICON_SPLIT));
    splitBtn.addEventListener('click', () => {
      this.closeMenu();
      this.splitColumnAt(i);
    });

    const mergeBtn = createEl('button');
    mergeBtn.className = 'block-editor-col-menu-item';
    mergeBtn.title = TEXT.message0056;
    const rowEnd = this.rows.length ? this.rowRange(this.rowIndexOf(i))[1] : this.texts.length;
    if (single || i + 1 >= rowEnd) {
      mergeBtn.disabled = true;
      mergeBtn.title = single ? TEXT.message0057 : TEXT.message0058;
    }
    mergeBtn.appendChild(ColumnsWidget.iconEl(ColumnsWidget.ICON_MERGE));
    mergeBtn.addEventListener('click', () => {
      this.closeMenu();
      this.mergeColumns(i);
    });

    const rowBtn = createEl('button');
    rowBtn.className = 'block-editor-col-menu-item';
    rowBtn.title = TEXT.message0059;
    rowBtn.appendChild(ColumnsWidget.iconEl(ColumnsWidget.ICON_PLUS));
    rowBtn.addEventListener('click', () => {
      this.closeMenu();
      this.appendRow();
    });

    // Delete the entire row: only available for multiple rows (disabled for single rows to avoid deleting the entire column)
    const delRowBtn = createEl('button');
    delRowBtn.className = 'block-editor-col-menu-item';
    delRowBtn.title = this.rows.length > 1 ? TEXT.message0060 : TEXT.message0061;
    if (this.rows.length <= 1) delRowBtn.disabled = true;
    delRowBtn.appendChild(ColumnsWidget.iconEl(ColumnsWidget.ICON_X));
    delRowBtn.addEventListener('click', () => {
      this.closeMenu();
      this.removeRowAt(this.rowIndexOf(i));
    });

    menu.appendChild(bgBtn);
    menu.appendChild(addBtn);
    menu.appendChild(splitBtn);
    menu.appendChild(mergeBtn);
    menu.appendChild(delBtn);
    menu.appendChild(rowBtn);
    menu.appendChild(delRowBtn);

    // Whole-row sorting (row up/row down) is only provided for multiple rows. A single row is meaningless.
    if (this.rows.length > 1) {
      const rIdx = this.rowIndexOf(i);
      const rowUp = createEl('button');
      rowUp.className = 'block-editor-col-menu-item';
      rowUp.title = TEXT.message0062;
      if (rIdx === 0) rowUp.disabled = true;
      rowUp.appendChild(ColumnsWidget.iconEl(ColumnsWidget.ICON_ROW_UP));
      rowUp.addEventListener('click', () => {
        this.closeMenu();
        this.moveRow(rIdx, -1);
      });

      const rowDown = createEl('button');
      rowDown.className = 'block-editor-col-menu-item';
      rowDown.title = TEXT.message0063;
      if (rIdx === this.rows.length - 1) rowDown.disabled = true;
      rowDown.appendChild(ColumnsWidget.iconEl(ColumnsWidget.ICON_ROW_DOWN));
      rowDown.addEventListener('click', () => {
        this.closeMenu();
        this.moveRow(rIdx, 1);
      });

      menu.appendChild(rowUp);
      menu.appendChild(rowDown);
    }
    document.body.appendChild(menu);
    this.menuEl = menu;

    // Click outside the menu to close (the mousedown of the menu item itself is inside the menu and will not be affected)
    window.setTimeout(() => {
      window.addEventListener('mousedown', this.onDocMouseDown, { once: true });
    }, 0);
  }

  /** 5 coordinating pastel preset background colors */
  private static readonly BG_PALETTE = ['#f1f3f5', '#ffe8e8', '#fff4d6', '#d8f3dc', '#d0ebff'];

  /** Pop-up window color selection: default color palette + custom hex + no background color (clear) */
  private openColorPicker(i: number, x: number, y: number): void {
    this.closeColorPicker();
    const picker = createEl('div');
    picker.className = 'block-editor-col-picker';
    picker.style.left = x + 'px';
    picker.style.top = y + 'px';

    const title = createEl('div');
    title.className = 'block-editor-col-picker-title';
    title.textContent = TEXT.message0064 + (i + 1) + TEXT.message0065;
    picker.appendChild(title);

    // Default color palette
    const swatches = createEl('div');
    swatches.className = 'block-editor-col-picker-swatches';
    for (const c of ColumnsWidget.BG_PALETTE) {
      const sw = createEl('button');
      sw.className = 'block-editor-col-picker-swatch';
      sw.style.backgroundColor = c;
      sw.title = c;
      sw.addEventListener('click', () => {
        this.closeColorPicker();
        this.applyBg(i, c);
      });
      swatches.appendChild(sw);
    }
    picker.appendChild(swatches);

    // Customized color selection window: native color picker (immediate preview to hex input box, change confirmation written back)
    const customRow = createEl('div');
    customRow.className = 'block-editor-col-picker-custom';
    const colorInput = createEl('input');
    colorInput.type = 'color';
    colorInput.className = 'block-editor-col-picker-native';
    colorInput.value = this.bgs[i]?.light ?? '#f1f3f5';
    colorInput.title = TEXT.message0066;
    colorInput.addEventListener('input', () => {
      input.value = colorInput.value;
      input.classList.remove('is-invalid');
    });
    colorInput.addEventListener('change', () => {
      this.closeColorPicker();
      this.applyBg(i, colorInput.value);
    });

    // Custom hex input
    const hexRow = createEl('div');
    hexRow.className = 'block-editor-col-picker-hex';
    const input = createEl('input');
    input.type = 'text';
    input.placeholder = '#RRGGBB';
    input.value = this.bgs[i]?.light ?? '';
    input.spellcheck = false;
    input.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter') applyHex();
    });
    const applyBtn = createEl('button');
    applyBtn.className = 'block-editor-col-picker-apply';
    applyBtn.textContent = TEXT.message0067;
    const applyHex = (): void => {
      const v = input.value.trim();
      if (!HEX_COLOR_RE.test(v)) {
        input.classList.add('is-invalid');
        return;
      }
      this.closeColorPicker();
      this.applyBg(i, v);
    };
    applyBtn.addEventListener('click', applyHex);
    hexRow.appendChild(input);
    hexRow.appendChild(applyBtn);
    customRow.appendChild(colorInput);
    customRow.appendChild(hexRow);
    picker.appendChild(customRow);

    // Collapsible "Overlay Dark" portal: Expand to set the background color under the dark theme; clear it to resume automatic derivation.
    // The explicitly set value is written back to `bg-dark=` and dropped into the library; the automatically derived value is not dropped into the library (the reading end reproduces it according to the same algorithm)
    const darkSection = createEl('div');
    darkSection.className = 'block-editor-col-picker-dark';
    const darkToggle = createEl('button');
    darkToggle.className = 'block-editor-col-picker-dark-toggle';
    darkToggle.textContent = TEXT.message0068;
    darkToggle.addEventListener('click', () => {
      darkBody.hidden = !darkBody.hidden;
      darkToggle.textContent = darkBody.hidden ? TEXT.message0069 : TEXT.message0070;
    });
    const darkBody = createEl('div');
    darkBody.className = 'block-editor-col-picker-dark-body';
    darkBody.hidden = true;
    const darkRow = createEl('div');
    darkRow.className = 'block-editor-col-picker-dark-row';
    const darkNative = createEl('input');
    darkNative.type = 'color';
    darkNative.className = 'block-editor-col-picker-native';
    darkNative.value = this.bgs[i]?.dark ?? '#f1f3f5';
    darkNative.title = TEXT.message0071;
    const darkInput = createEl('input');
    darkInput.type = 'text';
    darkInput.placeholder = '#RRGGBB';
    darkInput.value = this.bgs[i]?.dark ?? '';
    darkInput.spellcheck = false;
    darkNative.addEventListener('input', () => {
      darkInput.value = darkNative.value;
      darkInput.classList.remove('is-invalid');
    });
    const applyDarkHex = (): void => {
      const v = darkInput.value.trim();
      if (!HEX_COLOR_RE.test(v)) {
        darkInput.classList.add('is-invalid');
        return;
      }
      this.closeColorPicker();
      this.applyBgDark(i, v);
    };
    const darkApply = createEl('button');
    darkApply.className = 'block-editor-col-picker-apply';
    darkApply.textContent = TEXT.message0072;
    darkApply.addEventListener('click', applyDarkHex);
    darkInput.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter') applyDarkHex();
    });
    darkNative.addEventListener('change', () => {
      this.closeColorPicker();
      this.applyBgDark(i, darkNative.value);
    });
    const darkReset = createEl('button');
    darkReset.className = 'block-editor-col-picker-dark-reset';
    darkReset.textContent = TEXT.message0073;
    darkReset.addEventListener('click', () => {
      this.closeColorPicker();
      this.applyBgDark(i, null);
    });
    darkRow.appendChild(darkNative);
    darkRow.appendChild(darkInput);
    darkRow.appendChild(darkApply);
    darkBody.appendChild(darkRow);
    darkBody.appendChild(darkReset);
    darkSection.appendChild(darkToggle);
    darkSection.appendChild(darkBody);
    picker.appendChild(darkSection);

    // clear background
    const clearBtn = createEl('button');
    clearBtn.className = 'block-editor-col-picker-clear';
    clearBtn.textContent = TEXT.message0074;
    clearBtn.addEventListener('click', () => {
      this.closeColorPicker();
      this.applyBg(i, null);
    });
    picker.appendChild(clearBtn);

    document.body.appendChild(picker);
    this.colorPickerEl = picker;

    // Click outside the floating layer to close it
    window.setTimeout(() => {
      window.addEventListener('mousedown', this.onDocMouseDown, { once: true });
    }, 0);
  }

  private onDocMouseDown = (ev: MouseEvent): void => {
    if (this.menuEl && !this.menuEl.contains(ev.target as Node)) this.closeMenu();
    if (this.colorPickerEl && !this.colorPickerEl.contains(ev.target as Node)) this.closeColorPicker();
  };
}

interface DecorState {
  doc: { lines: number; line(n: number): { from: number; to: number; text: string } };
  field<T>(f: StateField<T>): T;
}

function path_of(state: DecorState): string {
  const mv = state.field(editorInfoField);
  return mv?.file?.path ?? '';
}

/**
 * Browse widget reuse cache: reuse instances when the range content remains unchanged (focus preservation, anti-flicker).
 * CM6 defense: key record document identification (path) + belonging view (owner) to prevent mistaken reuse--
 * The widget holds DOM and editor references (parentView / root is a single instance),
 * If the same startPos/content signature is shared across documents or different split screens of the same file, it will be reused.
 * parentView will be overwritten by the latter, the DOM will be moved, and the write back to dispatch will fall into the wrong view. */
const widgetCache = new Map<
  number,
  { path: string; owner: unknown; key: string; widget: ColumnsWidget }
>();
let sharedCtx: BlockEditorPlugin | null = null;

/**
 * DOM root element → registry of widget instances.
 *
 * It is required that the landing point of A/B must be checked from the DOM for the widget (elementFromPoint only gets the element,
 * The column information is stored on the widget instance). Here, a reverse index is built using the wrap created by toDOM as the key.
 * Automatically invalidate when widget is destroyed/DOM is rebuilt (WeakMap weak reference, does not prevent recycling). */
const widgetByRoot = new WeakMap<HTMLElement, ColumnsWidget>();

/**
 * Get the column widget under the pointer position (requirement A: hit the column → add a new column; requirement B: determine whether to drag it out).
 * Returns null if no column is hit.
 *
 * Use elementFromPoint instead of CM6 posAtCoords for hit determination: the widget is ignoreEvent
 * block replacement decoration, posAtCoords can only give the replacement position of the entire interval, but cannot get the "number of columns". */
export function columnsWidgetAtPoint(x: number, y: number): ColumnsWidget | null {
  const el = document.elementFromPoint(x, y);
  if (!el) return null;
  const root = el.closest('.block-editor-columns-widget');
  if (!(root instanceof HTMLElement)) return null;
  return widgetByRoot.get(root) ?? null;
}

/** For debugging/testing: currently living widget instances (in order of insertion) */
export function allColumnsWidgets(): ColumnsWidget[] {
  return [...widgetCache.values()].map((e) => e.widget);
}

/**
 * Whether the pointer falls within the visible area of the specified editor view.
 *
 * Requirement B uses: `posAtCoords` will return the nearest legal position for coordinates outside the editor (null is not guaranteed),
 * If the area verification is not done first, dragging the bar to the tab bar/sidebar/window blank will also be misjudged as a legal landing point.
 * It manifests as "it sticks to a strange position when you let go". */
export function editorDomAtPoint(x: number, y: number, view: EditorView): boolean {
  const dom = view?.dom;
  if (!dom) return false;
  const r = dom.getBoundingClientRect();
  return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
}

/** Decoration construction: Replace the entire column area with interactive widgets */
function buildDecorations(state: DecorState, regions: ColumnsRegion[]): DecorationSet {
  const ranges: Range<Decoration>[] = [];
  const live = state.field(editorLivePreviewField);
  const docId = path_of(state) || 'untitled';
  // Per-view discriminator: Different split-screens of the same file have independent Editor instances to avoid mistaken reuse of widgets.
  const owner = state.field(editorInfoField)?.editor ?? null;
  lastDiagnostics.livePreview = live;

  lastDiagnostics.regions = regions.length;
  lastDiagnostics.note = lastDiagnostics.markerLines > 0 && regions.length === 0 ? TEXT.message0075 : '';
  lastDiagnostics.segmentsPreview = regions.flatMap((r) =>
    r.segments.map((seg) => seg.slice(0, 30).replace(/\n/g, '⏎'))
  );
  colLog(TEXT.message0076, { live, markerLines: lastDiagnostics.markerLines, regions: regions.length });

  // Switch off or source mode: do not replace with widget, retain the native callout (horizontal or not is controlled by body.be-columns-live-on CSS)
  if (!sharedCtx?.settings.livePreviewWidget || !live) {
    lastDiagnostics.note = !sharedCtx?.settings.livePreviewWidget ? TEXT.message0077 : TEXT.message0078;
    for (const e of widgetCache.values()) e.widget.destroy();
    widgetCache.clear();
    return Decoration.none;
  }

  const used = new Set<number>();
  // docLen remains unchanged within this function, and is mentioned outside the loop to avoid repeated calculations for each interval.
  const docLen = state.doc.line(state.doc.lines).to;
  for (const r of regions) {
    // Row boundary clamping (defense): startPos/endPos must be finite values and fall within 0..doc.length
    // Internal and orderly, non-compliant intervals are skipped and diagnosed to avoid out-of-bounds errors of Decoration.replace.
    const clampStart = Math.max(0, Math.min(r.startPos, docLen));
    const clampEnd = Math.max(clampStart, Math.min(r.endPos, docLen));
    if (
      !Number.isFinite(r.startPos) ||
      !Number.isFinite(r.endPos) ||
      r.startPos < 0 ||
      r.startPos > docLen ||
      r.endPos > docLen ||
      r.startPos > r.endPos ||
      clampEnd <= clampStart
    ) {
      lastDiagnostics.note =
        TEXT.message0079(r.startLine, r.startPos, r.endPos, docLen);
      colLog(TEXT.message0080, { startLine: r.startLine, startPos: r.startPos, endPos: r.endPos, docLen });
      continue;
    }
    used.add(r.startPos);
    // The cache key is included in the default appearance setting signature of the column, consistent with WidgetType.key:
    // Force the widget to be rebuilt when the settings change gap / radius / valign / border, so that alignSelf,
    // Border width, etc. are updated in time.
    const key = columnsContentKey(r.segments, r.widths, r.bgs, r.rows, r.opts)
      + settingsAppearanceKey(sharedCtx.settings);
    let entry = widgetCache.get(r.startPos);
    let widget: ColumnsWidget;
    if (entry && entry.path === docId && entry.owner === owner && entry.key === key) {
      // The same view and the content remains unchanged: reuse the instance (maintain focus, anti-flicker), only synchronize the position
      widget = entry.widget;
      widget.region = r;
    } else {
      // Old cache mismatch (content/view/document changes): Uninstall the rendering component of the old widget first to avoid leaks
      if (entry) entry.widget.destroy();
      colLog(TEXT.message0081, { startLine: r.startLine, doc: docId });
      widget = new ColumnsWidget(ctx_of(state), r, docId, owner);
      widgetCache.set(r.startPos, { path: docId, owner, key, widget });
    }
    ranges.push(Decoration.replace({ block: true, widget }).range(clampStart, clampEnd));
  }
  // Clean up the disappeared range/cache that no longer belongs to the current document or current view
  for (const k of [...widgetCache.keys()]) {
    const e = widgetCache.get(k);
    if (!e || e.path !== docId || e.owner !== owner || !used.has(k)) {
      if (e) e.widget.destroy();
      widgetCache.delete(k);
    }
  }
  return Decoration.set(ranges, true);
}

function ctx_of(state: DecorState): BlockEditorPlugin {
  return sharedCtx as BlockEditorPlugin;
}

/**
 * Column decoration is provided by StateField:
 * Block replacement decoration across newlines provided from ViewPlugin will be silently rejected by CM6 (only an error will be reported in the console).
 * The decorations facet must be accessed through provide, otherwise the decorations only exist in the field value and are not visible in the view.
 *
 * Performance: Document changes are fully rescanned by default (the incremental translation scheme has been abandoned due to unreliable line number displacement statistics, see update comments);
 * Only when there was no column interval before and the `>` character was not inserted in this change, the fast path is used to directly use the old value.
 * Avoid full scanning of uncolumn documents with every keystroke. */
/** Whether this transaction inserted text containing `>` (necessary prefix for column lines, used for fast path determination) */
function insertsQuote(tr: Transaction): boolean {
  let hit = false;
  tr.changes.iterChanges((_fromA, _toA, _fromB, _toB, inserted) => {
    if (inserted.toString().includes('>')) hit = true;
  });
  return hit;
}

export const columnsField = StateField.define<ColumnsState>({
  create: () => {
    colLog(TEXT.message0082);
    return { initialized: false, regions: [], decorations: Decoration.none };
  },
  update(value, tr) {
    let forced = false;
    for (const e of tr.effects) {
      if (e.is(forceRecompute)) {
        forced = true;
        colLog(TEXT.message0083);
      }
    }

    try {
      // When not initialized (create cannot get the document) or forced recalculation, the constituency transaction must also be fully calculated.
      if (value.initialized && !tr.docChanged && !forced) return value;
      if (!value.initialized || forced) return fullRescan(tr);

      // Fast path: It is impossible to create new columns when there has not been any column interval before and `>` has not been inserted this time.
      // (Column lines must start with `>` reference; deletion cannot create `>` lines out of thin air), use the old value directly,
      // Avoid scanning the entire document with every keystroke.
      if (value.regions.length === 0 && !insertsQuote(tr)) return value;

      // Any document changes will be fully rescanned (H6 increment kept and translation abandoned).
      // Reason: iterChangedRanges' fromB/toB semantics + lineAt's ownership of the end of line position,
      // Make shiftLine's line number displacement statistics systematically smaller in the "insert/edit above column" scenario.
      // kept column startPos on the upper side (covering the leading row), endPos on the upper side (missing the end of the column),
      // Superimposed with Obsidian's native callout rendering into two upper and lower copies of the same column (mirror repetition).
      // Full rescan ensures that the range is accurate after each change; widgets are still cached and reused without losing focus.
      colLog(TEXT.message0084);
      return fullRescan(tr);
    } catch (e) {
      lastDiagnostics.note = e instanceof Error ? e.message : String(e);
      return value;
    }
  },
  // Key: Connect the decorations in the field to the decorations facet--
  // Without this step, the decoration only exists in the field value and cannot be seen by the view at all;
  // Block replacement is only allowed by CM6 if the value provided by compute is a static DecorationSet.
  // Consumption tip escape defense: compute callback is executed during the CM6 transaction application period, including try-catch +
  // Range normalization prevents illegal range/field exceptions from bubbling up to dispatch (lineAt out-of-bounds).
  provide: (f) =>
    EditorView.decorations.compute([f], safeDecoCompute((state) => state.field(f).decorations, (msg, e) => colLog(msg, e))),
});

/** Full rescan (initialization / forced recalculation / each document change - the only entry after incremental deprecation) */
function fullRescan(tr: Transaction): ColumnsState {
  const stats = { markerLines: 0 };
  const regions = scanRegions(tr.state.doc, stats);
  lastDiagnostics.markerLines = stats.markerLines;
  colLog(TEXT.message0085, {
    regionCount: regions.length,
    regionRanges: regions.map((r) => [r.startLine, r.endLine]),
  });
  const decorations = buildDecorations({ doc: tr.state.doc, field: (f) => tr.state.field(f) }, regions);
  return { initialized: true, regions, decorations };
}

// Interaction layer: Complement the calculation immediately after the editor is mounted (StateField.create cannot get the document)
const columnsInteractions = ViewPlugin.fromClass(
  class {
    constructor(view: EditorView) {
      colLog(TEXT.message0086);
      const v = view;
      queueMicrotask(() => {
        try {
          v.dispatch({ effects: forceRecompute.of(null) });
        } catch {
          /* View has been destroyed */
        }
      });
    }
  }
);

/**
 * Undo/redo viewport protection:
 * Undoing will cause the column widget to rebuild, CM6 to recalculate the viewport, and scroll the view away (commonly scrolling back to the top of the document--
 * Undoing the transaction will bring the "scroll to cursor" target, and the cursor is often still at the beginning of the document).
 *
 * Note the scroll anchor point in ViewPlugin.update here: this hook is executed before the DOM of CM6 is updated.
 * (EditorView.update sequence is viewState.update → updatePlugins → docView.update),
 * At this moment scrollTop is still trusted. Then use the scrollSnapshot transaction to "overwrite" the undo transaction carried
 * Scroll target - the later dispatched transaction will replace the original scrollTarget, and CM6 will restore it according to the anchor point during the measurement phase
 * Go to the original position instead of scrolling to the cursor.
 * Only takes effect when this document has column intervals to avoid changing the native undo behavior of ordinary documents. */
const undoViewportGuard = ViewPlugin.fromClass(
  class {
    update(update: ViewUpdate): void {
      if (!update.docChanged) return;
      const isUndoRedo = update.transactions.some(
        (tr) => tr.isUserEvent('undo') || tr.isUserEvent('redo')
      );
      if (!isUndoRedo) return;
      const view = update.view;
      // No intervention occurs when fields are missing or this document does not have column intervals.
      const state = view.state.field(columnsField, false);
      if (!state || !state.regions.length) return;
      const sd = view.scrollDOM;
      const top = sd.scrollTop;
      if (top <= 0) return; // It's at the top, there's no place to protect it
      const snap = view.scrollSnapshot();
      const restore = (): void => {
        if (!view.dom.isConnected) return;
        try {
          view.dispatch({ effects: snap });
        } catch {
          /* View has been destroyed */
        }
      };
      // Microtask: dispatched before CM6 measurement (apply original undo scroll target), preempt scrollTarget
      queueMicrotask(restore);
      // Next frame: Asynchronous scrolling that occurs only after pocket measurement
      window.requestAnimationFrame(() => {
        if (Math.abs(sd.scrollTop - top) > 1) restore();
      });
    }
  }
);

export function columnsExtension(ctx: BlockEditorPlugin): Extension {
  sharedCtx = ctx;
  // Highest priority: overrides Obsidian native callout render block decorations
  return Prec.highest([columnsField, columnsInteractions, undoViewportGuard]);
}

/** Let all editors immediately recalculate column decorations after setting the switch (no need to reload the plug-in) */
export function recomputeColumnsEditors(app: App): void {
  app.workspace.iterateAllLeaves((leaf) => {
    const mv = leaf.view as { editor?: unknown } | null;
    const cm = mv?.editor ? getCM(mv.editor as never) : null;
    if (!cm) return;
    try {
      (cm as unknown as EditorView).dispatch({ effects: forceRecompute.of(null) });
    } catch {
      /* View has been destroyed */
    }
  });
}
