import { TEXT } from './strings';
import { EditorSuggest } from 'obsidian';
import type {
  Editor,
  EditorPosition,
  EditorSuggestContext,
  EditorSuggestTriggerInfo,
  TFile,
} from 'obsidian';
import type BlockEditorPlugin from './main';
import type { BlockContext, InsertActionId, SlashItem } from './types';
import { INSERT_ACTIONS, INSERT_SPECS, TURN_INTO, DEFAULT_DATE_FORMAT, DEFAULT_TIME_FORMAT } from './constants';
import { pickBlock, pickFile, pickNote, pickNoteWithBlocks } from './picker';
import { enabledInsertIds, resolveSnippet } from './insert-actions';
import { slashTrigger, filterSlashItems } from './slash-trigger';

/** Subsequence fuzzy matching: prefix > continuous subsequence > scattered subsequence; extra points for initial and continuous hits, and -1 for no match */
function fuzzyScore(text: string, query: string): number {
  if (!query) return 0;
  if (text.startsWith(query)) return 100;
  const direct = text.indexOf(query);
  if (direct >= 0) return 60 - Math.min(direct, 30);
  let ti = 0;
  let score = 0;
  let streak = 0;
  for (const ch of query) {
    const found = text.indexOf(ch, ti);
    if (found === -1) return -1;
    streak = found === ti ? streak + 1 : 0;
    score += 1 + streak;
    if (found === 0 || /[\s-]/.test(text[found - 1])) score += 2;
    ti = found + 1;
  }
  return score;
}

/** The display name of the insertion type action (for selector placeholder copy) */
const TITLE_OF = new Map<string, string>(INSERT_ACTIONS.map(([id, title]) => [id, title]));

/**
 * Merge and sort the slash entries of "Convert Block Type" and "Insert Content" (export for regression testing).
 * - inline: Only the insertion class is retained when triggered inline to avoid accidentally triggering the entire conversion inline
 * - settings: used to exclude insert commands that are turned off in settings (pass null to enable all)
 *
 * NOTE: Filtering must be done ** before sorting **. It was once written as "The empty query returns the filtered pool,
 * Non-empty queries are sorted from unfiltered items", causing the conversion class to be leaked as long as the query words are entered in the row. */
export function buildSlashItems(
  query: string,
  inline = false,
  settings: Record<string, unknown> | null = null
): SlashItem[] {
  const enabled = new Set(enabledInsertIds(INSERT_ACTIONS.map(([id]) => id), settings));
  const items: SlashItem[] = [
    ...TURN_INTO.map(([id, title]): SlashItem => ({ kind: 'turn', id, title })),
    ...INSERT_ACTIONS.filter(([id]) => enabled.has(id)).map(
      ([id, title]): SlashItem => ({ kind: 'insert', id, title })
    ),
  ];
  const pool = filterSlashItems(items, inline);
  const q = query.toLowerCase();
  if (!q) return pool;
  return pool
    .map((item) => ({
      item,
      score: Math.max(fuzzyScore(item.id.toLowerCase(), q), fuzzyScore(item.title, q)),
    }))
    .filter((s) => s.score >= 0)
    .sort((a, b) => b.score - a.score)
    .map((s) => s.item);
}

/**
 * Slash "insert class" action executor: dispatched according to the kind of INSERT_SPECS, insert content without changing the block type.
 * All branches are passed through insertAt - the only exit for position clamping and cursor landing point. */
export class BlockInserter {
  constructor(private ctx: BlockEditorPlugin) {}

  run(id: InsertActionId, editor: Editor, pos: EditorPosition): void {
    const spec = INSERT_SPECS[id];
    if (!spec) return;
    const title = TITLE_OF.get(id) ?? TEXT.message0349;

    switch (spec.kind) {
      case 'pick':
        pickFile(this.ctx.app, spec.exts, TEXT.message0350 + title, (file: TFile) => {
          this.insertAt(editor, pos, `![[${file.path}]]`);
        });
        return;

      case 'snippet':
      case 'dynamic': {
        const r = resolveSnippet(spec, {
          now: new Date(),
          dateFormat: this.ctx.settings.dateFormat || DEFAULT_DATE_FORMAT,
          timeFormat: this.ctx.settings.timeFormat || DEFAULT_TIME_FORMAT,
        });
        if (r) this.insertAt(editor, pos, r.text, r.caret);
        return;
      }

      case 'note':
        pickNote(this.ctx.app, (file: TFile) => {
          this.insertAt(editor, pos, this.linkTo(file, '', spec.embed));
        });
        return;

      case 'blockref':
        // Two-level selection: first select a note, then select a block ID in the note
        pickNoteWithBlocks(this.ctx.app, (file: TFile) => {
          pickBlock(this.ctx.app, file, (blockId: string) => {
            this.insertAt(editor, pos, this.linkTo(file, '#^' + blockId, spec.embed));
          });
        });
        return;

      default:
        return;
    }
  }

  /** Generate note links: leave it to Obsidian to generate, automatically following the "Use Wikilinks" settings and relative paths */
  private linkTo(file: TFile, subpath: string, embed: boolean): string {
    const source = this.ctx.app.workspace.getActiveFile()?.path ?? '';
    const link = this.ctx.app.fileManager.generateMarkdownLink(file, source, subpath || undefined);
    return embed ? '!' + link : link;
  }

  /**
   * Insert text at pos and drop the cursor.
   * @param caret The offset of the cursor relative to the insertion starting point; when omitted or out of bounds, it falls at the end of the inserted text */
  private insertAt(
    editor: Editor,
    pos: EditorPosition,
    text: string,
    caret?: number
  ): void {
    // The document should not change while the selector is open; it is still clamped once to avoid going out of bounds.
    const line = Math.min(pos.line, editor.lineCount() - 1);
    const ch = Math.min(pos.ch, editor.getLine(line).length);
    editor.replaceRange(text, { line, ch });
    const offset = caret === undefined ? text.length : Math.max(0, Math.min(caret, text.length));
    editor.setCursor({ line, ch: ch + offset });
    editor.focus();
  }
}

/** Slash command: type / to invoke "Convert/Insert" suggestions.
 * - All blanks before `/` (beginning of line/indentation/after column character): all entries (conversion block type + insert attachment)
 * - The remaining positions (inline, such as `text/Figure`, `sdfs /`): only insert 4 items for attachments
 * Path form (C:/, https://), link/inline code/inline mathematics,
 * Will not trigger within code block/formula block/table/frontmatter. */
export class SlashSuggest extends EditorSuggest<SlashItem> {
  /** One-time diagnostic switch: only enter the first entry to avoid refreshing the screen every time you enter */
  private static logged = false;

  constructor(private ctx: BlockEditorPlugin) {
    super(ctx.app);
  }

  /**
   * Determine whether to trigger inline from the suggestion context **real time** without using instance field records.
   * Reason: The instance field depends on onTrigger must be executed earlier than getSuggestions, once Obsidian is reused
   * The last time the session or callback order changes, the dirty values ​​of the previous round will be read (shown as "all entries are given in the line").
   * Here, take the text before end.ch and re-run slashTrigger. The result must be consistent with the trigger moment. */
  private isInlineContext(sugg: {
    editor: Editor;
    start: EditorPosition;
    end: EditorPosition;
  }): boolean {
    try {
      const before = sugg.editor.getLine(sugg.start.line).slice(0, sugg.end.ch);
      return slashTrigger(before)?.inline ?? false;
    } catch {
      return false;
    }
  }

  onTrigger(cursor: EditorPosition, editor: Editor): EditorSuggestTriggerInfo | null {
    if (!this.ctx.settings.slashCommands) return null;

    const before = editor.getLine(cursor.line).slice(0, cursor.ch);
    const t = slashTrigger(before);
    if (!t) return null;
    // The in-line switch is independent: if you step on the false trigger, you can only turn off the in-line switch and keep the leading slash in the line.
    if (t.inline && !this.ctx.settings.slashInlineCommands) return null;

    // Do not disturb the attribute area (frontmatter)
    const fmEnd = this.ctx.detector.getFrontmatterEnd(editor);
    if (fmEnd !== -1 && cursor.line <= fmEnd) return null;

    // Do not disturb the container block: code block (old behavior) + formula block / table (inline insertion will break the version, it is better to leak)
    if (this.ctx.detector.findContainerAt(editor, cursor.line)) return null;

    return {
      start: { line: cursor.line, ch: t.ch },
      end: cursor,
      query: t.query,
    };
  }

  getSuggestions(context: EditorSuggestContext): SlashItem[] {
    const inline = this.isInlineContext(context);
    const items = buildSlashItems(
      context.query,
      inline,
      this.ctx.settings as unknown as Record<string, unknown>
    );
    if (!SlashSuggest.logged) {
      SlashSuggest.logged = true;
      let before = TEXT.message0351;
      try {
        const line = context.editor.getLine(context.start.line);
        before = line.slice(Math.max(0, context.end.ch - 24), context.end.ch);
      } catch {
        /* ignore：If the diagnostic field cannot be read, it does not affect the function. */
      }
      console.log('[block-editor] slash:', {
        before,
        query: context.query,
        inline,
        count: items.length,
        kinds: [...new Set(items.map((i) => i.kind))],
      });
    }
    return items;
  }

  renderSuggestion(item: SlashItem, el: HTMLElement): void {
    // There are many items (30+ items in the conversion class), and a single column will make the pop-up window very long → Change the container to a 3-column grid.
    // Obsidian does not expose the suggest container reference. It can only trace up one level from the entry element and add idempotent classes.
    const container = el.parentElement;
    if (container && !container.classList.contains('block-editor-slash-grid')) {
      container.classList.add('block-editor-slash-grid');
    }
    el.classList.add('block-editor-slash-item');
    el.setText(item.title);
  }

  selectSuggestion(item: SlashItem): void {
    const sugg = this.context;
    if (!sugg) return;
    const editor = sugg.editor;

    // First delete the entered "/xxx"
    editor.replaceRange('', sugg.start, sugg.end);

    // Insertion action: Do not change the block type and hand it over to the executor (the same applies within the line, the insertion point is /xxx)
    if (item.kind === 'insert') {
      this.ctx.inserter.run(item.id, editor, sugg.start);
      return;
    }

    // Bottom line: In theory, there will be no conversion items in inline mode (buildSlashItems has been filtered).
    // Even if it does appear, it cannot be executed - rewriting the entire block while the cursor is in the middle of the line is a destructive operation.
    if (this.isInlineContext(sugg)) return;

    const lineIndex = sugg.start.line;
    const detected = this.ctx.detector.getBlockAtLine(editor, lineIndex);
    const block: BlockContext = detected
      ? { editor, file: null, start: detected.start, end: detected.end, type: detected.type }
      : { editor, file: null, start: lineIndex, end: lineIndex, type: 'empty' };
    this.ctx.converter.convertBlock(editor, block, item.id);
  }
}