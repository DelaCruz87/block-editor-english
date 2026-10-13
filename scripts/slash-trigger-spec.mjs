/* *
 * Inline slash commands trigger decision regression.
 *
 * Decision background (user decision, second revision on 2026-10-07):
 * - **Only 4 attachments are given if they are not the first of the line** (`text/Figure`, `sdfs /`, `sdfs/` are all included in the line)
 * - The beginning of the line (including indentation and after the list character `- `) is still the full menu (convert + insert)
 * - Path shape exemption: `/` preceded by `:` / `/` / `\` (C:/, https://) does not trigger
 * - Links / inline code / inline math do not trigger internally
 * History: The first version was implemented by "Trigger only after Chinese + would rather leak". Users actually tested `sdfs /` to pop up the full menu.
 * I thought it was a bug, so I changed it to "Attach all non-line headers".
 *
 * Run: node scripts/build-slash-trigger-spec.mjs && node scripts/slash-trigger-spec.mjs */
import { readFileSync } from 'node:fs';
import { slashTrigger, isBlockedContext, filterSlashItems } from '../temp/verify/slash-trigger.mjs';

let pass = 0, fail = 0;
const ok = (c, l) => { if (c) { pass++; console.log(`  PASS ${l}`); } else { fail++; console.log(`  FAIL ${l}`); } };
const eq = (a, b, l) => ok(JSON.stringify(a) === JSON.stringify(b), `${l}（got ${JSON.stringify(a)}, want ${JSON.stringify(b)}）`);

/* * Trigger result summary: null or {ch, query, inline} */
const t = (s) => slashTrigger(s);

console.log("=== 1. Block-level trigger: / is all blank before (old behavior remains unchanged, full number of entries) ===");
{
  eq(t('/'), { ch: 0, query: '', inline: false }, "Beginning of line / → block");
  eq(t('/\u56fe'), { ch: 0, query: '\u56fe', inline: false }, "start of line/picture → block");
  eq(t('  /img'), { ch: 2, query: 'img', inline: false }, "After indentation /img → block");
  eq(t('- /img'), { ch: 2, query: 'img', inline: false }, "List symbol `- ` followed by /img → block (preserves the in-list conversion workflow)");
  eq(t('1. /img'), { ch: 3, query: 'img', inline: false }, "After the ordered list character `1. ` → block");
  eq(t('> /img'), { ch: 2, query: 'img', inline: false }, "After the quote character `> ` → block");
}

console.log("=== 2. Non-line headers: all within the line (only attachments are given) - the core of this revision ===");
{
  eq(t('\u6587\u5b57/\u56fe'), { ch: 2, query: '\u56fe', inline: true }, "text/image → inline");
  eq(t('sdfs /'), { ch: 5, query: '', inline: true }, "sdfs / (after space) → inline (user screenshot scenario)");
  eq(t('sdfs /'), { ch: 5, query: '', inline: true }, "Empty query words are also played (otherwise the user will think it is not effective)");
  eq(t('sdfs/img'), { ch: 4, query: 'img', inline: true }, "Directly after an English word / → inline");
  eq(t('\u6587\u5b57/img'), { ch: 2, query: 'img', inline: true }, "Chinese + English query → inline");
  eq(t('\u6587\u5b57、/\u56fe'), { ch: 3, query: '\u56fe', inline: true }, "After Chinese punctuation (,) → inline");
  eq(t('2026/\u56fe'), { ch: 4, query: '\u56fe', inline: true }, "After the number → inline (the query words a/b, 1/2 cannot match the entry, and the menu is automatically hidden)");
}

console.log("=== 3. Path form exemption (rather leaky residue) ===");
{
  for (const s of ['C:/Users', 'C:/', 'https://x', 'a\\b']) {
    eq(t(s), null, `${s}→ Not triggered (preceding character: / \\)`);
  }
  eq(t('src/util'), { ch: 3, query: 'util', inline: true }, "src/util still fires but the query term is not matched → menu is hidden (acceptable residue)");
}

console.log("=== 4. Contextual masking: links / inline code / inline math ===");
{
  ok(isBlockedContext('![[assets/p'), true);
  ok(isBlockedContext('\u89c1 [[\u6587\u4ef6\u5939/p'), true);
  ok(isBlockedContext('![[a.png]] \u6587\u5b57/p') === false, "After closed wiki link → not blocked");
  ok(isBlockedContext('[\u6807\u9898](assets/p'), true);
  ok(isBlockedContext('[\u6807\u9898](a.png) \u6587\u5b57/p') === false, "After closed md link → not blocked");
  ok(isBlockedContext('`\u4ee3\u7801/p'), true, '\u884c\u5185\u4ee3\u7801\u672a\u95ed\u5408 → \u5c4f\u853d');
  ok(isBlockedContext('`\u4ee3\u7801` \u540e/p') === false, "Inline code is closed → not blocked");
  ok(isBlockedContext('$x/p'), true, '\u884c\u5185\u6570\u5b66\u672a\u95ed\u5408 → \u5c4f\u853d');
  ok(isBlockedContext('$x$ \u540e/p') === false, "Inline math is closed → not blocked");

  eq(t('![[assets/\u56fe'), null, "/ within a link does not trigger");
  eq(t('[\u6807\u9898](assets/\u56fe'), null, "/ within md link target does not trigger");
  eq(t('`\u4ee3\u7801/\u56fe'), null, "/ within inline code does not trigger");
  eq(t('$x/\u56fe'), null, "/ does not trigger within inline math");
}

console.log("=== 5. Query word form ===");
{
  eq(t('\u6587\u5b57/\u56fe \u7247'), null, "Query words contain spaces → do not trigger (consistent with old S*)");
  eq(t('\u6587\u5b57/\u56fe/\u8868'), { ch: 4, query: '\u8868', inline: true }, "Multiple / takes the last one as the command");
}

console.log("=== 6. Only keep the insertion class in the row (Item 4 in the attachment) ===");
{
  const items = [
    { kind: 'turn', id: 'paragraph' },
    { kind: 'turn', id: 'h1' },
    { kind: 'insert', id: 'image' },
    { kind: 'insert', id: 'audio' },
    { kind: 'insert', id: 'video' },
    { kind: 'insert', id: 'pdf' },
  ];
  eq(filterSlashItems(items, true).map((i) => i.id), ['image', 'audio', 'video', 'pdf'], "inline → Only 4 attachments left");
  eq(filterSlashItems(items, false).length, 6, "block → total 6 items");
  ok(
    filterSlashItems(items, true).every((i) => i.kind === 'insert'),
    "Conversion classes must never appear inline (otherwise the entire block will be rewritten)"
  );
}

console.log("=== 7. Source code guard: onTrigger has been changed to slashTrigger ===");
{
  const src = readFileSync('src/slash-suggest.ts', 'utf8');
  const onTrigger = src.slice(src.indexOf('onTrigger('), src.indexOf('getSuggestions('));
  ok(onTrigger.includes('slashTrigger('), "onTrigger calls slashTrigger");
  ok(!/\(\?:\^|\\s\)\\\/\(\\S\*\)\$/.test(onTrigger), "The old regular expression (?:^|\\s)\\/(\\S*)$ is no longer used");
  ok(onTrigger.includes('slashInlineCommands'), "Inline switch takes effect");
  ok(onTrigger.includes('getFrontmatterEnd'), "frontmatter area excluded");
  ok(onTrigger.includes('findContainerAt'), "Container blocks (code/formula/table) excluded");
  const sel = src.slice(src.indexOf('selectSuggestion('));
  ok(sel.includes('isInlineContext(sugg)'), "selectSuggestion intercepts inline conversion classes");
}

console.log("=== 7b. Regression: Inline determination must not rely on instance fields (real bug: all entries are given inline) ===");
{
  const src = readFileSync('src/slash-suggest.ts', 'utf8');
  const getSug = src.slice(src.indexOf('getSuggestions('), src.indexOf('renderSuggestion('));
  ok(getSug.includes('isInlineContext(context)'), "getSuggestions is recalculated inline each time from the context");
  ok(!/this\.inline/.test(getSug), "getSuggestions does not read the instance field this.inline (otherwise the previous round of dirty values will be read)");
  ok(!/private inline/.test(src), "The inline instance field has been removed");
  ok(src.includes('isInlineContext(sugg:'), "isInlineContext accepts {editor,start,end} context");

  // Behavioral equivalence: For the same piece of text, the recalculation from the context and the determination when triggered must be consistent.
  const line = '\u6587\u5b57/\u56fe';
  const atTrigger = slashTrigger(line);
  const fromContext = slashTrigger(line.slice(0, line.length)); // end.ch = cursor position
  eq(fromContext?.inline, atTrigger?.inline, "The recalculation result of getSuggestions is consistent with the onTrigger judgment.");
  eq(fromContext?.query, atTrigger?.query, "query is also consistent");
}

console.log("=== 8. Main entrance export (parity reuse) + buildSlashItems wiring ===");
{
  const main = readFileSync('src/main.ts', 'utf8');
  ok(main.includes('export { slashTrigger'), "main.ts exports slashTrigger (for parity assertion)");

  // buildSlashItems itself relies on obsidian (EditorSuggest), and you can only check the connection when offline:
  // Default parameter false (old behavior) + hand inline to filterSlashItems
  const src = readFileSync('src/slash-suggest.ts', 'utf8');
  const fn = src.slice(src.indexOf('export function buildSlashItems'), src.indexOf('/** \u659c\u6760「\u63d2\u5165\u7c7b」\u52a8\u4f5c\u6267\u884c\u5668'));
  ok(fn.includes('inline = false'), "buildSlashItems is non-inline by default (parity old assertions are not affected)");
  ok(fn.includes('filterSlashItems(items, inline)'), "buildSlashItems passes inline to filterSlashItems");
  ok(!/if \(!q\) return items;/.test(fn), "No longer directly returns unfiltered items");
}

console.log(`Total:${pass}via /${fail}failed`);
if (fail) process.exit(1);
