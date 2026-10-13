import { TEXT } from './strings';
import { Decoration, EditorView } from '@codemirror/view';
import type { DecorationSet } from '@codemirror/view';
import { Prec, StateField } from '@codemirror/state';
import type { Extension, Range, Text as EditorText } from '@codemirror/state';
import type BlockEditorPlugin from './main';
// Reuse the same set of double-value structures for column backgrounds: only light colors automatically derive dark colors, and can be explicitly overridden
import { normalizeColBg, pickContrastText } from './col-bg';
import type { ColBg } from './col-bg';
import { safeDecoCompute } from './cm6-deco-guard';

/**
 * Block color marking syntax (written at the beginning and end of the block):
 * - Old syntax `%% block-color:<light> %%`: light only, dark theme by
 * col-bg's deriveDarkColor automatically derives (hex light color) or falls back to light color (named color);
 * - New syntax `%% block-color:<light>|<dark> %%`: vertical bar separation, dark is the dark theme
 * Explicit override, default/automatic derivation according to old syntax when illegal. */
export const BLOCK_COLOR_RE = /%%\s*block-color:\s*([^%]+?)\s*%%/;

/**
 * Loose matching: When Obsidian reading mode renders `%%...%%` as an HTML comment node,
 * comment.nodeValue may be `%% block-color:red %%` (delimiter reserved),
 * ` block-color:red ` (delimiters stripped), or asymmetric residue (like `block-color:red%%`).
 * This regular expression is compatible with all the above forms: `block-color` is not required to be preceded by `%%`, and tail residues are allowed.
 * `%%` and whitespace (`(?:%%\s*)?$`) ensure that whitespace boundaries and delimiter stripping do not affect matching. */
const BLOCK_COLOR_COMMENT_RE = /block-color:\s*([^%]+?)\s*(?:%%\s*)?$/;

/**
 * HTML span carrying form: `<span data-block-color="red"></span>` written at the end of the block
 * (Set the entry to write back the product). The attribute value format is consistent with the %% syntax body (`red` / `#f1f3f5` /
 * `#f1f3f5|#2a2a2a`), compatible with attribute order changes and single/double quotes; the write-back product is always closed and empty
 * span, so regular tags are required to be closed to avoid accidentally swallowing unclosed handwritten HTML. */
export const BLOCK_COLOR_SPAN_RE = /<span\b[^>]*\bdata-block-color=["']([^"']+)["'][^>]*>\s*<\/span>/gi;

/** Block color mark preset color palette (color selection floating layer display; coordinated with the column background preset style) */
const BLOCK_COLOR_PALETTE = [
  '#f1f3f5',
  '#ffe8e8',
  '#fff4d6',
  '#d8f3dc',
  '#d0ebff',
  '#ffd6e7',
  '#e5dbff',
  '#e6fcf5',
];

/** Commonly used CSS / Obsidian color name whitelist (dirty values are not written back to the document) */
const NAMED_COLORS = new Set([
  'red', 'blue', 'green', 'yellow', 'orange', 'purple', 'pink', 'gray', 'grey',
  'brown', 'black', 'white', 'cyan', 'teal', 'indigo', 'violet', 'magenta',
  'lime', 'olive', 'navy', 'maroon', 'silver', 'gold', 'coral', 'salmon',
  'tomato', 'khaki', 'beige', 'mint', 'lavender', 'turquoise', 'tan', 'plum',
  'orchid', 'crimson', 'darkred', 'darkblue', 'darkgreen', 'darkorange',
  'darkgray', 'darkgrey', 'lightgray', 'lightgrey', 'lightblue', 'lightgreen',
  'lightyellow', 'lightpink',
]);

/** Verify and normalize colors: support hex (#rgb / #rrggbb / #rrggbbaa) and common color names; if illegal, return null */
export function normalizeBlockColor(raw: string): string | null {
  const v = raw.trim().toLowerCase();
  if (/^#(?:[0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/.test(v)) return v;
  if (NAMED_COLORS.has(v)) return v;
  return null;
}

const HEX_RE = /^#[0-9a-f]{3,8}$/;

/**
 * Parse block color tag value → double value ColBg (reuse col-bg's normalizeColBg):
 * - Old syntax `#f1f3f5`: only light colors, hex automatically derives dark colors by deriveDarkColor;
 * The named color light cannot be deduced by HSL, and dark is set to null (CSS theme scope falls back to light color).
 * - New syntax `#f1f3f5|#2a2a2a`: dark explicit override (only accepts hex, with column bg-dark=
 * consistent); fallback to automatic derivation when dark is default/illegal (including named colors).
 * - Light illegal returns null. */
export function parseBlockColorValue(raw: string): ColBg | null {
  const v = raw.trim();
  if (!v) return null;
  const parts = v.split('|');
  const light = normalizeBlockColor(parts[0] ?? '');
  if (!light) return null;
  const darkRaw = (parts[1] ?? '').trim();
  const dark = darkRaw ? normalizeBlockColor(darkRaw) : null;
  const lightIsHex = HEX_RE.test(light);
  // hex light color: dark is explicitly overwritten by hex, otherwise it is automatically deduced by normalizeColBg
  if (lightIsHex) return normalizeColBg(light, dark);
  // Named color light color: deriveDarkColor only supports hex, dark retains explicit hex, otherwise light color is fallback by CSS
  return dark && HEX_RE.test(dark) ? { light, dark } : { light, dark: null };
}

/**
 * Whether the source text contains block color tags (span carries two forms: `data-block-color=` and stock `%% block-color:`).
 * Note that both forms must be detected at the same time: only checking `block-color:` will miss the span form (use `=` instead of `:`). */
export function hasBlockColorMarker(source: string): boolean {
  BLOCK_COLOR_SPAN_RE.lastIndex = 0;
  const hit = BLOCK_COLOR_SPAN_RE.test(source);
  BLOCK_COLOR_SPAN_RE.lastIndex = 0;
  return hit || BLOCK_COLOR_RE.test(source);
}

/**
 * Get the double value color of the first block color tag in the source text (none/illegal returns null).
 * Used for direct coloring when "the element's own row range contains tags". */
export function firstBlockColor(source: string): ColBg | null {
  BLOCK_COLOR_SPAN_RE.lastIndex = 0;
  const sm = BLOCK_COLOR_SPAN_RE.exec(source);
  BLOCK_COLOR_SPAN_RE.lastIndex = 0;
  const m = sm ?? BLOCK_COLOR_RE.exec(source);
  return m ? parseBlockColorValue(m[1]) : null;
}

/**
 * Write double value color to element inline CSS variable (live preview CM6 decoration and reading mode
 * Common to applyBlockColorToDom; named colors are not calculated as contrasting colors, and CSS falls back to the default text color):
 * - --be-block-color-light / --be-block-color-dark: background color under two themes (without dark
 * When no variable is set, styles.css theme scope falls back to light)
 * - --be-block-color-text-light / --be-block-color-text-dark: under the corresponding theme
 * Text contrast color selected by YIQ (only hex calculation)
 * `--be-block-color` in styles.css defaults to light, and body.theme-dark defaults to dark. */
export function setBlockColorVars(el: HTMLElement, bg: ColBg | null): void {
  const set = (name: string, v: string | null): void => {
    if (v) el.style.setProperty(name, v);
    else el.style.removeProperty(name);
  };
  const light = bg?.light ?? null;
  const dark = bg?.dark ?? null;
  set('--be-block-color-light', light);
  set('--be-block-color-text-light', light && HEX_RE.test(light) ? pickContrastText(light) : null);
  set('--be-block-color-dark', dark);
  set('--be-block-color-text-dark', dark && HEX_RE.test(dark) ? pickContrastText(dark) : null);
}

interface BlockColorState {
  /** Whether the first scan has been completed (the document cannot be obtained in the create phase, and the first transaction must be scanned once) */
  initialized: boolean;
  decorations: DecorationSet;
}

/** Diagnostics for block color CM6 decoration (Command Palette/Regression Script Reading; lastDiagnostics mode for aligned columnsField) */
const blockColorDiagnostics: {
  note: string;
  lastScan: { lines: number; hits: number; skipped: number };
} = { note: '', lastScan: { lines: 0, hits: 0, skipped: 0 } };
export function getBlockColorDiagnostics(): typeof blockColorDiagnostics {
  return { ...blockColorDiagnostics, lastScan: { ...blockColorDiagnostics.lastScan } };
}

/**
 * Fully scanned document generation block color decoration (shared entrance for creation initialization/document change).
 *Two forms:
 * - Stock `%% block-color:<color> %%`: written at the beginning and end of the block;
 * - New `<span data-block-color="..."></span>`: written on the last line of the block (element carrying,
 * Direct coloring in reading mode). The attribute value format is consistent with the %% syntax body (including `light|dark` double value).
 * Defense: from/to are always clamped to 0..doc.length, illegal intervals are skipped and diagnostic logs are recorded.
 * Avoid exception decoration causing CM6 errors to bubble up. */
function computeBlockColorDecorations(doc: EditorText): DecorationSet {
  const ranges: Range<Decoration>[] = [];
  const diag = { lines: doc.length, hits: 0, skipped: 0 };
  const pushColor = (from: number, to: number, raw: string, lineFrom: number): void => {
    // Line boundary clamping: out-of-bounds/illegal interval skipping and recording diagnosis (defense syntax tree/document status abnormality)
    // lineFrom must be a finite value and fall within 0..doc.length (CM6 consumer tip will
    // Line decoration is applied to the line corresponding to doc.lineAt(lineFrom). If it goes out of bounds, lineAt will collapse).
    if (
      !Number.isFinite(from) ||
      !Number.isFinite(to) ||
      !Number.isFinite(lineFrom) ||
      from < 0 ||
      to > doc.length ||
      from > to ||
      lineFrom < 0 ||
      lineFrom > doc.length
    ) {
      diag.skipped++;
      console.warn(LOG_TAG, '[deco-skip]', { from, to, docLen: doc.length, raw });
      return;
    }
    const bg = parseBlockColorValue(raw);
    if (!bg?.light) return;
    diag.hits++;
    // Hide the mark body (%% comments in LP are gray by default, and span tags will display the original text, both of which are invisible)
    ranges.push(Decoration.mark({ attributes: { style: 'display:none' } }).range(from, to));
    // The background color of the entire line (line decoration acts on .cm-line, multiple lines in the block are colored individually, and the vision is consistent)
    // Dual themes: Inline only writes two sets of specific values --be-block-color-light/-dark, and the theme is switched by
    // .cm-line / body.theme-dark .cm-line scope completion for styles.css (with columns
    // The same mode as the background); the dark variable is not set by default (named light color), and CSS falls back to light.
    // CM6 requires that the range of Decoration.line must be a zero-length single point (from === to),
    // Passing (line.from, line.to) a non-zero range will throw "Line decoration ranges must be zero-length".
    const light = bg.light;
    const dark = bg.dark;
    const lightHex = HEX_RE.test(light);
    const style =
      `--be-block-color-light:${light};` +
      (lightHex ? `--be-block-color-text-light:${pickContrastText(light)};` : '') +
      (dark ? `--be-block-color-dark:${dark};` : '') +
      (dark ? `--be-block-color-text-dark:${pickContrastText(dark)};` : '') +
      'background-color:var(--be-block-color);' +
      'color:var(--be-block-color-text);';
    ranges.push(Decoration.line({ attributes: { style } }).range(lineFrom, lineFrom));
  };
  for (let i = 0; i < doc.lines; i++) {
    const line = doc.line(i + 1);
    // Stock %% form (first line and end of block): skip this line span after hit to avoid double decoration in the same block
    const m = BLOCK_COLOR_RE.exec(line.text);
    if (m) {
      const from = line.from + (m.index ?? 0);
      pushColor(from, from + m[0].length, m[1], line.from);
      continue;
    }
    // New span form (last line of block): There can be multiple spans in a line, and they are processed one by one
    BLOCK_COLOR_SPAN_RE.lastIndex = 0;
    for (const sm of line.text.matchAll(BLOCK_COLOR_SPAN_RE)) {
      const idx = sm.index ?? 0;
      pushColor(line.from + idx, line.from + idx + sm[0].length, sm[1], line.from);
    }
  }
  // mark(from,to) and line(from,from) may have the same starting point. RangeSet assumes that the input has been pressed
  // (from, to) sorting, sort first to avoid zero-length line and mark order disorder affecting rendering
  ranges.sort((a, b) => a.from - b.from || a.to - b.to);
  blockColorDiagnostics.lastScan = { lines: diag.lines, hits: diag.hits, skipped: diag.skipped };
  return Decoration.set(ranges, true);
}

/**
 * H5 Live Preview decoration: add background color to rows marked with `%% block-color:<color> %%`,
 * At the same time, use mark decoration to hide the comment body (to avoid gray comment text remaining at the end of the line).
 * Coexisting with the column widget (columnsField): the rows inside the column are not displayed after being replaced by the widget.
 * Source mode/reading mode are covered by postProcessor.
 *
 * Reopening document failure fix: Obsidian may not have loaded the document yet during the StateField.create phase
 * state (create gets an empty document), the old implementation create returns empty decoration and update only
 * Rescan when docChanged - if the first transaction after reopening does not carry docChanged, the decoration will always be empty.
 * The Live Preview is invalid + the gray text of the comment (block-color:xxx) is exposed at the end of the block.
 * Fix: "Uninitialized" or "docChanged" in update are all rescanned (aligned columnsField
 * initialized mode), ensuring that the first transaction under any initialization path completes the decoration calculation. */
export const blockColorField = StateField.define<BlockColorState>({
  create: () => {
    return { initialized: false, decorations: Decoration.none };
  },
  update(value, tr) {
    // Not initialized (the document cannot be obtained during the create phase) or the entire document is rescanned when the document is changed;
    // Remaining transactions (selection/scrolling/configuration) are not rebuilt, avoiding full document scanning on every keystroke
    try {
      if (value.initialized && !tr.docChanged) return value;
      const next: BlockColorState = { initialized: true, decorations: computeBlockColorDecorations(tr.state.doc) };
      return next;
    } catch (e) {
      // CM6 Defense: Scan exceptions do not bubble up (align columnsField's lastDiagnostics mode),
      // Keep old decorations and remember diagnostics to avoid decoration exceptions from bringing down the entire editor
      blockColorDiagnostics.note = e instanceof Error ? e.message : String(e);
      return value;
    }
  },
  provide: (f) =>
    EditorView.decorations.compute(
      [f],
      safeDecoCompute(
        (state) => state.field(f).decorations,
        (msg) => {
          blockColorDiagnostics.note = msg;
        }
      )
    ),
});

export function blockColorExtension(ctx: BlockEditorPlugin): Extension {
  // The same level as columnsExtension has the highest priority to avoid being overwhelmed by native annotation decorations.
  return Prec.highest([blockColorField]);
}

/** Colorable block-level labels in reading mode (stops for text nodes to trace upwards) */
const BLOCK_TAGS = new Set([
  'P', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6',
  'LI', 'BLOCKQUOTE', 'PRE', 'TD', 'TH',
]);

/** Reading mode block color marking link: alarm log prefix (facilitates developer console filtering) */
const LOG_TAG = '[be-block-color]';

/**
 * Reading mode playback: scan the `%% block-color:<color> %%` mark in the rendered DOM,
 * Give the nearest block-level container a background color and remove the mark.
 *
 * Note: Obsidian reading mode will convert `%%...%%` to
 * HTML comment nodes (<!-- ... -->), not text nodes, so TreeWalker must
 * Monitor two node types SHOW_TEXT and SHOW_COMMENT at the same time; comment.nodeValue
 * The `%%` delimiter may be retained or stripped, and both forms must be compatible. */
/**
 * Move the color to the block-level container closest to the target (span element form is shared with text/comment form):
 * Returns whether it is actually applied (false = no block-level container / already done / root non-block tag).
 * The block container guard is consistent with the old logic: allowing root to be directly colored when it is a block label;
 * SetBlockColorVars (write --be-block-color-light/-dark variables) before coloring,
 * Then set the data-block-color attribute, and the background/contrast color is consumed by the styles.css theme scope. */
function applyColorToBlock(
  node: HTMLElement,
  bg: ColBg,
  done: Set<HTMLElement>,
  root: HTMLElement
): boolean {
  // Narrow ColBg.light(string|null): caller has ensured non-null, defend here and let TS narrow
  if (!bg.light) return false;
  let el: HTMLElement | null = node;
  while (el && el !== root && !BLOCK_TAGS.has(el.tagName)) {
    el = el.parentElement;
  }
  if (!el) return false;
  if (done.has(el)) return false;
  if (el === root && !BLOCK_TAGS.has(el.tagName)) return false;
  done.add(el);
  setBlockColorVars(el, bg);
  el.setAttribute('data-block-color', bg.light);
  return true;
}

/**
 * Reading mode playback: three modes coexist and are compatible.
 * 1) New form: `<span data-block-color="..."></span>` element bearer (write-back product at the end of the block),
 * Scan directly by element (querySelectorAll), the attribute value is the color;
 * 2) Stock form: `%% block-color:<color> %%` text node;
 * 3) Stock form variant: Obsidian renders `%%...%%` into HTML comment nodes (<!-- -->).
 * Text/comment form uses TreeWalker(SHOW_TEXT | SHOW_COMMENT) double regular matching;
 * The element form is given priority, and the done collection is deduplicated in the same block. The three forms can coexist without repeated coloring. */
export function applyBlockColorToDom(root: HTMLElement): void {
  const done = new Set<HTMLElement>();

  // 1) New form: Scan [data-block-color] element to carry.
  // The block-level container itself may also have this attribute (coloring result of this function / user handwriting), skipping the block-level
  // Elements only process inline containers to avoid repeatedly processing colored containers as new tags.
  const carriers = Array.from(root.querySelectorAll<HTMLElement>('[data-block-color]'));
  for (const carrier of carriers) {
    if (BLOCK_TAGS.has(carrier.tagName)) continue;
    const raw = carrier.getAttribute('data-block-color') ?? '';
    if (!raw) continue;
    const bg = parseBlockColorValue(raw);
    if (!bg?.light) continue;
    applyColorToBlock(carrier, bg, done, root);
  }

  // 2)+3) Stock form: TreeWalker scans text/annotation nodes.
  const walker = document.createTreeWalker(
    root,
    NodeFilter.SHOW_TEXT | NodeFilter.SHOW_COMMENT
  );
  let node: Node | null;
  while ((node = walker.nextNode())) {
    const isComment = node.nodeType === Node.COMMENT_NODE;
    const raw = isComment ? node.nodeValue ?? '' : node.textContent ?? '';
    if (raw.length < 4) continue;
    // Try two regular expressions respectively (the matching semantics are equivalent to the original `??`)
    const m = BLOCK_COLOR_RE.exec(raw) ?? BLOCK_COLOR_COMMENT_RE.exec(raw);
    if (!m) continue;
    const bg = parseBlockColorValue(m[1]);
    if (!bg?.light) continue;
    const parent = node.parentElement;
    if (parent && applyColorToBlock(parent, bg, done, root)) {
      // The text node needs to be removed to mark the original text; the comment node itself is not visible and does not need to be cleaned.
      if (!isComment) {
        const textNode = node as Text;
        const cleaned = textNode.textContent ?? '';
        textNode.textContent = cleaned.replace(BLOCK_COLOR_RE, '').replace(/[ \t]+$/u, '');
      }
    }
  }
}

/** Block-level candidate for source text-driven playback: add tr based on BLOCK_TAGS (table row mark whole row color). */
export const SOURCE_BLOCK_SELECTOR = 'p, h1, h2, h3, h4, h5, h6, li, blockquote, pre, td, th, tr';

/**
 * Source text line/rendered text → normalized text anchors: remove block prefixes (quote/title/list/taskbox)
 * With inline Markdown syntax (emphasis / inline code / links / table vertical bars), and remove all whitespace,
 * Facilitates "prefix/suffix" comparison with the rendered textContent. Both sides undergo the same normalization,
 * Therefore, these symbols appearing in the text should be consistent and there will be no one-sided mismatch. */
function normalizeAnchor(raw: string): string {
  let s = raw;
  s = s.replace(/^[\s>]+/, '');
  s = s.replace(/^#{1,6}\s*/, '');
  s = s.replace(/^(?:[-*+]|\d+[.)])\s+/, '');
  s = s.replace(/^\[[ xX]?\]\s*/, '');
  s = s.replace(/!?\[\[([^\]|]*)(?:\|([^\]]*))?\]\]/g, (_m: string, a: string, b?: string) => b ?? a);
  s = s.replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1');
  s = s.replace(/[*_~`]/g, '');
  s = s.replace(/==/g, '');
  s = s.replace(/\|/g, '');
  s = s.replace(/\s+/g, '');
  return s;
}

interface SourceColorEntry {
  light: string;
  bg: ColBg;
  /** Normalized line text anchor (empty string = tag occupies one line, matches empty block) */
  anchor: string;
  /** true = %% The stock form is written in the first line of the block (matches the beginning of the block text); false = span is written in the last line of the block (matches the end) */
  atStart: boolean;
}

/**
 * Reading mode "source text driven" playback (Option 1): paragraphs obtained with ctx.getSectionInfo(el)
 * Parse the mark based on the source text, and then click "Text Anchor" to drop the color on the rendered block-level element.
 *
 * Motivation: Obsidian reading mode will use its own Markdown renderer to reconstruct the DOM from the source text, custom
 * data-* vectors and %% comments may be discarded after reconstruction, and applyBlockColorToDom in DOM form will
 * Marks cannot be scanned; the source text is not affected by this process.
 *
 * Matching rules: source text advances monotonically in order of appearance, and rendering blocks advance monotonically in document order; in "continuously adjacent" hits
 * Take the deepest candidate (the ancestor precedes the descendant in document order, the deepest = the nearest block-level container), neither changing the color
 * If you fall into the outer container, you can also skip the unmarked blocks in the middle. Returns the actual color number (for diagnostics/testing). */
export function applyBlockColorFromSource(el: HTMLElement, source: string): number {
  if (!source) return 0;
  const entries: SourceColorEntry[] = [];
  for (const raw of source.split('\n')) {
    // span form (last line of block): there can be multiple in the line
    BLOCK_COLOR_SPAN_RE.lastIndex = 0;
    let hit = false;
    for (const m of raw.matchAll(BLOCK_COLOR_SPAN_RE)) {
      const bg = parseBlockColorValue(m[1]);
      if (!bg?.light) continue;
      entries.push({ light: bg.light, bg, anchor: normalizeAnchor(raw.replace(BLOCK_COLOR_SPAN_RE, '')), atStart: false });
      hit = true;
    }
    if (hit) continue;
    // Stock %% form (first line of block)
    const mm = BLOCK_COLOR_RE.exec(raw);
    if (mm) {
      const bg = parseBlockColorValue(mm[1]);
      if (bg?.light) {
        entries.push({ light: bg.light, bg, anchor: normalizeAnchor(raw.replace(BLOCK_COLOR_RE, '')), atStart: true });
      }
    }
  }
  if (entries.length === 0) return 0;

  const candidates = Array.from(el.querySelectorAll<HTMLElement>(SOURCE_BLOCK_SELECTOR));
  if (el.matches(SOURCE_BLOCK_SELECTOR)) candidates.unshift(el);
  const done = new Set<HTMLElement>();
  let from = 0;
  let applied = 0;
  for (const entry of entries) {
    let best: HTMLElement | null = null;
    let bestLen = Infinity;
    let lastHit = -1;
    let found = false;
    for (let i = from; i < candidates.length; i++) {
      const c = candidates[i];
      if (done.has(c)) {
        // Colored elements: The hit section is considered to be the end, and the missed section is skipped and the search continues.
        if (found) break;
        continue;
      }
      const t = normalizeAnchor(c.textContent ?? '');
      const ok = entry.anchor
        ? entry.atStart
          ? t.startsWith(entry.anchor)
          : t.endsWith(entry.anchor)
        : t === '';
      if (ok) {
        found = true;
        // Take the "deepest" candidate among adjacent hit segments (ancestors precede descendants in document order): li>p, tr>td
        // After nesting, the descendant is the nearest block-level container, which is consistent with the "nearest ancestor" semantics of DOM playback.
        if (t.length <= bestLen) {
          bestLen = t.length;
          best = c;
          lastHit = i;
        }
      } else if (found) {
        break;
      }
    }
    if (!best) continue;
    done.add(best);
    setBlockColorVars(best, entry.bg);
    best.setAttribute('data-block-color', entry.light);
    applied++;
    from = lastHit + 1;
  }
  return applied;
}

/**
 * Color selection floating layer (common to block menu/command panel):
 * Default color palette + native color picker + custom hex + clear; onPick(null) means clear mark. */
export function openBlockColorPicker(opts: {
  x: number;
  y: number;
  current: string | null;
  onPick: (color: string | null) => void;
}): void {
  const { x, y, current, onPick } = opts;
  const picker = createEl('div');
  picker.className = 'block-editor-col-picker';
  picker.style.left = x + 'px';
  picker.style.top = y + 'px';

  const close = (): void => {
    picker.remove();
    window.removeEventListener('mousedown', onDocDown);
  };
  const onDocDown = (ev: MouseEvent): void => {
    if (!picker.contains(ev.target as Node)) close();
  };

  const title = createEl('div');
  title.className = 'block-editor-col-picker-title';
  title.textContent = TEXT.message0001;
  picker.appendChild(title);

  const swatches = createEl('div');
  swatches.className = 'block-editor-col-picker-swatches';
  for (const c of BLOCK_COLOR_PALETTE) {
    const sw = createEl('button');
    sw.className = 'block-editor-col-picker-swatch';
    sw.style.backgroundColor = c;
    sw.title = c;
    sw.addEventListener('click', () => {
      close();
      onPick(c);
    });
    swatches.appendChild(sw);
  }
  picker.appendChild(swatches);

  // Native color picker + hex input (refer to the interactive habits of column background color selection)
  const customRow = createEl('div');
  customRow.className = 'block-editor-col-picker-custom';
  const colorInput = createEl('input');
  colorInput.type = 'color';
  colorInput.className = 'block-editor-col-picker-native';
  colorInput.value = current ?? '#f1f3f5';
  colorInput.title = TEXT.message0002;
  colorInput.addEventListener('input', () => {
    input.value = colorInput.value;
    input.classList.remove('is-invalid');
  });
  colorInput.addEventListener('change', () => {
    close();
    onPick(colorInput.value);
  });

  const hexRow = createEl('div');
  hexRow.className = 'block-editor-col-picker-hex';
  const input = createEl('input');
  input.type = 'text';
  input.placeholder = '#RRGGBB';
  input.value = current ?? '';
  input.spellcheck = false;
  input.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') applyHex();
  });
  const applyBtn = createEl('button');
  applyBtn.className = 'block-editor-col-picker-apply';
  applyBtn.textContent = TEXT.message0003;
  const applyHex = (): void => {
    const v = normalizeBlockColor(input.value);
    if (!v) {
      input.classList.add('is-invalid');
      return;
    }
    close();
    onPick(v);
  };
  applyBtn.addEventListener('click', applyHex);
  hexRow.appendChild(input);
  hexRow.appendChild(applyBtn);
  customRow.appendChild(colorInput);
  customRow.appendChild(hexRow);
  picker.appendChild(customRow);

  const clearBtn = createEl('button');
  clearBtn.className = 'block-editor-col-picker-clear';
  clearBtn.textContent = TEXT.message0004;
  clearBtn.addEventListener('click', () => {
    close();
    onPick(null);
  });
  picker.appendChild(clearBtn);

  document.body.appendChild(picker);
  window.setTimeout(() => window.addEventListener('mousedown', onDocDown, { once: true }), 0);
}
