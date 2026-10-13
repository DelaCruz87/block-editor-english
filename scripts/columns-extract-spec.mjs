/* *
 * Requirement B (column is dragged out into columns) state machine returns.
 *
 * Background (real bug): clearOutLine() is unconditionally called at the beginning of onUp of gripDown,
 * Internally, clearOutLine will set outLine to null - what the extraction branch reads will always be null.
 * It manifests as "I can't drag it out no matter how hard I drag it." This kit reproduces the state machine as it is and asserts the calling sequence.
 * Prevent sequence bugs from happening again (wrong sequence ts and runtime single tests may not be reported).
 *
 * Run: node scripts/columns-extract-spec.mjs */
import { readFileSync } from 'node:fs';

let pass = 0, fail = 0;
const ok = (c, l) => { if (c) { pass++; console.log(`  PASS ${l}`); } else { fail++; console.log(`  FAIL ${l}`); } };
const eq = (a, b, l) => ok(JSON.stringify(a) === JSON.stringify(b), `${l}（got ${JSON.stringify(a)}, want ${JSON.stringify(b)}）`);

/* * Mirror implementation of resolveExtractLine (any line outside the range is legal, synchronized with the implementation) */
function resolveExtractLine(shellStart, shellEnd, line) {
  if (line < 0) return null;
  if (line < shellStart) return line;
  if (line > shellEnd) return line;
  return null;
}

/* * Reprint the repaired state machine of gripDown */
function simulate({ insideWidget, hoverLine, start, end, inEditorRect = true }) {
  let dragging = false, hover = -1, outLine = null;
  const clearOutLine = () => { outLine = null; };
  const computeOutLine = () => {
    if (insideWidget) return null;
    if (!inEditorRect) return null;
    return resolveExtractLine(start, end, hoverLine);
  };
  // onMove
  dragging = true;
  hover = insideWidget ? 1 : -1;
  if (hover !== -1) clearOutLine();
  else { const l = computeOutLine(); outLine = l; if (l === null) clearOutLine(); }

  // onUp (fixed order: capture first, then clean)
  const finalOutLine = outLine;
  clearOutLine();
  const extracted = finalOutLine !== null && hover === -1;
  return { computed: finalOutLine, extracted };
}

console.log("=== 1. The legal landing point must be able to be extracted ===");
{
  const below = simulate({ insideWidget: false, hoverLine: 13, start: 2, end: 12 });
  eq(below.computed, 13, "Calculate the landing point of the row immediately below the column 13");
  ok(below.extracted, "Immediately below → trigger extraction");

  // Free positioning: Long-distance travel outside the range is also legal (users demand "the ability to drag and drop positions at will")
  const far = simulate({ insideWidget: false, hoverLine: 40, start: 2, end: 12 });
  eq(far.computed, 40, "Any row far below → drop point 40");
  ok(far.extracted, "Far below → trigger extraction (relaxed core capabilities)");

  const above = simulate({ insideWidget: false, hoverLine: 1, start: 2, end: 12 });
  eq(above.computed, 1, "Calculate the drop point 1 for the row immediately above the column");
  ok(above.extracted, "Immediately above → trigger extraction");

  // Regression: The shell line is swallowed by the widget, and the pointer can only hit start-1 above the widget.
  const above0 = simulate({ insideWidget: false, hoverLine: 0, start: 2, end: 12 });
  eq(above0.computed, 0, "Rows higher up are also considered legal.");
  ok(above0.extracted, "Far above → trigger extraction");
}

console.log("=== 1b. resolveExtractLine geometry (real implementation) ===");
{
  // Directly import the packaged product and lock the rule "Any line outside the range is legal"
  const { resolveExtractLine: rel } = await import('../temp/verify/droptarget.mjs');
  eq(rel(2, 12, 13), 13, "endLine+1 hit");
  eq(rel(2, 12, 14), 14, "endLine+2 hit");
  eq(rel(2, 12, 40), 40, "Far below hit (free positioning)");
  eq(rel(2, 12, 1), 1, "Immediately after the upward hit");
  eq(rel(2, 12, 0), 0, "Hit from far above");
  eq(rel(2, 12, 2), null, "Shell row (in range) miss");
  eq(rel(2, 12, 7), null, "Miss within the range");
  eq(rel(2, 12, 12), null, "The last row (within the interval) misses");
  eq(rel(0, 7, -1), null, "Negative line number misses");
}

console.log("=== 1c. Continuously drag the same drop point: the status cannot be cleared by yourself (user log replication) ===");
{
  // Replicate the onMove/onUp loop of gripDown (including the call point of showOutLine).
  // The real log once showed "outLine 94 was printed 20 times repeatedly, but finalOutLine=null when up":
  // The root cause is that showOutLine internally calls clearOutLine() to remove the previous line, and it also changes outLine
  // Set to null - self-destruct immediately after each landing point is calculated, and the next move will be judged as a "value change" and printed repeatedly.
  const runMoves = (moves, start, end, buggy = false) => {
    const logs = [];
    let hover = -1, outLine = null, el = null;
    const removeEl = () => { el = null; };
    const clearOutLine = () => { removeEl(); outLine = null; };
    // The repaired version only changes the DOM; the buggy version reuses clearOutLine (historical bug)
    const showOutLine = (line) => { if (buggy) clearOutLine(); else removeEl(); el = line; };
    const compute = (m) => {
      if (m.insideWidget) return null;
      if (!(m.inEditorRect ?? true)) return null;
      const upper = m.hoverLine <= start;
      const r = resolveExtractLine(start, end, m.hoverLine, upper);
      if (r === null) return null;
      if (upper && start === 0) return null;
      return r;
    };
    for (const m of moves) {
      hover = m.insideWidget ? 1 : -1;
      if (hover !== -1) clearOutLine();
      else {
        const line = compute(m);
        if (line !== outLine) logs.push(line);
        outLine = line;
        if (line === null) clearOutLine(); else showOutLine(line);
      }
    }
    const finalOutLine = outLine;
    clearOutLine();
    return { logs, finalOutLine, extracted: finalOutLine !== null && hover === -1 };
  };

  // Actual user scenario: start=78 end=92, first slide to 93 and then stop at 94, and then stop at 94 for multiple consecutive frames
  const moves = [
    { hoverLine: 93 }, { hoverLine: 94 },
    { hoverLine: 94 }, { hoverLine: 94 }, { hoverLine: 94 }, { hoverLine: 94 },
  ];
  const fixed = runMoves(moves, 78, 92);
  eq(fixed.logs, [93, 94], "Subsequent frames at the same landing point should not be printed again (only a change of 93→94 is recorded)");
  eq(fixed.finalOutLine, 94, "When you let go, the landing point is still 94");
  ok(fixed.extracted, "Extraction can still be triggered after continuous dragging (this is null in the user log)");

  // Counterexample: Deliberately returning to the old implementation, the shape of the user log must be reproduced (proving that the above two assertions are valid)
  const buggy = runMoves(moves, 78, 92, true);
  ok(buggy.logs.length > 2, "The old implementation will repeatedly print the landing point (bad case, proving that the assertion is not always true)");
  eq(buggy.finalOutLine, null, "The old implementation dropped the point to null when letting go (bad case)");
  ok(!buggy.extracted, "Old implementation does not trigger extraction (bad case)");
}

console.log("=== 2. Illegal landing points must not be extracted (cannot be relaxed due to bug fixes) ===");
{
  const inside = simulate({ insideWidget: false, hoverLine: 7, start: 2, end: 12 });
  ok(!inside.extracted, "Rows inside the interval → do not extract");
  const far = simulate({ insideWidget: false, hoverLine: 30, start: 2, end: 12 });
  ok(far.extracted, "Long distance travel outside the zone → Withdrawal is allowed (no longer illegal after relaxation)");
  const inWidget = simulate({ insideWidget: true, hoverLine: null, start: 2, end: 12 });
  ok(!inWidget.extracted, "The pointer is still within the widget → Change the order between columns without extracting");
  const outside = simulate({ insideWidget: false, hoverLine: 13, start: 2, end: 12, inEditorRect: false });
  ok(!outside.extracted, "The pointer is outside the editor's visible area → do not extract");
  const topmost = simulate({ insideWidget: false, hoverLine: 0, start: 0, end: 12 });
  ok(!topmost.extracted, "When the column is in the first line of the document, the shell line itself is inside the range → not extracted");
}

console.log("=== 3. Source code sequence guard: onUp must be captured first and then cleaned ===");
{
  const src = readFileSync('src/columns-preview.ts', 'utf8');
  const i = src.indexOf('private extractColumnTo');
  ok(i > 0, "extractColumnTo exists");
  const upIdx = src.indexOf('const onUp = (ev: MouseEvent) => {');
  ok(upIdx > 0, "gripDown's onUp exists");
  // Ignore prose length: the guard measures executable statements.
  const upBody = src.slice(upIdx, src.indexOf('const el = document.elementFromPoint', upIdx)).replace(/\/\/[^\n]*/g, '');
  const capIdx = upBody.indexOf('const finalOutLine = outLine;');
  const clearIdx = upBody.indexOf('clearOutLine();');
  ok(capIdx > 0, "There is a step of \"capture outLine first\" in onUp");
  ok(clearIdx > 0, "There is a clearOutLine() call in onUp");
  ok(capIdx < clearIdx, "Capture must precede cleanup (reversing the order is the original bug)");
  ok(upBody.includes('this.extractColumnTo(from, finalOutLine'), "Extract branch uses captured value instead of sanitized outLine");

  // Source code guard: showOutLine must not call clearOutLine() which clears the status when redrawing the line.
  const showAt = src.indexOf('const showOutLine = ');
  ok(showAt > 0, "showOutLine exists");
  const showBody = src.slice(showAt, showAt + 1200);
  // Strip the comment line and assert again: the comment will mention the clearOutLine counterexample, otherwise the guard will be triggered by its own comment.
  const showCode = showBody.split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');
  ok(/removeOutLineEl\(\)/.test(showCode), "showOutLine only removes the DOM (removeOutLineEl)");
  ok(!/clearOutLine\(\)/.test(showCode), "showOutLine must not call clearOutLine (will clear outLine to null)");
  ok(/const removeOutLineEl = /.test(src), "There is a removeOutLineEl that \"only clears the DOM\"");
  ok(/const clearOutLine = \(\)/.test(src), "There is clearOutLine that \"clears DOM + clears state\"");
}

console.log("=== 4. grip hit zone guard (CSS must not be degraded) ===");
{
  const css = readFileSync('styles.css', 'utf8');
  const m = css.match(/\.block-editor-col-grip\s*\{([^}]*)\}/);
  ok(!!m, "Find the .block-editor-col-grip rule");
  const body = m ? m[1] : '';
  ok(/padding:\s*4px\s+0/.test(body), "The grip has vertical padding (vertical hit area > 8px)");
  ok(/width:\s*100%/.test(body), "grip spreads the entire column horizontally (no need to align the fonts)");
  ok(/-webkit-user-select/.test(body), "grip disables webkit text selection");
  ok(/cursor:\s*grab/.test(body), "grip has grab cursor feedback");
  ok(/\.block-editor-col-grip:hover/.test(css), "grip has hover feedback");
}

console.log("=== 5. Drop point line visibility guard (return: once invisible / once coupled) ===");
{
  const css = readFileSync('styles.css', 'utf8');
  // [Core invariants after decoupling] The appearance base class .block-editor-indicator must not declare display.
  // Its two consumers have opposite visibility needs: the insertion line of drag.ts is a resident singleton and should be hidden by default;
  // Each time the drop point line of columns-preview is created, it must be visible as soon as it is hung up. Write display into the base class,
  // The latter can only be covered by the `.a.b` specificity - when the base class is modified, it will be silently invisible and "cannot be dragged out".
  const ind = css.match(/\.block-editor-indicator\s*\{([^}]*)\}/);
  ok(!!ind, "Find the .block-editor-indicator appearance base class");
  ok(!!ind && !/display\s*:/.test(ind[1]), "The appearance base class does not contain display (display and concealment do not belong to the appearance, and the two lines are independent)");
  ok(!!ind && /position:\s*absolute/.test(ind[1]), "Appearance base class declaration position:absolute (positioning belongs to appearance)");
  // The respective explicit and implicit rules of the two lines must exist and do not cover each other (both are single-type selectors with the same specificity)
  const insertLine = css.match(/\.block-editor-insert-line\s*\{([^}]*)\}/);
  ok(!!insertLine && /display:\s*none/.test(insertLine[1]), "Insert lines default to display:none (reusable singletons need to be hidden by default)");
  const outline = css.match(/\.block-editor-col-outline\s*\{([^}]*)\}/);
  ok(!!outline, ".block-editor-col-outline rule exists");
  ok(!!outline && /display:\s*block/.test(outline[1]), "col-outline itself is display:block (one-time element, must be visible as soon as it is hung)");
  ok(!/\.block-editor-indicator\.block-editor-col-outline/.test(css), "col-outline no longer relies on compound selectors to suppress base classes (coupling has been eliminated)");
  // On the display side, use the .is-visible status class: grep this class name to see "who is displaying"
  ok(/\.block-editor-insert-line\.is-visible/.test(css), "There is a .is-visible display rule");
  const dragSrc = readFileSync('src/drag.ts', 'utf8');
  ok(!/setCssStyles\(\{[^}]*display/.test(dragSrc), "drag.ts no longer uses setCssStyles to write inline display (display is only visible in CSS)");
  ok(/classList\.toggle\('is-visible'/.test(dragSrc), "drag.ts uniformly uses the is-visible class to switch between visible and hidden");
  // Source code side: New elements must have this class name (display is no longer set inline)
  const src = readFileSync('src/columns-preview.ts', 'utf8');
  ok(/block-editor-indicator block-editor-col-outline/.test(src), "The source code creates a new drop-out line with the col-outline class name");
  ok(!/el\.style\.display = 'block'/.test(src), "Source code no longer sets display inline (duplicate declaration with CSS)");
  // Source bar drag status feedback: without it, the user cannot tell whether the drag has started.
  ok(/\.block-editor-col-editor\.block-editor-col-dragging/.test(css), "There is a drag-and-drop style in the source bar");
  ok(/classList\.toggle\('block-editor-col-dragging'/.test(src), "The source code will switch the source bar drag state");
}

console.log(`\n${'='.repeat(46)}Pass${pass}/fail${fail}\n${'='.repeat(46)}`);
process.exit(fail ? 1 : 0);
