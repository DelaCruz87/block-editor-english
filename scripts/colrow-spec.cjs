/* Two-dimensional row (colrow) special verification: parsing/rendering/writeback/backward compatibility */
'use strict';

const path = require('path');
const Module = require('module');

const _origConsoleError = console.error;
console.error = (...a) => {
  _origConsoleError(
    '[hook]',
    ...a.map((x) => (x instanceof Error ? (x.stack || String(x)) : typeof x + ':' + String(x)))
  );
};

const { JSDOM } = require('jsdom');
const dom = new JSDOM('<!doctype html><html><body><div id="host"></div></body></html>', {
  pretendToBeVisual: true,
});
global.window = dom.window;
global.document = dom.window.document;
Object.defineProperty(global, 'navigator', { value: dom.window.navigator, configurable: true });
global.requestAnimationFrame = (cb) => setTimeout(() => cb(Date.now()), 16);
global.cancelAnimationFrame = (id) => clearTimeout(id);
global.ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
};
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
  Plugin: class {},
  Menu: class {},
  Notice: class {
    constructor(msg) {
      stub.Notice.last = msg;
    }
  },
  EditorSuggest: class {},
  PluginSettingTab: class {},
  Setting: class {},
  Modal: class {},
  MarkdownView: class {},
  MarkdownRenderer: {
    render: async (app, md, el) => {
      el.textContent = md;
    },
  },
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
process.on('unhandledRejection', (e) => {
  console.error('[colrow-spec] UNHANDLED_REJECTION:', e && e.stack ? e.stack : e);
  process.exit(1);
});
process.on('uncaughtException', (e) => {
  console.error('[colrow-spec] UNCAUGHT_EXCEPTION:', e && e.stack ? e.stack : e);
  process.exit(1);
});

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
  try {
    return new EditorView({ state, parent });
  } catch (e) {
    console.error('[colrow-spec] makeView error:', e && e.stack ? e.stack : e);
    throw e;
  }
}
const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));

(async () => {
  // ---- Use case 1: Two rows × two columns parsing and rendering ----
  console.log('[colrow-spec] case1 start');
  const DOC_2ROW = [
    '\u524d\u6587',
    '> [!multi-column|60-40/50-50]',
    '>',
    '>> [!col]',
    '>> \u7b2c1\u884c\u5de6',
    '>',
    '>> [!col]',
    '>> \u7b2c1\u884c\u53f3',
    '>> [!colrow]',
    '>',
    '>> [!col]',
    '>> \u7b2c2\u884c\u5de6',
    '>',
    '>> [!col]',
    '>> \u7b2c2\u884c\u53f3',
    '\u540e\u6587',
  ].join('\n');
  {
    const view = makeView(DOC_2ROW);
    await tick();
    console.log('[colrow-spec] case1 view ready, rows=', view.dom.querySelectorAll('.block-editor-columns-widget > .block-editor-columns-row').length);
    const diag = getColumnsDiagnostics();
    console.log('[colrow-spec] diag=', JSON.stringify(diag));
    check("Two-dimensional column identifies 1 interval", diag.regions === 1);
    check("Two-dimensional column analysis produces 4 column fragments (2 rows × 2 columns)", diag.segmentsPreview.length === 4);
    const rows = view.dom.querySelectorAll('.block-editor-columns-widget > .block-editor-columns-row');
    check("The widget renders 2 rows (stacked vertically)", rows.length === 2);
    const cols = view.dom.querySelectorAll('.block-editor-col-editor');
    console.log('[colrow-spec] cols=', cols.length, 'first=', !!cols[0], 'cls=', cols[0] ? cols[0].className : '');
    check("4 columns rendered in total", cols.length === 4);
    const texts = [...cols].map((c) => {
      const el = c.querySelector('.block-editor-col-content');
      if (!el) console.log('[colrow-spec] MISS content for', c.className);
      return el?.textContent ?? '';
    });
    check("The content of the inline column is correct", texts[0] === '\u7b2c1\u884c\u5de6' && texts[1] === '\u7b2c1\u884c\u53f3' && texts[2] === '\u7b2c2\u884c\u5de6' && texts[3] === '\u7b2c2\u884c\u53f3');
    console.log('[colrow-spec] texts ok=', JSON.stringify(texts));
    const widths = [...rows].map((r) => r.querySelectorAll('.block-editor-col-editor')[0].style.flex);
    check("The width is parsed by row (row 1=60, row 2=50)", widths[0] === '60 1 0%' && widths[1] === '50 1 0%');
    console.log('[colrow-spec] widths ok=', JSON.stringify(widths));
    view.destroy();
    await tick(60);
    console.log('[colrow-spec] case1 destroyed');
  }

  // ---- Use case 2: Old notes (without colrow) backward compatibility: single line parsing ----
  console.log('[colrow-spec] case2 start');
  const DOC_OLD = [
    '> [!multi-column]',
    '>',
    '>> [!col]',
    '>> \u5de6\u680f',
    '>',
    '>> [!col]',
    '>> \u53f3\u680f',
  ].join('\n');
  {
    const view = makeView(DOC_OLD);
    console.log('[colrow-spec] case2 view created');
    await tick();
    console.log('[colrow-spec] case2 ticked');
    let diag;
    try {
      diag = getColumnsDiagnostics();
    } catch (e) {
      console.error('[colrow-spec] getDiag error:', e && e.stack ? e.stack : e);
      throw e;
    }
    check("Compatible with old notes: recognize 1 interval", diag.regions === 1);
    console.log('[colrow-spec] case2 diag ok');
    check("Old note compatibility: parse 2 column fragments", diag.segmentsPreview.length === 2);
    const rows = view.dom.querySelectorAll('.block-editor-columns-widget > .block-editor-columns-row');
    console.log('[colrow-spec] case2 rows=', rows.length);
    check("Compatible with old notes: still render 1 row", rows.length === 1);
    const cols = view.dom.querySelectorAll('.block-editor-col-editor');
    console.log('[colrow-spec] case2 cols=', cols.length);
    check("Old note compatibility: render 2 columns", cols.length === 2);
    console.log('[colrow-spec] case2 checks ok, destroying');
    view.destroy();
    console.log('[colrow-spec] case2 destroyed');
  }

  // ---- Use case 3: Add a new row to the grip menu → write back containing [!colrow], and then render 2 more rows ----
  console.log('[colrow-spec] case3 start');
  {
    const view = makeView(DOC_OLD);
    console.log('[colrow-spec] case3 view created');
    await tick();
    const grip0 = view.dom.querySelector('.block-editor-col-grip');
    check("grip handle exists", !!grip0);
    grip0.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: 100, clientY: 100 }));
    grip0.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, clientX: 100, clientY: 100 }));
    const menu = document.querySelector('.block-editor-col-menu');
    check("grip click popup menu", !!menu);
    const btns = menu ? [...menu.querySelectorAll('button')] : [];
    // Button order: 0=bg 1=Add column 2=Split 3=Merge 4=Delete column 5=Add row 6=Delete row (multiple rows +7=Move up 8=Move down)
    check("The single-line menu contains 7 buttons (bg/add column/split/merge/delete column/add row/delete row)", btns.length === 7);
    check("Delete entire row button disabled when single row", btns.length === 7 && btns[6].disabled === true);
    btns[5].dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await tick(60);
    const doc = view.state.doc.toString();
    check("New rows written back contain >> [!colrow]", doc.includes('>> [!colrow]'));
    const rows = view.dom.querySelectorAll('.block-editor-columns-widget > .block-editor-columns-row');
    check("Render 2 rows after adding new rows", rows.length === 2);
    const grip2 = rows[1].querySelector('.block-editor-col-grip');
    check("The second line has grip", !!grip2);
    grip2.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: 120, clientY: 120 }));
    grip2.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, clientX: 120, clientY: 120 }));
    await tick(20);
    const menu2 = document.querySelector('.block-editor-col-menu');
    const btns2 = menu2 ? [...menu2.querySelectorAll('button')] : [];
    check("When there are 2 rows, the menu contains 9 buttons (multi-row sort button)", btns2.length === 9);
    check("The delete entire row button is available when there are 2 rows", btns2.length === 9 && btns2[6].disabled === false);
    btns2[6].dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await tick(60);
    const doc2 = view.state.doc.toString();
    check("After deleting the entire row, the document no longer contains colrow", !doc2.includes('[!colrow]'));
    const rows2 = view.dom.querySelectorAll('.block-editor-columns-widget > .block-editor-columns-row');
    check("Return to 1 row after deleting the entire row", rows2.length === 1);
    view.destroy();
  }

  let fails = 0;
  for (const [name, ok] of results) {
    console.log((ok ? 'PASS ' : 'FAIL ') + name);
    if (!ok) fails++;
  }
  console.log(fails ? `[colrow-spec] ${fails}Item failed` : "[colrow-spec] All passed");
  process.exit(fails ? 1 : 0);
})().catch((e) => {
  console.error('[colrow-spec] CATCH typeof=', typeof e, 'value=', typeof e === 'object' ? JSON.stringify(e) : e);
  if (e && e.stack) console.error('[colrow-spec] CATCH stack:', e.stack);
  console.error(e && e.stack ? e.stack : e);
  process.exit(1);
});
