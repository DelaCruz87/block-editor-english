/* *
 * Regression assertion for slash "insert class" command expansion (pure logic, no Obsidian environment required).
 *
 * Cover the user's decision-making:
 * - Command collection: date / time / date time / inline formula / inline code / highlight / note link /
 * Embed notes/block quotes/embed blocks (**not included** clipboard paste pictures)
 * - The cursor is centered: $ $, ` `, == == The cursor stops in the middle after inserting
 * - Switch items one by one in settings (media 4 items are permanent and cannot be turned off)
 *
 * Run: node scripts/build-insert-actions-spec.mjs && node scripts/insert-actions-spec.mjs */
import { readFileSync } from 'node:fs';
import {
  formatDateTime,
  resolveSnippet,
  enabledInsertIds,
  INSERT_TOGGLE_KEY,
} from '../temp/verify/insert-actions.mjs';
import { INSERT_ACTIONS, INSERT_SPECS } from '../temp/verify/constants.mjs';

let pass = 0,
  fail = 0;
const ok = (c, l) => {
  if (c) {
    pass++;
    console.log(`  PASS ${l}`);
  } else {
    fail++;
    console.log(`  FAIL ${l}`);
  }
};
const eq = (a, b, l) =>
  ok(
    JSON.stringify(a) === JSON.stringify(b),
    `${l}（got ${JSON.stringify(a)}, want ${JSON.stringify(b)}）`
  );

/* * Fixed time: 2026-10-07 09:05:03, to avoid assertions relying on runtime */
const NOW = new Date(2026, 9, 7, 9, 5, 3);
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const WD = WEEKDAYS[NOW.getDay()].slice(0, 3);
const WD_FULL = WEEKDAYS[NOW.getDay()];
const CTX = { now: NOW, dateFormat: 'YYYY-MM-DD', timeFormat: 'HH:mm' };

console.log("=== 1. formatDateTime: token replacement ===");
{
  eq(formatDateTime(NOW, 'YYYY-MM-DD'), '2026-10-07', "Default date format");
  eq(formatDateTime(NOW, 'HH:mm'), '09:05', "Default time format (zero padding)");
  eq(formatDateTime(NOW, 'HH:mm:ss'), '09:05:03', "seconds");
  eq(formatDateTime(NOW, 'YYYY-MM-DD dddd'), `2026-10-07 ${WD_FULL}`, "dddd full name of week");
  eq(formatDateTime(NOW, 'YYYY/MM/DD ddd'), `2026/10/07 ${WD}`, "ddd week abbreviation");
  eq(formatDateTime(NOW, 'YYYY\u5e74MM\u6708DD\u65e5'), '2026\u5e7410\u670807\u65e5', "Chinese characters are retained as they are");
  eq(formatDateTime(NOW, 'YY-MM'), '26-10', "YY two years");
  eq(formatDateTime(NOW, ''), '', "empty format string → empty result");
  // Counterexample guard: If the short token is replaced first, the long token will be truncated (dddd → ddd + d)
  ok(formatDateTime(NOW, 'dddd') === WD_FULL, "dddd is not truncated by ddd");
  ok(formatDateTime(NOW, 'YYYY') === '2026', "YYYY is not truncated by YY");
}

console.log("=== 2. resolveSnippet: Static snippet centered with cursor ===");
{
  eq(resolveSnippet({ kind: 'snippet', text: '$$', caret: 1 }, CTX), { text: '$$', caret: 1 }, "Inline formula: cursor between two $");
  eq(
    resolveSnippet({ kind: 'snippet', text: '``', caret: 1 }, CTX),
    { text: '``', caret: 1 },
    "Inline code: cursor between two backticks"
  );
  eq(
    resolveSnippet({ kind: 'snippet', text: '====', caret: 2 }, CTX),
    { text: '====', caret: 2 },
    "Highlight: The cursor is in the middle of ==|=="
  );
  // Guard: caret cross-border must be clamped, otherwise editor.setCursor will fall outside the text
  eq(resolveSnippet({ kind: 'snippet', text: '$$', caret: 99 }, CTX), { text: '$$', caret: 2 }, "caret cross the line → clamp to the end");
  eq(resolveSnippet({ kind: 'snippet', text: '$$', caret: -3 }, CTX), { text: '$$', caret: 0 }, "caret negative → clamp to 0");
}

console.log("=== 3. resolveSnippet: date and time dynamic snippet ===");
{
  eq(resolveSnippet({ kind: 'dynamic', dyn: 'date' }, CTX), { text: '2026-10-07', caret: 10 }, "Date: cursor at end");
  eq(resolveSnippet({ kind: 'dynamic', dyn: 'time' }, CTX), { text: '09:05', caret: 5 }, "Time: Cursor is at the end");
  eq(
    resolveSnippet({ kind: 'dynamic', dyn: 'datetime' }, CTX),
    { text: '2026-10-07 09:05', caret: 16 },
    "Date and time: date + space + time"
  );
  const c2 = { now: NOW, dateFormat: 'YYYY/MM/DD', timeFormat: 'HH:mm:ss' };
  eq(resolveSnippet({ kind: 'dynamic', dyn: 'datetime' }, c2), { text: '2026/10/07 09:05:03', caret: 19 }, "Custom format takes effect");
}

console.log("=== 4. resolveSnippet: Commands that require interaction do not have static text ===");
{
  eq(resolveSnippet({ kind: 'pick', exts: ['png'] }, CTX), null, "pick (select media) → null");
  eq(resolveSnippet({ kind: 'note', embed: false }, CTX), null, "note (select note) → null");
  eq(resolveSnippet({ kind: 'blockref', embed: true }, CTX), null, "blockref (select block) → null");
}

console.log("=== 5. enabledInsertIds: item-by-item switch in settings ===");
{
  const ids = INSERT_ACTIONS.map(([id]) => id);
  eq(enabledInsertIds(ids, null).length, ids.length, "settings missing → all enabled");
  eq(enabledInsertIds(ids, {}).length, ids.length, "Empty object (old configuration) → Enable all");
  const off = enabledInsertIds(ids, { insMath: false, insNote: false });
  ok(!off.includes('math'), "Turn off inline formulas → Eliminate");
  ok(!off.includes('note'), "Close note link → Delete");
  ok(off.includes('embednote'), "Similar commands that are not closed are retained.");
  // Media item 4 is a plug-in basic disk, there is no switch, everything must be transferred to
  const all = enabledInsertIds(ids, { insImage: false, insAudio: false });
  for (const m of ['image', 'audio', 'video', 'pdf']) {
    ok(all.includes(m), `media${m}Resident (not affected by any switch)`);
  }
  ok(Object.values(INSERT_TOGGLE_KEY).every((k) => typeof k === 'string'), "Each command that can be turned off has a corresponding setting key");
}

console.log("=== 6. One-to-one correspondence between INSERT_SPECS and INSERT_ACTIONS ===");
{
  const actionIds = INSERT_ACTIONS.map(([id]) => id);
  const specIds = Object.keys(INSERT_SPECS);
  eq([...specIds].sort(), [...actionIds].sort(), "The key of the specification table is exactly the same as that of the command table.");
  for (const [id] of INSERT_ACTIONS) {
    ok(INSERT_SPECS[id] !== undefined, `${id}There are execution specifications`);
  }
}

console.log("=== 7. Command scope: excluding clipboard pasting pictures ===");
{
  ok(!actionIdsHas('paste'), "No paste command (explicitly deleted by user)");
  function actionIdsHas(x) {
    return INSERT_ACTIONS.some(([id]) => id === x) || Object.prototype.hasOwnProperty.call(INSERT_SPECS, x);
  }
  const src = readFileSync('src/slash-suggest.ts', 'utf8');
  ok(!src.includes('clipboard'), "slash-suggest.ts no longer references the clipboard");
  ok(!src.includes('createBinary'), "slash-suggest.ts no longer writes binary attachments");
}

console.log("=== 8. Source Guard: Filter before sorting + 3-column grid ===");
{
  const src = readFileSync('src/slash-suggest.ts', 'utf8');
  // Previous bug: Empty query returns filtered pool, but non-empty query is sorted from unfiltered items →
  // As long as the query word is entered in the row, the conversion entry will be leaked.
  ok(src.includes('return pool\n    .map('), "Non-empty queries are also sorted from the filtered pool");
  ok(!src.includes('return items\n    .map('), "There is no old way of writing \"sort by unfiltered items\"");
  ok(src.includes('block-editor-slash-grid'), "renderSuggestion gives the container a grid class");
  const css = readFileSync('styles.css', 'utf8');
  ok(css.includes('grid-template-columns: repeat(3'), "Grid is 3 columns");
  ok(css.includes('display: grid !important'), "Override the default display of the Obsidian container");
}

console.log("=== 9. Implementation of setting items ===");
{
  const s = readFileSync('src/settings.ts', 'utf8');
  for (const key of [
    'insDate',
    'insTime',
    'insDateTime',
    'insMath',
    'insInlineCode',
    'insHighlight',
    'insNote',
    'insEmbedNote',
    'insBlockRef',
    'insBlockEmbed',
  ]) {
    ok(s.includes(`${key}: true`), `Enabled by default${key}`);
    ok(s.includes(`key: '${key}'`), `The settings page has${key}switch`);
  }
  ok(s.includes('dateFormat'), "Have date format settings");
  ok(s.includes('timeFormat'), "Have time format settings");
}

console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILED'} - pass=${pass} fail=${fail}`);
process.exit(fail === 0 ? 0 : 1);
