/* *
 * Nested list to column regression (`planListColumns` pure function + `buildColumnsMarkdown` product round trip).
 *
 * Background (functional void): "Combine into columns" press **blank line** to segment (`columnsSegmentCount`),
 * There are usually no blank lines between list items → Nested lists could not be divided into columns with one click.
 * This package locks the correctness of segmentation by indentation level, focusing on three error-prone points:
 * ① The relative level of the sub-items must be retained after stripping the common indent;
 * ② When the list item is embedded with a code fence, the indentation in the fence is deeper, and it must not be misjudged as a deeper level and cut into the wrong column;
 * ③ The product must be read back into the same column by `buildColumnsMarkdown` (round-trip consistency).
 *
 * Run: node scripts/columns-list-spec.mjs */
import { planListColumns, buildColumnsMarkdown } from '../temp/verify/convert.mjs';

let pass = 0, fail = 0;
const ok = (c, l) => { if (c) { pass++; console.log(`  PASS ${l}`); } else { fail++; console.log(`  FAIL ${l}`); } };
const eq = (a, b, l) => ok(JSON.stringify(a) === JSON.stringify(b), `${l}\n       got  ${JSON.stringify(a)}\n       want ${JSON.stringify(b)}`);

/* * Split and return the column content array (return [] if unavailable) */
const seg = (src, level = 0) => planListColumns(src, level).segments;

/* * Simulate the readback of parseColumnsRange: extract the contents of each column from the buildColumnsMarkdown product */
function readBack(md) {
  const cols = [];
  let cur = null;
  for (const line of md.split('\n')) {
    if (/^>\s*\[!multi-column/.test(line)) continue;
    if (/^>\s*>\s*\[!col/.test(line)) { cols.push(''); cur = cols.length - 1; continue; }
    if (/^>\s*>\s*\[!colrow/.test(line)) continue;
    if (/^>\s*$/.test(line)) continue;
    const m = line.match(/^>\s*>\s?(.*)$/);
    if (m && cur !== null) cols[cur] += (cols[cur] ? '\n' : '') + m[1];
  }
  return cols;
}

console.log("=== 1. Split by parent (level 0) ===");
{
  eq(seg(['- \u573a\u666f\u4e00', '  - \u63cf\u8ff0 A', '  - \u63cf\u8ff0 B', '- \u573a\u666f\u4e8c', '  - \u63cf\u8ff0 C'], 0),
    ['- \u573a\u666f\u4e00\n  - \u63cf\u8ff0 A\n  - \u63cf\u8ff0 B', '- \u573a\u666f\u4e8c\n  - \u63cf\u8ff0 C'],
    "Two parents each in one column");
}

console.log("=== 2. Retain the relative level after stripping the common indentation ===");
{
  // Overall indentation with 2 spaces
  eq(seg(['  - \u7532', '    - \u5b501', '  - \u4e59', '    - \u5b502'], 0),
    ['- \u7532\n  - \u5b501', '- \u4e59\n  - \u5b502'],
    "The basic indentation is stripped off, and the relative indentation of the subitems is retained.");
}

console.log("=== 3. Three levels of nesting: grandchildren follow their children ===");
{
  eq(seg(['- \u7532', '  - \u5b501', '    - \u5b591', '    - \u5b592', '- \u4e59', '  - \u5b502'], 0),
    ['- \u7532\n  - \u5b501\n    - \u5b591\n    - \u5b592', '- \u4e59\n  - \u5b502'],
    "Deep sub-rows follow their parent items and do not form separate columns");
}

console.log("=== 4. Split by sub-item (level 1): The parent item is moved out of the column as a guide segment ===");
{
  const src = ['- \u4e09\u4e2a\u65b9\u6848', '  - \u65b9\u6848 A', '  - \u65b9\u6848 B', '  - \u65b9\u6848 C'];
  const plan = planListColumns(src, 1);
  // Cutting point = child level (indent 2) → after peeling off 2 cells, the child becomes the top cell of each column
  eq(plan.segments, ['- \u65b9\u6848 A', '- \u65b9\u6848 B', '- \u65b9\u6848 C'], "Each of the three children is in a column (the parent is not in the column)");
  eq(plan.lead, '- \u4e09\u4e2a\u65b9\u6848', "The parent item is returned independently as the leading segment before the column.");
  ok(!plan.segments.some((s) => s.includes('\u4e09\u4e2a\u65b9\u6848')), "The parent never appears in any column");
}

console.log("=== 4b. The complete product of introductory paragraph + column ===");
{
  // Actual user scenario: The parent item is the introduction that governs all child items.
  const src = ['- \u89e3\u8bfb：\u9ed1\u6cfd\u660e\u662f\u4e00\u4f4d\u7528\u5f71\u50cf\u8bf4\u8bdd\u7684\u8bd7\u4eba。', '  - **\u98ce\u6797\u706b\u5c71**：\u519b\u65d7\u8c61\u5f81', '  - \u68a6\u5883\u7684\u9a6c：\u5750\u9a91\u8c61\u5f81'];
  const plan = planListColumns(src, 1);
  const md = [...plan.lead.split('\n'), '', buildColumnsMarkdown(plan.segments)].join('\n');
  ok(md.startsWith('- \u89e3\u8bfb：\u9ed1\u6cfd\u660e\u662f\u4e00\u4f4d\u7528\u5f71\u50cf\u8bf4\u8bdd\u7684\u8bd7\u4eba。\n\n> [!multi-column]'),
    "The product starts with the parent entry paragraph, and is followed by a blank line before the columns.");
  const cols = readBack(buildColumnsMarkdown(plan.segments));
  eq(cols, ['- **\u98ce\u6797\u706b\u5c71**：\u519b\u65d7\u8c61\u5f81', '- \u68a6\u5883\u7684\u9a6c：\u5750\u9a91\u8c61\u5f81'],
    "The content of the two columns only has children, and the parent is not among them.");
  ok(!cols.some((c) => c.includes('\u89e3\u8bfb')), "The parent item is not stuffed into the first column (the core of this fix)");
}

console.log("=== 5. Split by children: multiple parents rejected (semantic ambiguity, no content lost) ===");
{
  const plan = planListColumns(['- \u573a\u666f\u4e00', '  - A', '  - B', '- \u573a\u666f\u4e8c', '  - C'], 1);
  eq(plan.segments, [], "No conversion when there are multiple parents");
  eq(plan.reason, 'multi-parent', "Give multi-parent reasons for menu prompts");
}

console.log("=== 6. Boundary: less than 2 columns ===");
{
  eq(planListColumns(['- \u53ea\u6709\u4e00\u9879'], 0).reason, 'need-two', "single-parent → need-two");
  eq(planListColumns(['\u7eaf\u6bb5\u843d', '\u6ca1\u6709\u5217\u8868'], 0).reason, 'no-list', "no list item → no-list");
  eq(planListColumns([], 0).reason, 'no-list', "empty-array → no-list");
  eq(seg(['- \u7532', '  - \u53ea\u6709\u4e00\u4e2a\u5b50\u9879'], 1), [], "single item → column 0");
  // When there is only one level of list, level=1, there is no shallower level to retreat to, cut point = the shallowest level, and the parent item title is empty.
  eq(seg(['- \u7532', '- \u4e59'], 1), ['- \u7532', '- \u4e59'], "Single-level lists use level=1 to degenerate into parent items.");
}

console.log("=== 7. Natural support for ordered lists (only look at indentation and not symbols) ===");
{
  eq(seg(['1. \u7532', '   1. \u5b501', '2. \u4e59', '   2. \u5b502'], 0),
    ['1. \u7532\n   1. \u5b501', '2. \u4e59\n   2. \u5b502'],
    "Ordered list is split correctly by parent");
}

console.log("=== 8. Fence awareness: the code fence within the item does not participate in the cut point determination ===");
{
  eq(seg(['- \u7532', '  ```js', '      const deepIndent = 1;', '  ```', '- \u4e59', '  - \u5b50'], 0),
    ['- \u7532\n  ```js\n      const deepIndent = 1;\n  ```', '- \u4e59\n  - \u5b50'],
    "The depth and shrinkage of the fence is carried out without accidentally opening a new column, and the content is retained as it is.");
}

console.log("=== 8b. List lines within the fence are not used as cut points ===");
{
  eq(seg(['- \u7532', '  ```', '- \u8fd9\u4e0d\u662f\u5217\u8868\u9879', '  ```', '- \u4e59'], 0),
    ['- \u7532\n  ```\n- \u8fd9\u4e0d\u662f\u5217\u8868\u9879\n  ```', '- \u4e59'],
    "Rows inside the fence that look like list items are not cut out");
}

console.log("=== 9. Non-list continuation lines remain in this column ===");
{
  eq(seg(['- \u7532', '  \u8865\u5145\u8bf4\u660e', '- \u4e59'], 0),
    ['- \u7532\n  \u8865\u5145\u8bf4\u660e', '- \u4e59'],
    "Lines that are indented more deeply but are not list items follow this column");
}

console.log("=== 10. Blank line processing ===");
{
  eq(seg(['- \u7532', '', '  - \u5b50', '- \u4e59'], 0),
    ['- \u7532\n\n  - \u5b50', '- \u4e59'],
    "Blank lines in columns are retained as paragraph breaks");
}

console.log("=== 11. Round trip consistency: Parent mode ===");
{
  const s = seg(['- \u573a\u666f\u4e00', '  - \u63cf\u8ff0 A', '  - \u63cf\u8ff0 B', '- \u573a\u666f\u4e8c', '  - \u63cf\u8ff0 C'], 0);
  const md = buildColumnsMarkdown(s);
  ok(md.startsWith('> [!multi-column]'), "The product is a multi-column shell");
  ok(md.includes('>> [!col]'), "Product contains subcolumn tags");
  eq(readBack(md), s, "The content of the readback column is word-for-word consistent with the segmentation result.");
}

console.log("=== 12. Round trip consistency: child mode ===");
{
  const plan = planListColumns(['- \u4e09\u4e2a\u65b9\u6848', '  - \u65b9\u6848 A', '  - \u65b9\u6848 B', '  - \u65b9\u6848 C'], 1);
  const md = buildColumnsMarkdown(plan.segments);
  eq(readBack(md), plan.segments, "Subkey mode round trip consistency");
  eq(plan.segments.length, 3, "Cut out 3 columns");
}

console.log("=== 13. No boot segment is generated when there is no parent ===");
{
  const plan = planListColumns(['- \u7532', '  - \u5b501', '  - \u5b502'], 1);
  eq(plan.lead, '- \u7532', "The single parent item is still in the lead (no content is lost)");
  eq(plan.segments, ['- \u5b501', '- \u5b502'], "Two columns only have children");

  const p0 = planListColumns(['- \u7532', '- \u4e59'], 0);
  eq(p0.lead, undefined, "Parent mode (level=0) has no boot segment");
}

console.log(`\n[columns-list] ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
