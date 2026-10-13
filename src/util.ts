import type { App, Editor, MarkdownView, TFile } from 'obsidian';
import type { CMView } from './types';

/** CM6 view on Editor.cm, taken according to the surface used by this plug-in */
export function getCM(editor: Editor): CMView | null {
  const cm = (editor as unknown as { cm?: unknown }).cm;
  return (cm as CMView) ?? null;
}

export function getIndent(line: string): string {
  const m = line.match(/^(\s*)/);
  return m ? m[1] : '';
}

/** Column vertical alignment semantic value → CSS align-items legal value.
 * align-items does not accept top / bottom (illegal values will be ignored by the browser and fall back to stretch,
 * Shows that top/bottom alignment does not take effect) and must be mapped to flex-start/flex-end;
 * center / stretch is a legal value and will be returned unchanged. */
export function colValignToCss(v: string): string {
  if (v === 'top') return 'flex-start';
  if (v === 'bottom') return 'flex-end';
  return v;
}

export function getLines(editor: Editor, start: number, end: number): string[] {
  const lines: string[] = [];
  for (let i = start; i <= end; i++) lines.push(editor.getLine(i));
  return lines;
}

export function shiftIndent(line: string, delta: number): string {
  if (line.trim() === '') return line;
  if (delta > 0) return ' '.repeat(delta) + line;
  const cur = (line.match(/^(\s*)/) || ['', ''])[1].length;
  return ' '.repeat(Math.max(cur + delta, 0)) + line.slice(cur);
}

/** Viewport lock: Pin the CM editor's scroll position during fn execution.
 * When programmatically changing the document/rebuilding the widget DOM, CM6 will recalculate the viewport according to the change, resulting in scroll bars throughout the document
 * Jump away from the current editing position; record and restore scrollTop here (synchronized + once each for the next frame, covering CM6
 *Asynchronous displacement caused by the measurement phase), allowing the operation to always stay at the current editing position. */
export function keepViewport(
  cm: { scrollDOM: HTMLElement } | null | undefined,
  fn: () => void
): void {
  const sd = cm?.scrollDOM;
  if (!sd) {
    fn();
    return;
  }
  const top = sd.scrollTop;
  fn();
  if (sd.scrollTop !== top) sd.scrollTop = top;
  window.requestAnimationFrame(() => {
    if (sd.scrollTop !== top) sd.scrollTop = top;
  });
}

/** Check the editor and file from .cm-content DOM */
export function getEditorFromContent(
  app: App,
  cmContent: HTMLElement
): { editor: Editor; file: TFile | null } | null {
  const cmEditor = cmContent.closest('.cm-editor');
  if (!cmEditor) return null;

  const active = app.workspace.activeEditor;
  if (active?.editor) {
    const editor = active.editor;
    const cm = getCM(editor);
    if (cm && cm.dom === cmEditor) {
      return { editor, file: active.file ?? app.workspace.getActiveFile() };
    }
  }

  const leaves = app.workspace.getLeavesOfType('markdown');
  for (const leaf of leaves) {
    const view = leaf.view as MarkdownView | null;
    const editor = view?.editor;
    if (!editor) continue;
    const cm = getCM(editor);
    if (cm && cm.dom === cmEditor) return { editor, file: view?.file ?? null };
  }
  return null;
}
