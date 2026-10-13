import type { Editor, TFile } from 'obsidian';
import type { BlockContext, BlockRange } from './types';
import type BlockEditorPlugin from './main';
import { getCM } from './util';

export interface SelectionState {
  editor: Editor;
  file: TFile | null;
  ranges: BlockRange[];
}

/** Multi-selection block: Shift+click the handle to add/remove and render the highlight layer */
export class SelectionManager {
  selection: SelectionState | null = null;
  private layerEl: HTMLElement | null = null;

  constructor(private ctx: BlockEditorPlugin) {}

  init(): void {
    // The selection layer is not linked to the DOM during init, and is dynamically linked to the current editor during renderSelection.
    // On .cm-editor: absolute positioning + overflow:hidden physical cropping, which will not overflow to the tab bar.
    const layer = createEl('div');
    layer.className = 'block-editor-selection-layer';
    this.layerEl = layer;
  }

  destroy(): void {
    this.layerEl?.remove();
    this.layerEl = null;
    this.selection = null;
  }

  // If the current block participates in multi-selection, the entire selection will be returned, otherwise only itself will be returned.
  actionRanges(block: BlockContext): BlockRange[] {
    const sel = this.selection;
    if (sel && this.isInSelection(block) && sel.ranges.length > 0) return sel.ranges;
    return [{ start: block.start, end: block.end, type: block.type }];
  }

  isInSelection(block: BlockContext): boolean {
    if (!this.selection || this.selection.editor !== block.editor) return false;
    return this.selection.ranges.some((r) => block.start <= r.end && block.end >= r.start);
  }

  toggleSelection(block: BlockContext): void {
    if (!this.selection || this.selection.editor !== block.editor) {
      this.selection = { editor: block.editor, file: block.file, ranges: [] };
    }
    const ranges = this.selection.ranges;
    const idx = ranges.findIndex((r) => r.start === block.start && r.end === block.end);
    if (idx >= 0) ranges.splice(idx, 1);
    else ranges.push({ start: block.start, end: block.end, type: block.type });

    ranges.sort((a, b) => a.start - b.start);
    // Adjacent/overlapping blocks are merged into one segment
    const merged: BlockRange[] = [];
    for (const r of ranges) {
      const last = merged[merged.length - 1];
      if (last && r.start <= last.end + 1) last.end = Math.max(last.end, r.end);
      else merged.push({ start: r.start, end: r.end, type: r.type });
    }
    this.selection.ranges = merged;

    if (!merged.length) this.clearSelection();
    else this.renderSelection();
  }

  clearSelection(): void {
    this.selection = null;
    this.renderSelection();
  }

  renderSelection(): void {
    const layer = this.layerEl;
    if (!layer) return;
    while (layer.firstChild) layer.removeChild(layer.firstChild);

    const sel = this.selection;
    if (!sel) return;
    const cm = getCM(sel.editor);
    if (!cm) return;

    // Hang to the current editor .cm-editor, absolute positioning + overflow:hidden physical cropping
    const editorDom = cm.dom;
    const editorRect = editorDom.getBoundingClientRect();
    if (layer.parentElement !== editorDom) editorDom.appendChild(layer);

    const doc = cm.state.doc;
    for (const r of sel.ranges) {
      // The selection may expire due to document changes, and it will be skipped if it goes out of bounds (doc.line will throw an error if it goes out of bounds)
      if (r.start >= doc.lines || r.end >= doc.lines) continue;
      const from = cm.coordsAtPos(doc.line(r.start + 1).from);
      const below = doc.line(r.end + 1);
      const to = cm.coordsAtPos(below.to);
      if (!from || !to) continue;

      const top = Math.max(from.top - editorRect.top, 0);
      const bottom = Math.min(to.bottom - editorRect.top, editorRect.height);
      if (bottom - top < 4) continue;

      const box = createEl('div');
      box.className = 'block-editor-selection';
      box.style.top = top + 'px';
      box.style.height = bottom - top + 'px';
      box.setCssStyles({ left: '0' });
      box.style.width = editorRect.width + 'px';
      layer.appendChild(box);
    }
  }
}
