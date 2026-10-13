import { TEXT } from './strings';
import { Notice } from 'obsidian';
import type { Editor } from 'obsidian';
import type { BlockContext } from './types';
import type BlockEditorPlugin from './main';
import { ID_WORDS } from './constants';
import { ConfirmModal } from './modal';
import { pickBlock, pickNoteWithBlocks } from './picker';
import { getLines } from './util';

/** Block ID: generate, append, find, clear and block link copy */
export class BlockIdService {
  constructor(private ctx: BlockEditorPlugin) {}

  copyBlockLink(block: BlockContext): void {
    if (!block.file) {
      new Notice(TEXT.message0005);
      return;
    }
    const id = this.ensureBlockId(block);
    navigator.clipboard
      .writeText(`[[${block.file.basename}#^${id}]]`)
      .then(() => new Notice(TEXT.message0006(id)))
      .catch(() => new Notice(TEXT.message0007));
    this.ctx.handle.hideHandle();
  }

  ensureBlockId(block: BlockContext): string {
    const existing = this.findBlockId(block);
    if (existing) return existing;
    const id = this.generateBlockId(block.editor);
    this.attachBlockId(block, id);
    return id;
  }

  // The ID of the structured block must be on a separate line, and it will be regarded as the block content if it is hung on the last line (the code block will also have one less closing fence)
  needsOwnLine(block: BlockContext): boolean {
    switch (block.type) {
      case 'line':
      case 'empty':
      case 'heading':
        return false;
      case 'list':
      case 'quote':
        return block.start !== block.end;
      default:
        return true;
    }
  }

  findBlockId(block: BlockContext): string | null {
    const { editor, end } = block;
    if (!this.needsOwnLine(block)) {
      const m = editor.getLine(end).match(/\s\^([A-Za-z0-9-]+)\s*$/);
      return m ? m[1] : null;
    }
    // The individual ID line may follow the block immediately, or it may be separated by a blank line
    const line = this.findOwnLineIdLine(editor, end);
    if (line === null) return null;
    const m = editor.getLine(line).match(/^\s*\^([A-Za-z0-9-]+)\s*$/);
    return m ? m[1] : null;
  }

  // When the ID of a structured block is an independent line, the line number of the line is returned (immediately after the block or separated by a blank line), otherwise null
  findOwnLineIdLine(editor: Editor, end: number): number | null {
    const last = Math.min(editor.lineCount() - 1, end + 2);
    for (let i = end + 1; i <= last; i++) {
      const line = editor.getLine(i);
      const m = line.match(/^\s*\^([A-Za-z0-9-]+)\s*$/);
      if (m) return i;
      if (line.trim() !== '') break;
    }
    return null;
  }

  attachBlockId(block: BlockContext, id: string): void {
    const { editor, end } = block;
    if (!this.needsOwnLine(block)) {
      editor.setLine(end, editor.getLine(end).replace(/\s*$/, '') + ' ^' + id);
      return;
    }
    // Insert "blank line + ^id + blank line" at the end: the insertion point is the end of the line, and the suffix must start with a newline. All three situations are true.
    editor.replaceRange('\n\n^' + id + '\n', {
      line: end,
      ch: editor.getLine(end).length,
    });
  }

  // Vocabulary + serial number to avoid existing IDs in this article
  generateBlockId(editor: Editor): string {
    const used = new Set<string>();
    for (let i = 0; i < editor.lineCount(); i++) {
      const hits = editor.getLine(i).match(/\^([A-Za-z0-9-]+)/g);
      if (hits) for (const hit of hits) used.add(hit.slice(1));
    }
    for (let i = 0; i < 200; i++) {
      const word = ID_WORDS[Math.floor(Math.random() * ID_WORDS.length)];
      const id = `${word}-${1 + Math.floor(Math.random() * 99)}`;
      if (!used.has(id)) return id;
    }
    return 'block-' + Math.random().toString(36).slice(2, 8);
  }

  // Link to the block where the cursor is located (used in the command panel, does not rely on handles)
  copyCurrentBlockLink(editor: Editor): void {
    const cursor = editor.getCursor();
    const block = this.ctx.detector.getBlockAtLine(editor, cursor.line);
    if (!block) {
      new Notice(TEXT.message0008);
      return;
    }
    this.copyBlockLink({
      editor,
      file: this.ctx.app.workspace.getActiveFile(),
      start: block.start,
      end: block.end,
      type: block.type,
    });
  }

  /** Graphical reference: Select the note containing the block ID → Select the block → Insert the [[target note#^id]] link below the current block */
  referenceOtherBlock(block: BlockContext): void {
    pickNoteWithBlocks(this.ctx.app, (file) => {
      pickBlock(this.ctx.app, file, (id) => {
        // Use a normal link (without !): clickable to jump; with ! is an embedded syntax, and it will not be displayed if the block reference cannot be parsed.
        this.ctx.ops.insertLines(block.editor, [`[[${file.basename}#^${id}]]`], block.end + 1);
        new Notice(TEXT.message0009(id));
      });
    });
  }

  // Clear the block ID of the full text (independent lines and sentence endings), confirm first for destructive operations
  clearBlockIds(editor: Editor): void {
    let removed = 0;
    for (let i = 0; i < editor.lineCount(); i++) {
      const line = editor.getLine(i);
      if (/^\s*\^[A-Za-z0-9-]+\s*$/.test(line)) removed++;
      else if (/\s\^[A-Za-z0-9-]+\s*$/.test(line)) removed++;
    }
    if (!removed) {
      new Notice(TEXT.message0010);
      return;
    }
    new ConfirmModal(
      this.ctx.app,
      TEXT.message0011,
      TEXT.message0012(removed),
      TEXT.message0013,
      () => this.doClearBlockIds(editor)
    ).open();
  }

  private doClearBlockIds(editor: Editor): void {
    const total = editor.lineCount();
    const out: string[] = [];
    let removed = 0;

    for (let i = 0; i < total; i++) {
      let line = editor.getLine(i);
      if (/^\s*\^[A-Za-z0-9-]+\s*$/.test(line)) {
        removed++;
        continue;
      }
      const trailing = line.match(/\s\^[A-Za-z0-9-]+\s*$/);
      if (trailing) {
        line = line.slice(0, trailing.index);
        removed++;
      }
      out.push(line);
    }

    editor.replaceRange(
      out.join('\n'),
      { line: 0, ch: 0 },
      { line: total - 1, ch: editor.getLine(total - 1).length }
    );
    new Notice(TEXT.message0014(removed));
  }
}
