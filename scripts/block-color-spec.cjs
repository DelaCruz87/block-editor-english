/* * block-editor color mark carries transformation regression test (node scripts/block-color-spec.cjs)
 *
 * Coverage (corresponding to the acceptance list of this transformation):
 * A. Real-time preview of CM6 decoration (blockColorField):
 * A1 text paragraph span form <span data-block-color="..."></span> → mark + line decoration
 * A2 stock %% block-color:<c> %% format compatible → mark + line decoration
 * A3 span double value light|dark → line decoration includes --be-block-color-dark
 * A4 empty document → no errors, 0 decorations
 * A5 document end mark (last line without line break) → from/to does not cross the boundary
 * A6 illegal span (not closed) → does not match, does not throw an error
 * B. Reading mode scanning (applyBlockColorToDom):
 * B1 span shape → parent block color (data-block-color + --be-block-color-light)
 * B2 stock %% text form → colored and marked original text cleared
 * B3 stock comment form (<!--...-->) → colored
 * B4 three forms coexist in the same block → only applied once (done deduplication)
 * B5-B11 Source text-driven playback (applyBlockColorFromSource, scenario 1): Marker in DOM is
 * When cleaning Obsidian, it is analyzed based on paragraph source text + text anchor point alignment and coloring
 * C. Write back logic (BlockConverter.setBlockColor/clearBlockColor):
 * C1 blank line is written back to span
 * C2 inventory %% tag cleaned and rewritten span
 * C3 already has span color replacement
 * C4 multi-line block writes back the last line of the block
 * Write back in C5 callout without crash + Column prompt Notice
 * C6 clearBlockColor clear span / %% two forms */
'use strict';

const path = require('path');
const Module = require('module');

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
global.NodeFilter = dom.window.NodeFilter;
global.Node = dom.window.Node;

// ---- obsidian pile ----
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
  SuggestModal: class SuggestModalStub {},
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

const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'obsidian') return stub;
  return origLoad.call(this, request, parent, isMain);
};

// ---- Code under test (build product) ----
const main = require(path.join(__dirname, '..', 'main.js'));
const { blockColorField, applyBlockColorToDom, applyBlockColorFromSource, BlockConverter } = main;
const { EditorState } = require('@codemirror/state');
const { EditorView } = require('@codemirror/view');

// ---- Minimalist assertion ----
let passed = 0;
let failed = 0;
const failures = [];
function ok(cond, name, detail) {
  if (cond) {
    passed++;
    console.log('  PASS', name);
  } else {
    failed++;
    failures.push(name);
    console.error('  FAIL', name, detail !== undefined ? JSON.stringify(detail) : '');
  }
}
function section(name) {
  console.log('\n== ' + name + ' ==');
}

// ================= A. Live preview of CM6 decorations =================
function decosOf(doc) {
  const view = new EditorView({
    state: EditorState.create({ doc, extensions: [blockColorField] }),
    parent: document.getElementById('host'),
  });
  // If there is no transaction in the create phase, update will not be triggered: dispatch empty transaction will force the first full scan to be completed.
  view.dispatch({});
  const deco = view.state.field(blockColorField).decorations;
  const marks = [];
  const lines = [];
  const it = deco.iter();
  while (it.value) {
    const style = it.value.spec.attributes ? it.value.spec.attributes.style : '';
    if (it.from < it.to) marks.push({ from: it.from, to: it.to, style });
    else lines.push({ from: it.from, style });
    it.next();
  }
  view.destroy();
  return { marks, lines };
}

section("A1. Text paragraph span shape decoration");
{
  const doc = '\u6b63\u6587\u6bb5\u843d<span data-block-color="red"></span>';
  const { marks, lines } = decosOf(doc);
  ok(marks.length === 1, "The span tag range should have 1 mark decoration", marks);
  ok(lines.length === 1 && lines[0].from === 0, "There should be 1 line background line decorated with from===0", lines);
  ok(lines[0].style.includes('--be-block-color-light:red'), "line style contains light variable", lines[0].style);
  ok(marks[0].style.includes('display:none'), "span tag body display:none invisible", marks[0].style);
}

section("A2. Stock %% shape decoration");
{
  const doc = '\u6bb5\u843d %% block-color:blue %%';
  const { marks, lines } = decosOf(doc);
  ok(marks.length === 1, "%% mark should have 1 mark decoration", marks);
  ok(lines.length === 1 && lines[0].style.includes('--be-block-color-light:blue'), "line decoration contains light=blue", lines);
}

section("A3. span double value light|dark");
{
  const doc = '\u6b63\u6587<span data-block-color="#f1f3f5|#2a2a2a"></span>';
  const { lines } = decosOf(doc);
  ok(
    lines.length === 1 &&
      lines[0].style.includes('--be-block-color-light:#f1f3f5') &&
      lines[0].style.includes('--be-block-color-dark:#2a2a2a'),
    "The line style also contains light/dark variables",
    lines
  );
}

section("A4. Empty document");
{
  const { marks, lines } = decosOf('');
  ok(marks.length === 0 && lines.length === 0, "Empty document 0 decoration, no error thrown", { marks, lines });
}

section("A5. End of document mark (no line break in the last line)");
{
  const doc = '\u6700\u540e\u4e00\u884c<span data-block-color="green"></span>';
  const { marks, lines } = decosOf(doc);
  const len = doc.length;
  ok(marks.length === 1 && marks[0].to <= len, "mark does not cross the line", { marks, len });
  ok(lines.length === 1 && lines[0].from <= len, "line does not cross the line", { lines, len });
}

section("A6. Illegal span (unclosed) does not match and does not throw an error");
{
  const doc = '\u6b63\u6587<span data-block-color="red"';
  const { marks, lines } = decosOf(doc);
  ok(marks.length === 0 && lines.length === 0, "Unclosed span does not generate decoration", { marks, lines });
}

// ================= B. Reading mode scanning =================
section("B1. span shape → parent block color");
{
  const root = document.createElement('div');
  root.innerHTML = '<p>\u6b63\u6587<span data-block-color="red"></span></p>';
  applyBlockColorToDom(root);
  const p = root.querySelector('p');
  ok(p.getAttribute('data-block-color') === 'red', "Parent block p hits data-block-color=red", p.outerHTML);
  ok(p.style.getPropertyValue('--be-block-color-light') === 'red', "The parent block sets the light variable", p.style.cssText);
}

section("B2. Stock %% text form → color + clean original text");
{
  const root = document.createElement('div');
  root.innerHTML = '<p>\u6b63\u6587 %% block-color:blue %%</p>';
  applyBlockColorToDom(root);
  const p = root.querySelector('p');
  ok(p.getAttribute('data-block-color') === 'blue', "Parent block p hits data-block-color=blue", p.outerHTML);
  ok(!p.textContent.includes('%%'), "Mark original text cleared", p.textContent);
}

section("B3. Stock annotation form → coloring");
{
  const root = document.createElement('div');
  root.innerHTML = '<p>\u6b63\u6587<!--block-color:green--></p>';
  applyBlockColorToDom(root);
  const p = root.querySelector('p');
  ok(p.getAttribute('data-block-color') === 'green', "Annotation shape hit and color", p.outerHTML);
}

section("B4. Three forms coexist → apply only once");
{
  const root = document.createElement('div');
  root.innerHTML =
    '<p>\u6b63\u6587<span data-block-color="red"></span> %% block-color:blue %% <!--block-color:green--></p>';
  applyBlockColorToDom(root);
  const p = root.querySelector('p');
  // span form is hit first, red is applied first; subsequent %% / annotation form is skipped due to done set deduplication
  ok(p.getAttribute('data-block-color') === 'red', "The same block is only applied once (span takes precedence)", p.outerHTML);
}

// ---- Source text-driven playback (Option 1): Markup in the DOM can still be colored even when it is cleaned by Obsidian ----
section("B5. Source text driver: span form (DOM has no data attribute) → parent block coloring");
{
  const root = document.createElement('div');
  root.innerHTML = '<p>\u6b63\u6587mark：\u6587\u672c</p>';
  const n = applyBlockColorFromSource(root, '\u6b63\u6587mark：\u6587\u672c<span data-block-color="#d0ebff"></span>');
  const p = root.querySelector('p');
  ok(n === 1 && p.getAttribute('data-block-color') === '#d0ebff', "The parent block hits data-block-color", p.outerHTML);
  ok(
    p.style.getPropertyValue('--be-block-color-light') === '#d0ebff',
    "The parent block sets the light variable",
    p.style.cssText
  );
}

section("B6. Source text driver: Stock %% form (first line of block) → Coloring");
{
  const root = document.createElement('div');
  root.innerHTML = '<p>\u6bb5\u843d</p>';
  const n = applyBlockColorFromSource(root, '\u6bb5\u843d %% block-color:blue %%');
  ok(n === 1 && root.querySelector('p').getAttribute('data-block-color') === 'blue', "%% form hit", root.innerHTML);
}

section("B7. Source text driver: unmarked blocks in the middle do not string bits");
{
  const root = document.createElement('div');
  root.innerHTML = '<p>\u7b2c\u4e00\u5757</p><p>\u7b2c\u4e8c\u5757</p><p>\u7b2c\u4e09\u5757</p>';
  applyBlockColorFromSource(
    root,
    '\u7b2c\u4e00\u5757<span data-block-color="red"></span>\n\n\u7b2c\u4e8c\u5757\n\n\u7b2c\u4e09\u5757<span data-block-color="green"></span>'
  );
  const ps = root.querySelectorAll('p');
  ok(ps[0].getAttribute('data-block-color') === 'red', "The first piece is colored red", ps[0].outerHTML);
  ok(ps[1].getAttribute('data-block-color') === null, "The second piece was not mistakenly colored", ps[1].outerHTML);
  ok(ps[2].getAttribute('data-block-color') === 'green', "The third piece is colored green", ps[2].outerHTML);
}

section("B8. Source text driven: inline Markdown anchors (**bold**)");
{
  const root = document.createElement('div');
  root.innerHTML = '<p>\u7c97\u4f53\u6587\u672c</p>';
  applyBlockColorFromSource(root, '**\u7c97\u4f53**\u6587\u672c<span data-block-color="red"></span>');
  ok(root.querySelector('p').getAttribute('data-block-color') === 'red', "Still hit after removing the grammar", root.innerHTML);
}

section("B9. Source text driver: Nested container takes the nearest block-level element (li > p)");
{
  const root = document.createElement('div');
  root.innerHTML = '<ul><li><p>\u9879\u76ee\u4e00</p></li></ul>';
  applyBlockColorFromSource(root, '- \u9879\u76ee\u4e00<span data-block-color="red"></span>');
  ok(root.querySelector('p').getAttribute('data-block-color') === 'red', "Color falls to nearest p", root.innerHTML);
  ok(root.querySelector('li').getAttribute('data-block-color') === null, "The outer layer li is not colored", root.innerHTML);
}

section("B10. Source text driver: table row mark (tr)");
{
  const root = document.createElement('div');
  root.innerHTML = '<table><tbody><tr><td>ssd</td><td>sdf</td></tr></tbody></table>';
  applyBlockColorFromSource(root, '| ssd | sdf |<span data-block-color="red"></span>');
  ok(root.querySelector('tbody tr').getAttribute('data-block-color') === 'red', "Table row coloring", root.innerHTML);
}

section("B11. Source text driver: no mark → 0 colors");
{
  const root = document.createElement('div');
  root.innerHTML = '<p>\u666e\u901a\u6bb5\u843d</p>';
  const n = applyBlockColorFromSource(root, '\u666e\u901a\u6bb5\u843d\n\n\u53e6\u4e00\u4e2a\u6bb5\u843d');
  ok(n === 0, "No marking, no coloring", n);
}

// ================= C. Write back logic =================
function makeEditor(initialLines) {
  const lines = initialLines.slice();
  return {
    lines,
    getLine(i) {
      return lines[i];
    },
    setLine(i, s) {
      lines[i] = s;
    },
  };
}
function makeConverter() {
  return new BlockConverter({ handle: { hideHandle() {} } });
}

section("C1. Write blank lines back to span");
{
  const ed = makeEditor(['\u6b63\u6587']);
  makeConverter().setBlockColor({ editor: ed, start: 0, end: 0 }, 'red');
  ok(ed.lines[0] === '\u6b63\u6587<span data-block-color="red"></span>', "Append an empty span at the end of the line", ed.lines[0]);
}

section("C2. Inventory %% tag cleans and rewrites span");
{
  const ed = makeEditor(['\u6b63\u6587 %% block-color:blue %%']);
  makeConverter().setBlockColor({ editor: ed, start: 0, end: 0 }, 'red');
  ok(
    ed.lines[0] === '\u6b63\u6587<span data-block-color="red"></span>' && !ed.lines[0].includes('%%'),
    "%% tags are replaced by span",
    ed.lines[0]
  );
}

section("C3. There is span color replacement");
{
  const ed = makeEditor(['\u6b63\u6587<span data-block-color="blue"></span>']);
  makeConverter().setBlockColor({ editor: ed, start: 0, end: 0 }, 'red');
  ok(ed.lines[0] === '\u6b63\u6587<span data-block-color="red"></span>', "span color is replaced", ed.lines[0]);
}

section("C4. Multi-line block writes back to the last line of the block");
{
  const ed = makeEditor(['\u7b2c\u4e00\u884c', '\u7b2c\u4e8c\u884c']);
  makeConverter().setBlockColor({ editor: ed, start: 0, end: 1 }, 'red');
  ok(ed.lines[0] === '\u7b2c\u4e00\u884c', "The first line remains unchanged", ed.lines[0]);
  ok(ed.lines[1] === '\u7b2c\u4e8c\u884c<span data-block-color="red"></span>', "Append span to the last line", ed.lines[1]);
}

section("C5. Write back in callout without crash + column prompt");
{
  stub.Notice.last = null;
  const ed = makeEditor(['> [!multi-column]', '>', '>> [!col]', '>> \u5185\u5bb9']);
  makeConverter().setBlockColor({ editor: ed, start: 3, end: 3 }, 'red');
  ok(ed.lines[3] === '>> \u5185\u5bb9<span data-block-color="red"></span>', "Write back successfully in callout", ed.lines[3]);
  ok(typeof stub.Notice.last === 'string' && stub.Notice.last.includes('\u5206\u680f'), "Pop up column prompt Notice", stub.Notice.last);
}

section("C6. clearBlockColor clear span / %% two forms");
{
  const ed1 = makeEditor(['\u6b63\u6587<span data-block-color="red"></span>']);
  makeConverter().clearBlockColor({ editor: ed1, start: 0, end: 0 });
  ok(ed1.lines[0] === '\u6b63\u6587', "clear span form", ed1.lines[0]);

  const ed2 = makeEditor(['\u6b63\u6587 %% block-color:blue %%']);
  makeConverter().clearBlockColor({ editor: ed2, start: 0, end: 0 });
  ok(ed2.lines[0] === '\u6b63\u6587', "Clear %% form", ed2.lines[0]);
}

// ---- Summary ----
console.log("==== Summary:" + passed + ' passed, ' + failed + ' failed ====');
if (failed > 0) {
  console.error("Failure use case:");
  for (const f of failures) console.error('  - ' + f);
  process.exit(1);
}
