import type { Editor } from 'obsidian';
import type { BlockContext, BlockRange, CMView } from './types';
import type BlockEditorPlugin from './main';
import { HANDLE_W } from './constants';
import { getCM, getEditorFromContent } from './util';
import { computeHandleLeft } from './handle-layout';

/** Notion-style block handle: hover display, cursor follow, drag entry */
export class HandleController {
  /** One-time diagnostic switch: only hit the first item to avoid refreshing the screen when hovering */
  private static dodgeLogged = false;
  private handleEl: HTMLElement | null = null;
  private highlightEl: HTMLElement | null = null;
  private hideTimer: number | null = null;
  currentBlock: BlockContext | null = null;
  private cursorBlock: BlockContext | null = null;

  constructor(private ctx: BlockEditorPlugin) {}

  init(): void {
    // Highlight/handle is not hung into DOM during init, but during showHighlight/showHandle
    // Dynamically hang on the .cm-editor of the current editor: .cm-editor has overflow:hidden,
    // Absolutely positioned highlights are physically clipped within the editor's viewable area and will never overflow into the tab bar.
    const highlight = createEl('div');
    highlight.className = 'block-editor-hover-block';
    this.highlightEl = highlight;

    const handle = createEl('div');
    handle.className = 'block-editor-handle';

    const svg = createSvg('svg');
    svg.setAttribute('class', 'block-editor-handle-dots');
    svg.setAttribute('width', '14');
    svg.setAttribute('height', '14');
    svg.setAttribute('viewBox', '0 0 16 16');
    for (const [cx, cy] of [
      [5, 4],
      [11, 4],
      [5, 8],
      [11, 8],
      [5, 12],
      [11, 12],
    ]) {
      const circle = createSvg('circle');
      circle.setAttribute('cx', String(cx));
      circle.setAttribute('cy', String(cy));
      circle.setAttribute('r', '1.3');
      svg.appendChild(circle);
    }

    handle.appendChild(svg);
    this.handleEl = handle;

    this.ctx.registerDomEvent(handle, 'mousedown', (e) => this.ctx.drag.onHandleMouseDown(e));
    this.ctx.registerDomEvent(handle, 'mouseenter', () => this.clearHideTimer());
    this.ctx.registerDomEvent(handle, 'mouseleave', () => this.scheduleHide());
  }

  destroy(): void {
    this.clearHideTimer();
    this.handleEl?.remove();
    this.handleEl = null;
    this.highlightEl?.remove();
    this.highlightEl = null;
    this.currentBlock = null;
    this.cursorBlock = null;
  }

  onMouseMove(e: MouseEvent): void {
    if (!this.ctx.settings.showHandle) return;

    const target = e.target;
    if (!(target instanceof HTMLElement)) return;

    // Mouse over handle: keep display
    if (this.handleEl?.contains(target)) {
      this.clearHideTimer();
      return;
    }

    const cmEl = target.closest('.cm-content');
    const cmContent = cmEl instanceof HTMLElement ? cmEl : null;
    if (!cmContent) {
      this.scheduleHide();
      return;
    }

    const found = getEditorFromContent(this.ctx.app, cmContent);
    if (!found) {
      this.scheduleHide();
      return;
    }
    const editor = found.editor;

    const cm = getCM(editor);
    if (!cm) {
      this.scheduleHide();
      return;
    }

    const pos = cm.posAtCoords({ x: e.clientX, y: e.clientY });
    if (pos == null) {
      this.scheduleHide();
      return;
    }

    const lineIndex = cm.state.doc.lineAt(pos).number - 1;
    const block = this.ctx.detector.getBlockAtLine(editor, lineIndex);
    if (!block) {
      this.scheduleHide();
      return;
    }

    this.clearHideTimer();
    this.currentBlock = {
      editor,
      file: found.file,
      start: block.start,
      end: block.end,
      type: block.type,
    };
    this.showHandle(editor, block);
  }

  showHandle(editor: Editor, block: BlockRange): void {
    if (!this.ctx.settings.showHandle) return;
    const cm = getCM(editor);
    if (!cm) return;
    const doc = cm.state.doc;
    // The document may have been shortened (deleted/undone), and the old line number will be out of bounds and an error will be thrown.
    if (block.start < 0 || block.start >= doc.lines) {
      this.hideHandle();
      return;
    }
    const line = doc.line(block.start + 1);
    const coords = cm.coordsAtPos(line.from);
    if (!coords) {
      this.hideHandle();
      return;
    }

    // Hang on the current editor .cm-editor: absolute positioning + overflow:hidden physical cropping,
    // Handles/highlights never overflow into the tab bar
    const editorDom = cm.dom;
    const editorRect = editorDom.getBoundingClientRect();

    const lineH = coords.bottom - coords.top || 20;
    // M4: The handle size takes the set value (default fallback constant 20), consistent with --be-handle-size of styles.css
    const handleSize = this.ctx.settings.handleSize || HANDLE_W;

    const foldLeft = this.findFoldIndicatorLeft(cm, line.from);
    // Under Live Preview, the Obsidian fold icon is drawn on the left side of the list/title line:
    // The handle must be arranged on the left side of the icon, otherwise the two will overlap (if the icon is covered, you cannot click to collapse it).
    // The folding icon only appears when there are sub-items, so it is measured in real time according to the row, and if it is not measured, it returns to the left side of the first row.
    const layout = computeHandleLeft({
      lineLeft: coords.left,
      foldLeft,
      editorLeft: editorRect.left,
      editorWidth: editorRect.width,
      handleSize,
    });

    // One-time diagnosis: Confirm whether the avoidance is effective (foldLeft is null when the fold icon cannot be reached)
    if (!HandleController.dodgeLogged) {
      HandleController.dodgeLogged = true;
      console.log('[block-editor] handle-dodge:', {
        type: block.type,
        lineLeft: Math.round(coords.left),
        foldLeft: foldLeft == null ? null : Math.round(foldLeft),
        left: Math.round(layout.left),
        size: layout.size,
        squeezed: layout.squeezed,
      });
    }

    const top = coords.top - editorRect.top + (lineH - layout.size) / 2;

    if (this.handleEl) {
      if (this.handleEl.parentElement !== editorDom) editorDom.appendChild(this.handleEl);
      this.handleEl.setCssStyles({ position: 'absolute', display: 'flex' });
      this.handleEl.style.top = top + 'px';
      this.handleEl.style.left = layout.left + 'px';
      // When there is not enough space on the left side, the handle is compressed by the available width (instead of letting it press back onto the collapse icon).
      // When there is room, layout.size === handleSize, which is the same value as the CSS variable --be-handle-size.
      this.handleEl.style.width = layout.size + 'px';
      this.handleEl.style.height = layout.size + 'px';
      this.handleEl.classList.toggle('is-squeezed', layout.squeezed);
    }
    this.showHighlight(editor, block);
  }

  /**
   * Get the viewport x on the left edge of the fold icon (`.list-collapse-indicator` / `.collapse-indicator`) in this row.
   * If the amount is less than the amount (no icon in source code mode, icon not rendered, hidden element rect is all 0), null will be returned.
   * Return the old position of "left side of the first line" by computeHandleLeft. */
  private findFoldIndicatorLeft(cm: CMView, pos: number): number | null {
    try {
      const at = cm.domAtPos(pos);
      let node: Node | null = at.node;
      let lineEl: HTMLElement | null = null;
      while (node) {
        if (node instanceof HTMLElement && node.classList.contains('cm-line')) {
          lineEl = node;
          break;
        }
        node = node.parentNode;
      }
      if (!lineEl) return null;
      const ind = lineEl.querySelector('.list-collapse-indicator, .collapse-indicator');
      if (!(ind instanceof HTMLElement)) return null;
      const r = ind.getBoundingClientRect();
      // The width and height of the hidden element (display:none) is 0: it cannot be regarded as a valid measurement, otherwise the handle will stick to the left edge
      if (r.width <= 0 || r.height <= 0) return null;
      return r.left;
    } catch {
      return null;
    }
  }

  setDragging(on: boolean): void {
    this.handleEl?.classList.toggle('is-dragging', on);
    if (on) this.hideHighlight();
  }

  hideHandle(): void {
    if (this.ctx.drag.isActive()) return;
    if (this.handleEl) this.handleEl.setCssStyles({ display: 'none' });
    this.hideHighlight();
    this.currentBlock = null;
  }

  // After scrolling/window changes, the highlighted position is recalculated according to the current block; it is not displayed when dragging or the handle is closed.
  renderHighlight(): void {
    if (!this.ctx.settings.showHandle || this.ctx.drag.isActive() || !this.currentBlock) {
      this.hideHighlight();
      return;
    }
    this.showHighlight(this.currentBlock.editor, this.currentBlock);
  }

  // The light color highlight of the corresponding block of the handle provides visual feedback on "which block is about to be operated"
  private showHighlight(editor: Editor, block: BlockRange): void {
    // Set highlights not to show when turned off (and erase any layers that may have been shown)
    if (!this.ctx.settings.blockHoverHighlight) {
      this.hideHighlight();
      return;
    }
    const el = this.highlightEl;
    if (!el) return;
    const cm = getCM(editor);
    if (!cm) return;
    const doc = cm.state.doc;
    if (block.start < 0 || block.end >= doc.lines) {
      this.hideHighlight();
      return;
    }
    const from = cm.coordsAtPos(doc.line(block.start + 1).from);
    const below = doc.line(block.end + 1);
    const to = cm.coordsAtPos(below.to);
    if (!from || !to) {
      this.hideHighlight();
      return;
    }
    // Hang to the current editor .cm-editor, use absolute positioning + overflow:hidden physical cropping:
    // Highlights will never overflow the editor's viewable area, fundamentally preventing them from covering the tab bar.
    // Coordinates are converted from viewport system to editor system (minus the top/left of editorRect).
    const editorDom = cm.dom;
    const editorRect = editorDom.getBoundingClientRect();
    // The width reference is the content area (.cm-content, that is, line width) rather than the entire .cm-editor:
    // .cm-editor contains left and right margins. Using its right edge will cause the highlighted right side to exceed the line width.
    const contentRect = cm.contentDOM.getBoundingClientRect();
    if (el.parentElement !== editorDom) editorDom.appendChild(el);

    const top = Math.max(from.top - editorRect.top, 0);
    const bottom = Math.min(to.bottom - editorRect.top, editorRect.height);
    if (bottom - top < 4) {
      this.hideHighlight();
      return;
    }
    el.setCssStyles({ position: 'absolute', display: 'block' });
    el.style.top = top + 'px';
    el.style.height = bottom - top + 'px';
    el.style.left = from.left - editorRect.left + 'px';
    el.style.width = Math.max(contentRect.right - from.left, 8) + 'px';
  }

  private hideHighlight(): void {
    if (this.highlightEl) this.highlightEl.setCssStyles({ display: 'none' });
  }

  scheduleHide(): void {
    this.clearHideTimer();
    this.hideTimer = window.setTimeout(() => this.fallbackHandle(), 150);
  }

  private clearHideTimer(): void {
    if (this.hideTimer !== null) {
      window.clearTimeout(this.hideTimer);
      this.hideTimer = null;
    }
  }

  // The mouse does not disappear directly after leaving it, but returns to the handle of the "block where the cursor is located"
  private fallbackHandle(): void {
    this.hideTimer = null;
    if (this.ctx.drag.isActive()) return;
    if (!this.ctx.settings.handleFollowsCursor) {
      this.hideHandle();
      return;
    }
    const cb = this.cursorBlock;
    if (cb && cb.editor && getCM(cb.editor)) {
      this.currentBlock = cb;
      this.showHandle(cb.editor, cb);
      return;
    }
    this.hideHandle();
  }

  // The handle of the block where the cursor is located is always displayed (only takes effect when the editor itself has focus)
  updateCursorBlock(): void {
    if (this.ctx.drag.isActive()) return;
    const block = this.getCursorBlock();
    this.cursorBlock = block;
    // The cursor block cannot be retrieved (switching pages/editor is out of focus): handles and highlights are on the body
    // fixed The floating layer will not be automatically removed when the page switches. The residue of the previous page must be cleared here.
    if (!block) {
      this.hideHandle();
      return;
    }
    if (!this.ctx.settings.handleFollowsCursor) return;
    this.currentBlock = block;
    this.showHandle(block.editor, block);
  }

  getCursorBlock(): BlockContext | null {
    const active = this.ctx.app.workspace.activeEditor;
    const editor = active?.editor;
    if (!editor) return null;
    const cm = getCM(editor);
    if (!cm) return null;
    if (typeof cm.hasFocus === 'function' && !cm.hasFocus()) return null;

    const cursor = editor.getCursor();
    const block = this.ctx.detector.getBlockAtLine(editor, cursor.line);
    if (!block) return null;
    return {
      editor,
      file: active.file ?? this.ctx.app.workspace.getActiveFile(),
      start: block.start,
      end: block.end,
      type: block.type,
    };
  }
}
