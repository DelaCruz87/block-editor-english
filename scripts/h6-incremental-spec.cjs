/* H6 incremental scan special return: affected range rescan + unaffected range translation multiplexing + full anti-shake coverage.
 * Core invariant: getColumnsDiagnostics() under incremental path (unified updated by buildDecorations)
 * Consistent with full scanRegions semantics - interval number/column fragment/fence awareness/colrow row structure are not returned. */
'use strict';

const path = require('path');
const Module = require('module');

const { JSDOM } = require('jsdom');
const dom = new JSDOM('<!doctype html><html><body><div id="host"></div></body></html>', {
  pretendToBeVisual: true,
});
global.window = dom.window;
global.document = dom.window.document;
Object.defineProperty(global, 'navigator', { value: dom.window.navigator, configurable: true });
global.requestAnimationFrame = (cb) => setTimeout(() => cb(Date.now()), 16);
global.cancelAnimationFrame = (id) => clearTimeout(id);
global.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
global.MutationObserver = dom.window.MutationObserver;
global.Range = dom.window.Range;
global.Selection = dom.window.Selection;
global.KeyboardEvent = dom.window.KeyboardEvent;
global.MouseEvent = dom.window.MouseEvent;
global.Window = dom.window.Window;
global.Element = dom.window.Element;
global.HTMLElement = dom.window.HTMLElement;
global.SVGElement = dom.window.SVGElement;
global.Text = dom.window.Text;

const { StateField } = require('@codemirror/state');
const stub = {
  Plugin: class {}, Menu: class {}, Notice: class {}, EditorSuggest: class {},
  PluginSettingTab: class {}, Setting: class {}, Modal: class {}, MarkdownView: class {},
  MarkdownRenderer: { render: async (app, md, el) => { el.textContent = md; } },
  editorInfoField: StateField.define({ create: () => ({ file: null }), update: (v) => v }),
  editorLivePreviewField: StateField.define({ create: () => true, update: (v) => v }),
};
const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'obsidian') return stub;
  return origLoad.call(this, request, parent, isMain);
};
const main = require(path.join(__dirname, '..', 'main.js'));
const { columnsExtension, getColumnsDiagnostics } = main;
const { EditorState } = require('@codemirror/state');
const { EditorView } = require('@codemirror/view');

const results = [];
const check = (name, ok) => results.push([name, !!ok]);
const ctx = { app: {}, settings: { livePreviewWidget: true } };
process.on('unhandledRejection', (e) => { console.error('UNHANDLED_REJECTION:', e && e.stack ? e.stack : e); process.exit(1); });
process.on('uncaughtException', (e) => { console.error('UNCAUGHT_EXCEPTION:', e && e.stack ? e.stack : e); process.exit(1); });

function makeView(doc) {
  const state = EditorState.create({
    doc,
    extensions: [
      stub.editorInfoField,
      stub.editorLivePreviewField,
      EditorView.exceptionSink.of((e) => console.error('[cm6-exception]', e && e.stack ? e.stack : e)),
      columnsExtension(ctx),
    ],
  });
  const parent = document.getElementById('host');
  parent.textContent = '';
  return new EditorView({ state, parent });
}
const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));

// Insert text at the end of the old document line number line (1-based); return whether it is successful
function insertAtLine(view, line, insert) {
  const doc = view.state.doc;
  if (line > doc.lines) return false;
  const pos = doc.line(line).to;
  view.dispatch({ changes: { from: pos, to: pos, insert } });
  return true;
}
// Replace the entire line content of the old line line (1-based)
function setLine(view, line, text) {
  const doc = view.state.doc;
  if (line > doc.lines) return false;
  const l = doc.line(line);
  view.dispatch({ changes: { from: l.from, to: l.to, insert: text } });
  return true;
}
// Insert several lines after the old line (1-based)
function insertLinesAfter(view, line, linesArr) {
  const doc = view.state.doc;
  if (line > doc.lines) return false;
  const pos = doc.line(line).to;
  view.dispatch({ changes: { from: pos, to: pos, insert: '\n' + linesArr.join('\n') } });
  return true;
}

const COL2 = [
  '> [!multi-column|60-40]',
  '>',
  '>> [!col]',
  '>> \u5de6\u680f',
  '>',
  '>> [!col]',
  '>> \u53f3\u680f',
].join('\n');

(async () => {
  // ---- Scenario A: External editing of columns (adding words to the previous text) → The number of intervals remains unchanged and the column content remains unchanged ----
  console.log("[h6] A external editor");
  {
    const doc = ['\u524d\u65871', '\u524d\u65872', COL2, '\u540e\u6587'].join('\n');
    const view = makeView(doc);
    await tick();
    const d0 = getColumnsDiagnostics();
    check("A0 initial recognition 1 interval", d0.regions === 1);
    insertAtLine(view, 1, ' \u8ffd\u52a0');
    await tick();
    const d1 = getColumnsDiagnostics();
    check("A1 The interval is still 1 after external editing", d1.regions === 1);
    check("The content of column A2 is not affected", JSON.stringify(d1.segmentsPreview) === JSON.stringify(['\u5de6\u680f', '\u53f3\u680f']));
    view.destroy();
    await tick(50);
  }

  // ---- Scenario B: Internal editing of columns (change of content in the left column) → incremental rescan to create a new interval ----
  console.log("[h6] Edit in column B");
  {
    const view = makeView(['\u524d\u6587', COL2, '\u540e\u6587'].join('\n'));
    await tick();
    // The content line in the left column is the 5th line overall (the 4th of the 7 lines in the previous article 1 + COL2 = `>> left column`)
    setLine(view, 5, '>> \u5de6\u680f\u5df2\u6539');
    await tick();
    const d = getColumnsDiagnostics();
    check("Recognize 1 interval after editing in column B1", d.regions === 1);
    check("B2 left column content updated", d.segmentsPreview[0] === '\u5de6\u680f\u5df2\u6539');
    check("B3 The content in the right column is retained", d.segmentsPreview[1] === '\u53f3\u680f');
    view.destroy();
    await tick(50);
  }

  // ---- Scenario C: Insert 10 lines before column → interval translation multiplexing, still recognized ----
  console.log("[h6] C forward translation");
  {
    const view = makeView(['\u524d\u6587', COL2, '\u540e\u6587'].join('\n'));
    await tick();
    const pad = Array.from({ length: 10 }, (_, i) => '\u586b\u5145\u884c' + i);
    insertLinesAfter(view, 1, pad);
    await tick();
    const d = getColumnsDiagnostics();
    check("C1 inserts 10 lines forward and the interval is still 1", d.regions === 1);
    check("C2 The content of the column behind the translation is correct", JSON.stringify(d.segmentsPreview) === JSON.stringify(['\u5de6\u680f', '\u53f3\u680f']));
    // The number of widget rows should also be normal
    const cols = view.dom.querySelectorAll('.block-editor-col-editor');
    check("C3 widget still renders 2 columns", cols.length === 2);
    view.destroy();
    await tick(50);
  }

  // ---- Scene D: Delete the column shell → the section disappears; create a new one → the section appears ----
  console.log("[h6] D addition and deletion interval");
  {
    const view = makeView(['\u524d\u6587', COL2, '\u540e\u6587'].join('\n'));
    await tick();
    setLine(view, 2, '\u4e0d\u518d\u662f\u5206\u680f');
    await tick();
    const d1 = getColumnsDiagnostics();
    check("The interval after D1 shell is deleted is 0", d1.regions === 0);
    // Rebuild columns (replaced back to COL2)
    view.dispatch({
      changes: { from: view.state.doc.line(2).from, to: view.state.doc.line(2).to, insert: COL2 },
    });
    await tick();
    const d2 = getColumnsDiagnostics();
    check("D2 interval restores 1 after reinsertion", d2.regions === 1);
    view.destroy();
    await tick(50);
  }

  // ---- Scenario E: Example column text in the code fence → No misrecognition (incremental fence backtracking) ----
  console.log("[h6] E fence awareness");
  {
    const doc = [
      '\u6b63\u6587',
      '```markdown',
      '> [!multi-column]',
      '>',
      '>> [!col]',
      '>> \u793a\u4f8b',
      '```',
      '\u540e\u6587',
    ].join('\n');
    const view = makeView(doc);
    await tick();
    const d0 = getColumnsDiagnostics();
    check("Examples within the E1 fence are not recognized", d0.regions === 0);
    // Edit before fence (trigger increment, fence retrace path)
    insertAtLine(view, 1, ' \u8ffd\u52a0');
    await tick();
    const d1 = getColumnsDiagnostics();
    check("E2 is still not mistakenly recognized after editing in front of the fence", d1.regions === 0);
    // Insert real columns immediately after the end of the fence
    insertLinesAfter(view, 7, [COL2]);
    await tick();
    const d2 = getColumnsDiagnostics();
    check("E3 Real columns inserted outside the fence are recognized", d2.regions === 1);
    check("E4 The content of the real columns is correct", JSON.stringify(d2.segmentsPreview) === JSON.stringify(['\u5de6\u680f', '\u53f3\u680f']));
    view.destroy();
    await tick(50);
  }

  // ---- Scenario F: Large changes (>50 lines) take the full anti-shake path, and the result is still correct ----
  console.log("[h6] F full anti-shake");
  {
    const view = makeView(['\u524d\u6587', COL2, '\u540e\u6587'].join('\n'));
    await tick();
    const pad = Array.from({ length: 60 }, (_, i) => '\u6279\u91cf\u884c' + i);
    insertLinesAfter(view, 1, pad);
    await tick();
    const d = getColumnsDiagnostics();
    check("F1 60 After major changes, the range is still 1", d.regions === 1);
    check("The content of the column after the F2 major change is correct", JSON.stringify(d.segmentsPreview) === JSON.stringify(['\u5de6\u680f', '\u53f3\u680f']));
    view.destroy();
    await tick(50);
  }

  // ---- Scenario G: Large document + external continuous editing takes time and smoke (no strict assertion, only output takes time) ----
  console.log("[h6] G Large documents take time and smoke");
  {
    const N = 2000;
    const lines = Array.from({ length: N }, (_, i) => '\u6b63\u6587\u884c' + i);
    lines.splice(1000, 0, COL2);
    const view = makeView(lines.join('\n'));
    await tick();
    const d0 = getColumnsDiagnostics();
    check("G1 2000 lines large document recognition 1 interval", d0.regions === 1);
    const t0 = Date.now();
    for (let i = 0; i < 30; i++) {
      insertAtLine(view, 1, 'x');
      await tick(2);
    }
    const cost = Date.now() - t0;
    const d1 = getColumnsDiagnostics();
    check("G2 After 30 external edits, the interval is still 1", d1.regions === 1);
    check("The content of column G3 remains correct.", JSON.stringify(d1.segmentsPreview) === JSON.stringify(['\u5de6\u680f', '\u53f3\u680f']));
    console.log("[h6] Time taken for 30 external editing increments =", cost, 'ms');
    view.destroy();
    await tick(50);
  }

  // ---- Scenario H: Adjacent double columns + front reference content editing → no repeated display (bug regression) ----
  // For two adjacent columns in the same continuous quotation block, edit the quotation line before the first column:
  // The reference block extension causes the scan area to cover the entire reference block. If subsequent columns are not judged to be affected,
  // fresh rescans a copy + kept translates a copy → the same column is rendered twice.
  console.log("[h6] H Pre-edit adjacent columns");
  {
    const doc = [
      '> \u524d\u7f6e\u5f15\u7528\u6587\u672c',
      '> [!multi-column|50-50]',
      '> [!col]',
      '> A\u5de6',
      '> [!col]',
      '> A\u53f3',
      '> [!multi-column|50-50]',
      '> [!col]',
      '> B\u5de6',
      '> [!col]',
      '> B\u53f3',
      '\u540e\u6587',
    ].join('\n');
    const view = makeView(doc);
    await tick();
    const d0 = getColumnsDiagnostics();
    check("H0 initially identifies 2 intervals", d0.regions === 2);
    check("H0b initial 4 columns", JSON.stringify(d0.segmentsPreview) === JSON.stringify(['A\u5de6', 'A\u53f3', 'B\u5de6', 'B\u53f3']));
    // Insert a new quotation line at the end of the quotation line before column A (triggers quotation block expansion → overwriting A+B)
    insertAtLine(view, 1, '\n> \u65b0\u589e\u5f15\u7528\u5185\u5bb9');
    await tick();
    const d1 = getColumnsDiagnostics();
    check("H1 still recognizes 2 intervals after pre-editing", d1.regions === 2);
    check("H2 no duplicate columns (still 4 paragraphs)", JSON.stringify(d1.segmentsPreview) === JSON.stringify(['A\u5de6', 'A\u53f3', 'B\u5de6', 'B\u53f3']));
    // DOM layer: The number of widget columns should be 4 (before fix, B will render two copies → 6 columns)
    const cols1 = view.dom.querySelectorAll('.block-editor-col-editor');
    check("H3 widget renders 4 columns (no duplication)", cols1.length === 4);
    // Editing back and forth: change the content line in column B (1-based line 10 = '> B left') → then change the forward reference content → still stable
    insertAtLine(view, 10, 'x');
    await tick();
    insertAtLine(view, 1, '\n> \u518d\u6b21\u63d2\u5165');
    await tick();
    const d2 = getColumnsDiagnostics();
    check("H4 After multiple back-and-forth editing, the interval is still 2", d2.regions === 2);
    check("H5 After editing back and forth, the column segment is correct", JSON.stringify(d2.segmentsPreview) === JSON.stringify(['A\u5de6', 'A\u53f3', 'B\u5de6x', 'B\u53f3']));
    const cols2 = view.dom.querySelectorAll('.block-editor-col-editor');
    check("H6 widget still has 4 columns after editing back and forth", cols2.length === 4);
    view.destroy();
    await tick(50);
  }

  // ---- Scenario I: Single column + pre-editing above the column (user's actual trigger path) → no duplication + widget range accurate ----
  // User scenario: single column, insert a line **above** the column/edit the text, and the content of the same column is rendered twice vertically up and down.
  // (When the old increment was kept and the panning was in "editing above the column", startPos was biased upward to overwrite the preceding row, and endPos was biased upward and missing.
  // At the end of the code block, it is superimposed with Obsidian's native callout rendering to form a mirror repetition; after full rescan, the widget's
  // regionStart must be exactly equal to the shell line from).
  console.log("[h6] I Single column pre-editing");
  {
    const SINGLE = [
      '> [!multi-column]',
      '>',
      '>> [!col]',
      '>> \u552f\u4e00\u680f\u5185\u5bb9',
      '>',
      '> ```js',
      '> const a = 1;',
      '> ```',
    ].join('\n');
    const doc = ['\u524d\u7f6e0', '\u524d\u7f6e1', '\u524d\u7f6e2', '\u524d\u7f6e3', SINGLE, '\u540e\u6587'].join('\n');
    const view = makeView(doc);
    await tick();
    const shellLine = () => {
      const d = view.state.doc;
      for (let i = 1; i <= d.lines; i++) if (/\[!multi-column/.test(d.line(i).text)) return i;
      return -1;
    };
    const widgetStart = () => {
      const w = view.dom.querySelector('.block-editor-columns-widget');
      return w ? Number(w.dataset.regionStart) : -1;
    };
    const rangeOK = () => {
      const sl = shellLine();
      const ws = widgetStart();
      return sl > 0 && ws === view.state.doc.line(sl).from;
    };
    // segmentsPreview merge the code block into the same segment (including newline mark), take the first segment prefix assertion
    const segOK = (d) =>
      Array.isArray(d.segmentsPreview) &&
      d.segmentsPreview.length === 1 &&
      d.segmentsPreview[0].startsWith('\u552f\u4e00\u680f\u5185\u5bb9');
    const d0 = getColumnsDiagnostics();
    check("I0 initial recognition 1 interval", d0.regions === 1);
    check("I0b widget range accurate", rangeOK());
    // I1: Append characters at the end of the preceding line (no additional lines; startPos in the old kept path is misplaced)
    insertAtLine(view, 1, 'x');
    await tick();
    const d1 = getColumnsDiagnostics();
    check("I1 After appending the leading line, the range is still 1", d1.regions === 1);
    check("I1b no repeated columns", segOK(d1));
    check("I1c widget range precise (no additional pre-editing)", rangeOK());
    // I2: Carriage return at the end of the preceding line (1 additional line; old kept path endPos misaligned and leaked coverage of the end of the code block)
    insertAtLine(view, 1, '\n');
    await tick();
    const d2 = getColumnsDiagnostics();
    check("I2 The interval after carriage return is still 1", d2.regions === 1);
    check("I2b no duplicate columns", segOK(d2));
    check("I2c widget range precise (additional pre-editing)", rangeOK());
    // I3: Multiple rounds of editing (inserting another line + editing the preceding line of text) → still stable
    insertAtLine(view, 1, '\n\u65b0\u524d\u7f6e\u884c');
    await tick();
    insertAtLine(view, 1, '!');
    await tick();
    const d3 = getColumnsDiagnostics();
    check("I3 After multiple rounds of pre-editing, the interval is still 1", d3.regions === 1);
    check("I3b No duplicate columns after multiple rounds", segOK(d3));
    check("I3c widget range accurate after multiple rounds", rangeOK());
    const cols = view.dom.querySelectorAll('.block-editor-col-editor');
    check("I4 widget renders 1 column (no duplicates)", cols.length === 1);
    view.destroy();
    await tick(50);
  }

  let fails = 0;
  for (const [name, ok] of results) {
    console.log((ok ? 'PASS ' : 'FAIL ') + name);
    if (!ok) fails++;
  }
  console.log(fails ? `[h6] ${fails}Item failed` : "[h6] All passed");
  process.exit(fails ? 1 : 0);
})().catch((e) => {
  console.error('[h6] CATCH:', e && e.stack ? e.stack : e);
  process.exit(1);
});
