import { Plugin, TFile } from 'obsidian';
import type { App } from 'obsidian';
import { BlockDetector } from './block-detect';
import { SelectionManager } from './selection';
import { BlockConverter } from './convert';
import { BlockIdService } from './block-id';
import { BlockOps } from './ops';
import { BlockMenuController } from './block-menu';
import { HandleController } from './handle';
import { DragController } from './drag';
import { SlashSuggest, BlockInserter } from './slash-suggest';
import {
  columnsExtension,
  flushEditingColumns,
  installColumnsFormatBridge,
  uninstallColumnsFormatBridge,
} from './columns-preview';
import {
  blockColorExtension,
  applyBlockColorToDom,
  applyBlockColorFromSource,
  hasBlockColorMarker,
  firstBlockColor,
  setBlockColorVars,
  SOURCE_BLOCK_SELECTOR,
} from './block-color';
import { parseColBgMeta, setColBgVars } from './col-bg';
import { colValignToCss } from './util';
import { registerCommands } from './commands';
import { invalidateNotesWithBlocks } from './picker';
import { installLinkOpenBridge, uninstallLinkOpenBridge } from './link-open';
import { BlockEditorSettingTab, DEFAULT_SETTINGS, applyColumnsCssVars, applyHoverHighlightCssVars } from './settings';
import type { BlockEditorSettings } from './settings';

/**
 * Get the source text of "the current element itself": the text of ctx.getSectionInfo is usually the entire paragraph/entire text,
 * And lineStart/lineEnd are the source code line range (closed range) of the element. Only intercept this paragraph to avoid
 * Tags elsewhere are counted at the head of this element (otherwise each title/paragraph will be misjudged as "marked but not colored").
 * Return the entire text when the line range is out of bounds or unavailable. */
function ownSourceText(
  source: string,
  info: { lineStart: number; lineEnd: number } | null
): string {
  if (!source || !info) return source;
  const lines = source.split('\n');
  if (info.lineStart < 0 || info.lineEnd < info.lineStart || info.lineEnd >= lines.length) {
    return source;
  }
  return lines.slice(info.lineStart, info.lineEnd + 1).join('\n');
}

/** Read the entire file text (source text is used to cover the whole story; duck type judgment TFile is used to avoid errors when the test stub is missing a class) */
async function readVaultText(app: App, path: string): Promise<string> {
  const file = app.vault.getAbstractFileByPath(path);
  if (!(file instanceof TFile)) return '';
  try {
    return await app.vault.cachedRead(file);
  } catch {
    return '';
  }
}

/**
 * Reading mode source text: extract callout's `[!type|meta]` from the paragraph source text in the order of appearance,
 * Backfill to missing `data-callout-metadata` on rendered DOM. Only if the source text matches the DOM's
 * Backfill only when the number and type of callouts are consistent one by one (otherwise the coloring may be misplaced, so I would rather not fill it in).
 * Callouts with existing attributes are not moved and are compatible with Obsidian's regular path of parsing metadata by itself. */
function backfillCalloutMetaFromSource(el: HTMLElement, source: string): void {
  if (!source) return;
  const srcList: { kind: string; meta: string }[] = [];
  const re = /^\s*>+\s*\[!([^\]\n]+)\]/;
  for (const line of source.split('\n')) {
    const m = re.exec(line);
    if (!m) continue;
    let kind = m[1];
    let meta = '';
    const bar = kind.indexOf('|');
    if (bar !== -1) {
      meta = kind.slice(bar + 1).trim();
      kind = kind.slice(0, bar);
    }
    srcList.push({ kind: kind.trim().toLowerCase(), meta });
  }
  if (srcList.length === 0) return;
  const domList = Array.from(el.querySelectorAll<HTMLElement>('.callout[data-callout]'));
  if (domList.length !== srcList.length) return;
  domList.forEach((callout, i) => {
    const src = srcList[i];
    if (!src || callout.getAttribute('data-callout') !== src.kind) return;
    if (!src.meta || callout.getAttribute('data-callout-metadata')) return;
    callout.setAttribute('data-callout-metadata', src.meta);
  });
}

export default class BlockEditorPlugin extends Plugin {
  settings: BlockEditorSettings = { ...DEFAULT_SETTINGS };
  detector = new BlockDetector();
  selection = new SelectionManager(this);
  converter = new BlockConverter(this);
  ids = new BlockIdService(this);
  ops = new BlockOps(this);
  menu = new BlockMenuController(this);
  handle = new HandleController(this);
  drag = new DragController(this);
  inserter = new BlockInserter(this);

  async onload(): Promise<void> {
    await this.loadSettings();
    document.body.classList.toggle('be-columns-live-on', this.settings.livePreviewWidget);
    // M4: Set the default appearance/handle size to the body CSS variable (also consumed by native rendering in reading mode)
    applyColumnsCssVars(this.settings);
    // Block hover highlight color/transparency falls into body CSS variable
    applyHoverHighlightCssVars(this.settings);

    // Link opening position: Closure reading settings ⇒ Changes to settings take effect immediately, no need to reinstall the bridge
    installLinkOpenBridge(this.app, () => this.settings.linkOpenMode);

    this.handle.init();
    this.drag.init();
    this.selection.init();
    registerCommands(this);
    this.registerEditorSuggest(new SlashSuggest(this));
    this.registerEditorExtension(columnsExtension(this));
    this.registerEditorExtension(blockColorExtension(this));

    // Reading mode playback: background color of each column + shell appearance parameters + column width.
    // Obsidian parses the `|key=value` parameter of the callout into the data-callout-metadata attribute:
    // - The bg of subcolumn `[!col|bg=#xxxxxx]` sets the background of the column element, and remains transparent when there is no bg parameter;
    // - Shell `[!multi-column|60-40|gap=12|valign=center|radius=8|border]`:
    // Appearance parameters are written as CSS variables (subcolumn inheritance, connected with var() consumption of styles.css),
    // border adds class to the sub-column; the width supports multi-line grouping `60-40/50-50`, the number is the same as the direct sub-column
    // Set by weighted flex when consistent (consistent with Live Preview ColumnsWidget).
    // Reading mode playback body: The same element may be "synchronized (getSectionInfo source text)" with
    // "Asynchronous (return the entire document content)" is run once each, so local functions are extracted for reuse.
    const applyReadingMode = (
      el: HTMLElement,
      source: string
    ): { blockColor: number; colBg: number } => {
      // H5 arbitrary block color mark playback: independent of column widget switch (%% block-color:<color> %%).
      // Perform accurate DOM playback when there is a DOM carrier (marker not cleaned by Obsidian); otherwise use
      // The source text of the paragraph obtained by ctx.getSectionInfo shall be used for playback (Option 1).
      let blockColor = 0;
      const carriers = el.querySelectorAll('[data-block-color]').length;
      if (carriers > 0) {
        applyBlockColorToDom(el);
        blockColor = carriers;
      } else if (source) {
        blockColor = applyBlockColorFromSource(el, source);
        // Bottom line: The incoming source is the source line range of this element, and if the mark falls within it, it belongs to this element;
        // When anchor point matching fails due to inline format differences, etc., the color falls directly to the element itself.
        if (blockColor === 0 && el.matches(SOURCE_BLOCK_SELECTOR)) {
          const bg = firstBlockColor(source);
          if (bg?.light) {
            setBlockColorVars(el, bg);
            el.setAttribute('data-block-color', bg.light);
            blockColor = 1;
          }
        }
      }
      // When the switch is turned off, the reading mode does not superimpose custom playback (column width/background color/appearance parameters),
      // Consistent with the on/off behavior of the live preview widget: off = native callout display
      if (!this.settings.livePreviewWidget) return { blockColor, colBg: 0 };
      // Column metadata: If Obsidian does not drop `|bg=...` into data-callout-metadata,
      // Use source text to backfill in order, and subsequent playback logic does not need to be changed.
      backfillCalloutMetaFromSource(el, source);
      let colBg = 0;
      el.querySelectorAll('.callout[data-callout="col"]').forEach((callout) => {
        const meta = callout.getAttribute('data-callout-metadata') ?? '';
        // Two-color background: parse bg / bg-dark → write --col-bg-light/--col-bg-dark variables,
        // Consumed by styles.css theme scope (body.theme-dark is taken from dark)
        const bg = parseColBgMeta(meta);
        if (bg) colBg++;
        setColBgVars(callout as HTMLElement, bg);
      });

      el.querySelectorAll('.callout[data-callout="multi-column"]').forEach((shell) => {
        const meta = shell.getAttribute('data-callout-metadata') ?? '';
        const shellEl = shell as HTMLElement;
        // H1 appearance parameters → CSS variables: not set when not written, the subcolumn inherits the default value set on the body
        const gapM = meta.match(/(?:^|\s)gap=(\d+)(?:\s|$)/);
        if (gapM) shellEl.style.setProperty('--be-col-gap', gapM[1] + 'px');
        const valignM = meta.match(/(?:^|\s)valign=(top|center|bottom|stretch)(?:\s|$)/);
        if (valignM) shellEl.style.setProperty('--be-col-valign', colValignToCss(valignM[1]));
        const radiusM = meta.match(/(?:^|\s)radius=(\d+)(?:\s|$)/);
        if (radiusM) shellEl.style.setProperty('--be-col-radius', radiusM[1] + 'px');
        const hasBorder = /(?:^|\s)border(?:\s|$)/.test(meta);

        const content = shell.querySelector(':scope > .callout-content');
        if (!content) return;
        // Collect direct subcolumns grouped by row: Compatible with `.callout-content > .callout[data-callout="col"]`
        // Two structures with `.callout-content > .cm-callout > .callout[data-callout="col"]`;
        // colrow row markers are not rendered but participate in grouping as row separators.
        const rows: HTMLElement[][] = [];
        let cur: HTMLElement[] = [];
        for (const child of Array.from(content.children)) {
          const isCol =
            child.classList.contains('callout') && child.getAttribute('data-callout') === 'col';
          const isRow =
            child.classList.contains('callout') && child.getAttribute('data-callout') === 'colrow';
          if (isRow) {
            if (cur.length) rows.push(cur);
            cur = [];
            continue;
          }
          // Column unit = direct child of .callout-content (same as flex/min-width of styles.css
          // The rules have the same level):
          // - Direct connection structure `.callout-content > .callout[col]`: The column unit is the .callout;
          // - Packaging structure `.callout-content > .cm-callout > .callout[col]`: Real participation
          // For flex layout, the flex/min-width set by CSS is the outer .cm-callout, so it must be pushed
          // outer layer. Previously, the inner layer .callout was pushed, causing the outer layer to be forced by CSS to equalize `flex:1 1 0` and
          // The inline column width weight is invalid; at the same time, align-items only acts on the outer layer, and the inner layer is still stretch →
          // Column width and alignment are invalid under the same structure, which is manifested as "some are valid and some are not valid in the same view".
          const isCmCol =
            !isCol &&
            child.classList.contains('cm-callout') &&
            !!child.querySelector(':scope > .callout[data-callout="col"]');
          if (isCmCol) {
            cur.push(child as HTMLElement);
            continue;
          }
          const cmRow = !isCol && child.classList.contains('cm-callout')
            ? child.querySelector(':scope > .callout[data-callout="colrow"]')
            : null;
          if (cmRow) {
            if (cur.length) rows.push(cur);
            cur = [];
            continue;
          }
          if (isCol) cur.push(child as HTMLElement);
        }
        if (cur.length) rows.push(cur);
        const cols = rows.flat();

        // H1 border: The shell writes the border parameter before adding a stroke to the subcolumn class
        // (Setting the default border is controlled by the body variable --be-col-border, no need to add class)
        if (hasBorder) {
          for (const col of cols) col.classList.add('be-col-border');
        }

        // Width playback: multi-line `60-40/50-50` grouped by line, single line compatible with old `60-40`
        const wm = meta.match(/(?:^|\s)(\d+(?:-\d+)+(?:\/\d+(?:-\d+)+)*)(?:\s|$)/);
        if (!wm) return;
        const groups = wm[1].split('/').map((g) => g.split('-').map((x) => Number(x)));
        const flat = groups.flat();
        if (flat.length !== cols.length || flat.some((w) => !Number.isFinite(w) || w <= 0)) return;
        if (groups.length > 1 && groups.length === rows.length) {
          // Multiple lines: each line applies its own width group
          rows.forEach((row, ri) => {
            const w = groups[ri];
            if (!w || w.length !== row.length) return;
            row.forEach((col, ci) => {
              col.style.flex = `${w[ci]} 1 0%`;
            });
          });
        } else {
          cols.forEach((col, i) => {
            col.style.flex = `${flat[i]} 1 0%`;
          });
        }
      });
      return { blockColor, colBg };
    };

    this.registerMarkdownPostProcessor((el, ctx) => {
      // When rendering for the first time, ctx.getSectionInfo / rendering DOM may not be ready yet (shown as: edit
      // The color does not appear until re-rendering is triggered), so run it once synchronously and then delay and retry as many times as needed.
      const attempt = (n: number): void => {
        let info: { text: string; lineStart: number; lineEnd: number } | null = null;
        try {
          info = typeof ctx.getSectionInfo === 'function' ? ctx.getSectionInfo(el) : null;
        } catch {
          info = null;
        }
        const source = info?.text ?? '';
        // Key: text is often the entire paragraph/entire text, lineStart/lineEnd is the source code line range of this element.
        // Only take the element's own line, otherwise each heading/paragraph will include tags elsewhere.
        const own = ownSourceText(source, info);
        const ownHasMarkers = hasBlockColorMarker(own);
        const hasColMarkup = !!el.querySelector(
          '.callout[data-callout="col"], .callout[data-callout="multi-column"]'
        );
        let r = { blockColor: 0, colBg: 0 };
        try {
          r = applyReadingMode(el, own);
        } catch {
          // Abnormal playback of a single element does not bring down the entire rendering
        }
        // When the section information cannot be obtained (getSectionInfo is null/throws an error), return the entire file content and run again.
        if (!source && ctx.sourcePath && n === 0) {
          void readVaultText(this.app, ctx.sourcePath).then((text) => {
            if (!text) return;
            try {
              applyReadingMode(el, text);
            } catch {
              // Abnormal playback at the bottom of the page does not bring down the entire rendering.
            }
          });
        }
        // This element does have a plug-in tag but has not been colored once, or the paragraph information is empty → delay retry until the DOM/paragraph information is ready
        const shouldRetry =
          n < 3 &&
          el.isConnected &&
          (source === '' || (ownHasMarkers && r.blockColor === 0) || (hasColMarkup && r.colBg === 0));
        if (shouldRetry) window.setTimeout(() => attempt(n + 1), n === 0 ? 0 : 80);
      };
      attempt(0);
    });

    // Mouse movement: Drag first, then decide whether to display the handle
    this.registerDomEvent(
      document,
      'mousemove',
      (e: MouseEvent) => {
        if (this.drag.isActive()) this.drag.onDragMove(e);
        else this.handle.onMouseMove(e);
      },
      true
    );
    // Release: End dragging or pop up the block menu; then take the handle of the cursor block back
    this.registerDomEvent(
      document,
      'mouseup',
      (e: MouseEvent) => {
        this.drag.onMouseUp(e);
        this.handle.updateCursorBlock();
      },
      true
    );
    // After the keyboard moves the cursor, the handle follows the block where the cursor is.
    this.registerDomEvent(document, 'keyup', () => this.handle.updateCursorBlock(), true);
    // Esc ends multiple selection
    this.registerDomEvent(
      document,
      'keydown',
      (e: KeyboardEvent) => {
        if (e.key === 'Escape' && this.selection.selection) this.selection.clearSelection();
      },
      true
    );
    // Scroll/Resize: Hide handles, recalculate highlights and selections
    this.registerDomEvent(
      window,
      'scroll',
      () => {
        this.handle.scheduleHide();
        this.handle.renderHighlight();
        this.selection.renderSelection();
      },
      true
    );
    this.registerDomEvent(window, 'resize', () => {
      this.handle.scheduleHide();
      this.handle.renderHighlight();
      this.selection.renderSelection();
    });
    // After the text is changed, the line number becomes invalid and the selection is cleared.
    this.registerEvent(
      this.app.workspace.on('editor-change', (editor) => {
        const sel = this.selection.selection;
        if (sel && sel.editor === editor) this.selection.clearSelection();
      })
    );
    // Before changing files/switching leaves, write the contents of the column being edited back to the document (blur may not be triggered),
    // And clear the floating layer bound to the previous page (handle/cursor block highlight/multi-select highlight).
    // active-leaf-change covers switching tabs; file-open covers clicking links within the same leaf.
    // Jump to the scene of other notes (the active leaf has not changed at this time and active-leaf-change will not be triggered).
    const onActiveDocumentChange = (): void => {
      flushEditingColumns();
      this.selection.clearSelection();
      // First clear the remaining handle/highlight floating layer from the previous page (it will not be automatically removed when the page switches),
      // Press the new page cursor block again to relocate; the new editor remains hidden when it is not focused.
      this.handle.hideHandle();
      this.handle.updateCursorBlock();
    };
    this.registerEvent(this.app.workspace.on('active-leaf-change', onActiveDocumentChange));
    // file-open will be triggered when any leaf opens a file: the background leaf opens a file (the current active file
    // unchanged) should not interrupt ongoing column editing and will only be processed when the currently active file is open.
    this.registerEvent(
      this.app.workspace.on('file-open', (file) => {
        if (this.app.workspace.getActiveFile()?.path !== file?.path) return;
        onActiveDocumentChange();
      })
    );
    // Write everything back before exiting the application
    this.registerEvent(this.app.workspace.on('quit', () => flushEditingColumns()));
    // After the note content is changed, the cache of "Notes with Block ID" will be invalidated and will be scanned again next time.
    this.registerEvent(this.app.vault.on('modify', () => invalidateNotesWithBlocks()));
    this.registerEvent(this.app.vault.on('create', () => invalidateNotesWithBlocks()));
    this.registerEvent(this.app.vault.on('delete', () => invalidateNotesWithBlocks()));

    this.addSettingTab(new BlockEditorSettingTab(this));

    // Column editing mode format command bridging: Mod+B / right-click "Text Format" and so on to redirect to the column textarea.
    // Avoid writing markup syntax outside the columns. The Editor prototype is created with the view and is idempotently reinstalled when switching documents.
    installColumnsFormatBridge(this.app);
    this.registerEvent(
      this.app.workspace.on('active-leaf-change', () => installColumnsFormatBridge(this.app))
    );
  }

  onunload(): void {
    flushEditingColumns();
    uninstallColumnsFormatBridge();
    uninstallLinkOpenBridge();
    this.drag.destroy();
    this.handle.destroy();
    this.selection.destroy();
  }

  async loadSettings(): Promise<void> {
    const data = (await this.loadData()) as Partial<BlockEditorSettings> | undefined;
    this.settings = { ...DEFAULT_SETTINGS, ...data };
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }
}

// For local CM6 recurrence testing (scripts/cm6-repro.cjs / colrow-spec.cjs)
export { columnsExtension, columnsField, getColumnsDiagnostics } from './columns-preview';
// Regression test hook (scripts/*.cjs reuse; export read-only symbols, does not affect plug-in runtime behavior)
export {
  blockColorField,
  blockColorExtension,
  applyBlockColorToDom,
  applyBlockColorFromSource,
  getBlockColorDiagnostics,
  BLOCK_COLOR_RE,
  BLOCK_COLOR_SPAN_RE,
  parseBlockColorValue,
} from './block-color';
export { BlockConverter } from './convert';
export { buildColumnsMarkdown, planListColumns } from './convert';
export type { ListColumnsPlan } from './convert';
export { buildSlashItems, BlockInserter } from './slash-suggest';
export { slashTrigger, filterSlashItems, isBlockedContext } from './slash-trigger';
export { INSERT_SPECS } from './constants';
export { resolveSnippet, enabledInsertIds, formatDateTime, INSERT_TOGGLE_KEY } from './insert-actions';
export { scanBlockIds } from './picker';
