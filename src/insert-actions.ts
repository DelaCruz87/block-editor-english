import { TEXT } from './strings';
/**
 * Pure logic of the slash "insert class" command: date and time formatting, fragment expansion, and enable collection filtering.
 *
 * This module does not import obsidian, does not touch the DOM, and can be used by scripts/insert-actions-spec.mjs
 * Use esbuild to package it separately and assert it in Node. */
import type { InsertActionId, InsertSpec } from './types';

/** Wednesday → Wednesday; dddd uses "Wednesday" */
const WEEKDAYS = [TEXT.message0250, TEXT.message0251, TEXT.message0252, TEXT.message0253, TEXT.message0254, TEXT.message0255, TEXT.message0256];

const pad = (n: number): string => String(n).padStart(2, '0');

/**
 * Format time by token (does not rely on moment, convenient for offline assertion).
 * Support YYYY / YY / MM / DD / HH / mm / ss / ddd / dddd, and leave the remaining characters as they are. */
export function formatDateTime(now: Date, format: string): string {
  const y = now.getFullYear();
  const table: Record<string, string> = {
    YYYY: String(y),
    YY: pad(y % 100),
    MM: pad(now.getMonth() + 1),
    DD: pad(now.getDate()),
    HH: pad(now.getHours()),
    mm: pad(now.getMinutes()),
    ss: pad(now.getSeconds()),
    ddd: WEEKDAYS[now.getDay()].slice(0, 3),
    dddd: WEEKDAYS[now.getDay()],
  };
  // Long tokens must be ranked before short tokens (dddd comes before ddd, YYYY comes before YY), otherwise it will be truncated.
  return format.replace(/YYYY|YY|MM|DD|HH|mm|ss|dddd|ddd/g, (m) => table[m] ?? m);
}

/** Fragment expansion result: text is the inserted text, caret is the offset of the cursor relative to the insertion starting point */
export interface SnippetResult {
  text: string;
  caret: number;
}

const clamp = (n: number, max: number): number => Math.max(0, Math.min(n, max));

/** After inserting the text fragment, the cursor is at the end */
const atEnd = (text: string): SnippetResult => ({ text, caret: text.length });

/**
 * Expand the "static text part" of an insert command.
 * Returning null indicates that the command requires interaction (select files/select notes) and there is no pre-calculated text. */
export function resolveSnippet(
  spec: InsertSpec,
  ctx: { now: Date; dateFormat: string; timeFormat: string }
): SnippetResult | null {
  if (spec.kind === 'snippet') {
    return { text: spec.text, caret: clamp(spec.caret, spec.text.length) };
  }
  if (spec.kind === 'dynamic') {
    if (spec.dyn === 'date') return atEnd(formatDateTime(ctx.now, ctx.dateFormat));
    if (spec.dyn === 'time') return atEnd(formatDateTime(ctx.now, ctx.timeFormat));
    return atEnd(
      formatDateTime(ctx.now, ctx.dateFormat) + ' ' + formatDateTime(ctx.now, ctx.timeFormat)
    );
  }
  return null;
}

/**
 * Insert command that can be turned off separately in the settings → corresponds to the setting field name.
 * Picture/Audio/Video/PDF are the basic disks of the insert class and are not disabled, so they are not included in the table. */
export const INSERT_TOGGLE_KEY: Partial<Record<InsertActionId, string>> = {
  date: 'insDate',
  time: 'insTime',
  datetime: 'insDateTime',
  math: 'insMath',
  inlinecode: 'insInlineCode',
  highlight: 'insHighlight',
  note: 'insNote',
  embednote: 'insEmbedNote',
  blockref: 'insBlockRef',
  blockembed: 'insBlockEmbed',
};

/**
 * Filter out enabled insert commands by setting.
 * @param settings Plug-in settings (any object is enough to avoid this module relying on settings.ts)
 * Missing fields (old version configuration) are considered enabled; only explicit false is removed. */
export function enabledInsertIds(
  ids: readonly InsertActionId[],
  settings: Record<string, unknown> | null | undefined
): InsertActionId[] {
  if (!settings) return [...ids];
  return ids.filter((id) => {
    const key = INSERT_TOGGLE_KEY[id];
    if (!key) return true; // No switch items (media 4 items) are resident
    return settings[key] !== false;
  });
}
