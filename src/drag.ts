import type { Editor, MarkdownView, TFile } from 'obsidian';
import type { BlockContext, BlockRange, BlockType, CMView } from './types';
import type BlockEditorPlugin from './main';
import { getCM, getIndent, getLines, keepViewport } from './util';
import { columnsWidgetAtPoint } from './columns-preview';
import {
  buildCombinedChanges,
  collectDraggedLines,
  hitColumnsLayout,
  stripQuotePrefixes,
} from './columns-droptarget';
import type { ColDropHit } from './columns-droptarget';

interface DragState {
  editor: Editor;
  file: TFile | null;
  start: number;
  end: number;
  type: BlockType;
  ranges: BlockRange[];
  /** The target editor where the drop point is located; null means it is still in the source editor (or split screen with the same document) */
  targetEditor: Editor | null;
  targetLine: number | null;
  nestCol: number | null;
  /** Reference prefix applied when dragging in a reference/callout (such as `> ` / `>> `), null means no nested references */
  quotePrefix: string | null;
  /** H4 Paste column: -1 paste the left edge of the target block (drag the block to make the left column), 1 paste the right edge (make the right column), null miss */
  edgeSide: -1 | 1 | null;
  /** The first line of the H4 border target block (re-fetch the block during onMouseUp, the document remains unchanged and the line number is stable during dragging) */
  edgeTargetStart: number | null;
  /** The first line of the target that needs to be "listed" when dragging in an ordinary paragraph/title (null means no such nesting) */
  listifyTargetLine: number | null;
  /** Requirement A: Hit the drop point of the column widget (add a new column), null means the column is not hit. */
  colHit: ColDropHit | null;
  /** Requirement A: Hit the widget to which the column belongs (use its range and status when writing back) */
  colWidget: ColumnsWidgetLike | null;
  startY: number;
  startX: number;
  lastX: number;
  lastY: number;
  edgeDir: number;
  scrollTimer: number | null;
  moved: boolean;
}

/**
 * The ColumnsWidget surface actually used by drag.ts (local declaration to avoid formation with columns-preview
 * Type loop: columns-preview does not import drag.ts, and structured subtypes are used to decouple it here). */
interface ColumnsWidgetLike {
  getLayoutInfo(): ReturnType<typeof import('./columns-droptarget').buildColLayout>;
  getLineRange(): { start: number; end: number };
  getRegionStartPos(): number;
  getRegionEndPos(): number;
  hasBreak(): boolean;
  insertColumnAt(insertIndex: number, text: string): boolean;
  buildRegionText(): string;
}


/** Column shell mark (excluded when dragging nested references to prevent the insertion point from falling inside the column and truncating the structure) */
const COL_SHELL_RE = /^\s*>\s*\[!multi-column(?:\|[^\]]*)?\]/;

/** Four-way drop zone: the upper limit of the width of the hot zone on the left and right edges of the target block box */
const EDGE_BAND = 36;
/** When the block is narrow, the lower limit of the sideband is attached to prevent the hot zone from being too small to hit. */
const EDGE_BAND_MIN = 12;
/** Indent the starting point of the nested hot area (the pointer must exceed the left edge of the line text + NEST_OFFSET to be nested) */
const NEST_OFFSET = 24;
/** The number of indented characters for nested insertion (used when the step size is not specified in the settings) */
const NEST_INDENT = 4;
/** When the target is a list/reference/callout, the left sideband shrinks before the starting point of the nesting to avoid competing with the nesting */
const EDGE_BAND_NESTABLE = NEST_OFFSET - 4;
/** Block types that can be used as indented nesting targets (need to give way to edge hot areas) */
const NESTABLE_TYPES = ['list', 'quote', 'callout'];
/** Ordinary paragraph/title: Markdown has no parent-child structure. When dragging in, the target is "listed" and then nested. */
const LISTIFY_TYPES = ['line', 'heading'];

/** Whether it is the drop target of "Indent to sub-block" (list/quote/Callout + ordinary paragraph/title that needs to be listed) */
function isNestTarget(type: BlockType): boolean {
  return NESTABLE_TYPES.includes(type) || LISTIFY_TYPES.includes(type);
}

/** Drag and drop sorting: ghost preview, insertion indicator line, edge auto-scrolling, list nesting/degradation */
export class DragController {
  private state: DragState | null = null;
  private ghostEl: HTMLElement | null = null;
  private indicatorEl: HTMLElement | null = null;
  private edgeLineEl: HTMLElement | null = null;
  private edgeBoxEl: HTMLElement | null = null;
  /** Requirement A: Vertical bar at the position of "Insert new column here" in the column */
  private colSlotEl: HTMLElement | null = null;

  constructor(private ctx: BlockEditorPlugin) {}

  init(): void {
    // The indicator / edge line / stroke box is not hung into the DOM during init, and is dynamically hung into the target editor when used.
    // On .cm-editor: absolute positioning + overflow:hidden physical cropping, not overflowing to the tab bar.
    // Dragging the ghost still hangs on the body, and needs to follow the mouse above all other UIs.
    //
    // Class name division: Appearance base class .block-editor-indicator only cares about appearance (excluding display),
    // Visibility is taken over by the .is-visible state class (see styles.css).
    // The reason why the inline style is not visible or hidden is to make it always controlled by CSS - the inline style will cover the style sheet.
    // When changing CSS, no effect can be seen, and both sides quietly go astray. The drop-point lines of columns-preview also share the same base class.
    // Each independently decides to show or hide without affecting each other.
    const indicator = createEl('div');
    indicator.className = 'block-editor-indicator block-editor-insert-line';
    this.indicatorEl = indicator;
    // H4 Vertical line for welt column division (above the horizontal insertion line, visual distinction: vertical line = welt synthesis)
    const edgeLine = createEl('div');
    edgeLine.className = 'block-editor-edge-line';
    this.edgeLineEl = edgeLine;
    // The overall stroke of the border column target block (together with the vertical line to form a clear visual "this block will be combined into columns",
    // Form a clearly distinguishable distinction from "horizontal insertion line = move" to avoid confusion between the two placement modes)
    const edgeBox = createEl('div');
    edgeBox.className = 'block-editor-edge-box';
    this.edgeBoxEl = edgeBox;
    // Requirement A: Insert a vertical bar in a column (accent color, width 2px, distinguished from edge-line:
    // edge-line is the semantic vertical line of "edge combined column", this article is the insertion position of "insert new column here")
    const colSlot = createEl('div');
    colSlot.className = 'block-editor-col-slot';
    this.colSlotEl = colSlot;
  }

  /**
   * The visibility of the landing point vision (the only entrance).
   *
   * Why not use setCssStyles to write inline display: Inline styles have higher priority than style sheets.
   * Once written in, the effect of the explicit and implicit rules in styles.css can no longer be observed - two lines
   * (Reusable insertion line of drag.ts / one-time drop point line of columns-preview) Although shared
   * Appearance base class, but visibility must be independent and visible in CSS. Uniformly go .is-visible
   * After the status class, there is only one truth about "who is showing": just grep the class name. */
  private setVisual(el: HTMLElement | null, visible: boolean): void {
    el?.classList.toggle('is-visible', visible);
  }

  /** Hide all drop point vision (insertion line/edge line/stroke box/new column vertical bar) */
  private hideAllVisuals(): void {
    this.setVisual(this.indicatorEl, false);
    this.setVisual(this.edgeLineEl, false);
    this.setVisual(this.edgeBoxEl, false);
    this.setVisual(this.colSlotEl, false);
  }

  destroy(): void {
    this.stopAutoScroll();
    this.removeGhost();
    this.indicatorEl?.remove();
    this.indicatorEl = null;
    this.edgeLineEl?.remove();
    this.edgeLineEl = null;
    this.edgeBoxEl?.remove();
    this.edgeBoxEl = null;
    this.colSlotEl?.remove();
    this.colSlotEl = null;
    this.state = null;
    document.body.classList.remove('block-editor-dragging');
  }

  isActive(): boolean {
    return this.state !== null;
  }

  onHandleMouseDown(e: MouseEvent): void {
    const block = this.ctx.handle.currentBlock;
    if (!block) return;

    e.preventDefault();
    e.stopPropagation();

    // Shift + click handle: add/remove blocks to multiple selections
    if (e.shiftKey) {
      this.ctx.selection.toggleSelection(block);
      return;
    }

    const inSelection = this.ctx.selection.isInSelection(block);
    const sel = this.ctx.selection.selection;
    const ranges =
      inSelection && sel
        ? sel.ranges
        : [{ start: block.start, end: block.end, type: block.type }];
    if (!inSelection) this.ctx.selection.clearSelection();

    this.state = {
      editor: block.editor,
      file: block.file,
      start: block.start,
      end: block.end,
      type: block.type,
      ranges,
      targetEditor: null,
      targetLine: null,
      nestCol: null,
      quotePrefix: null,
      edgeSide: null,
      edgeTargetStart: null,
      listifyTargetLine: null,
      colHit: null,
      colWidget: null,
      startY: e.clientY,
      startX: e.clientX,
      lastX: e.clientX,
      lastY: e.clientY,
      edgeDir: 0,
      scrollTimer: null,
      moved: false,
    };
    this.ctx.handle.setDragging(true);
    document.body.classList.add('block-editor-dragging');
  }

  onMouseUp(e: MouseEvent): void {
    const ds = this.state;
    if (!ds) return;
    this.state = null;
    this.stopAutoScroll(ds);
    this.removeGhost();

    this.ctx.handle.setDragging(false);
    document.body.classList.remove('block-editor-dragging');
    this.hideAllVisuals();

    if (!ds.moved) {
      // Treat as click -> open block menu
      this.ctx.menu.openTypeMenu(e, {
        editor: ds.editor,
        file: ds.file,
        start: ds.start,
        end: ds.end,
        type: ds.type,
      });
      return;
    }

    // Requirement A: Drag into columns to add new columns. Placed before the edge column - ds.edgeSide must be null when the column is hit.
    // The two are geometrically mutually exclusive, and the order does not affect the correctness; placing them in front allows "advance column" to take precedence over "edge synthesis".
    if (ds.colHit && ds.colWidget) {
      if (this.commitColumnDrop(ds, ds.colWidget, ds.colHit, e.altKey)) {
        this.ctx.handle.hideHandle();
        return;
      }
    }

    // Four-way drop area·Welt column: If you still hit the welt hot spot (same as the document) when you let go, move the drag block to the target block
    // Synthesize two columns; when synthesis fails (the target has changed/the structure is abnormal), ds.targetLine is still retained
    // The vertical insertion point calculated during dragging naturally falls back to the normal movement branch below.
    if (ds.edgeSide !== null && ds.edgeTargetStart !== null && ds.targetEditor === null) {
      const t = this.ctx.detector.getBlockAtLine(ds.editor, ds.edgeTargetStart);
      if (t && this.ctx.converter.wrapToEdgeColumns(ds.editor, ds.ranges, t, ds.edgeSide)) {
        this.ctx.handle.hideHandle();
        return;
      }
    }

    // Ordinary paragraph/title nesting: list the target and insert sub-items (single-step undo; Alt means copy)
    if (ds.listifyTargetLine != null && ds.nestCol != null && ds.targetEditor === null) {
      this.ctx.ops.nestUnderPlainBlock(
        ds.editor,
        ds.ranges,
        ds.listifyTargetLine,
        ds.nestCol,
        e.altKey
      );
      this.ctx.handle.hideHandle();
      return;
    }

    if (ds.targetLine != null) {
      const cross = ds.targetEditor !== null && ds.targetEditor !== ds.editor;
      if (cross && ds.targetEditor) {
        if (e.altKey) {
          // Cross-document copy: source unchanged
          const lines: string[] = [];
          for (const r of [...ds.ranges].sort((a, b) => a.start - b.start)) {
            lines.push(...getLines(ds.editor, r.start, r.end));
          }
          this.ctx.ops.insertLines(ds.targetEditor, lines, ds.targetLine, ds.nestCol, ds.quotePrefix);
        } else {
          // Cross-document movement: target insertion + source deletion, undoing each file in one step
          this.ctx.ops.moveRangesTo(
            ds.targetEditor,
            ds.editor,
            ds.ranges,
            ds.targetLine,
            ds.nestCol,
            ds.quotePrefix
          );
        }
      } else if (e.altKey) {
        this.ctx.ops.copyRanges(ds.editor, ds.ranges, ds.targetLine, ds.nestCol, ds.quotePrefix);
      } else {
        this.ctx.ops.moveRanges(ds.editor, ds.ranges, ds.targetLine, ds.nestCol, ds.quotePrefix);
      }
    }
    this.ctx.handle.hideHandle();
  }

  /**
   * Implementation of requirement A: Insert the dragged block as a column into the hit.insertIndex position of the target column.
   *
   * Implementation points of single-step undo: Here are "interval rewrite (insert new columns into columns)" + "delete outside the interval (source block)"
   * Two edits must be merged into **the same Transaction**. If you first write back the columns and then delete the source block separately,
   * A two-step undo will occur, and Ctrl+Z can only undo half of it at a time.
   * CM6's state.update({changes: [...]}) accepts multiple edits and rolls back as a whole,
   * Used temp/verify-single-trx.mjs to verify that invert() can be restored cleanly.
   *
   * The source block may be before or after the column interval. The two edits do not overlap each other and CM6 can safely merge them.
   *
   * @param copy Alt = Copy to new column, source block retained
   * @returns Whether it has been submitted (false means that the landing point has expired, and the caller should fall back to normal movement) */
  private commitColumnDrop(
    ds: DragState,
    widget: ColumnsWidgetLike,
    hit: ColDropHit,
    copy: boolean
  ): boolean {
    const cm = getCM(ds.editor);
    if (!cm) return false;

    const lines = collectDraggedLines(ds.editor, ds.ranges);
    const text = stripQuotePrefixes(lines);
    if (!text.trim()) return false;

    const range = widget.getLineRange();
    // The document did not change during dragging, but the review interval did not cross the boundary for safety reasons (this placement point is abandoned when the structure is changed externally)
    const doc = cm.state.doc;
    if (range.start < 0 || range.end >= doc.lines) return false;

    if (!widget.insertColumnAt(hit.insertIndex, text)) return false;

    const changes = buildCombinedChanges(
      widget.getRegionStartPos(),
      widget.getRegionEndPos(),
      widget.buildRegionText(),
      null
    );

    if (!copy) {
      // Delete source blocks: Delete segments one by one in ascending order of line numbers during multi-selection, and each segment contains a newline at the end of the line (same semantics as ops.removeRanges)
      const sorted = [...ds.ranges].sort((a, b) => a.start - b.start);
      for (const r of sorted) {
        const from = doc.line(r.start + 1).from;
        // The last line block cannot have a newline (it will cross the end of the document), and is instead deleted to the end of the current line.
        const to =
          r.end < doc.lines - 1 ? doc.line(r.end + 2).from : doc.line(r.end + 1).to;
        changes.push({ from, to, insert: '' });
      }
    }

    // Viewport locking: Range rewriting + source block deletion will cause CM6 to recalculate the viewport and pin the scrollTop to stop at the original position.
    keepViewport(cm, () => {
      cm.dispatch({ changes });
    });
    return true;
  }

  onDragMove(e: MouseEvent): void {
    const ds = this.state;
    if (!ds) return;

    ds.lastX = e.clientX;
    ds.lastY = e.clientY;

    // Dragging occurs when the displacement exceeds 4px in any direction; it also counts if you have left the source editor (dragging across split screens is almost purely horizontal.
    // The old logic only looked at vertical displacement, resulting in split-screen drag never being able to start, and letting go was treated as a click pop-up menu)
    if (!ds.moved) {
      // M4: The drag threshold takes the set value (default 4px), and if it is less than the threshold, it is considered a click (open the block menu)
      const dist = Math.hypot(e.clientX - ds.startX, e.clientY - ds.startY);
      ds.moved = dist > (this.ctx.settings.dragThreshold || 4) || this.isOutsideSourceEditor(ds, e.clientX, e.clientY);
      if (ds.moved) this.ghostEl = this.createGhost(ds);
    }
    if (!ds.moved) return;
    this.moveGhost(e);

    this.updateDropTarget(ds, e.clientX, e.clientY);
    this.applyActionHint(ds, e.altKey);
    this.updateAutoScroll(ds);
  }

  // Write "what will happen if you let go" to the ghost's data-action, and render it into an action tag that follows the cursor by styles.css
  private applyActionHint(ds: DragState, altKey: boolean): void {
    const el = this.ghostEl;
    if (!el) return;
    const action = this.resolveAction(ds, altKey);
    if (action) el.dataset.action = action;
    else delete el.dataset.action;
  }

  // The action state corresponding to the current landing point; if there is no valid landing point (drag back to itself/invalid area), null will be returned, and the label will not be displayed at this time.
  private resolveAction(ds: DragState, altKey: boolean): string | null {
    // Requirement A: Hit the column → add a new column (this path takes precedence over the edge and is geometrically mutually exclusive)
    if (ds.colHit) return altKey ? 'col-new-copy' : 'col-new';
    // Prioritize side column splitting: let go and directly merge the target block into two columns (this path does not respond to Alt)
    if (ds.edgeSide === -1) return 'column-left';
    if (ds.edgeSide === 1) return 'column-right';
    if (ds.targetLine == null) return null;
    if (ds.targetEditor !== null) return altKey ? 'copy-cross' : 'move-cross';
    if (altKey) return 'copy';
    if (ds.nestCol != null || ds.quotePrefix != null) return 'nest';
    return 'move';
  }

  // Whether the pointer has left the source editor area
  private isOutsideSourceEditor(ds: DragState, x: number, y: number): boolean {
    const cm = getCM(ds.editor);
    if (!cm) return false;
    const r = cm.dom.getBoundingClientRect();
    return x < r.left || x > r.right || y < r.top || y > r.bottom;
  }

  // Calculate the landing point based on the current mouse position and draw the insertion line. The drop point can be the editor of another document (cross-document drag and drop)
  private updateDropTarget(ds: DragState, x: number, y: number): void {
    const over = this.editorAtPoint(x, y);
    if (!over) {
      this.clearDropTarget(ds);
      return;
    }
    const overCm = getCM(over.editor);
    if (!overCm) {
      this.clearDropTarget(ds);
      return;
    }
    // The same document object (such as opening the same file in split screen) is handled by dragging and dropping within the document to avoid confusing line numbers.
    const sameDoc = overCm.state.doc === getCM(ds.editor)?.state.doc;
    const editor = sameDoc ? ds.editor : over.editor;
    const cm = getCM(editor);
    if (!cm) {
      this.clearDropTarget(ds);
      return;
    }
    const cross = !sameDoc;

    // Requirement A: Hit the column widget → add a new column.
    // Must be placed before posAtCoords: widget is the block replacement decoration of ignoreEvent,
    // posAtCoords can only give the replacement position of the entire interval in the column, but cannot get the "which column".
    // A hit means return, and does not enter subsequent line numbers/nesting/edge determination (geometric mutual exclusion).
    if (!cross) {
      const colWidget = columnsWidgetAtPoint(x, y);
      if (colWidget) {
        if (this.tryColumnDropTarget(ds, colWidget, x, y)) return;
        // The column is hit but the qualification verification fails (the drag source is the column itself/overlaps with the interval): no drop point prompt is given
        this.clearDropTarget(ds);
        return;
      }
    }
    // Missed column: clear the remaining column status from the previous round to prevent the pointer from still taking the column-building branch after moving out of the column
    if (ds.colHit !== null) {
      ds.colHit = null;
      ds.colWidget = null;
    }

    const pos = cm.posAtCoords({ x, y });
    if (pos == null) {
      this.clearDropTarget(ds);
      return;
    }

    const doc = cm.state.doc;
    const lineInfo = doc.lineAt(pos);
    const lineIndex = lineInfo.number - 1;
    const lineCoords = cm.coordsAtPos(lineInfo.from);
    if (!lineCoords) {
      this.clearDropTarget(ds);
      return;
    }

    const mid = (lineCoords.top + lineCoords.bottom) / 2;
    let insertAt = y > mid ? lineIndex + 1 : lineIndex;

    // Drag to the right of the list/quote/callout block body: become its subblock
    // When dragging within the document, it does not count if the drop point falls within the dragged range, otherwise "drag it to yourself" will inexplicably add another level of indentation.
    let nestCol: number | null = null;
    let quotePrefix: string | null = null;
    let listifyTargetLine: number | null = null;
    const overSelf = !cross && ds.ranges.some((r) => lineIndex >= r.start && lineIndex <= r.end);
    const target = overSelf ? null : this.ctx.detector.getBlockAtLine(editor, lineIndex);

    // One-step indentation for nested insertion: If the step size is specified in the settings, the setting value will be used, otherwise it will be fixed at 4 characters.
    const indentStep = this.ctx.settings.indentStep > 0 ? this.ctx.settings.indentStep : NEST_INDENT;
    // The left edge of the text in the first line of the dragged block. The nested threshold is based on this (not the left edge of the drop-point line text):
    // The handle is located on the left side of the text. When dragging vertically from the handle, the pointer x is always less than "the starting point of the own text + NEST_OFFSET".
    // Therefore, when moving up and down, it will not be judged as indentation - ensuring that the blocks can be rearranged up and down stably.
    let dragTextLeft: number | null = null;
    if (!cross) {
      const firstRange = [...ds.ranges].sort((a, b) => a.start - b.start)[0];
      const firstCoords = cm.coordsAtPos(doc.line(firstRange.start + 1).from);
      dragTextLeft = firstCoords ? firstCoords.left : null;
    }

    // Four-way landing area: Using the target block visual box as the anchor point to divide the landing points, the two intentions are geometrically mutually exclusive and can be distinguished at a glance--
    // The left and right outer edges → welt columns (vertical lines + target block strokes); the remaining positions → move (horizontal insertion lines).
    // Two gates ensure clear boundaries (no longer confused with "movement"):
    // 1) Vertical: The pointer must fall within the vertical range of the target block - the gaps between blocks will all move backward;
    // 2) Horizontal: The pointer must fall within the left/right outer edge band of the block box (the band is based on the block box and consistent with the hovering highlighted block).
    // When the target is a list/reference/callout, the left band shrinks before the start of the nest to avoid competing with the indented nest.
    if (target && !cross && this.canEdgeColumnSource(ds, target)) {
      const box = this.blockBox(cm, target);
      if (box && y >= box.top - 1 && y <= box.bottom + 1) {
        const width = Math.max(box.right - box.left, 1);
        const band = Math.max(EDGE_BAND_MIN, Math.min(EDGE_BAND, width * 0.22));
        // The hot areas on both sides of nested targets (list/quote/Callout/ordinary paragraph/title) are narrowed.
        // Make way for "indent into sub-blocks" to make way for text area
        const edgeBand = isNestTarget(target.type) ? Math.min(band, EDGE_BAND_NESTABLE) : band;
        const dl = x - box.left;
        const dr = box.right - x;
        const side: -1 | 1 | null =
          dl >= -2 && dl <= edgeBand && dl <= dr
            ? -1
            : dr >= -2 && dr <= edgeBand && dr < dl
              ? 1
              : null;
        if (side !== null) {
          ds.edgeSide = side;
          ds.edgeTargetStart = target.start;
          // Keep the longitudinal insertion point as a backstop: when the welt synthesis fails (the target has changed/the structure is abnormal), the whole piece will not move
          ds.targetLine = insertAt;
          ds.nestCol = null;
          ds.quotePrefix = null;
          ds.targetEditor = null;
          this.showEdgeLine(side, box, cm);
          return;
        }
      }
    }

    // Missing the welt hot spot: clear the possible remaining welt status and vision from the previous round.
    // Otherwise, when the pointer first passes through the welt hot zone and then moves to the normal landing point, when you let go, it will take the welt column branch first (eating out nesting/movement).
    if (ds.edgeSide !== null) {
      ds.edgeSide = null;
      ds.edgeTargetStart = null;
      this.setVisual(this.edgeLineEl, false);
      this.setVisual(this.edgeBoxEl, false);
    }

    if (target && isNestTarget(target.type)) {
      const targetText = editor.getLine(target.start);
      // The nesting threshold is the larger of "left edge of drag block text" and "left edge of target row text" + NEST_OFFSET:
      // - The lower limit includes the left edge of the target: move the pointer to the right side of the target text to nest (the indented block can also be hit by dragging it to a shallower target,
      // If you only drag the left edge of the block, the threshold will be pushed further by its own indentation, which appears as "drag to the right side of the text without nesting");
      // - The lower limit includes the left edge of the drag block: when dragging vertically from the handle, the pointer is always to the left of the left edge of the text itself, and will not be misjudged as nested.
      const targetLeft = cm.coordsAtPos(doc.line(target.start + 1).from)?.left ?? lineCoords.left;
      const nestGate = Math.max(dragTextLeft ?? targetLeft, targetLeft) + NEST_OFFSET;
      // Column shells are not targeted for nesting: dragging to a shell row truncates the column structure
      if (!COL_SHELL_RE.test(targetText) && x > nestGate) {
        const marker = targetText.match(/^(\s*)([-*+]|\d+[.)])\s+/);
        if (marker) {
          // List items: indent to subitems
          nestCol = marker[1].length + indentStep;
          insertAt = target.end + 1;
        } else if (target.type === 'quote' || target.type === 'callout') {
          // Reference/callout nesting: add a layer of `> ` prefix to the dragged line (retain the original indent)
          const qm = targetText.match(/^(\s*)((?:>\s*)+)/);
          if (qm) {
            quotePrefix = qm[1] + qm[2];
            insertAt = target.end + 1;
          }
        } else {
          // Ordinary paragraph/title: Markdown has no parent-child structure, and the drop point triggers the nesting of "list target"
          nestCol = getIndent(targetText).length + indentStep;
          listifyTargetLine = target.start;
          insertAt = target.start + 1;
        }
      }
    }

    // Drag out to the left: When the indentation of the dropped line is shallower, the dragged list item will be demoted to this level.
    if (nestCol == null && !overSelf) {
      const first = [...ds.ranges].sort((a, b) => a.start - b.start)[0];
      const firstLine = ds.editor.getLine(first.start);
      if (/^\s*(?:[-*+]|\d+[.)])\s+/.test(firstLine)) {
        const baseIndent = getIndent(firstLine).length;
        const refIndent = getIndent(editor.getLine(lineIndex)).length;
        if (refIndent < baseIndent) nestCol = refIndent;
      }
    }

    // When the position has not changed (simultaneous movement), no drop point prompt will be given (only when dragging within the document)
    if (!cross) {
      const noMove = ds.ranges.every((r) => insertAt >= r.start && insertAt <= r.end + 1);
      if (noMove && nestCol == null) {
        this.clearDropTarget(ds);
        return;
      }
    }

    ds.targetLine = insertAt;
    ds.nestCol = nestCol;
    ds.quotePrefix = quotePrefix;
    ds.listifyTargetLine = listifyTargetLine;
    ds.targetEditor = cross ? editor : null;

    // The insertion line width takes the editor's "system line width": the content area (.cm-content, that is, the Obsidian readable line width
    // The constrained text column) is filled with the entire column and will no longer change with the length of the target row/current block text.
    // (Otherwise, the rows in the same block are of different lengths, and the drop point indications are sometimes long or short).
    // Hooked to the target editor .cm-editor, absolute positioning + overflow:hidden physical cropping.
    const editorDom = cm.dom;
    const editorRect = editorDom.getBoundingClientRect();
    const contentRect = cm.contentDOM.getBoundingClientRect();
    const left = contentRect.left - editorRect.left;
    const width = Math.max(contentRect.width, 40);

    const yPos = insertAt > lineIndex ? lineCoords.bottom : lineCoords.top;
    if (this.indicatorEl) {
      if (this.indicatorEl.parentElement !== editorDom) editorDom.appendChild(this.indicatorEl);
      this.setVisual(this.indicatorEl, true);
      this.indicatorEl.style.top = yPos - editorRect.top + 'px';
      this.indicatorEl.style.left = left + 'px';
      this.indicatorEl.style.width = width + 'px';
    }
  }

  // The markdown editor where the mouse is located (any split screen), returns null if it is not in any editor
  private editorAtPoint(x: number, y: number): { editor: Editor; file: TFile | null } | null {
    const leaves = this.ctx.app.workspace.getLeavesOfType('markdown');
    for (const leaf of leaves) {
      const view = leaf.view as MarkdownView | null;
      const editor = view?.editor;
      if (!editor) continue;
      const cm = getCM(editor);
      if (!cm) continue;
      const r = cm.dom.getBoundingClientRect();
      if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) {
        return { editor, file: view?.file ?? null };
      }
    }
    return null;
  }

  // Continuous scrolling when dragging to the upper/lower edge of the editing area (scroll to whichever editor you hover over)
  private updateAutoScroll(ds: DragState): void {
    if (!this.ctx.settings.dragAutoScroll) return;
    const scroller = getCM(ds.targetEditor ?? ds.editor)?.scrollDOM;
    if (!scroller) return;

    const r = scroller.getBoundingClientRect();
    const EDGE = 40;
    let dir = 0;
    if (ds.lastY < r.top + EDGE) dir = -1;
    else if (ds.lastY > r.bottom - EDGE) dir = 1;

    if (!dir) {
      this.stopAutoScroll(ds);
      return;
    }
    ds.edgeDir = dir;
    if (ds.scrollTimer) return;

    ds.scrollTimer = window.setInterval(() => {
      const el = getCM(ds.targetEditor ?? ds.editor)?.scrollDOM;
      if (!el) return;
      const before = el.scrollTop;
      el.scrollTop = before + ds.edgeDir * 14;
      // It has rolled to the top/bottom and the landing point will not change.
      if (el.scrollTop !== before) this.updateDropTarget(ds, ds.lastX, ds.lastY);
    }, 16);
  }

  private stopAutoScroll(ds?: DragState): void {
    const s = ds ?? this.state;
    if (!s) return;
    if (s.scrollTimer) {
      window.clearInterval(s.scrollTimer);
      s.scrollTimer = null;
    }
    s.edgeDir = 0;
  }

  private clearDropTarget(ds: DragState): void {
    this.hideAllVisuals();
    ds.targetLine = null;
    ds.nestCol = null;
    ds.quotePrefix = null;
    ds.targetEditor = null;
    ds.edgeSide = null;
    ds.edgeTargetStart = null;
    ds.listifyTargetLine = null;
    ds.colHit = null;
    ds.colWidget = null;
  }

  /**
   * Requirement A: Determination of the point of impact when the pointer hits the column widget + vision.
   *
   * Qualification verification (if any condition is not met, false will be returned and no placement will be given):
   * - The drag source must not be a column shell row or be located inside a column (otherwise it will be equivalent to stuffing the column into its own column)
   * - The drag source interval must not overlap with the target column interval (anti-self-drag)
   * - The dragged content cannot be empty after stripping off the reference prefix (empty columns are meaningless)
   *
   * @returns true indicates that the column drop point has been hit (the caller should return and no longer follow the subsequent line number logic) */
  private tryColumnDropTarget(
    ds: DragState,
    widget: ColumnsWidgetLike,
    x: number,
    y: number
  ): boolean {
    const lines = collectDraggedLines(ds.editor, ds.ranges);
    const text = stripQuotePrefixes(lines);
    if (!text.trim()) return false;

    const range = widget.getLineRange();
    for (const r of ds.ranges) {
      if (COL_SHELL_RE.test(ds.editor.getLine(r.start))) return false;
      if (this.ctx.converter.insideColumns(ds.editor, r)) return false;
      if (r.start <= range.end && range.start <= r.end) return false;
    }

    const hit = hitColumnsLayout(widget.getLayoutInfo(), x, y);
    if (!hit) return false;

    ds.colHit = hit;
    ds.colWidget = widget;
    ds.targetLine = null;
    ds.nestCol = null;
    ds.quotePrefix = null;
    ds.targetEditor = null;
    ds.edgeSide = null;
    ds.edgeTargetStart = null;
    ds.listifyTargetLine = null;
    this.showColumnSlot(hit, widget);
    return true;
  }

  /**
   * Requirement A’s landing point vision:
   * - kind='gap' → draw a vertical line between two columns (reuse edgeLine, clearly "insert in the gap")
   * - kind='before'/'after' → stroke the reference column (reuse edgeBox, the same visual language as the edge column)
   * Add another colSlot bar: when hit, an accent vertical bar is displayed at the inserted position, so that "where it is inserted" can be seen at a glance. */
  private showColumnSlot(hit: ColDropHit, widget: ColumnsWidgetLike): void {
    this.setVisual(this.indicatorEl, false);
    const ds = this.state;
    if (!ds || !hit.box) return;
    // Vertical lines/strokes are hung in the source editor .cm-editor (same as document dragging, coordinates are from the same source; overflow:hidden will be cropped)
    const editorDom = getCM(ds.editor)?.dom;
    if (!editorDom) return;
    const editorRect = editorDom.getBoundingClientRect();
    const top = hit.box.top - editorRect.top;
    const height = `${Math.max(2, hit.box.bottom - hit.box.top)}px`;

    if (hit.kind === 'gap' && this.edgeLineEl) {
      if (this.edgeLineEl.parentElement !== editorDom) editorDom.appendChild(this.edgeLineEl);
      this.setVisual(this.edgeLineEl, true);
      this.edgeLineEl.style.left = `${hit.box.left - editorRect.left}px`;
      this.edgeLineEl.style.top = `${top}px`;
      this.edgeLineEl.style.height = height;
      this.setVisual(this.edgeBoxEl, false);
    } else if (this.edgeBoxEl) {
      if (this.edgeBoxEl.parentElement !== editorDom) editorDom.appendChild(this.edgeBoxEl);
      this.setVisual(this.edgeBoxEl, true);
      this.edgeBoxEl.style.left = `${hit.box.left - editorRect.left}px`;
      this.edgeBoxEl.style.top = `${top}px`;
      this.edgeBoxEl.style.width = `${Math.max(hit.box.right - hit.box.left, 8)}px`;
      this.edgeBoxEl.style.height = height;
      this.setVisual(this.edgeLineEl, false);
    }

    // Insertion position vertical bar: before is drawn on the left edge of the reference column, after/gap is drawn on the right edge of the reference column
    if (this.colSlotEl) {
      const slotX = (hit.kind === 'before' ? hit.box.left : hit.box.right) - editorRect.left;
      if (this.colSlotEl.parentElement !== editorDom) editorDom.appendChild(this.colSlotEl);
      this.setVisual(this.colSlotEl, true);
      this.colSlotEl.style.left = `${slotX - 1}px`;
      this.colSlotEl.style.top = `${top}px`;
      this.colSlotEl.style.height = height;
    }
  }

  /** Judgment of side column target: The target cannot be a blank line, a column shell, or inside a column (to avoid truncating the structure) */
  private isEdgeColumnTarget(editor: Editor, target: BlockRange): boolean {
    if (target.type === 'empty') return false;
    if (COL_SHELL_RE.test(editor.getLine(target.start))) return false;
    return !this.ctx.converter.insideColumns(editor, target);
  }

  /** Qualifications for side columns (target + drag source bidirectional verification, if any one is not clean, normal movement will fall back):
   * The drag source must not be the column shell/located inside the column (otherwise the entire column will be inserted into the new column to form a nested column),
   * And must not overlap with the target range (using min/max to select the range during synthesis will swallow up the middle content). */
  private canEdgeColumnSource(ds: DragState, target: BlockRange): boolean {
    if (!this.isEdgeColumnTarget(ds.editor, target)) return false;
    for (const r of ds.ranges) {
      if (r.start <= target.end && target.start <= r.end) return false;
      if (COL_SHELL_RE.test(ds.editor.getLine(r.start))) return false;
      if (this.ctx.converter.insideColumns(ds.editor, r)) return false;
    }
    return true;
  }

  /** The visual box of the target block: the same anchor point as handle.showHighlight (left = starting point of the first line of text, right = right edge of the content area,
   * Top = top of the first row, bottom = bottom of the last row). Both edge hotspot and target stroke are based on it, ensuring
   * "The hover highlight block seen by the user" == "The drop area of the side column" eliminates confusion caused by inconsistent positioning and caliber. */
  private blockBox(
    cm: CMView,
    block: BlockRange
  ): { top: number; bottom: number; left: number; right: number } | null {
    const doc = cm.state.doc;
    if (block.start < 0 || block.end >= doc.lines) return null;
    const topC = cm.coordsAtPos(doc.line(block.start + 1).from);
    const botC = cm.coordsAtPos(doc.line(block.end + 1).to);
    if (!topC || !botC) return null;
    // Clamp to the visible range of the editor content area: top of coordsAtPos when the first line of the block is close to the top
    // It may be smaller than the upper edge of the content area, causing the border column strokes/vertical lines to overflow upward and cover the tab page.
    const contentRect = cm.contentDOM.getBoundingClientRect();
    return {
      top: Math.max(topC.top, contentRect.top),
      bottom: Math.min(botC.bottom, contentRect.bottom),
      left: topC.left,
      right: contentRect.right,
    };
  }

  /** Draw the side column vision: the overall stroke of the target block + side vertical line (side=-1 sticks to the left, 1 sticks to the right) */
  private showEdgeLine(
    side: -1 | 1,
    box: { top: number; bottom: number; left: number; right: number },
    cm: CMView
  ): void {
    this.setVisual(this.indicatorEl, false);
    // Hang to the target editor .cm-editor, convert viewport coordinates to editor coordinates, overflow:hidden physical cropping
    const editorDom = cm.dom;
    const editorRect = editorDom.getBoundingClientRect();
    const top = box.top - editorRect.top;
    const bottom = box.bottom - editorRect.top;
    const left = box.left - editorRect.left;
    const right = box.right - editorRect.left;
    const h = Math.max(2, bottom - top);
    if (this.edgeLineEl) {
      if (this.edgeLineEl.parentElement !== editorDom) editorDom.appendChild(this.edgeLineEl);
      const x = side === -1 ? left : right;
      this.setVisual(this.edgeLineEl, true);
      this.edgeLineEl.style.left = x + 'px';
      this.edgeLineEl.style.top = top + 'px';
      this.edgeLineEl.style.height = h + 'px';
    }
    if (this.edgeBoxEl) {
      if (this.edgeBoxEl.parentElement !== editorDom) editorDom.appendChild(this.edgeBoxEl);
      this.setVisual(this.edgeBoxEl, true);
      this.edgeBoxEl.style.left = left + 'px';
      this.edgeBoxEl.style.top = top + 'px';
      this.edgeBoxEl.style.width = Math.max(right - left, 8) + 'px';
      this.edgeBoxEl.style.height = h + 'px';
    }
  }

  // Floating preview that follows the mouse when dragging
  private createGhost(ds: DragState): HTMLElement {
    const editor = ds.editor;
    const lines: string[] = [];
    for (const r of [...ds.ranges].sort((a, b) => a.start - b.start)) {
      for (let i = r.start; i <= r.end; i++) lines.push(editor.getLine(i));
    }
    let text = lines.join('\n');
    if (text.length > 300) text = text.slice(0, 300) + ' …';

    const el = createEl('div');
    el.className = 'block-editor-drag-ghost';
    el.textContent = text;
    document.body.appendChild(el);
    return el;
  }

  private moveGhost(e: MouseEvent): void {
    const el = this.ghostEl;
    if (!el) return;
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    let x = e.clientX + 14;
    let y = e.clientY + 14;
    if (x + w > window.innerWidth - 8) x = Math.max(8, e.clientX - w - 14);
    if (y + h > window.innerHeight - 8) y = Math.max(8, e.clientY - h - 14);
    el.style.left = x + 'px';
    el.style.top = y + 'px';
  }

  private removeGhost(): void {
    this.ghostEl?.remove();
    this.ghostEl = null;
  }
}
