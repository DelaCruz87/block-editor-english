import type { Editor } from 'obsidian';
import type { BlockRange, BlockType, CMDoc } from './types';
import { getCM } from './util';

export interface ContainerRange {
  start: number;
  end: number;
  type: 'code' | 'math' | 'table';
}

interface ScanResult {
  doc: CMDoc;
  list: ContainerRange[];
  fmEnd: number;
}

/** Block recognition: fence code blocks / formula blocks / table scan and line-by-line block positioning */
export class BlockDetector {
  private scanCache: ScanResult | null = null;

  // Collect "fence code blocks/formula blocks/tables/attribute area ranges" in a single traversal.
  // CM6 documents are immutable, and the object identity can be directly used as the cache key: changing a word changes the object, and the cache automatically expires.
  getScan(editor: Editor): { list: ContainerRange[]; fmEnd: number } {
    const cm = getCM(editor);
    if (!cm) return { list: [], fmEnd: -1 };
    const doc = cm.state.doc;
    if (this.scanCache && this.scanCache.doc === doc) return this.scanCache;

    const list: ContainerRange[] = [];
    const total = editor.lineCount();
    let fenceStart = -1;
    let fenceChar: string | null = null;
    let mathStart = -1;
    let tableStart = -1;

    // The attribute area (frontmatter) can only appear at the beginning, and the scanning limit is 500 lines to avoid full-text scanning of malformed documents.
    let fmEnd = -1;
    if (/^---\s*$/.test(editor.getLine(0))) {
      const limit = Math.min(total, 500);
      for (let i = 1; i < limit; i++) {
        if (/^---\s*$/.test(editor.getLine(i))) {
          fmEnd = i;
          break;
        }
      }
    }

    for (let i = 0; i < total; i++) {
      const text = editor.getLine(i);

      if (fenceStart !== -1) {
        const m = text.match(/^\s*(`{3,}|~{3,})/);
        if (m && m[1][0] === fenceChar) {
          list.push({ start: fenceStart, end: i, type: 'code' });
          fenceStart = -1;
          fenceChar = null;
        }
        continue;
      }

      if (mathStart !== -1) {
        if (/^\s*\$\$\s*$/.test(text)) {
          list.push({ start: mathStart, end: i, type: 'math' });
          mathStart = -1;
        }
        continue;
      }

      if (tableStart !== -1 && !/^\s*\|/.test(text)) {
        list.push({ start: tableStart, end: i - 1, type: 'table' });
        tableStart = -1;
      }

      const fence = text.match(/^\s*(`{3,}|~{3,})/);
      if (fence) {
        fenceStart = i;
        fenceChar = fence[1][0];
      } else if (/^\s*\$\$\s*$/.test(text)) {
        mathStart = i;
      } else if (/^\s*\|/.test(text) && tableStart === -1) {
        tableStart = i;
      }
    }

    if (fenceStart !== -1) list.push({ start: fenceStart, end: total - 1, type: 'code' });
    if (mathStart !== -1) list.push({ start: mathStart, end: total - 1, type: 'math' });
    if (tableStart !== -1) list.push({ start: tableStart, end: total - 1, type: 'table' });

    this.scanCache = { doc, list, fmEnd };
    return this.scanCache;
  }

  getContainers(editor: Editor): ContainerRange[] {
    return this.getScan(editor).list;
  }

  getFrontmatterEnd(editor: Editor): number {
    return this.getScan(editor).fmEnd;
  }

  findContainerAt(editor: Editor, lineIndex: number): ContainerRange | null {
    for (const c of this.getContainers(editor)) {
      if (lineIndex >= c.start && lineIndex <= c.end) return c;
    }
    return null;
  }

  // The ending line of the last "chunk" before this line + 1, used to prevent the code block from being crossed when backtracking upwards
  getFloorLine(editor: Editor, lineIndex: number): number {
    let floor = 0;
    for (const c of this.getContainers(editor)) {
      if (c.end < lineIndex) floor = Math.max(floor, c.end + 1);
    }
    return floor;
  }

  getBlockAtLine(editor: Editor, lineIndex: number): BlockRange | null {
    const total = editor.lineCount();
    if (lineIndex < 0 || lineIndex >= total) return null;

    // The attribute area (frontmatter) is not given a handle to prevent the entire block from being accidentally deleted.
    const fmEnd = this.getFrontmatterEnd(editor);
    if (fmEnd !== -1 && lineIndex <= fmEnd) return null;

    // Code Block/Formula Block/Table
    const container = this.findContainerAt(editor, lineIndex);
    if (container) return container;

    const line = editor.getLine(lineIndex);

    // Empty row: Still gives handles, making it easy to insert new blocks in place
    if (line.trim() === '') return { start: lineIndex, end: lineIndex, type: 'empty' };

    // Title: counts as one paragraph together with the following text (until the next title of the same level or higher)
    const heading = line.match(/^(\s*)(#{1,6})\s/);
    if (heading) {
      const level = heading[2].length;
      let end = lineIndex;
      for (let i = lineIndex + 1; i < total; i++) {
        const m = editor.getLine(i).match(/^(\s*)(#{1,6})\s/);
        if (m && m[2].length <= level) break;
        end = i;
      }
      while (end > lineIndex && editor.getLine(end).trim() === '') end--;
      return { start: lineIndex, end, type: 'heading' };
    }

    // Quote/Callout: trace back up to the first line of the entire block
    if (/^\s*>/.test(line)) {
      const floor = this.getFloorLine(editor, lineIndex);
      let start = lineIndex;
      while (start > floor && /^\s*>/.test(editor.getLine(start - 1))) start--;
      let end = lineIndex;
      for (let i = lineIndex + 1; i < total; i++) {
        if (/^\s*>/.test(editor.getLine(i))) end = i;
        else break;
      }
      const type: BlockType = /^\s*>\s*\[!/.test(editor.getLine(start)) ? 'callout' : 'quote';
      return { start, end, type };
    }

    // List items (including sub-items)
    const listMatch = line.match(/^(\s*)([-*+]|\d+[.)])\s+/);
    if (listMatch) {
      const indent = listMatch[1].length;
      let end = lineIndex;
      for (let i = lineIndex + 1; i < total; i++) {
        const l = editor.getLine(i);
        if (l.trim() === '') break;
        const ind = (l.match(/^(\s*)/) || ['', ''])[1].length;
        if (ind > indent) end = i;
        else break;
      }
      return { start: lineIndex, end, type: 'list' };
    }

    // Default: single line
    return { start: lineIndex, end: lineIndex, type: 'line' };
  }
}
