/* *
 * Controller horizontal positioning (avoid fold icon) returns.
 *
 * Background (real bug): Under real-time preview, Obsidian draws the folding icon of the list/title on the left side of the line
 * In the blank space, the old logic of the handle is fixed at "size+6px on the left side of the line", and both fall on the same blank space →
 * There is visual overlap, and the folding point cannot be found after pressing the icon with the handle.
 *
 * Fix: Paste "left edge of folded icon - gap" on the right edge of the handle; when there is not enough space on the left side, compress the handle instead of pressing the icon back.
 *
 * Run: node scripts/build-handle-layout-spec.mjs && node scripts/handle-layout-spec.mjs */
import { computeHandleLeft, isDodgeableFold, HANDLE_GAP, HANDLE_INSET, HANDLE_MIN_SIZE } from '../temp/verify/handle-layout.mjs';

let pass = 0, fail = 0;
const ok = (c, l) => { if (c) { pass++; console.log(`  PASS ${l}`); } else { fail++; console.log(`  FAIL ${l}`); } };
const eq = (a, b, l) => ok(Object.is(a, b), `${l}（got ${JSON.stringify(a)}, want ${JSON.stringify(b)}）`);

/* * Typical geometry: editor left edge 0, start of line x=320 (including file margin 32 + content), handle 20 */
const base = { lineLeft: 320, editorLeft: 0, editorWidth: 800, handleSize: 20 };
/* * Folding icon: Draw 20px left of the beginning of the line (width ~16), that is, x=300 */
const FOLD = 300;

console.log("=== 1. Return of old behavior: no folding icon ===");
{
  const r = computeHandleLeft({ ...base, foldLeft: null });
  eq(r.left, 320 - HANDLE_GAP - 20, "No icon → Controller sticker on the left side of the line (gap 6 + size 20)");
  eq(r.size, 20, "No icon → no compression");
  ok(!r.squeezed, "No icon → not marked squeezed");
}

console.log("=== 2. There is a folded icon: it must be moved to the left side of the icon (core repair) ===");
{
  const r = computeHandleLeft({ ...base, foldLeft: FOLD });
  eq(r.left + r.size, FOLD - HANDLE_GAP, "Right edge of handle = left edge of icon - gap (no longer pressing the icon)");
  ok(r.left + r.size <= FOLD - HANDLE_GAP + 0.5, "The handle has zero overlap with the icon");
  eq(r.size, 20, "Sufficient white space → maintain original size");
  ok(!r.squeezed, "Sufficient white space → do not mark squeezed");
}

console.log("=== 3. Invalid measurements must be ignored (to prevent the handle from flying around) ===");
{
  ok(!isDodgeableFold(null, 320, 0), "null → do not give way");
  ok(!isDodgeableFold(0, 320, 0), "rect all 0 (display:none icon) → no avoidance");
  ok(!isDodgeableFold(-5, 320, 0), "The left edge of the icon is outside the editor → no avoidance");
  ok(!isDodgeableFold(400, 320, 0), "The icon is on the right side of the beginning of the line (the wrong element is measured) → no avoidance");
  ok(!isDodgeableFold(Number.NaN, 320, 0), "NaN → do not avoid");
  ok(isDodgeableFold(FOLD, 320, 0), "Normal icon (left side of the line, in the editor) → avoid");

  // Regression: If the hidden icon is regarded as a valid measurement, the handle will be attached to the left edge of the editor (old bug form)
  const bad = computeHandleLeft({ ...base, foldLeft: 0 });
  eq(bad.left, 320 - HANDLE_GAP - 20, "Icons with all rect 0s are ignored → return to the left of the beginning of the line");
}

console.log("=== 4. Insufficient white space: compress the handle instead of pressing back the icon ===");
{
  // Editor left margin 276 (file margin 24), icon x=300 → only 24px available on the left side of the icon
  const r = computeHandleLeft({ lineLeft: 320, foldLeft: FOLD, editorLeft: 276, editorWidth: 800, handleSize: 20 });
  ok(r.size < 20, `Insufficient white space → Compression handle (size=${r.size}）`);
  ok(r.size >= HANDLE_MIN_SIZE, `Compress no less than minimum side length${HANDLE_MIN_SIZE}`);
  ok(r.left >= HANDLE_INSET, "Does not exceed the left edge of the editor after compression");
  ok(r.left + r.size <= FOLD - 276 + 0.5, "Still overlaps zero of the icon after compression (left edge of the icon - editorLeft)");
  ok(r.squeezed, "squeeze → mark squeezed (caller downgrades accordingly)");
}

console.log("=== 5. Can’t even fit in the minimum size: clamp + report truthfully ===");
{
  // Icon hugs the left edge of the editor: available width on the left is 4px
  const r = computeHandleLeft({ lineLeft: 320, foldLeft: 300, editorLeft: 296, editorWidth: 800, handleSize: 20 });
  eq(r.size, HANDLE_MIN_SIZE, "Can’t fit → take the smallest side length");
  eq(r.left, HANDLE_INSET, "Clamp to minimum white space");
  ok(r.squeezed, "still overlap → squeezed = true (do not pretend success)");
}

console.log("=== 6. Right border clamping: the beginning of the line runs outside the editor (extremely narrow panel/long line horizontal scrolling) ===");
{
  // The beginning of the line x=780 is already outside the 720-wide editor: without clamping, the handle will be completely cropped by overflow:hidden
  const r = computeHandleLeft({ lineLeft: 780, foldLeft: null, editorLeft: 0, editorWidth: 720, handleSize: 20 });
  eq(r.left, 720 - HANDLE_INSET - 20, "Clamp to the blank space on the right");
  ok(r.left + r.size <= 720 - HANDLE_INSET + 0.5, "The right edge of the handle does not exceed the right edge of the editor");

  // The beginning of the line is still in the editor: no need to clamp, stick to the left side of the beginning of the line as it is
  const inBounds = computeHandleLeft({ lineLeft: 700, foldLeft: null, editorLeft: 0, editorWidth: 720, handleSize: 20 });
  eq(inBounds.left, 700 - HANDLE_GAP - 20, "The beginning of the line is in the editor → does not trigger clamping");
  ok(inBounds.left + inBounds.size <= 720 - HANDLE_INSET + 0.5, "Even if it is not clamped, it will not cross the line");
}

console.log("=== 7. Measurement → Positioning end-to-end (replicate the call of showHandle) ===");
{
  const scenarios = [
    { name: "Source code mode (no icon)", lineLeft: 320, foldLeft: null, editorLeft: 0 },
    { name: "List has children (icon x=300)", lineLeft: 320, foldLeft: 300, editorLeft: 0 },
    { name: "The list has children (indented two levels, x=352 at the beginning of the line)", lineLeft: 352, foldLeft: 332, editorLeft: 0 },
    { name: "title (icon x=300)", lineLeft: 320, foldLeft: 300, editorLeft: 0 },
  ];
  for (const s of scenarios) {
    const r = computeHandleLeft({ lineLeft: s.lineLeft, foldLeft: s.foldLeft, editorLeft: s.editorLeft, editorWidth: 800, handleSize: 20 });
    const rightEdgeViewport = s.editorLeft + r.left + r.size;
    const anchor = s.foldLeft ?? s.lineLeft;
    ok(rightEdgeViewport <= anchor - HANDLE_GAP + 0.5, `${s.name}→ right edge of handle${rightEdgeViewport}≤ giving way base-6 (${anchor - HANDLE_GAP})`);
  }
}

console.log("=== 8. Source code guard: showHandle must no longer use hard-coded -6 positioning ===");
{
  const src = (await import('node:fs')).readFileSync('src/handle.ts', 'utf8');
  const showHandle = src.slice(src.indexOf('showHandle(editor'), src.indexOf('private findFoldIndicatorLeft'));
  ok(showHandle.includes('computeHandleLeft'), "showHandle go computeHandleLeft");
  ok(!showHandle.includes('- handleSize - 6'), "No more hardcoding \"start of line - size - 6\"");
  ok(showHandle.includes('layout.size'), "Compressed dimensions are used for centering, width and height");
  ok(showHandle.includes('is-squeezed'), "squeezed is fed back to the DOM (CSS covert)");
}

console.log(`Total:${pass}via /${fail}failed`);
if (fail) process.exit(1);
