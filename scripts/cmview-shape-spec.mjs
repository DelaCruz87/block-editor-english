/* *
 * Runtime shape regression: CMView's dispatch is hung on the view itself, not .view.
 *
 * Background (real bug): commitColumnDrop was written as `cm.view.dispatch(...)`,
 * And getCM(editor) returns EditorView itself (Editor.cm is the view),
 * There is no .view layer of packaging → TypeError when running, and it will crash if you let go after dragging.
 *
 * Why the type check cannot be caught: At that time, the `view` field was added to CMView, the type and incorrect usage
 * Self-consistent → tsc passed. **The type can only verify "the declaration is consistent with the usage", but cannot verify "the declaration is consistent with the runtime". **
 * Therefore, a fake CM object is used here to make runtime assertions, and the source code is statically scanned to see if `.view.dispatch` appears again.
 *
 * Run: node scripts/cmview-shape-spec.mjs */
import { readFileSync, existsSync } from 'node:fs';

let pass = 0;
let fail = 0;
const ok = (c, label) => {
  if (c) { pass++; console.log(`  PASS ${label}`); }
  else { fail++; console.log(`  FAIL ${label}`); }
};

/* * Same signature as keepViewport (accept { scrollDOM } in util.ts) */
const keepViewport = (cm, fn) => {
  const sd = cm?.scrollDOM;
  if (!sd) { fn(); return; }
  const top = sd.scrollTop;
  fn();
  if (sd.scrollTop !== top) sd.scrollTop = top;
};

console.log("=== 1. Fake CM object: dispatch in the view itself ===");
{
  // Simulate Obsidian: editor.cm i.e. EditorView
  let dispatched = null;
  const editor = {
    cm: {
      dom: { getBoundingClientRect: () => ({ top: 0, left: 0, right: 100, bottom: 100 }) },
      scrollDOM: { scrollTop: 42 },
      contentDOM: { getBoundingClientRect: () => ({ left: 0, width: 500 }) },
      state: { doc: { lines: 3, line: (n) => ({ from: 0, to: 0, number: n }) } },
      dispatch(spec) { dispatched = spec; },
      posAtCoords: () => 0,
      coordsAtPos: () => ({ top: 0, bottom: 10, left: 0, right: 100 }),
      hasFocus: () => true,
    },
  };

  // The actual calling form of commitColumnDrop
  const cm = editor.cm;
  let threw = null;
  try {
    keepViewport(cm, () => {
      cm.dispatch({ changes: [{ from: 0, to: 1, insert: 'x' }] });
    });
  } catch (e) {
    threw = e;
  }
  ok(threw === null, `cm.dispatch does not throw an error when called normally (actual error:${threw && threw.message}）`);
  ok(dispatched !== null, "dispatch is indeed called");
  ok(Array.isArray(dispatched?.changes), "The changes array is passed in as is");
  ok(cm.scrollDOM.scrollTop === 42, "keepViewport keeps scrollTop unchanged");
}

console.log("=== 2. Counterexample: written cm.view.dispatch must fail (prove the assertion is valid) ===");
{
  const cm = { view: undefined, dispatch: () => {} };
  let threw = null;
  try {
    keepViewport(cm, () => {
      cm.view.dispatch({ changes: [] });
    });
  } catch (e) {
    threw = e;
  }
  ok(threw !== null, "cm.view.dispatch does throw TypeError (consistent with online error reporting)");
  ok(/dispatch/.test(threw?.message ?? ''), `The error message points to dispatch:${threw?.message}`);
}

console.log("=== 3. Static scanning: .view.dispatch must not appear in the source code ===");
{
  const files = ['src/drag.ts', 'src/columns-preview.ts', 'src/ops.ts', 'src/util.ts', 'src/types.ts'];
  let bad = [];
  for (const f of files) {
    if (!existsSync(f)) continue;
    const src = readFileSync(f, 'utf8');
    // Remove the comment line and scan again to avoid misjudgment when mentioning this writing method in the document.
    const code = src.split('\n').filter((l) => !l.trim().startsWith('*') && !l.trim().startsWith('//')).join('\n');
    if (/\.view\.dispatch\(/.test(code)) bad.push(f);
  }
  ok(bad.length === 0, `No .view.dispatch calls${bad.length ? "(Hit:" + bad.join(', ') + '）' : ''}`);
}

console.log("=== 4. The CMView declaration must not contain the view field ===");
{
  const types = readFileSync('src/types.ts', 'utf8');
  // Extract the interface body according to curly brace balancing: the interface contains inline object types such as `{ changes: unknown }`,
  // Direct indexOf('}') will be truncated early by the curly braces of the inline type.
  const start = types.indexOf('export interface CMView');
  let depth = 0;
  let body = '';
  for (let i = types.indexOf('{', start); i < types.length; i++) {
    const ch = types[i];
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) { body = types.slice(types.indexOf('{', start), i + 1); break; }
    }
  }
  ok(body.length > 0, "Successfully extracted CMView interface body");
  ok(!/^\s*view[?]?\s*:/m.test(body), "There is no view field in the CMView interface");
  ok(/^\s*dispatch\s*\(/m.test(body), "There is a dispatch method in the CMView interface");
}

console.log(`\n${'='.repeat(46)}Pass${pass}/fail${fail}\n${'='.repeat(46)}`);
process.exit(fail ? 1 : 0);
