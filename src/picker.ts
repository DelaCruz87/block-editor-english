import { TEXT } from './strings';
import { Notice, SuggestModal } from 'obsidian';
import type { App, TFile } from 'obsidian';

/** Subsequence fuzzy scoring: prefix > continuous subsequence > dispersed subsequence; no match returns -1 */
function scoreName(text: string, query: string): number {
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
    ti = found + 1;
  }
  return score;
}

/** File selection floating layer: fuzzy search by file name */
class FileSuggest extends SuggestModal<TFile> {
  constructor(
    app: App,
    private files: TFile[],
    placeholder: string,
    private onPick: (file: TFile) => void
  ) {
    super(app);
    this.setPlaceholder(placeholder);
  }

  getSuggestions(query: string): TFile[] {
    const q = query.trim().toLowerCase();
    if (!q) return this.files;
    return this.files
      .map((f) => ({ f, score: scoreName(f.basename.toLowerCase(), q) }))
      .filter((s) => s.score >= 0)
      .sort((a, b) => b.score - a.score)
      .map((s) => s.f);
  }

  renderSuggestion(file: TFile, el: HTMLElement): void {
    el.createDiv({ text: file.basename });
    el.createDiv({ cls: 'block-editor-picker-path', text: file.path });
  }

  onChooseSuggestion(file: TFile): void {
    this.onPick(file);
  }
}

/** Block selection: id + content summary */
interface BlockItem {
  id: string;
  preview: string;
}

/** Block selection floating layer: display `^id` and block content summary */
class BlockSuggest extends SuggestModal<BlockItem> {
  constructor(
    app: App,
    private items: BlockItem[],
    private onPick: (id: string) => void
  ) {
    super(app);
    this.setPlaceholder(TEXT.message0261);
  }

  getSuggestions(query: string): BlockItem[] {
    const q = query.trim().toLowerCase();
    if (!q) return this.items;
    return this.items
      .map((it) => ({ it, score: Math.max(scoreName(it.id.toLowerCase(), q), scoreName(it.preview.toLowerCase(), q)) }))
      .filter((s) => s.score >= 0)
      .sort((a, b) => b.score - a.score)
      .map((s) => s.it);
  }

  renderSuggestion(item: BlockItem, el: HTMLElement): void {
    el.createDiv({ text: `^${item.id}` });
    el.createDiv({ cls: 'block-editor-picker-path', text: item.preview || TEXT.message0262 });
  }

  onChooseSuggestion(item: BlockItem): void {
    this.onPick(item.id);
  }
}

/** Summary of independent ID lines: skip up empty lines and take the first non-empty line */
function previewBefore(lines: string[], i: number): string {
  for (let j = i - 1; j >= 0; j--) {
    const t = lines[j].trim();
    if (t) return t.slice(0, 60);
  }
  return '';
}

/** Filter files in the vault by extension and pop up the selector */
export function pickFile(
  app: App,
  exts: string[],
  placeholder: string,
  onPick: (file: TFile) => void
): void {
  const set = new Set(exts.map((e) => e.toLowerCase()));
  const files = app.vault.getFiles().filter((f) => set.has(f.extension.toLowerCase()));
  new FileSuggest(app, files, placeholder, onPick).open();
}

/** Select note (extension md) */
export function pickNote(app: App, onPick: (file: TFile) => void): void {
  pickFile(app, ['md'], TEXT.message0263, onPick);
}

/** Scan the block ID in the text: two forms: independent line `^\s*\^id\s*$` and end of line `\s\^id\s*$` */
export function scanBlockIds(text: string): { id: string; preview: string }[] {
  const lines = text.split('\n');
  const items: { id: string; preview: string }[] = [];
  for (let i = 0; i < lines.length; i++) {
    const own = lines[i].match(/^\s*\^([A-Za-z0-9-]+)\s*$/);
    if (own) {
      items.push({ id: own[1], preview: previewBefore(lines, i) });
      continue;
    }
    const tail = lines[i].match(/\s\^([A-Za-z0-9-]+)\s*$/);
    if (tail) items.push({ id: tail[1], preview: lines[i].slice(0, tail.index ?? 0).trim() });
  }
  return items;
}

/** Select a block in a note: scan `^block-id` (independent line and end of line) */
export function pickBlock(app: App, file: TFile, onPick: (blockId: string) => void): void {
  app.vault.cachedRead(file).then((text) => {
    const items = scanBlockIds(text);
    if (!items.length) {
      new Notice(TEXT.message0264);
      return;
    }
    new BlockSuggest(app, items, onPick).open();
  }).catch(() => new Notice(TEXT.message0265));
}

/** "Notes with block ID" path cache: null means it has not been scanned yet */
let notesWithBlocks: string[] | null = null;

/** Clear the "notes with block ID" cache (called when vault is changed) */
export function invalidateNotesWithBlocks(): void {
  notesWithBlocks = null;
}

/** Open note selector by path collection */
function openNoteSuggest(app: App, paths: string[], onPick: (file: TFile) => void): void {
  const set = new Set(paths);
  // Do not introduce TFile value import: use path collection filtering (vault.getFiles is a memory operation, the overhead is negligible)
  const files = app.vault.getFiles().filter((f) => f.extension === 'md' && set.has(f.path));
  if (!files.length) {
    new Notice(TEXT.message0266);
    return;
  }
  new FileSuggest(app, files, TEXT.message0267, onPick).open();
}

/** Only list notes containing "block ID"; hit collection is used for session-level caching */
export function pickNoteWithBlocks(app: App, onPick: (file: TFile) => void): void {
  if (notesWithBlocks) {
    openNoteSuggest(app, notesWithBlocks, onPick);
    return;
  }
  const files = app.vault.getFiles().filter((f) => f.extension === 'md');
  Promise.all(
    files.map(async (f) => ({
      path: f.path,
      hit: scanBlockIds(await app.vault.cachedRead(f)).length > 0,
    }))
  ).then((results) => {
    const paths = results.filter((r) => r.hit).map((r) => r.path);
    if (!paths.length) {
      new Notice(TEXT.message0268);
      return;
    }
    notesWithBlocks = paths;
    openNoteSuggest(app, paths, onPick);
  }).catch(() => new Notice(TEXT.message0269));
}