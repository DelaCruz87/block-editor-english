import { TEXT } from './strings';
import { Notice, MarkdownView, Modal } from 'obsidian';
import type { App, Editor } from 'obsidian';
import type { BlockContext } from './types';
import type BlockEditorPlugin from './main';
import { TURN_INTO } from './constants';
import { openBlockColorPicker } from './block-color';
import { getColumnsDiagnostics } from './columns-preview';
import { getCM } from './util';

/** Diagnostic information pop-up window: displayed directly on the screen, and feedback can be obtained by taking a screenshot */
class ColumnsDiagModal extends Modal {
  constructor(
    app: App,
    private json: string
  ) {
    super(app);
    this.titleEl.setText(TEXT.message0123);
  }

  onOpen(): void {
    const pre = this.contentEl.createEl('pre', { text: this.json });
    pre.classList.add('block-editor-diag-pre');
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

export function registerCommands(plugin: BlockEditorPlugin): void {
  plugin.addCommand({
    id: 'move-block-up',
    name: TEXT.message0124,
    editorCallback: (editor) => plugin.ops.moveCurrentBlock(editor, -1),
  });
  plugin.addCommand({
    id: 'move-block-down',
    name: TEXT.message0125,
    editorCallback: (editor) => plugin.ops.moveCurrentBlock(editor, 1),
  });
  plugin.addCommand({
    id: 'open-block-menu',
    name: TEXT.message0126,
    editorCallback: (editor) => plugin.menu.openMenuAtCursor(editor),
  });
  plugin.addCommand({
    id: 'indent-block',
    name: TEXT.message0127,
    editorCallback: (editor) => plugin.ops.indentCurrentBlock(editor, 1),
  });
  plugin.addCommand({
    id: 'outdent-block',
    name: TEXT.message0128,
    editorCallback: (editor) => plugin.ops.indentCurrentBlock(editor, -1),
  });
  plugin.addCommand({
    id: 'copy-block-link',
    name: TEXT.message0129,
    editorCallback: (editor) => plugin.ids.copyCurrentBlockLink(editor),
  });
  plugin.addCommand({
    id: 'reference-block',
    name: TEXT.message0130,
    editorCallback: (editor) => {
      const cursor = editor.getCursor();
      const block = plugin.detector.getBlockAtLine(editor, cursor.line);
      if (!block) {
        new Notice(TEXT.message0131);
        return;
      }
      plugin.ids.referenceOtherBlock({
        editor,
        file: plugin.app.workspace.getActiveFile(),
        start: block.start,
        end: block.end,
        type: block.type,
      });
    },
  });
  plugin.addCommand({
    id: 'duplicate-block',
    name: TEXT.message0132,
    editorCallback: (editor) => plugin.ops.duplicateCurrentBlock(editor),
  });
  plugin.addCommand({
    id: 'clear-block-ids',
    name: TEXT.message0133,
    editorCallback: (editor) => plugin.ids.clearBlockIds(editor),
  });

  plugin.addCommand({
    id: 'debug-columns-dom',
    name: TEXT.message0134,
    callback: () => {
      const mdView = plugin.app.workspace.getActiveViewOfType(MarkdownView);
      if (!mdView) {
        new Notice(TEXT.message0135);
        return;
      }
      const diag = getColumnsDiagnostics();
      const info: Record<string, unknown> = {
        // MarkdownView.getMode() of Live Preview in Obsidian returns "source" (rendering variant),
        // It needs to be combined with the editorLivePreviewField annotation to avoid misreading it as source code mode.
        mode: mdView.getMode() + (diag.livePreview ? ' (live-preview)' : ''),
        file: mdView.file?.path ?? null,
      };
      const cm = getCM(mdView.editor);
      const dom = cm?.dom;
      if (dom) {
        info.widgetCount = dom.querySelectorAll('.block-editor-columns-widget').length;
        info.cmCalloutCount = dom.querySelectorAll('.cm-callout').length;
        info.multiColumnCalloutCount = dom.querySelectorAll(
          '.callout[data-callout="multi-column"]'
        ).length;
        const el =
          dom.querySelector('.cm-callout') ??
          dom.querySelector('.callout[data-callout="multi-column"]');
        info.sample = el ? el.outerHTML.slice(0, 2500) : TEXT.message0136;
      } else {
        info.editorDom = TEXT.message0137;
      }
      info.columnsDetection = diag;
      const json = JSON.stringify(info, null, 2);
      new ColumnsDiagModal(plugin.app, json).open();
      navigator.clipboard.writeText(json).then(() => new Notice(TEXT.message0138)).catch(() => new Notice(TEXT.message0139));
    },
  });

  // The cursor moves to whichever block it stops on, without having to touch the handle first.
  for (const [id, title] of TURN_INTO) {
    plugin.addCommand({
      id: 'turn-into-' + id,
      name: TEXT.message0140 + title,
      editorCallback: (editor) => plugin.converter.convertCurrentBlock(editor, id),
    });
  }

  // H5 arbitrary block color mark: set/clear (no mouse coordinates in the command panel, the floating layer is positioned in the center of the editor viewport)
  const currentBlockOf = (editor: Editor): BlockContext | null => {
    const cursor = editor.getCursor();
    const block = plugin.detector.getBlockAtLine(editor, cursor.line);
    if (!block) {
      new Notice(TEXT.message0141);
      return null;
    }
    return {
      editor,
      file: plugin.app.workspace.getActiveFile(),
      start: block.start,
      end: block.end,
      type: block.type,
    };
  };
  plugin.addCommand({
    id: 'set-block-color',
    name: TEXT.message0142,
    editorCallback: (editor) => {
      const b = currentBlockOf(editor);
      if (!b) return;
      const cm = getCM(editor);
      const rect = cm?.dom.getBoundingClientRect();
      openBlockColorPicker({
        x: (rect?.left ?? 0) + 320,
        y: (rect?.top ?? 0) + 160,
        current: plugin.converter.blockColorOf(b),
        onPick: (color) => {
          if (color === null) plugin.converter.clearBlockColor(b);
          else if (color !== plugin.converter.blockColorOf(b)) plugin.converter.setBlockColor(b, color);
        },
      });
    },
  });
  plugin.addCommand({
    id: 'clear-block-color',
    name: TEXT.message0143,
    editorCallback: (editor) => {
      const b = currentBlockOf(editor);
      if (!b) return;
      plugin.converter.clearBlockColor(b);
    },
  });
}
