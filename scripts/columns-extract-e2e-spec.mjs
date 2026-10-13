/* *
 * End-to-end verification of text assembly of extractColumnTo (replicate the internal logic of the method and run real CM6).
 *Purpose: To ensure that the markdown structure produced by "column dragging" is correct, rather than just passing the judgment.
 *
 * Drop point semantics: `line` = inserted before line ** (0-based); line === total number of lines means appended to the end of the text.
 * Any row outside the column range is legal (free positioning). */
import {
  buildCombinedChanges,
  buildExtractInsertText,
  columnToPlainBlock,
  shouldUnwrapAfterExtract,
} from '../temp/verify/droptarget.mjs';
import { buildColumnsMarkdown } from '../temp/verify/convert.mjs';
import { EditorState } from '@codemirror/state';

let pass = 0, fail = 0;
const ok = (c, l) => { if (c) { pass++; console.log(`  PASS ${l}`); } else { fail++; console.log(`  FAIL ${l}`); } };
const eq = (a, b, l) => ok(JSON.stringify(a) === JSON.stringify(b), `${l}\n       got  ${JSON.stringify(a)}\n       want ${JSON.stringify(b)}`);

/* * Replicate computeEndPos of columns-preview.ts (real geometry, must be consistent, otherwise the measured product will be fake) */
function computeEndPos(doc, endLine) {
  const hasBreak = endLine + 1 < doc.lines;
  if (hasBreak && (endLine + 2 < doc.lines || doc.line(endLine + 2).text !== '')) {
    return { endPos: doc.line(endLine + 2).from, hasBreak: true };
  }
  if (hasBreak) return { endPos: doc.length - 1, hasBreak: false };
  return { endPos: doc.line(endLine + 1).to, hasBreak: false };
}

/* * Replicate the state of ColumnsWidget after removing column i (removeColumnAt semantics) */
function removeCol(texts, widths, bgs, rows, i) {
  texts.splice(i, 1); bgs.splice(i, 1);
  if (widths.length === texts.length + 1) {
    widths.splice(i, 1);
    const sum = widths.reduce((a, b) => a + b, 0) || 1;
    widths.splice(0, widths.length, ...widths.map((w) => Math.round((w / sum) * 100 * 10) / 10));
  } else widths.splice(0, widths.length);
  return { texts, widths, bgs, rows };
}

/* * Replicate the main process of extractColumnTo */
function extract({ src, i, line, copy = false, opts = {} }) {
  const st = EditorState.create({ doc: src });
  const L = (n) => st.doc.line(n + 1);
  // Locate region: find shell row and last row
  let start = -1;
  for (let k = 0; k < st.doc.lines; k++) if (/^\s*>\s*\[!multi-column/.test(st.doc.line(k + 1).text)) { start = k; break; }
  let end = start;
  for (let k = start + 1; k < st.doc.lines; k++) { if (!/^>/.test(st.doc.line(k + 1).text)) break; end = k; }
  // Analysis column (simplified: single line and column)
  const texts = [], bgs = [];
  for (let k = start + 1; k <= end; k++) {
    const t = st.doc.line(k + 1).text;
    if (/^>\s*>\s*\[!col/.test(t)) { texts.push(''); bgs.push(null); continue; }
    if (/^>\s*$/.test(t)) continue;
    const m = t.match(/^>\s*>\s?(.*)$/);
    if (m && texts.length) texts[texts.length - 1] += (texts[texts.length - 1] ? '\n' : '') + m[1];
  }
  const regionFrom = L(start).from;
  const ei = computeEndPos(st.doc, end);
  const regionTo = ei.endPos;

  const lines = [];
  for (let k = 1; k <= st.doc.lines; k++) lines.push(st.doc.line(k).text);

  const plain = columnToPlainBlock(texts[i] ?? '').trim();
  if (!plain) return { skip: true };

  const insert = buildExtractInsertText(plain, lines, line, { start, end, hasBreak: ei.hasBreak });
  const lineFrom = line >= st.doc.lines ? st.doc.length : L(line).from;

  const buildRegionText = (ts, ws, bs) =>
    buildColumnsMarkdown(ts, ws, bs, undefined, Object.keys(opts).length ? opts : undefined) + (ei.hasBreak ? '\n' : '');

  const apply = (changes) => {
    const tr = st.update({ changes });
    return {
      doc: tr.state.doc.toString(),
      src,
      undo: tr.state.update({ changes: tr.changes.invert(st.doc) }).state.doc.toString(),
    };
  };

  if (copy) {
    return apply(buildCombinedChanges(regionFrom, regionTo, buildRegionText(texts, widthsOf(st), bgs), { pos: lineFrom, text: insert }));
  }

  const removed = removeCol([...texts], widthsOf(st), [...bgs], [], i);
  // Downgrade (remaining 1 column → cancel column division) and follow the normal path of "interval rewriting + outside interval insertion",
  // In this way, the dragged content can be dropped to any position (in earlier versions, it was spelled into the region text and could only be immediately adjacent)
  const regionText = shouldUnwrapAfterExtract(removed.texts.length)
    ? removed.texts.map((t) => t.replace(/\s+$/, '')).filter(Boolean).join('\n\n') + (ei.hasBreak ? '\n' : '')
    : buildRegionText(removed.texts, removed.widths, removed.bgs);
  return apply(buildCombinedChanges(regionFrom, regionTo, regionText, { pos: lineFrom, text: insert }));

  function widthsOf(s) {
    const meta = s.doc.line(start + 1).text.match(/\[!multi-column\|([^\]]*)\]/);
    if (!meta) return [];
    const wm = meta[1].match(/^(\d+(?:-\d+)+)/);
    if (!wm) return [];
    const flat = wm[1].split('-').map(Number);
    return flat.length === texts.length ? flat : [];
  }
}

const TWO = ['intro', '', '> [!multi-column]', '>', '>> [!col]', '>> left', '>', '>> [!col]', '>> right', '', 'after'].join('\n');
const THREE = ['> [!multi-column|60-40]', '>', '>> [!col]', '>> a', '>', '>> [!col]', '>> b', '>', '>> [!col]', '>> c', '', 'tail'].join('\n');

console.log("=== 1. Drag out the last column of three columns (immediately below the drop point) ===");
{
  // lines: 0..9 columns, 10 blank lines, 11 tail → insert before tail
  const r = extract({ src: THREE, i: 2, line: 11 });
  ok(!r.skip, "not skipped");
  ok(r.doc.includes('>> a') && r.doc.includes('>> b'), "Keep the remaining two columns");
  ok(!r.doc.includes('>> c'), "The dragged column has been removed from the column");
  ok(r.doc.includes('c'), "The dragged content becomes an independent ordinary block");
  ok(/\n\nc\n/.test(r.doc), "There is a blank line between the dragged block and the adjacent block");
  eq(r.doc.split('\n').filter((l) => l === '').length, 2, "The number of blank lines is normal (no accumulation)");
  ok(r.undo === THREE, "Undo full restore in one step");
}

console.log("=== 2. Drag out one column from two columns → downgrade to cancel column ===");
{
  const r = extract({ src: TWO, i: 1, line: 10 });
  ok(!r.skip, "not skipped");
  ok(!r.doc.includes('[!multi-column]'), "Column shell has disappeared (downgraded to cancel column)");
  ok(!r.doc.includes('[!col]'), "Column markers have disappeared");
  ok(r.doc.includes('left') && r.doc.includes('right'), "Both columns of content remain as normal paragraphs");
  ok(r.undo === TWO, "Undo full restore in one step");
}

console.log("=== 3. Alt copy: keep the column + add a new copy ===");
{
  const r = extract({ src: THREE, i: 2, line: 11, copy: true });
  ok(r.doc.includes('>> a') && r.doc.includes('>> b') && r.doc.includes('>> c'), "Keep all three columns");
  ok(/\n\nc\n/.test(r.doc), "There are too many copied ordinary blocks outside the column.");
  ok(r.undo === THREE, "Undo full restore in one step");
}

console.log("=== 4. Top landing point (3 columns, avoid triggering downgrade) ===");
{
  const src = ['> [!multi-column]', '>', '>> [!col]', '>> a', '>', '>> [!col]', '>> b', '>', '>> [!col]', '>> c', '', 'after'].join('\n');
  const r = extract({ src, i: 2, line: 0 });
  ok(!r.skip && r.doc.includes('c'), "Dragging from above was successful");
  ok(r.doc.includes('[!multi-column]'), "Still retain the columns (3 columns and 2 columns left, no downgrade)");
  ok(r.doc.indexOf('\nc\n') < r.doc.indexOf('[!multi-column]'), "Drag the block before the column");
  // When inserted before the first line, the document starts with a drag block, and there is no \n in front, so ^c\n\n is used to judge.
  ok(/^c\n\n/.test(r.doc), "Drag the block to the front and separate it from the column with a blank line");
  ok(r.doc.includes('>> b\n'), "The column text itself is complete");
  ok(r.undo === src, "Undo full restore in one step");
}

console.log("=== 4b. Top drop + 2 columns only → downgrade, correct order ===");
{
  const src = ['> [!multi-column]', '>', '>> [!col]', '>> left', '>', '>> [!col]', '>> right', '', 'after'].join('\n');
  const r = extract({ src, i: 1, line: 0 });
  ok(!r.skip, "not skipped");
  ok(!r.doc.includes('[!multi-column]'), "Column shell disappears (downgraded)");
  eq(r.doc, 'right\n\nleft\n\nafter', "After downgrading: Drag out the block in front, remaining columns in the back, the order is correct");
  ok(r.undo === src, "Undo full restore in one step");
}

console.log("=== 5. Do not drag out empty columns ===");
{
  const src = ['> [!multi-column]', '>', '>> [!col]', '>', '>> [!col]', '>> right', '', 'after'].join('\n');
  const r = extract({ src, i: 0, line: 7 });
  ok(r.skip === true, "Empty columns are rejected");
}

console.log("=== 6. Free fall point: drag to the end of the article ===");
{
  // THREE 12 lines in total → line=12 means appending to the end of the text
  const r = extract({ src: THREE, i: 2, line: 12 });
  ok(!r.skip, "not skipped");
  ok(r.doc.endsWith('c'), "Drag the block to the end of the document");
  ok(/\n\nc$/.test(r.doc), "separated by a blank line from tail");
  ok(r.doc.indexOf('tail') < r.doc.indexOf('c\n') || r.doc.indexOf('tail') < r.doc.lastIndexOf('c'), "Drag out the block after tail");
  ok(r.undo === THREE, "Undo full restore in one step");
}

console.log("=== 7. Free drop point: drag to the far top (there is text before the column) ===");
{
  // TWO: 0 intro, 1 empty, 2..8 columns, 9 empty, 10 after → insert before intro
  const r = extract({ src: TWO, i: 1, line: 0 });
  ok(!r.skip, "not skipped");
  ok(!r.doc.includes('[!multi-column]'), "2 columns drag out 1 column → downgrade to cancel column");
  eq(r.doc, 'right\n\nintro\n\nleft\n\nafter', "Drag the block to the front and keep the rest in order.");
  ok(r.undo === TWO, "Undo full restore in one step");
}

console.log("=== 8. Free drop point: drag to between two paragraphs in the middle of the document ===");
{
  const src = [
    '> [!multi-column]', '>', '>> [!col]', '>> a', '>', '>> [!col]', '>> b', '>', '>> [!col]', '>> c',
    '', 'p1', '', 'p2', '', 'p3',
  ].join('\n');
  // 0..9 columns, 10 empty, 11 p1, 12 empty, 13 p2, 14 empty, 15 p3 → insert before p2 (line 13)
  const r = extract({ src, i: 2, line: 13 });
  ok(!r.skip, "not skipped");
  eq(r.doc.split('\n').filter((l) => l.trim() === 'p1' || l.trim() === 'p2' || l.trim() === 'p3').length, 3, "All three paragraphs are in");
  const idx = (s) => r.doc.split('\n').indexOf(s);
  ok(idx('c') > idx('p1') && idx('c') < idx('p2'), "Drag the block to fall between p1 and p2");
  // There should not be two consecutive blank lines between paragraphs (accumulation of blank lines will make the source code look scattered)
  ok(!/\n\n\n/.test(r.doc), "No accumulation of consecutive blank lines");
  ok(r.undo === src, "Undo full restore in one step");
}

console.log("=== 9. Free fall point: the downgrade path can also fall far away ===");
{
  const src = ['> [!multi-column]', '>', '>> [!col]', '>> left', '>', '>> [!col]', '>> right', '', 'p1', '', 'p2'].join('\n');
  // 0..6 columns, 7 empty, 8 p1, 9 empty, 10 p2 → drag out right before p2 (line 10)
  const r = extract({ src, i: 1, line: 10 });
  ok(!r.skip, "not skipped");
  ok(!r.doc.includes('[!multi-column]'), "Downgrade to cancel column");
  const idx = (s) => r.doc.split('\n').indexOf(s);
  ok(idx('left') < idx('p1') && idx('p1') < idx('right') && idx('right') < idx('p2'),
    "Sequence: left, p1, right (drag out block), p2");
  ok(r.undo === src, "Undo full restore in one step");
}

console.log(`\n${'='.repeat(46)}Pass${pass}/fail${fail}\n${'='.repeat(46)}`);
process.exit(fail ? 1 : 0);
