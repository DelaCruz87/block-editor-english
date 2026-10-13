/* *
 * Ordered list renumbering regression (`renumberOrdered` + `collectLayerStarts` pure function).
 *
 * Background: Live Preview displays numbers in the source code, and block movement moves the entire text → the serial numbers will be messed up after rearrangement.
 * This package locks the semantics of renumbering, focusing on five error-prone points:
 * ① The starting number is taken from the layer snapshot before **transfer**, rather than the old number of the first line of output (otherwise, the entire segment becomes 2/3/4 after 1.A is dragged away);
 * ② The nesting levels are independently numbered;
 * ③ The content of the code fence/formula block embedded in the list item must not be modified;
 * ④ The list in the callout (`> `) does not alias the outside;
 * ⑤ Keep the original first item number (lists starting with 3 will not be pressed to start with 1).
 *
 * Run: node scripts/list-number-spec.mjs */
import { renumberOrdered, collectLayerStarts } from '../temp/verify/list-number.mjs';

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
    `${l}\n       got  ${JSON.stringify(a)}\n       want ${JSON.stringify(b)}`
  );

/* * Simulate an "entire paragraph rewrite": before is the span before moving, and after is the new line after rearrangement */
const move = (before, after) => renumberOrdered(after, { layerStarts: collectLayerStarts(before) }).lines;
/* * Plain text renumbering without snapshot */
const rn = (lines) => renumberOrdered(lines).lines;

console.log("=== 1. Basics: If the serial number is correct, it will not move ===");
{
  eq(rn(['1. \u7532', '2. \u4e59', '3. \u4e19']), ['1. \u7532', '2. \u4e59', '3. \u4e19'], "1/2/3 Leave as is");
  eq(rn(['- \u7532', '- \u4e59']), ['- \u7532', '- \u4e59'], "Unordered lists are not affected");
  eq(renumberOrdered(['1. \u7532', '2. \u4e59']).changed, false, "changed=false when there is no change");
}

console.log("=== 2. Drag and rearrange: the starting number comes from the snapshot before the move ===");
{
  // Drag 3.C to the front: the starting number of the top level in the snapshot is 1 → C1 A2 B3
  eq(
    move(['1. \u7532', '2. \u4e59', '3. \u4e19'], ['3. \u4e19', '1. \u7532', '2. \u4e59']),
    ['1. \u4e19', '2. \u7532', '3. \u4e59'],
    "Drag C to the first position → 1/2/3 consecutive numbers"
  );

  // The key return: drag 1.A away, and the remaining first line is 2.B.
  // If the old number in the first line of the output is used as the anchor point, it will become 2/3/4; the correct answer is to return to the original starting number 1 of the list.
  eq(
    move(['1. \u7532', '2. \u4e59', '3. \u4e19'], ['2. \u4e59', '1. \u7532', '3. \u4e19']),
    ['1. \u4e59', '2. \u7532', '3. \u4e19'],
    "A is dragged to the middle → B returns to No. 1 (not dragged to No. 2)"
  );

  eq(
    move(['1. \u7532', '2. \u4e59', '3. \u4e19'], ['2. \u4e59', '3. \u4e19', '1. \u7532']),
    ['1. \u4e59', '2. \u4e19', '3. \u7532'],
    "A is dragged to the end → B and C are renumbered from 1"
  );
}

console.log("=== 3. Keep the original first item number (not repress from 1) ===");
{
  eq(
    move(['3. \u7532', '4. \u4e59', '5. \u4e19'], ['5. \u4e19', '3. \u7532', '4. \u4e59']),
    ['3. \u4e19', '4. \u7532', '5. \u4e59'],
    "3 The starting list is still 3 starting after rearrangement"
  );
  eq(rn(['5. \u7532', '5. \u4e59']), ['5. \u7532', '6. \u4e59'], "5,5 → 5,6 (not repressed from 1)");
}

console.log("=== 4. The nesting levels are consecutively numbered ===");
{
  eq(
    move(['1. \u7532', '   1. \u5b501', '   2. \u5b502', '2. \u4e59'], ['1. \u7532', '2. \u4e59', '   1. \u5b501', '   2. \u5b502']),
    ['1. \u7532', '2. \u4e59', '   1. \u5b501', '   2. \u5b502'],
    "When the top level is re-arranged, the sub-levels maintain their serial numbers."
  );

  // The sub-level starting number is independently anchored: the sub-level originally starts at 3
  eq(
    move(['1. \u7532', '   3. \u5b501', '   9. \u5b502'], ['1. \u7532', '   9. \u5b502', '   3. \u5b501']),
    ['1. \u7532', '   3. \u5b502', '   4. \u5b501'],
    "Sub-level anchor point 3 → 3,4, regardless of the top-level starting number"
  );

  eq(
    rn(['1. \u7532', '   1. \u5b501', '   5. \u5b502']),
    ['1. \u7532', '   1. \u5b501', '   2. \u5b502'],
    "Sublevels are numbered consecutively from 1"
  );
}

console.log("=== 5. Unordered items/separator switching interrupts the sequence ===");
{
  eq(
    rn(['1. \u7532', '   1. \u5b501', '- \u63d2\u65e0\u5e8f', '2. \u4e59']),
    ['1. \u7532', '   1. \u5b501', '- \u63d2\u65e0\u5e8f', '2. \u4e59'],
    "The child item is followed by an unordered item, and the parent level is still 1,2"
  );

  eq(rn(['1. \u7532', '2) \u4e59', '3) \u4e19']), ['1. \u7532', '2) \u4e59', '3) \u4e19'], "`.` and `)` are two lists");
  eq(rn(['1. \u7532', '1) \u4e59', '1) \u4e19']), ['1. \u7532', '1) \u4e59', '2) \u4e19'], "Reconnect numbers after switching separators");
}

console.log("=== 6. The inside of the fence/formula block is not affected ===");
{
  eq(
    rn(['1. \u7532', '   ```', '   9. \u4ee3\u7801\u91cc\u7684\u5047\u5217\u8868', '   ```', '2. \u4e59']),
    ['1. \u7532', '   ```', '   9. \u4ee3\u7801\u91cc\u7684\u5047\u5217\u8868', '   ```', '2. \u4e59'],
    "List items are embedded in fences: the content remains unchanged, and the parent items behind the fence are still consecutively numbered."
  );

  eq(
    rn(['1. \u7532', '   1. \u5b501', '   ```', '   1. \u4ee3\u7801', '   ```', '   1. \u5b502']),
    ['1. \u7532', '   1. \u5b501', '   ```', '   1. \u4ee3\u7801', '   ```', '   2. \u5b502'],
    "The children of the fence partition are still numbered hierarchically."
  );

  eq(
    rn(['1. \u7532', '   $$', '   5. \u516c\u5f0f\u884c', '   $$', '2. \u4e59']),
    ['1. \u7532', '   $$', '   5. \u516c\u5f0f\u884c', '   $$', '2. \u4e59'],
    "The inside of the formula block does not change"
  );
}

console.log("=== 7. Independent number within callout (reference prefix) ===");
{
  eq(
    rn(['> [!note]', '> 1. \u7532', '> 1. \u4e59', '1. \u4e59\u5916']),
    ['> [!note]', '> 1. \u7532', '> 2. \u4e59', '1. \u4e59\u5916'],
    "The inner list of references is serialized independently, not with the external serial number."
  );

  eq(
    move(['> 1. \u7532', '> 1. \u4e59'], ['> 2. \u4e59', '> 1. \u7532']),
    ['> 1. \u4e59', '> 2. \u7532'],
    "Rearrangement within the reference also returns to the starting number 1"
  );
}

console.log("=== 8. Multiple lists with the same name separated by blank lines/paragraphs ===");
{
  eq(
    rn(['1. \u7532', '', '1. \u4e59', '5. \u4e19']),
    ['1. \u7532', '', '1. \u4e59', '2. \u4e19'],
    "New lists after blank lines start independently from 1"
  );

  // The second list with the same key: the snapshot queue is consumed in document order, each taking its own starting number.
  const before = ['3. \u7532', '4. \u4e59', '', '7. \u4e19', '9. \u4e01'];
  eq(
    move(before, ['4. \u4e59', '3. \u7532', '', '9. \u4e01', '7. \u4e19']),
    ['3. \u4e59', '4. \u7532', '', '7. \u4e01', '8. \u4e19'],
    "Both lists retain their original starting numbers (3 and 7)"
  );
}

console.log("=== 9. Non-list lines (continuation lines/ordinary paragraphs) ===");
{
  eq(
    rn(['1. \u7532', '   \u666e\u901a\u7eed\u884c\u6587\u5b57', '2. \u4e59']),
    ['1. \u7532', '   \u666e\u901a\u7eed\u884c\u6587\u5b57', '2. \u4e59'],
    "Line continuation of list items does not break the hierarchy"
  );

  eq(
    rn(['1. \u7532', '\u666e\u901a\u6bb5\u843d', '9. \u4e19']),
    ['1. \u7532', '\u666e\u901a\u6bb5\u843d', '9. \u4e19'],
    "Top grid ordinary paragraph termination list, C becomes its own anchor point"
  );
}

console.log("=== 10. Boundaries ===");
{
  eq(rn([]), [], "empty array");
  eq(rn(['\u7eaf\u6587\u672c', '\u53e6\u4e00\u884c']), ['\u7eaf\u6587\u672c', '\u53e6\u4e00\u884c'], "Zero changes when no ordered items");
  eq(rn(['9. \u7532', '10. \u4e59']), ['9. \u7532', '10. \u4e59'], "Across 9→10 two digits are normal");
  eq(rn(['99. \u7532', '1. \u4e59']), ['99. \u7532', '100. \u4e59'], "Round two digits to three digits");
  eq(renumberOrdered(['5. \u7532', '5. \u4e59']).changed, true, "changed=true when there is a change");
}

console.log("=== 11. Idempotence and unchanged input parameters ===");
{
  const once = move(['1. \u7532', '2. \u4e59', '3. \u4e19'], ['3. \u4e19', '1. \u7532', '2. \u4e59']);
  eq(renumberOrdered(once).lines, once, "Repeated execution of the correct sequence number does not accumulate offsets");

  const src = ['5. \u7532', '5. \u4e59'];
  const snapshot = src.slice();
  renumberOrdered(src);
  eq(src, snapshot, "Enter the parameter group and keep it as it is.");

  const before = ['1. \u7532', '2. \u4e59'];
  collectLayerStarts(before);
  eq(before, ['1. \u7532', '2. \u4e59'], "collectLayerStarts does not change the input parameters");
}

console.log(`Result:${pass}pass,${fail}failed`);
process.exit(fail ? 1 : 0);
