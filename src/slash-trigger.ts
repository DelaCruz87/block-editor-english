/**
 * Slash command triggers judgment (pure string logic, does not touch DOM / Obsidian, can be asserted offline).
 *
 * Two modes (2026-10-07 user decision: only attachments will be given if the first line is not included):
 * - `block`: All spaces before `/` (beginning of line, indentation, and after list character `- `)--
 * Consistent with old behavior, all entries for "Convert Block Type + Insert Attachment" are given.
 * - `inline`: `/` had actual content before (`text/Figure`, `sdfs /`, `sdfs/`) -
 * **Insert only 4 items for attachments**. Reason: If an entry such as "Convert to title/list" is given when triggering inline,
 * will rewrite the **entire block** where the cursor is located. It is a destructive operation in the middle of the line, so it is not provided.
 *
 * Path exemption (rather leaky residue): `/` is not triggered when the previous character is `:` / `/` / `\`,
 * Block path shapes such as `C:/Users` and `https://x`.
 * Links/inline code/inline math are also not triggered (isBlockedContext). */

/** The previous character of `/` is these → treated as a path rather than a command */
const PATH_PREV = /[:/\\]/;

/**
 * Prefix for block-level triggering: blank, reference character `>`, list character `- * +`, ordered mark `1.` `1)`.
 * If `/` only consists of these (such as the beginning of the line, indentation, and after `- `), it will be regarded as the "content starting point" → full menu. */
const BLOCK_PREFIX = /^(\s|(?:[-*+>]|\d+[.)])\s*)*/;

function countOf(text: string, ch: string): number {
  let n = 0;
  for (let i = 0; i < text.length; i++) if (text[i] === ch) n++;
  return n;
}

/**
 * Whether the text before the cursor is in the context of "commands that should not be played":
 * Unclosed `[[` / `](`, odd number of backticks (inline code), odd number of `$` (inline math). */
export function isBlockedContext(before: string): boolean {
  // Inside the wiki link: ![[assets/p - / in the path is not a command
  if (before.lastIndexOf('[[') > before.lastIndexOf(']]')) return true;
  // Markdown link target internal: [title](assets/p
  const lp = before.lastIndexOf('](');
  if (lp !== -1 && before.indexOf(')', lp) === -1) return true;
  // Inline code (backticks are not closed)
  if (countOf(before, '`') % 2 === 1) return true;
  // Inline math ($ not closed)
  if (countOf(before, '$') % 2 === 1) return true;
  return false;
}

export interface SlashTriggerResult {
  /** The column number where `/` is located (relative to the beginning of the line) */
  ch: number;
  /** The query words entered after `/` */
  query: string;
  /** true = inline trigger (only for inserted classes); false = block level trigger (for all) */
  inline: boolean;
}

/**
 * Determine whether the text before the cursor triggers the slash command.
 * @param before The line where the cursor is, the text before the cursor */
export function slashTrigger(before: string): SlashTriggerResult | null {
  const i = before.lastIndexOf('/');
  if (i === -1) return null;

  const query = before.slice(i + 1);
  // The command word does not contain spaces; the second / indicates that it is a path rather than a command
  if (/[\s/]/.test(query)) return null;

  // `/` was preceded by only whitespace/block markers (start of line, indentation, list character `- ` `1. `, quote `> `)
  // → Block level, give the full amount; there is actual content before it → Inline, give only attachments
  const head = before.slice(0, i).replace(BLOCK_PREFIX, '');
  const inline = head !== '';
  // Path shape exemption: C:/, https://, a\b, etc. Don’t bother.
  if (inline && PATH_PREV.test(before.charAt(i - 1))) return null;

  if (isBlockedContext(before)) return null;
  return { ch: i, query, inline };
}

/** Only insert entries are retained when triggered inline (Item 4 in the attachment) */
export function filterSlashItems<T extends { kind: 'turn' | 'insert' }>(
  items: T[],
  inline: boolean
): T[] {
  return inline ? items.filter((i) => i.kind === 'insert') : items;
}
