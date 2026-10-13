import type { App, Editor, TFile } from 'obsidian';
import type { BlockDetector } from './block-detect';
import type { SelectionManager } from './selection';
import type { BlockConverter } from './convert';
import type { BlockIdService } from './block-id';
import type { BlockOps } from './ops';
import type { BlockMenuController } from './block-menu';
import type { HandleController } from './handle';
import type { DragController } from './drag';

/** The block shape recognized by getBlockAtLine */
export type DetectedBlockType =
  | 'code'
  | 'math'
  | 'table'
  | 'empty'
  | 'heading'
  | 'quote'
  | 'callout'
  | 'list'
  | 'line';

/** Block types supported by the "Convert to" menu */
export type TurnIntoType =
  | 'paragraph'
  | 'h1'
  | 'h2'
  | 'h3'
  | 'h4'
  | 'h5'
  | 'h6'
  | 'ul'
  | 'ol'
  | 'todo'
  | 'quote'
  | 'callout'
  | 'toggle'
  | 'code'
  | 'mermaid'
  | 'math'
  | 'table'
  | 'divider';

export type BlockType = DetectedBlockType | TurnIntoType;

/** The line range and type of a block in the document (excluding editor references) */
export interface BlockRange {
  start: number;
  end: number;
  type: BlockType;
}

/** Blocks with editor and file references for operations and menus */
export interface BlockContext extends BlockRange {
  editor: Editor;
  file: TFile | null;
}

export type TurnIntoItem = [TurnIntoType, string];

/** Slash "insert class" action id: only insert content, do not change the block type */
export type InsertActionId =
  | 'image'
  | 'audio'
  | 'video'
  | 'pdf'
  | 'date'
  | 'time'
  | 'datetime'
  | 'math'
  | 'inlinecode'
  | 'highlight'
  | 'note'
  | 'embednote'
  | 'blockref'
  | 'blockembed';

/**
 * Execution specifications of insertion actions: determine how BlockInserter gets content and what to insert.
 * To add a new command, just add a line to INSERT_SPECS in constants.ts, and the executor will be dispatched according to kind. */
export type InsertSpec =
  /** Select a media file from the vault (filter by extension) */
  | { kind: 'pick'; exts: string[] }
  /** Insert fixed text; caret = offset of the cursor relative to the insertion starting point (`$$` → 1, falling between two $) */
  | { kind: 'snippet'; text: string; caret: number }
  /** Insert after formatting according to the current time (date/time/datetime) */
  | { kind: 'dynamic'; dyn: 'date' | 'time' | 'datetime' }
  /** Select a note → `[[link]]` or `![[Embed]]` */
  | { kind: 'note'; embed: boolean }
  /** Select a note and then select one of the blocks → `[[Notes#^id]]` or `![[Notes#^id]]` */
  | { kind: 'blockref'; embed: boolean };

/** Uniform entry for slash suggestion: convert block type/insert content */
export type SlashItem =
  | { kind: 'turn'; id: TurnIntoType; title: string }
  | { kind: 'insert'; id: InsertActionId; title: string };

/** The CM6 EditorView surface actually used by this plug-in */
export interface CMLine {
  from: number;
  to: number;
  number: number;
}

export interface CMDoc {
  lines: number;
  line(n: number): CMLine;
  lineAt(pos: number): CMLine;
}

export interface CMView {
  dom: HTMLElement;
  scrollDOM: HTMLElement;
  contentDOM: HTMLElement;
  state: { doc: CMDoc };
  /**
   * Distribute transactions. Note: The value returned by getCM() is the EditorView itself (Editor.cm is the view).
   * It is not a wrapper object that wraps the view - you need to call cm.dispatch(...) directly, there is no cm.view.
   * This is also used when merging multiple paragraph edits into a single transaction (single-step undo). */
  dispatch(spec: { changes: unknown }): void;
  posAtCoords(coords: { x: number; y: number }): number | null;
  coordsAtPos(pos: number): { top: number; bottom: number; left: number; right: number } | null;
  /** Get the DOM node where the document is located, and use it to check the location of .cm-line (find the fold icon) */
  domAtPos(pos: number): { node: Node; offset: number };
  hasFocus(): boolean;
}
