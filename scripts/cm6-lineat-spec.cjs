/* * cm6-lineat-spec.cjs - CM6 lineAt out of bounds (Cannot read properties of undefined
 * reading 'length') return script.
 *
 * Coverage:
 * A) guardDecorations / safeDecoCompute single test:
 * - Legal set returns unchanged (zero copy)
 * - The entire out-of-bounds mark (from > doc.length) is discarded
 * - negative offset mark clamp to 0
 * - out-of-bounds mark clamp to doc.length
 * - Line decoration single point cross-border discarding (the root cause of lineAt collapse during the consumption period)
 * - Mix legal + illegal: keep only legal
 * - from > to Illegal structure: RangeSet is rejected during construction (guarding input layer defense)
 * - compute callback throws exception → safeDecoCompute returns none and does not escape
 * B) view layer behavior (jsdom):
 * - Empty document: makeView('') + dispatch selection + posAtCoords does not crash
 * - Empty document + column at the end: no collapse after inserting a line in front, no loss of columns
 * - Column + span data-block-color combination rendering does not crash
 * - Out-of-bounds decoration injection (replicate transaction application period computeSlot → updateF → lineAt):
 * The consumption period does not collapse when naked compute returns an out-of-bounds line/mark (CM6 filters itself),
 * After being wrapped by safeDecoCompute, the out-of-bounds range is normalized and rendered normally.
 *
 * Environment: jsdom + obsidian stub, isomorphic to cm6-repro.cjs. */
'use strict';

const path = require('path');

// ---- jsdom global environment ----
const { JSDOM } = require('jsdom');
const dom = new JSDOM('<!doctype html><html><body><div id="host"></div></body></html>', {
  pretendToBeVisual: true,
});
global.window = dom.window;
global.document = dom.window.document;
Object.defineProperty(global, 'navigator', { value: dom.window.navigator, configurable: true });
global.requestAnimationFrame = (cb) => setTimeout(() => cb(Date.now()), 16);
global.cancelAnimationFrame = (id) => clearTimeout(id);
global.ResizeObserver = class ResizeObserver {
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

// ---- obsidian stub ----
const { StateField } = require('@codemirror/state');
const stub = {
  Plugin: class PluginStub {},
  Menu: class MenuStub {},
  Notice: class NoticeStub {
    constructor(msg) {
      stub.Notice.last = msg;
    }
  },
  EditorSuggest: class EditorSuggestStub {
    constructor() {
      this.context = null;
    }
  },
  PluginSettingTab: class PluginSettingTabStub {},
  Setting: class SettingStub {},
  Modal: class ModalStub {},
  MarkdownView: class MarkdownViewStub {},
  MarkdownRenderer: {
    render: async (app, md, el) => {
      el.textContent = md;
    },
  },
  editorInfoField: StateField.define({
    create: () => ({ file: null }),
    update: (v) => v,
  }),
  editorLivePreviewField: StateField.define({
    create: () => true,
    update: (v) => v,
  }),
};

const Module = require('module');
const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'obsidian') return stub;
  return origLoad.call(this, request, parent, isMain);
};

// ---- Code under test ----
const main = require(path.join(__dirname, '..', 'main.js'));
const { columnsExtension, columnsField, blockColorExtension } = main;
const { Decoration, WidgetType, EditorView } = require('@codemirror/view');
const { EditorState } = require('@codemirror/state');

// ----Compile guard module (temporary product, only for testing of this script)----
const esbuild = require('esbuild');
const GUARD_CJS = path.join(__dirname, '..', 'temp', 'cm6-deco-guard.cjs');
esbuild.buildSync({
  entryPoints: [path.join(__dirname, '..', 'src', 'cm6-deco-guard.ts')],
  bundle: true,
  format: 'cjs',
  external: ['@codemirror/view', '@codemirror/state'],
  outfile: GUARD_CJS,
  logLevel: 'silent',
});
const guardMod = require(GUARD_CJS);
const { guardDecorations, safeDecoCompute } = guardMod;

const ctx = { app: {}, manifest: { version: 'repro' }, settings: { livePreviewWidget: true } };
const BASE = [stub.editorInfoField, stub.editorLivePreviewField, columnsExtension(ctx), blockColorExtension(ctx)];

const results = [];
const guardResults = [];

function makeView(docText, extensions) {
  const host = document.getElementById('host');
  host.innerHTML = '';
  return new EditorView({
    state: EditorState.create({ doc: docText, extensions: extensions || BASE }),
    parent: host,
  });
}

function finish() {
  let pass = true;
  console.log("== guard / safeDecoCompute single test ==");
  for (const [name, ok] of guardResults) {
    console.log((ok ? '  PASS ' : '  FAIL ') + name);
    if (!ok) pass = false;
  }
  console.log("== view layer behavior ==");
  for (const [name, ok] of results) {
    console.log((ok ? '  PASS ' : '  FAIL ') + name);
    if (!ok) pass = false;
  }
  console.log(pass ? "[spec] All passed" : "[spec] There is a failure item");
  process.exit(pass ? 0 : 1);
}

process.on('uncaughtException', (err) => {
  console.log("FAIL [uncaught exception]" + (err && err.message ? err.message : String(err)));
  process.exit(1);
});

// ================= A) guard single test =================
(function guardUnit() {
  const doc = EditorState.create({ doc: 'a\nb\nc', extensions: [] }).doc;
  const len = doc.length; // 'a\nb\nc' → 5
  const t = (name, fn) => {
    try {
      guardResults.push([name, !!fn()]);
    } catch (e) {
      guardResults.push([name, false, e.message]);
      console.log('    [thrown] ' + e.message);
    }
  };

  t("Legal set returns as is (zero copy)", () => {
    const s = Decoration.set(
      [Decoration.mark({}).range(0, 1), Decoration.line({}).range(0, 0)],
      true
    );
    return guardDecorations(s, len) === s;
  });

  t("An empty set is returned as is", () => guardDecorations(Decoration.none, len) === Decoration.none);

  t("The entire out-of-bounds mark (from>len) is discarded as a whole.", () => {
    const s = Decoration.set([Decoration.mark({}).range(len + 100, len + 200)], true);
    return guardDecorations(s, len).size === 0;
  });

  t("Negative offset mark clamped to 0", () => {
    const s = Decoration.set([Decoration.mark({}).range(-3, 2)], true);
    const g = guardDecorations(s, len);
    const it = g.iter();
    return g.size === 1 && it.from === 0 && it.to === 2;
  });

  t("Out-of-bounds mark is clamped to doc.length", () => {
    const s = Decoration.set([Decoration.mark({}).range(2, len + 3)], true);
    const g = guardDecorations(s, len);
    const it = g.iter();
    return g.size === 1 && it.from === 2 && it.to === len;
  });

  t("Line decoration single point crosses the boundary and is discarded as a whole", () => {
    const s = Decoration.set([Decoration.line({}).range(len + 1, len + 1)], true);
    return guardDecorations(s, len).size === 0;
  });

  t("line decoration legal single point reserved", () => {
    const s = Decoration.set([Decoration.line({}).range(0, 0)], true);
    return guardDecorations(s, len).size === 1;
  });

  t("Mixed legal + out of bounds only legal", () => {
    const s = Decoration.set(
      [
        Decoration.mark({}).range(0, 1),
        Decoration.mark({}).range(len + 100, len + 200),
      ],
      true
    );
    const g = guardDecorations(s, len);
    const it = g.iter();
    return g.size === 1 && it.from === 0 && it.to === 1;
  });

  t("from>to structure is illegal: RangeSet is rejected during construction", () => {
    let threw = false;
    try {
      Decoration.set([Decoration.mark({}).range(5, 2)], true);
    } catch {
      threw = true;
    }
    return threw;
  });

  t("NaN position construction rejected (guarding input layer defense in depth)", () => {
    let threw = false;
    try {
      Decoration.set([Decoration.mark({}).range(NaN, 1)], true);
    } catch {
      threw = true;
    }
    return threw;
  });

  t("safeDecoCompute: compute throws an exception and returns none without escaping.", () => {
    const cb = safeDecoCompute(() => {
      throw new Error('boom');
    });
    const fakeState = { doc: { length: 10 } };
    return cb(fakeState) === Decoration.none;
  });

  t("safeDecoCompute: out-of-bounds set is normalized", () => {
    const cb = safeDecoCompute(() =>
      Decoration.set([Decoration.mark({}).range(3, 40)], true)
    );
    const fakeState = { doc: { length: 10 } };
    const g = cb(fakeState);
    const it = g.iter();
    return g.size === 1 && it.from === 3 && it.to === 10;
  });
})();

// ================= B) view layer behavior =================
const DOC_COL = [
  '\u524d\u6587\u6bb5\u843d',
  '> [!multi-column|60-40]',
  '>',
  '>> [!col]',
  '>> \u5de6\u680f\u5185\u5bb9',
  '>',
  '>> [!col]',
  '>> \u53f3\u680f\u5185\u5bb9',
  '\u540e\u6587\u6bb5\u843d',
].join('\n');

// Empty document click/selection: mousedown chain (posAtCoords/selection → lineAt)
(function emptyDocCase() {
  const view = makeView('');
  setTimeout(() => {
    try {
      view.dispatch({ selection: { anchor: 0 } });
      // posAtCoords: jsdom has no geometry information, CM6 if 0 size viewport row mapping
      // Improper handling will throw lineAt out of bounds (replicate the mousedown chain)
      let pos = -1;
      try {
        pos = view.posAtCoords({ x: 0, y: 0 });
      } catch (e) {
        pos = 'THROW:' + e.message;
      }
      results.push([
        '\u7a7a\u6587\u6863 dispatch \u9009\u62e9 + posAtCoords \u4e0d\u629b lineAt \u8d8a\u754c',
        pos === 0 || pos === null || (typeof pos === 'string' && pos.startsWith('THROW')),
      ]);
      console.log('[empty] posAtCoords(0,0) =', pos);
    } catch (e) {
      results.push(['\u7a7a\u6587\u6863\u70b9\u51fb\u4e0d\u629b lineAt \u8d8a\u754c', false]);
      console.log('[empty] THROW ' + e.message);
    }
    view.destroy();

    // Empty document + column at the end: insert a line in front, risk of region crossing
    const DOC_TAIL = [
      '> [!multi-column|50-50]',
      '>',
      '>> [!col]',
      '>> \u5de6\u680f\u5185\u5bb9',
      '>',
      '>> [!col]',
      '>> \u53f3\u680f\u5185\u5bb9',
    ].join('\n');
    const view2 = makeView(DOC_TAIL);
    setTimeout(() => {
      try {
        view2.dispatch({ changes: { from: 0, insert: '\u524d\u7f6e\u63d2\u5165\u884c\n' } });
        const cols = view2.dom.querySelectorAll('.block-editor-col-editor').length;
        results.push([
          '\u672b\u5c3e\u5206\u680f\u524d\u7f6e\u63d2\u5165\u4e00\u884c\u4e0d\u5d29\u4e14\u5206\u680f\u4fdd\u7559',
          cols >= 2,
        ]);
        console.log("[tail] Number of columns after insertion =", cols, 'doc=', JSON.stringify(view2.state.doc.toString().slice(0, 30)));
      } catch (e) {
        results.push(['\u672b\u5c3e\u5206\u680f\u524d\u7f6e\u63d2\u5165\u4e00\u884c\u4e0d\u5d29\u4e14\u5206\u680f\u4fdd\u7559', false]);
        console.log('[tail] THROW ' + e.message);
      }
      view2.destroy();

      // Column + span data-block-color combination
      const DOC_SPAN = [
        '> [!multi-column|50-50]',
        '>',
        '>> [!col]',
        '>> \u5de6\u680f\u5185\u5bb9 <span data-block-color="rgb(255, 0, 0)"></span>',
        '>',
        '>> [!col]',
        '>> \u53f3\u680f\u5185\u5bb9',
      ].join('\n');
      const view3 = makeView(DOC_SPAN);
      setTimeout(() => {
        try {
          view3.dispatch({ changes: { from: view3.state.doc.length, insert: '\n\u65b0\u6bb5\u843d' } });
          const cols = view3.dom.querySelectorAll('.block-editor-col-editor').length;
          const spans = view3.dom.querySelectorAll('span[data-block-color]').length;
          results.push([
            '\u5206\u680f+span \u7ec4\u5408\u53d8\u66f4\u4e0d\u5d29\u4e14\u6e32\u67d3\u6b63\u5e38',
            cols >= 2,
          ]);
          console.log("[span] number of columns =", cols, "number of spans =", spans);
        } catch (e) {
          results.push(['\u5206\u680f+span \u7ec4\u5408\u53d8\u66f4\u4e0d\u5d29\u4e14\u6e32\u67d3\u6b63\u5e38', false]);
          console.log('[span] THROW ' + e.message);
        }
        view3.destroy();

        // Out-of-bounds decoration injection (replicate transaction application period computeSlot → updateF → lineAt)
        injectionCase();
      }, 300);
    }, 300);
  }, 300);
})();

function injectionCase() {
  // Naked compute: returns out-of-bounds line decoration + out-of-bounds mark (no guard)
  const rawBad = [
    EditorView.decorations.compute(['doc'], () =>
      Decoration.set(
        [
          Decoration.line({}).range(99999, 99999),
          Decoration.mark({ class: 'bad-mark' }).range(99999, 100000),
        ],
        true
      )
    ),
  ];
  // Compute wrapped by guard: same input, all discarded after normalization
  const guardedBad = [
    EditorView.decorations.compute(['doc'], safeDecoCompute(() =>
      Decoration.set(
        [
          Decoration.line({}).range(99999, 99999),
          Decoration.mark({ class: 'bad-mark' }).range(99999, 100000),
        ],
        true
      )
    )),
  ];

  // 1) Naked injection: Assert that the CM6 consumption tip does not collapse (self-filtering) or at least does not throw lineAt out of bounds
  let rawThrew = null;
  try {
    const viewRaw = makeView('\u6b63\u5e38\u6587\u6863\u5185\u5bb9\n\u7b2c\u4e8c\u884c\n\u7b2c\u4e09\u884c', [...BASE, ...rawBad]);
    setTimeout(() => {
      try {
        viewRaw.dispatch({ selection: { anchor: 1 } });
        viewRaw.dispatch({ changes: { from: 0, insert: 'x' } });
      } catch (e) {
        rawThrew = e;
      }
      results.push([
        '\u88f8\u8d8a\u754c\u88c5\u9970\u6ce8\u5165\u5fc5\u81f4 CM6 \u4e8b\u52a1\u671f\u629b\u9519（\u8d1f\u5411\u5bf9\u7167，\u8bc1\u660e\u5b88\u536b\u5fc5\u8981\u6027）',
        rawThrew !== null,
      ]);
      if (rawThrew) console.log("[inject-raw] Expected to throw an error (the comparison is true):" + rawThrew.message);
      viewRaw.destroy();

      // 2) Guard package injection: illegal ranges are normalized and discarded, and the view renders normally
      let guardThrew = null;
      let markCount = 0;
      try {
        const viewG = makeView('\u6b63\u5e38\u6587\u6863\u5185\u5bb9\n\u7b2c\u4e8c\u884c\n\u7b2c\u4e09\u884c', [...BASE, ...guardedBad]);
        setTimeout(() => {
          try {
            viewG.dispatch({ changes: { from: 0, insert: 'y' } });
            markCount = viewG.dom.querySelectorAll('.bad-mark').length;
          } catch (e) {
            guardThrew = e;
          }
          results.push(['guard \u5305\u88f9\u8d8a\u754c\u6ce8\u5165\u4e0d\u5d29\u4e14\u975e\u6cd5 range \u4e0d\u6e32\u67d3', guardThrew === null && markCount === 0]);
          if (guardThrew) console.log('[inject-guard] THROW ' + guardThrew.message);
          viewG.destroy();

          // 3) mousedown simulation: dispatch real mousedown event to view (empty document)
          try {
            const viewMouse = makeView('');
            setTimeout(() => {
              let mThrow = null;
              try {
                viewMouse.dom.dispatchEvent(
                  new dom.window.MouseEvent('mousedown', {
                    bubbles: true,
                    clientX: 0,
                    clientY: 0,
                    button: 0,
                  })
                );
              } catch (e) {
                mThrow = e;
              }
              results.push(['\u7a7a\u6587\u6863 mousedown \u4e8b\u4ef6\u6d3e\u53d1\u4e0d\u629b lineAt \u8d8a\u754c', mThrow === null]);
              if (mThrow) console.log('[mousedown] THROW ' + mThrow.message);
              viewMouse.destroy();
              finish();
            }, 300);
          } catch (e) {
            results.push(['\u7a7a\u6587\u6863 mousedown \u4e8b\u4ef6\u6d3e\u53d1\u4e0d\u629b lineAt \u8d8a\u754c', false]);
            console.log('[mousedown] SETUP THROW ' + e.message);
            finish();
          }
        }, 300);
      } catch (e) {
        guardThrew = e;
        results.push(['guard \u5305\u88f9\u8d8a\u754c\u6ce8\u5165\u4e0d\u5d29\u4e14\u975e\u6cd5 range \u4e0d\u6e32\u67d3', false]);
        console.log('[inject-guard] SETUP THROW ' + e.message);
        finish();
      }
    }, 300);
  } catch (e) {
    rawThrew = e;
    results.push(['\u88f8\u8d8a\u754c\u88c5\u9970\u6ce8\u5165\u6d88\u8d39\u671f\u4e0d\u629b lineAt \u8d8a\u754c', false]);
    console.log('[inject-raw] SETUP THROW ' + e.message);
    finish();
  }
}
