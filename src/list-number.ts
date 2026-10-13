/**
 * Ordered list sequence number renumbering (pure logic, no import obsidian, can be asserted offline)
 *
 * Background: Obsidian’s Live Preview displays the numbers in the source code (reading view/export only in order
 * consecutive numbers), and the movement semantics of blocks is "moving the entire text" - after dragging and rearranging the ordered list, the source code serial number will inevitably be confused.
 * This module changes the serial number back during the same entire segment rewrite during move/copy/delete.
 *
 * Three semantics:
 * 1. **The starting number is taken from the list before moving**: After dragging `1. A` away from `1.A 2.B 3.C`, the remaining first line
 * is `2. B`; if it is used as an anchor point, the entire section will become 2/3/4. The correct result is the starting number from the list **original**
 * 1 Re-number. Therefore, the caller needs to pass in the layer snapshot `collectLayerStarts` before moving.
 * 2. **Level independent**: Each (reference chain + indent + delimiter) combination has its own consecutive number, and the nested sublist is not affected by the parent layer.
 * 3. **Fences/mathematical blocks are not included inside**: The contents of code fences and formula blocks embedded in list items are retained as they are.
 *
 * The same key (reference chain + indent + separator) may appear multiple times in the document (separated by blank lines/text
 * Multiple lists), so the snapshots are stored in a queue in document order and consumed one by one when renumbering. */

/** Ordered list items: row index + original sequence number */
interface OrderedItem {
  index: number;
  num: number;
}

/** A list at the indentation level (the `ul` level is only responsible for interrupting the ordered sequence and does not participate in numbering) */
interface Layer {
  /** Reference chain + indent + separator, the same key level is the same list */
  key: string;
  kind: '.' | ')' | 'ul';
  items: OrderedItem[];
}

export interface RenumberOpts {
  /**
   * Layer snapshot before transfer (product of `collectLayerStarts`). When provided, the starting number of each layer shall be based on it.
   * By default, it degenerates to "get the first line number of this layer in the output", which is suitable for plain text scenarios without transfer semantics. */
  layerStarts?: Map<string, number[]>;
}

export interface RenumberResult {
  lines: string[];
  changed: boolean;
}

/**
 * List mark: must be at the beginning of the line (indentation and quotation prefix are allowed), and the mark must be followed by whitespace.
 * The upper limit of the serial number is 9 digits, consistent with CommonMark; both `1.` / `1)` delimiters are recognized. */
const LIST_RE = /^[\t ]*(?:>[\t ]*)*(?:[-*+]|\d{1,9}[.)])[\t ]+/;
/** The numerical part of the ordered label */
const ORDERED_NUM_RE = /[\t ]*(?:>[\t ]*)*(\d{1,9})[.)][\t ]+/;
/** The delimiter in the list mark (`.` / `)`), unordered items return an empty string - note that only the delimiter is captured, not the serial number. */
const DELIM_RE = /(?:^|[\t >])(?:[-*+]|\d{1,9}([.)]))[\t ]/;

/**
 * Strip out "reference chain + effective indentation".
 *
 * Level comparison must be performed after stripping off the reference prefix: the indentation of `> 1. A` and `1. B` is 0,
 * But they belong to two lists, the inner and outer lists, which are distinguished by key, otherwise there will be aliasing.
 * The space after `>` in the reference chain is counted as indentation - `>   1. A` is the "three-level indentation under the reference". */
function listContext(line: string): { indent: number } {
  const m = line.match(/^([\t ]*)((?:>[\t ]*)*)/);
  const lead = m ? m[1] : '';
  const quotes = m ? m[2] : '';
  return {
    indent: lead.length + quotes.replace(/>/g, '').length,
  };
}

/** List level key of this line: indent + separator (excluding serial numbers, otherwise each line will be a different key) */
function layerKey(line: string): string {
  const ctx = listContext(line);
  const d = line.match(DELIM_RE);
  const delim = d && d[1] ? d[1] : '';
  return `${ctx.indent}|${delim}`;
}

/** The external alias of `layerKey`, used by ops.ts to determine "whether two lines belong to the same list" */
export const layerKeyOf = layerKey;

/** The sequence number of the list item; unordered items return 0 */
function seqOf(line: string): number {
  const m = line.match(ORDERED_NUM_RE);
  return m ? parseInt(m[1], 10) : 0;
}

/** Only replace the serial numbers in the list tags, and keep all indents, reference prefixes, separators, and subsequent whitespace */
function replaceMarkerNum(line: string, n: number): string {
  return line.replace(
    /^([\t ]*(?:>[\t ]*)*)(\d{1,9})([.)])/,
    (_all, pre: string, _num: string, delim: string) => pre + n + delim
  );
}

/**
 * Scan a piece of text and record the starting sequence number queue (document order) of each level key.
 * Call once before moving and pass the result to `renumberOrdered`. */
export function collectLayerStarts(lines: string[]): Map<string, number[]> {
  const starts = new Map<string, number[]>();
  let fence: string | null = null;
  let math = false;
  const seen = new Set<string>();

  for (const line of lines) {
    const fenceMark = line.match(/^\s*(`{3,}|~{3,})/);
    if (fenceMark) {
      const ch = fenceMark[1][0];
      if (fence === null) fence = ch;
      else if (fence === ch) fence = null;
      continue;
    }
    if (fence !== null) continue;
    if (/^\s*\$\$\s*$/.test(line)) {
      math = !math;
      continue;
    }
    if (math) continue;

    if (!LIST_RE.test(line)) {
      // Empty lines/non-list lines in the top grid will truncate all current levels - subsequent entries with the same key will be treated as a new list
      if (line.trim() === '' || listContext(line).indent === 0) seen.clear();
      continue;
    }
    const key = layerKey(line);
    if (seen.has(key)) continue;
    seen.add(key);
    if (!starts.has(key)) starts.set(key, []);
    starts.get(key)!.push(seqOf(line));
  }
  return starts;
}

/**
 * Rearrange the sequence number of the ordered list in a piece of text. Pure function, no changes to input parameters.
 *
 * @param lines The **new** line array produced by rewriting the entire section at once (the result after moving/deleting/copying)
 * @param opts.layerStarts Layer snapshot before transfer, see `collectLayerStarts` */
export function renumberOrdered(
  lines: string[],
  opts: RenumberOpts = {}
): RenumberResult {
  const out = lines.slice();
  const layerStarts = opts.layerStarts;
  /** Which list has been consumed for each key (keys with the same name may have multiple lists, which are taken in document order) */
  const cursor = new Map<string, number>();

  /** The current level is still continuing; empty rows/top grid non-list rows are cleared to indicate the end of the list */
  let active: Layer[] = [];
  const allLayers: Layer[] = [];

  let fence: string | null = null;
  let math = false;

  // ---- The first stage: hierarchical collection of ordered items ----
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Fence code: Switch lines and internal lines are not involved in numbering, nor do they reset the level (fences are often embedded in list items)
    const fenceMark = line.match(/^\s*(`{3,}|~{3,})/);
    if (fenceMark) {
      const ch = fenceMark[1][0];
      if (fence === null) fence = ch;
      else if (fence === ch) fence = null;
      continue;
    }
    if (fence !== null) continue;

    if (/^\s*\$\$\s*$/.test(line)) {
      math = !math;
      continue;
    }
    if (math) continue;

    const m = line.match(LIST_RE);
    if (!m) {
      if (line.trim() === '') {
        active = [];
      } else {
        // Non-list lines: indented deeper than all active levels → treated as continuation lines of list items (levels preserved)
        const ind = listContext(line).indent;
        const shallowest = active.length ? Math.min(...active.map((l) => Number(l.key.split('|')[0]))) : -1;
        if (!(active.length && ind > shallowest)) active = [];
      }
      continue;
    }

    const marker = line.match(DELIM_RE);
    const delim = marker && marker[1] ? marker[1] : '';
    const kind: Layer['kind'] = delim === '' ? 'ul' : delim === ')' ? ')' : '.';
    const key = layerKey(line);

    // Same key and same delimiter → keep the current level (continue the serial number); change to disorder/change delimiter → new list
    let layer = active.find((l) => l.key === key && l.kind === kind) ?? null;
    if (!layer && kind !== 'ul') {
      layer = { key, kind, items: [] };
      allLayers.push(layer);
    }

    // Deeper levels end with this line; old levels with the same key (different delimiters) are also discarded
    const ind = Number(key.split('|')[0]);
    active = active.filter((l) => Number(l.key.split('|')[0]) < ind);
    if (layer) {
      active.push(layer);
      layer.items.push({ index: i, num: seqOf(line) });
    }
  }

  // ----The second stage: determine the starting number and rewrite it ----
  let changed = false;
  for (const layer of allLayers) {
    if (!layer.items.length) continue;
    let start: number;
    if (layerStarts) {
      const queue = layerStarts.get(layer.key);
      const at = cursor.get(layer.key) ?? 0;
      cursor.set(layer.key, at + 1);
      // There is no corresponding list in the snapshot (newly created in this edit) → Return to the first row number
      start = queue && queue.length ? queue[Math.min(at, queue.length - 1)] : layer.items[0].num;
    } else {
      start = layer.items[0].num;
    }
    layer.items.forEach((it, k) => {
      const want = start + k;
      if (it.num === want) return;
      out[it.index] = replaceMarkerNum(lines[it.index], want);
      changed = true;
    });
  }

  return { lines: changed ? out : lines.slice(), changed };
}
