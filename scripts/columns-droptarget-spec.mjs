/* *
 * Offline regression: drop point determination and text transformation for two-way dragging in columns.
 * First run build-droptarget-spec.mjs to generate temp/verify/droptarget.mjs, and then execute this file.
 * Coverage: insert priority between columns, multi-line global subscripts, strip prefixes (including fence/indent regression),
 * Drag out legal landing points, single-step undo (CM6 invert), blank line separation, and downgrade rules. */
import {
  hitColumnsLayout,
  buildColLayout,
  stripQuotePrefixes,
  columnToPlainBlock,
  resolveExtractLine,
  buildExtractInsertText,
  buildCombinedChanges,
  shouldUnwrapAfterExtract,
  COL_GAP_BAND,
} from '../temp/verify/droptarget.mjs';
import { EditorState } from '@codemirror/state';

let pass = 0;
let fail = 0;
function eq(actual, expected, label) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) { pass++; console.log(`  PASS ${label}`); }
  else { fail++; console.log(`  FAIL ${label}\n    got:      ${a}\n    expected: ${e}`); }
}
function ok(cond, label) {
  if (cond) { pass++; console.log(`  PASS ${label}`); }
  else { fail++; console.log(`  FAIL ${label}`); }
}

/* * Create a fake bar DOM (just getBoundingClientRect + identity) */
function fakeCol(left, right) {
  const el = { left, right, top: 100, bottom: 300, getBoundingClientRect: () => ({ left, right, top: 100, bottom: 300, width: right-left, height: 200 }) };
  return el;
}

console.log("=== 1. Hit zone: Inserting bands between columns takes precedence over half zones ===");
{
  // 3 columns, equally divided: 0-300 / 300-600 / 600-900 (resizer accounts for 8px, ignored)
  const cols = [fakeCol(0, 300), fakeCol(300, 600), fakeCol(600, 900)];
  const layout = buildColLayout(cols, []);

  // Center left half of column 1 → before (index 0)
  eq(hitColumnsLayout(layout, 100, 200)?.kind, 'before', "Left half of column 1 → before");
  eq(hitColumnsLayout(layout, 100, 200)?.insertIndex, 0, "Left half of column 1 insertIndex=0");

  // Right half of column 1 → after (index 1)
  eq(hitColumnsLayout(layout, 200, 200)?.kind, 'after', "Right half of column 1 → after");
  eq(hitColumnsLayout(layout, 200, 200)?.insertIndex, 1, "Right half of column 1 insertIndex=1");

  // Left half of column 2 → before (index 1) - the same as insertIndex in the previous article (same semantics)
  eq(hitColumnsLayout(layout, 400, 200)?.insertIndex, 1, "Left half of column 2 insertIndex=1");
  // Right half of column 2 → after (index 2)
  eq(hitColumnsLayout(layout, 500, 200)?.insertIndex, 2, "Right half of column 2 insertIndex=2");

  // Right half of last column → append end of line (index 3)
  eq(hitColumnsLayout(layout, 800, 200)?.insertIndex, 3, "Right half of the last column insertIndex=3 (append at the end of the line)");

  // The middle of the gap between columns (x=300) → gap, index 1; and the priority is higher than the two half areas on both sides
  eq(hitColumnsLayout(layout, 300, 200)?.kind, 'gap', "middle of the column → gap");
  eq(hitColumnsLayout(layout, 300, 200)?.insertIndex, 1, "Center between columns insertIndex=1");

  // The gap ±COL_GAP_BAND is still gap
  eq(hitColumnsLayout(layout, 300 - COL_GAP_BAND + 1, 200)?.kind, 'gap', "The left edge of the gap is still gap");
  eq(hitColumnsLayout(layout, 300 + COL_GAP_BAND - 1, 200)?.kind, 'gap', "The right edge of the gap is still gap");
  // Exceeding the bandwidth → Return to half area for judgment (x=320 falls in the left half of column 2, mid=450)
  eq(hitColumnsLayout(layout, 300 + COL_GAP_BAND + 2, 200)?.kind, 'before', "Return to the left half if the bandwidth is exceeded");
  // Narrowband scenario: When the bandwidth is much smaller than the column width, the left and right sides of the out-of-band must be determined independently.
  eq(hitColumnsLayout(layout, 300 + COL_GAP_BAND + 40, 200)?.kind, 'before', "Outside the band is still to the left before");
  eq(hitColumnsLayout(layout, 600 - COL_GAP_BAND - 40, 200)?.kind, 'after', "The band is still to the right after");
}

console.log("=== 2. The central text area is merged into the right half area (no white space left) ===");
{
  const cols = [fakeCol(0, 400)];
  const layout = buildColLayout(cols, []);
  // Center: x=200 is exactly on the center line, belonging to the right half → after
  eq(hitColumnsLayout(layout, 200, 200)?.kind, 'after', "Center of single column → after (right half)");
  eq(hitColumnsLayout(layout, 199, 200)?.kind, 'before', "1px left of center line → before");
}

console.log("=== 3. Vertical gate: No hits outside the line ===");
{
  const cols = [fakeCol(0, 300), fakeCol(300, 600)];
  const layout = buildColLayout(cols, []);
  eq(hitColumnsLayout(layout, 100, 50), null, "above line → null");
  eq(hitColumnsLayout(layout, 100, 400), null, "row below → null");
}

console.log("=== 4. Multiple rows and columns: Insertion is independent by row, and the global subscript is correct ===");
{
  // First row 2 columns (global 0,1), second row 2 columns (global 2,3)
  const r2a = { left: 0, right: 400, top: 100, bottom: 300, getBoundingClientRect: () => ({ left: 0, right: 400, top: 100, bottom: 300 }) };
  const r2b = { left: 400, right: 800, top: 100, bottom: 300, getBoundingClientRect: () => ({ left: 400, right: 800, top: 100, bottom: 300 }) };
  const r3a = { left: 0, right: 400, top: 320, bottom: 520, getBoundingClientRect: () => ({ left: 0, right: 400, top: 320, bottom: 520 }) };
  const r3b = { left: 400, right: 800, top: 320, bottom: 520, getBoundingClientRect: () => ({ left: 400, right: 800, top: 320, bottom: 520 }) };
  const layout = buildColLayout([r2a, r2b, r3a, r3b], [2, 2]);

  const h1 = hitColumnsLayout(layout, 400, 200);   // First row of gaps
  eq(h1?.kind, 'gap', "gap in the first row");
  eq(h1?.insertIndex, 1, "The first row of gaps insertIndex=1 (global)");

  const h2 = hitColumnsLayout(layout, 400, 400);   // Second row of gaps
  eq(h2?.kind, 'gap', "second row gap gap");
  eq(h2?.insertIndex, 3, "Second line gap insertIndex=3 (global, not 1)");

  const h3 = hitColumnsLayout(layout, 200, 400);   // Second row, right half of column 1
  eq(h3?.insertIndex, 3, "Second row, right half of column 1 insertIndex=3");
}

console.log("=== 5. Strip the reference prefix (requirement A: drag in) ===");
{
  eq(stripQuotePrefixes(['>> plain text']), 'plain text', "strip >> prefix");
  eq(stripQuotePrefixes(['>> - item', '>>   sub']), '- item\n  sub', "Strip list prefixes preserving relative indentation (regression)");
  // Nested callout in the column: `>>>` is a three-layer reference, stripped down to only one layer of bare content (aligned with stripToColLevel)
  eq(stripQuotePrefixes(['>>> [!note]', '>>> inner']), '[!note]\ninner', "Strip all third-level references (enter the bare column when dragging in)");
  eq(stripQuotePrefixes(['>>']), '', "empty content line → empty string");
  // Fence: It must still be correctly identified after stripping the prefix, and the content of the fence is also stripped (isomorphic with scanRegions)
  eq(stripQuotePrefixes(['>> ```js', '>> > not quote', '>> ```']), '```js\n> not quote\n```', "Fence lines and content are stripped of prefixes");
  eq(stripQuotePrefixes(['>> ```js', '>> const a = 1;', '>> ```']), '```js\nconst a = 1;\n```', "JS fence content is not destroyed");
  // Key regression: fences with reference prefixes must be recognized (otherwise [!col] inside the fence will be treated as a new column)
  eq(stripQuotePrefixes(['>> ```', '>> [!col] fake marker', '>> ```']), '```\n[!col] fake marker\n```', "Inside [!col] is text only");

  // The indentation of the three-level list is retained level by level (the core goal of this repair)
  eq(stripQuotePrefixes(['>> - a', '>>   - b', '>>     - c']), '- a\n  - b\n    - c', "The indentation of three-level lists is retained level by level.");
  eq(stripQuotePrefixes(['  indented']), 'indented', "Remove public indentation for unprefixed blocks");
  eq(stripQuotePrefixes(['>> [!note]- folded']), '[!note]- folded', "Collapse callout tag peels off normally");
}

console.log("=== 5b. Convert column to normal block (requirement B: drag out) - no more prefixes allowed ===");
{
  // texts[i] has been stripped to the column level, and the remaining `> ` is the real content in the column (nested callout)
  eq(columnToPlainBlock('> [!note] inner\nmore'), '> [!note] inner\nmore', "Nested callout tags intact (regression)");
  eq(columnToPlainBlock('plain\ntext'), 'plain\ntext', "Normal column as is");
  eq(columnToPlainBlock('trailing\n\n'), 'trailing', "Remove trailing blank lines");
  eq(columnToPlainBlock('\n\nleading'), 'leading', "Go to the first blank line");
}

console.log("=== 6. Legal landing point of requirement B: any row outside the column range ===");
{
  // In the early days, only the immediate up/down movement was allowed, but the actual test was too restrictive (user feedback "cannot drag and drop the position at will") → Relaxed
  eq(resolveExtractLine(5, 12, 0), 0, "Any row above far → legal");
  eq(resolveExtractLine(5, 12, 4), 4, "Immediately uplink → legal");
  eq(resolveExtractLine(5, 12, 13), 13, "Separate empty lines (immediately after columns) → legal");
  eq(resolveExtractLine(5, 12, 30), 30, "Any row far below → legal (the core of free positioning)");
  eq(resolveExtractLine(5, 12, 99), 99, "Append to the end of the article → Legal");
  eq(resolveExtractLine(5, 12, 5), null, "shell line (in range) → illegal");
  eq(resolveExtractLine(5, 12, 8), null, "inside range → illegal");
  eq(resolveExtractLine(5, 12, 12), null, "Last line (within range) → illegal");
  eq(resolveExtractLine(0, 7, -1), null, "Negative line number → illegal");
}

console.log("=== 6b. Free-drop text insertion (automatically fill in blank lines) ===");
{
  const lines = ['A', '', 'B', 'C', ''];
  const R = { start: 1, end: 2, hasBreak: true };
  // Insert before a non-empty line, and the previous neighbor is not empty → add a blank line before and after
  eq(buildExtractInsertText('X', lines, 3, R), '\nX\n\n', "The previous neighbor is not empty + the back neighbor is not empty →\n X");
  // The preceding neighbor is already a blank line → no leading line is added
  eq(buildExtractInsertText('X', lines, 2, R), 'X\n\n', "The preceding neighbor is an empty line → no leader");
  // The following neighbor is a blank line → only one \n is added (the previous neighbor A is not empty, so the leading one still needs to be added)
  eq(buildExtractInsertText('X', lines, 1, R), '\nX\n', "The following neighbor is a blank line → only the tail is padded \\n");
  // First line of document
  eq(buildExtractInsertText('X', lines, 0, R), 'X\n\n', "first line → no leader");
  // Append to the end of the text: the last line is not empty → add two
  eq(buildExtractInsertText('X', ['A', 'B'], 2, R), '\n\nX', "Append to the end of the text (the last line is not empty) → \\n\\n leading");
  // Append to the end of the text: the last line is already a blank line → only add one
  eq(buildExtractInsertText('X', ['A', ''], 2, R), '\nX', "Append to the end of the text (last line is blank) → \\n leading");
  // Empty content → do not insert
  eq(buildExtractInsertText('   ', lines, 3, R), '', "empty content → empty string (no insertion)");
}

console.log("=== 7. Single-step undo: merged changes can be rolled back cleanly ===");
{
  const src = ['p0','','> [!multi-column]','>','>> [!col]','>> left','>','>> [!col]','>> right','','after'].join('\n');
  const st = EditorState.create({ doc: src });
  const L = (n) => st.doc.line(n + 1);
  const from = L(2).from, to = L(10).from;
  const restRegion = ['> [!multi-column]','>','>> [!col]','>> left',''].join('\n') + '\n';

  // Drag out to the bottom: interval rewriting + insert outside the interval
  const changes = buildCombinedChanges(from, to, restRegion, { pos: to, text: 'dragged\n\n' });
  const tr = st.update({ changes });
  const out = tr.state.doc.toString();
  ok(out.includes('>> left\n\ndragged'), "There is a blank line between the dragged text and the column");
  ok(out.includes('dragged\n\nafter'), "There is a blank line between the dragged text and the subsequent block");
  ok(!out.includes('>> right'), "The dragged column has been removed from the column");
  const back = tr.state.update({ changes: tr.changes.invert(st.doc) }).state.doc.toString();
  eq(back === src, true, "invert restores the original text completely");

  // Drag out to the top: the insertion point is at the same position as the starting point of the interval
  const tr2 = st.update({ changes: buildCombinedChanges(from, to, restRegion, { pos: from, text: '\n\nabove\n' }) });
  const back2 = tr2.state.update({ changes: tr2.changes.invert(st.doc) }).state.doc.toString();
  eq(back2 === src, true, "Insert invert above to restore");

  // Requirement A: Add column + delete source block, merge single transactions
  const twoCol = ['p0','src block','','> [!multi-column]','>','>> [!col]','>> L','>','>> [!col]','>> R','','after'].join('\n');
  const st2 = EditorState.create({ doc: twoCol });
  const S = (n) => st2.doc.line(n + 1);
  const st2From = S(3).from, st2To = S(11).from;
  const newRegion = ['> [!multi-column]','>','>> [!col]','>> NEW','>','>> [!col]','>> L','>','>> [!col]','>> R',''].join('\n') + '\n';
  const delFrom = S(1).from, delTo = S(2).from;  // Delete the entire line 'src block'
  const ch3 = [
    { from: st2From, to: st2To, insert: newRegion },
    { from: delFrom, to: delTo, insert: '' },
  ];
  const tr3 = st2.update({ changes: ch3 });
  const out3 = tr3.state.doc.toString();
  ok(out3.includes('>> NEW'), "New column inserted");
  ok(!out3.includes('src block'), "Source block deleted");
  const back3 = tr3.state.update({ changes: tr3.changes.invert(st2.doc) }).state.doc.toString();
  eq(back3 === twoCol, true, "Requirement A invert restoration (including source block recovery)");
}

console.log("=== 8. Blank line separation and degradation rules ===");
{
  // Blank line separation has been uniformly taken care of by buildExtractInsertText (see 6b), only the downgrade rules are left here
  eq(shouldUnwrapAfterExtract(1), true, "1 column left → downgrade cancel column");
  eq(shouldUnwrapAfterExtract(2), false, "2 columns left → keep columns");
  eq(shouldUnwrapAfterExtract(0), true, "0 columns left → downgrade");
}

console.log(`\n${'='.repeat(46)}Pass${pass}/fail${fail}\n${'='.repeat(46)}`);
process.exit(fail ? 1 : 0);
