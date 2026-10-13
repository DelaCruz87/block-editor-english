/* *
 * End-to-end verification of ordered list renumbering: directly load the build product main.js,
 * Run real ops.moveRanges / removeRanges / insertLines / with minimal Editor stub
 * duplicateBlock, confirms that the sequence number is indeed corrected in the real call chain (not just correct in pure functions).
 *
 * Run: node scripts/list-number-e2e.mjs */
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import Module from 'node:module';

const require = createRequire(import.meta.url);
const ROOT = path.resolve('.');

// obsidian stub: only empty classes that can be imported / new
const stub = {
  Plugin: class {},
  Menu: class {},
  Notice: class {},
  EditorSuggest: class {},
  PluginSettingTab: class {},
  Setting: class {},
  Modal: class {},
  SuggestModal: class {},
};
const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'obsidian') return stub;
  return origLoad.call(this, request, parent, isMain);
};
// Starting from Node 22, navigator is a read-only getter. Direct assignment will throw a TypeError.
if (!globalThis.navigator || !globalThis.navigator.clipboard) {
  Object.defineProperty(globalThis, 'navigator', {
    value: { clipboard: { writeText: () => Promise.resolve() } },
    configurable: true,
    writable: true,
  });
}

const NewPlugin = require(path.join(ROOT, 'main.js'));
const plugin = new (NewPlugin.default || NewPlugin)();

/* * Minimal Editor pile: row array + interval replacement */
function makeEditor(lines) {
  const doc = { lines: lines.slice() };
  return {
    cm: { state: { doc: {} }, scrollDOM: null },
    lineCount: () => doc.lines.length,
    getLine: (i) => doc.lines[i],
    setLine: (i, t) => (doc.lines[i] = t),
    replaceRange(text, from, to) {
      to = to || from;
      const all = doc.lines;
      let head = '';
      if (from.line > 0) head += all.slice(0, from.line).join('\n') + '\n';
      head += all[from.line].slice(0, from.ch);
      let tail = all[to.line].slice(to.ch);
      if (to.line < all.length - 1) tail += '\n' + all.slice(to.line + 1).join('\n');
      doc.lines = (head + text + tail).split('\n');
    },
    getCursor: () => ({ line: 0, ch: 0 }),
    setCursor: () => {},
    focus: () => {},
    docLines: () => doc.lines.slice(),
  };
}

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
const eq = (a, b, l) => {
  const got = JSON.stringify(a);
  const want = JSON.stringify(b);
  if (got === want) {
    pass++;
    console.log(`  PASS ${l}`);
  } else {
    fail++;
    console.log(`  FAIL ${l}\n       got  ${got}\n       want ${want}`);
  }
};

// selection.actionRanges: e2e only cares about single blocks
plugin.selection = { actionRanges: (b) => [{ start: b.start, end: b.end, type: b.type }] };
plugin.handle = { hideHandle() {} };
// Query the block ID used by duplicateBlock: This use case does not involve block ID and returns null
plugin.ids = { findOwnLineIdLine: () => null };

console.log("=== E2E 1. Drag and drop to rearrange: 3. C Drag to the front ===");
{
  const ed = makeEditor(['1. \u7532', '2. \u4e59', '3. \u4e19']);
  // Source = row 3 (C), drop point = before row 0
  plugin.ops.moveRanges(ed, [{ start: 2, end: 2, type: 'list' }], 0);
  eq(ed.docLines(), ['1. \u4e19', '2. \u7532', '3. \u4e59'], "After C is moved to the first position, 1/2/3 consecutive numbers");
}

console.log("=== E2E 2. Drag and rearrange: 1. Drag A to between B and C ===");
{
  // insertLine=2 → insert before line 2 (B)
  const ed = makeEditor(['1. \u7532', '2. \u4e59', '3. \u4e19']);
  plugin.ops.moveRanges(ed, [{ start: 0, end: 0, type: 'list' }], 2);
  eq(ed.docLines(), ['1. \u4e59', '2. \u7532', '3. \u4e19'], "A inserts in front of B → B 1 A 2 C 3");
}

console.log("=== E2E 2b. Drag to the end (fall after the end of the document) ===");
{
  const ed = makeEditor(['1. \u7532', '2. \u4e59', '3. \u4e19']);
  plugin.ops.moveRanges(ed, [{ start: 0, end: 0, type: 'list' }], 3);
  eq(ed.docLines(), ['1. \u4e59', '2. \u4e19', '3. \u7532'], "A is moved 1/2/3 consecutive numbers after the end");
}

console.log("=== E2E 3. Keep the original first item number (the starting number of 3 is not pressed to 1) ===");
{
  const ed = makeEditor(['3. \u7532', '4. \u4e59', '5. \u4e19']);
  plugin.ops.moveRanges(ed, [{ start: 2, end: 2, type: 'list' }], 0);
  eq(ed.docLines(), ['3. \u4e19', '4. \u7532', '5. \u4e59'], "3 The starting list is still 3 starting after rearrangement");
}

console.log("=== E2E 4. Move up/down (moveBlockVertically) ===");
{
  const ed = makeEditor(['1. \u7532', '2. \u4e59', '3. \u4e19']);
  plugin.ops.moveBlockVertically({ editor: ed, file: null, start: 2, end: 2, type: 'list' }, -1);
  eq(ed.docLines(), ['1. \u7532', '2. \u4e19', '3. \u4e59'], "Move C up one digit and continue with the number");
}
{
  const ed = makeEditor(['1. \u7532', '2. \u4e59', '3. \u4e19']);
  plugin.ops.moveBlockVertically({ editor: ed, file: null, start: 0, end: 0, type: 'list' }, 1);
  eq(ed.docLines(), ['1. \u4e59', '2. \u7532', '3. \u4e19'], "Move the first letter down one digit and continue the number.");
}

console.log("=== E2E 5. The nesting levels are consecutively numbered ===");
{
  // moveRanges only moves lines without changing the indentation (nestCol=null): B is still the top-level item, and sub-levels are not affected.
  const ed = makeEditor(['1. \u7532', '   1. \u5b501', '   2. \u5b502', '2. \u4e59']);
  plugin.ops.moveRanges(ed, [{ start: 3, end: 3, type: 'list' }], 1);
  eq(
    ed.docLines(),
    ['1. \u7532', '2. \u4e59', '   1. \u5b501', '   2. \u5b502'],
    "The top-level serial numbers are rearranged, and the sub-level 1/2 remains unchanged."
  );
}
{
  // The subitem is dragged to the end of the top level: moveRanges does not change the indentation, subitem 1 is still indented by 3 spaces → becomes a subitem of B,
  // The numbers are consecutive (remaining 1.) in the sub-level, and the top-level A/B is not affected by its serial number.
  const ed = makeEditor(['1. \u7532', '   1. \u5b501', '   2. \u5b502', '2. \u4e59']);
  plugin.ops.moveRanges(ed, [{ start: 1, end: 1, type: 'list' }], 4);
  eq(
    ed.docLines(),
    ['1. \u7532', '   1. \u5b502', '2. \u4e59', '   1. \u5b501'],
    "Child 1 remains indented → falls into the sublevel of B and takes number 1"
  );
}

console.log("=== E2E 6. Moving across lists: subsequent items in the target list must be renumbered ===");
{
  const ed = makeEditor(['1. \u7532', '2. \u4e59', '\u6b63\u6587', '1. \u4e19', '2. \u4e01', '3. \u620a']);
  // Drag "2. B" to the end of the target list (before the last line, that is, before line 5)
  plugin.ops.moveRanges(ed, [{ start: 1, end: 1, type: 'list' }], 5);
  eq(
    ed.docLines(),
    ['1. \u7532', '\u6b63\u6587', '1. \u4e19', '2. \u4e01', '3. \u4e59', '4. \u620a'],
    "B inserts the whole number into the target list (span expansion takes effect)"
  );
}

console.log("=== E2E 7. The serial number keeps increasing after deleting the middle item ===");
{
  const ed = makeEditor(['1. \u7532', '2. \u4e59', '3. \u4e19', '4. \u4e01']);
  plugin.ops.removeRanges(ed, [{ start: 1, end: 1, type: 'list' }]);
  eq(ed.docLines(), ['1. \u7532', '2. \u4e19', '3. \u4e01'], "Delete 2. After B, C/D and replace it with 2/3");
}

console.log("=== E2E 8. Multi-segment deletion is still one-step undo ===");
{
  const ed = makeEditor(['1. \u7532', '2. \u4e59', '3. \u4e19', '4. \u4e01', '5. \u620a']);
  plugin.ops.removeRanges(ed, [
    { start: 0, end: 0, type: 'list' },
    { start: 3, end: 3, type: 'list' },
  ]);
  eq(ed.docLines(), ['1. \u4e59', '2. \u4e19', '3. \u620a'], "Delete the first and last two items followed by a consecutive number");
}

console.log("=== E2E 9. Copy (Alt drag/copyRanges) serial number is correct ===");
{
  const ed = makeEditor(['1. \u7532', '2. \u4e59', '3. \u4e19']);
  plugin.ops.copyRanges(ed, [{ start: 0, end: 0, type: 'list' }], 2);
  eq(ed.docLines(), ['1. \u7532', '2. \u4e59', '3. \u7532', '4. \u4e19'], "The copy is inserted between B and C, and the two are postponed");
}

console.log("=== E2E 10. The serial number of the created copy is correct ===");
{
  const ed = makeEditor(['1. \u7532', '2. \u4e59', '3. \u4e19']);
  plugin.ops.duplicateBlock({ editor: ed, file: null, start: 0, end: 0, type: 'list' });
  eq(ed.docLines(), ['1. \u7532', '2. \u7532', '3. \u4e59', '4. \u4e19'], "A's copy gets No. 2, and the original B and C are postponed.");
}

console.log("=== E2E 11. Non-list content is not affected ===");
{
  const ed = makeEditor(['- \u7532', '\u6bb5\u843d', '# \u6807\u9898']);
  plugin.ops.moveRanges(ed, [{ start: 2, end: 2, type: 'heading' }], 0);
  eq(ed.docLines(), ['# \u6807\u9898', '- \u7532', '\u6bb5\u843d'], "Unordered list and paragraph as is");
}

console.log("=== E2E 12. Fake lists within code fences will not be modified ===");
{
  const ed = makeEditor(['1. \u7532', '   ```', '   9. \u4ee3\u7801\u91cc\u7684\u5047\u5217\u8868', '   ```', '2. \u4e59']);
  plugin.ops.moveRanges(ed, [{ start: 4, end: 4, type: 'list' }], 0);
  const got = ed.docLines();
  ok(got.includes('   9. \u4ee3\u7801\u91cc\u7684\u5047\u5217\u8868'), "The contents of the fence remain intact");
  eq(got[0], '1. \u4e59', "After B moves to the first position, take number 1");
  eq(got[1], '2. \u7532', "A was postponed to No. 2, and his fence line was moved accordingly.");
}

console.log("=== E2E 13. Independent numbering of the list in the callout ===");
{
  const ed = makeEditor(['> [!note]', '> 1. \u7532', '> 2. \u4e59', '1. \u4e59\u5916']);
  plugin.ops.moveRanges(ed, [{ start: 2, end: 2, type: 'list' }], 1);
  eq(
    ed.docLines(),
    ['> [!note]', '> 1. \u4e59', '> 2. \u7532', '1. \u4e59\u5916'],
    "The serial numbers are rearranged within the callout, and the external list is not affected."
  );
}

console.log(`Result:${pass}pass,${fail}failed`);
process.exit(fail ? 1 : 0);
