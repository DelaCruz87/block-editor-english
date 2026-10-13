import { TEXT } from './strings';
import { Menu, Notice } from 'obsidian';
import type { Editor } from 'obsidian';
import type { BlockContext, TurnIntoType } from './types';
import type BlockEditorPlugin from './main';
import { CALLOUT_TYPES, CODE_LANGS, TURN_INTO } from './constants';
import { openBlockColorPicker } from './block-color';
import { getCM } from './util';

/** There are too many menu items. After adding this class, styles.css will arrange them into two columns to reduce the height of the menu. */
const MENU_GRID_CLASS = 'block-editor-menu-grid';

// The Menu type does not expose dom / scrollEl in typings, but exists at runtime; if missing, it will silently return to a single column.
function useGridLayout(menu: Menu): Menu {
  const m = menu as unknown as { dom?: HTMLElement; scrollEl?: HTMLElement };
  m.dom?.classList.add(MENU_GRID_CLASS);
  m.scrollEl?.classList.add(MENU_GRID_CLASS);
  return menu;
}

/** Block menu: Convert to, Insert, Copy, Move and Delete */
export class BlockMenuController {
  constructor(private ctx: BlockEditorPlugin) {}

  openTypeMenu(e: MouseEvent, block: BlockContext): void {
    this.buildTypeMenu(block).showAtMouseEvent(e);
  }

  buildTypeMenu(block: BlockContext): Menu {
    const editor = block.editor;
    const current: TurnIntoType = ['code', 'table', 'math'].includes(block.type)
      ? (block.type as TurnIntoType)
      : this.ctx.converter.detectType(editor.getLine(block.start) || '');

    const menu = useGridLayout(new Menu());

    // When the clicked block participates in multi-selection, "Convert to" is applied to the entire selection in batches
    const ranges = this.ctx.selection.actionRanges(block);
    const multi = ranges.length > 1;

    for (const [id, title] of TURN_INTO) {
      menu.addItem((mi) => {
        mi.setTitle(title);
        if (!multi && current === id) mi.setChecked(true);
        mi.onClick(() => {
          if (id === 'code') this.openLangMenu(block);
          else if (id === 'callout') this.openCalloutMenu(block);
          else this.ctx.converter.convertRanges(editor, ranges, id);
        });
      });
    }

    // Folding block expanded state switch: only displayed for folded blocks, this item does not appear for non-folded blocks
    const fold = this.ctx.converter.foldStateOf(block);
    if (fold !== null) {
      menu.addItem((mi) =>
        mi
          .setTitle(fold === 'collapsed' ? TEXT.message0015 : TEXT.message0016)
          .onClick(() => this.ctx.converter.toggleFoldState(block))
      );
    }

    menu.addSeparator();
    menu.addItem((mi) => mi.setTitle(TEXT.message0017).onClick(() => this.ctx.ops.insertBlock(block, 'above')));
    menu.addItem((mi) => mi.setTitle(TEXT.message0018).onClick(() => this.ctx.ops.insertBlock(block, 'below')));

    menu.addSeparator();
    menu.addItem((mi) => mi.setTitle(TEXT.message0019).onClick(() => this.ctx.ops.copyBlockContent(block)));
    menu.addItem((mi) =>
      mi.setTitle(TEXT.message0020).onClick(() => this.ctx.ids.copyBlockLink(block))
    );
    menu.addItem((mi) =>
      mi.setTitle(TEXT.message0021).onClick(() => this.ctx.ids.referenceOtherBlock(block))
    );
    menu.addItem((mi) => mi.setTitle(TEXT.message0022).onClick(() => this.ctx.ops.duplicateBlock(block)));

    menu.addSeparator();
    menu.addItem((mi) => mi.setTitle(TEXT.message0023).onClick(() => this.ctx.ops.moveBlockVertically(block, -1)));
    menu.addItem((mi) => mi.setTitle(TEXT.message0024).onClick(() => this.ctx.ops.moveBlockVertically(block, 1)));

    menu.addSeparator();
    if (this.ctx.converter.isColumnsBlock(editor, block)) {
      menu.addItem((mi) => mi.setTitle(TEXT.message0025).onClick(() => this.ctx.converter.addColumn(block)));
      menu.addItem((mi) => mi.setTitle(TEXT.message0026).onClick(() => this.ctx.converter.appendColumnRow(block)));
      menu.addItem((mi) => mi.setTitle(TEXT.message0027).onClick(() => this.ctx.converter.unwrapColumns(block)));
    } else if (this.ctx.converter.insideColumns(editor, block)) {
      // Column internal block: Column and row editing (split/merge/insert/row sort), no more columns are allowed.
      const colState = this.ctx.converter.columnsMenuState(editor, block);
      const canMerge = !!colState && colState.canMerge;
      const multiRow = !!colState && colState.rows.length > 1;
      menu.addItem((mi) => mi.setTitle(TEXT.message0028).onClick(() => this.ctx.converter.splitColumn(block)));
      menu.addItem((mi) =>
        mi
          .setTitle(TEXT.message0029)
          .setDisabled(!canMerge)
          .onClick(() => this.ctx.converter.mergeColumn(block))
      );
      menu.addItem((mi) => mi.setTitle(TEXT.message0030).onClick(() => this.ctx.converter.insertColumn(block)));
      if (multiRow) {
        menu.addSeparator();
        menu.addItem((mi) =>
          mi
            .setTitle(TEXT.message0031)
            .setDisabled(!colState || !colState.canUp)
            .onClick(() => this.ctx.converter.moveColumnRow(block, -1))
        );
        menu.addItem((mi) =>
          mi
            .setTitle(TEXT.message0032)
            .setDisabled(!colState || !colState.canDown)
            .onClick(() => this.ctx.converter.moveColumnRow(block, 1))
        );
      }
      menu.addSeparator();
      menu.addItem((mi) =>
        mi
          .setTitle(TEXT.message0033)
          .setDisabled(true)
      );
      menu.addItem((mi) =>
        mi
          .setTitle(TEXT.message0034)
          .setDisabled(true)
      );
    } else {
      menu.addItem((mi) =>
        mi
          .setTitle(TEXT.message0035)
          .onClick(() => this.ctx.converter.addEmptyColumns(block))
      );
      menu.addItem((mi) =>
        mi
          .setTitle(TEXT.message0036)
          .setDisabled(this.ctx.converter.columnsSegmentCount(block) < 2)
          .onClick(() => this.ctx.converter.wrapBlockToColumns(block))
      );

      // Special for lists: "Combine into columns" cuts segments according to blank lines. There are usually no blank lines between list items → columns cannot be cut.
      // Therefore, the list block is given two additional entries divided by indentation level.
      if (block.type === 'list') {
        const byParent = this.ctx.converter.listColumnCount(block, 'parent');
        const byChild = this.ctx.converter.listColumnCount(block, 'child');
        menu.addItem((mi) =>
          mi
            .setTitle(TEXT.message0037)
            .setDisabled(byParent < 2)
            .onClick(() => this.ctx.converter.wrapListToColumns(block, 'parent'))
        );
        menu.addItem((mi) =>
          mi
            .setTitle(TEXT.message0038)
            .setDisabled(byChild < 2)
            .onClick(() => this.ctx.converter.wrapListToColumns(block, 'child'))
        );
      }
    }

    menu.addSeparator();
    // H5 arbitrary block color mark: set/change/clear (floating layer positioning to select menu item click position)
    const hasColor = this.ctx.converter.blockColorOf(block) !== null;
    menu.addItem((mi) =>
      mi.setTitle(TEXT.message0039).onClick((ev) => {
        openBlockColorPicker({
          x: (ev as MouseEvent).clientX,
          y: (ev as MouseEvent).clientY,
          current: this.ctx.converter.blockColorOf(block),
          onPick: (color) => {
            if (color === null) this.ctx.converter.clearBlockColor(block);
            else if (color !== this.ctx.converter.blockColorOf(block)) this.ctx.converter.setBlockColor(block, color);
          },
        });
      })
    );
    if (hasColor) {
      menu.addItem((mi) =>
        mi.setTitle(TEXT.message0040).onClick(() => this.ctx.converter.clearBlockColor(block))
      );
    }

    menu.addSeparator();
    menu.addItem((mi) => mi.setTitle(TEXT.message0041(this.ctx.ops.blockLength(block))).setDisabled(true));
    menu.addItem((mi) =>
      mi
        .setTitle(block.type === 'heading' ? TEXT.message0042 : TEXT.message0043)
        .onClick(() => this.ctx.ops.deleteBlock(block))
    );

    return menu;
  }

  // There are no mouse events in the command panel, and the menu pops up against the upper left corner of the block.
  openMenuAtCursor(editor: Editor): void {
    const cursor = editor.getCursor();
    const block = this.ctx.detector.getBlockAtLine(editor, cursor.line);
    if (!block) {
      new Notice(TEXT.message0044);
      return;
    }
    const b: BlockContext = {
      editor,
      file: this.ctx.app.workspace.getActiveFile(),
      start: block.start,
      end: block.end,
      type: block.type,
    };
    this.showMenuAtBlock(this.buildTypeMenu(b), b);
  }

  private openLangMenu(block: BlockContext): void {
    const current = block.type === 'code' ? this.ctx.converter.getFenceLang(block) : null;
    const menu = useGridLayout(new Menu());
    for (const [lang, title] of CODE_LANGS) {
      menu.addItem((mi) => {
        mi.setTitle(title);
        if (current === lang) mi.setChecked(true);
        mi.onClick(() =>
          this.ctx.converter.convertRanges(
            block.editor,
            this.ctx.selection.actionRanges(block),
            'code',
            lang
          )
        );
      });
    }
    this.showMenuAtBlock(menu, block);
  }

  // Callout type submenu (applied in batches when multiple selections are made)
  private openCalloutMenu(block: BlockContext): void {
    const m = block.editor.getLine(block.start).match(/\[!([\w-]+)\][+-]?/);
    const current = m ? m[1].toLowerCase() : null;
    const menu = useGridLayout(new Menu());
    for (const [type, title] of CALLOUT_TYPES) {
      menu.addItem((mi) => {
        mi.setTitle(title);
        if (current === type) mi.setChecked(true);
        mi.onClick(() =>
          this.ctx.converter.convertRanges(
            block.editor,
            this.ctx.selection.actionRanges(block),
            'callout',
            type
          )
        );
      });
    }
    this.showMenuAtBlock(menu, block);
  }

  private showMenuAtBlock(menu: Menu, block: BlockContext): void {
    const cm = getCM(block.editor);
    const doc = cm?.state.doc;
    if (cm && doc && block.start < doc.lines) {
      const coords = cm.coordsAtPos(doc.line(block.start + 1).from);
      if (coords) {
        menu.showAtPosition({ x: coords.left, y: coords.bottom + 2 });
        return;
      }
    }
    menu.showAtPosition({ x: 200, y: 200 });
  }
}
