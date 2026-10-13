/* *
 * Scope detection regression for `listColumnRange`.
 *
 * Background (real hidden danger): `actionRanges` only returns the list item where the cursor is located during single selection.
 * `getBlockAtLine` only returns the current item (excluding deeper sub-items) for list items → when the cursor stops on the sub-item
 * The range has only one row, the column cannot be cut, and the menu item will always be grayed out.
 * The responsibility of `listColumnRange` is to include the "entire peer list" in scope.
 *
 * This function is pure geometric logic. It is reproduced and asserted according to its source code rules.
 * Also use source code guards to ensure that the implementation does not degenerate back to actionRanges.
 *
 * Run: node scripts/columns-list-range-spec.mjs */
import { readFileSync } from 'node:fs';

let pass = 0, fail = 0;
const ok = (c, l) => { if (c) { pass++; console.log(`  PASS ${l}`); } else { fail++; console.log(`  FAIL ${l}`); } };
const eq = (a, b, l) => ok(JSON.stringify(a) === JSON.stringify(b), `${l}\n       got  ${JSON.stringify(a)}\n       want ${JSON.stringify(b)}`);

const LIST_ITEM_RE = /^(\s*)(?:[-*+]|\d+[.)])\s+/;
const indentWidth = (l) => (l.match(/^(\s*)/) || ['', ''])[1].length;

/* * Mirror implementation of listColumnRange single-selection branch (multi-selection branch is responsible for selection, not tested here) */
function rangeOf(lines, blockStart, blockEnd) {
  let start = blockStart;
  let base = indentWidth(lines[blockStart]);
  for (let i = blockStart - 1; i >= 0; i--) {
    const line = lines[i];
    const m = LIST_ITEM_RE.exec(line);
    if (m) {
      const ind = m[1].length;
      if (ind < base) { start = i; base = ind; }
      else if (ind === base) { start = i; }
    } else if (line.trim() === '') break;
    else if (indentWidth(line) >= base) continue;
    else break;
  }
  return { start, end: blockEnd };
}

console.log("=== 1. The cursor is on the child: merge upward into the top-level parent ===");
{
  const lines = ['- \u7236\u9879', '  - \u5b50\u9879A', '  - \u5b50\u9879B', '\u6bb5\u843d'];
  eq(rangeOf(lines, 1, 1), { start: 0, end: 1 }, "Merge from children up to top-level parent");
  eq(rangeOf(lines, 2, 2), { start: 0, end: 2 }, "Merges upward from the second child into the top-level parent");
}

console.log("=== 1b. Nested list: The cursor merges into the top level on the grandchild ===");
{
  const lines = ['- L1', '  - L2', '    - L3', '    - L4', '- \u4e0b\u4e00\u4e2a'];
  eq(rangeOf(lines, 2, 2), { start: 0, end: 2 }, "The grandchild item crosses two levels upward and merges into the top-level item");
  eq(rangeOf(lines, 3, 3), { start: 0, end: 3 }, "Another grandchild was also incorporated");
}

console.log("=== 1c. Nested list: cursor on middle item ===");
{
  const lines = ['- L1', '  - L2', '    - L3', '- \u4e0b\u4e00\u4e2a'];
  eq(rangeOf(lines, 1, 1), { start: 0, end: 1 }, "Middle-level items are merged upward into top-level items");
}

console.log("=== 2. The cursor is on the first line of parent: the scope is itself ===");
{
  const lines = ['- \u7532', '  - \u5b50', '- \u4e59', '  - \u5b50'];
  eq(rangeOf(lines, 0, 0), { start: 0, end: 0 }, "The parent itself is not expanded");
}

console.log("=== 3. Go up to the deeper grandson and continue to merge ===");
{
  const lines = ['- \u7236\u9879', '  - \u5b50\u9879', '    - \u5b59\u9879', '- \u4e0b\u4e00\u4e2a\u7236\u9879'];
  eq(rangeOf(lines, 2, 2), { start: 0, end: 2 }, "The grandchildren are still merged into the same parent range upwards");
}
console.log("=== 4. Stop when encountering a blank line ===");
{
  const lines = ['- \u7532', '', '- \u4e59', '  - \u5b50'];
  eq(rangeOf(lines, 2, 3), { start: 2, end: 3 }, "Blank lines are boundaries and should not be crossed");
}

console.log("=== 5. Stop when encountering unindented text ===");
{
  const lines = ['\u6b63\u6587\u6bb5\u843d', '- \u7532', '  - \u5b50'];
  eq(rangeOf(lines, 1, 2), { start: 1, end: 2 }, "Top text is not merged");
}

console.log("=== 6. Same-level items with different indentations will not be merged ===");
{
  const lines = ['  - \u6df1\u7f29\u8fdb\u9879', '- \u9876\u683c\u9879'];
  eq(rangeOf(lines, 1, 1), { start: 1, end: 1 }, "Top cell items do not merge upward into more deeply indented lines");
}

console.log("=== 7. Source code guard: listColumnRange must not fall back to actionRanges ===");
{
  const src = readFileSync('src/convert.ts', 'utf8');
  const m = src.match(/private listColumnRange[\s\S]*?\n  }\n/);
  ok(!!m, "listColumnRange method exists");
  if (m) {
    const body = m[0];
    ok(!body.includes('actionRanges'), "actionRanges is not used (otherwise there is only one item in the range for single selection)");
    ok(body.includes('indentWidth'), "Detect sibling list range by indentation");
  }
  ok(
    /listColumnCount[\s\S]{0,400}listColumnRange/.test(src),
    "listColumnCount uses listColumnRange instead of actionRanges"
  );
  ok(
    /wrapListToColumns[\s\S]{0,900}listColumnRange/.test(src),
    "wrapListToColumns uses listColumnRange instead of actionRanges"
  );
}

console.log(`\n[columns-list-range] ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
