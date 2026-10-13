import type { App, PaneType } from 'obsidian';
import type { LinkOpenMode } from './settings';

/** Relaxed signature of openLinkText (avoids additional imports of OpenViewState and other types) */
type OpenLinkText = (
  linktext: string,
  sourcePath: string,
  newLeaf?: PaneType | boolean,
  openViewState?: unknown
) => Promise<void>;

let original: OpenLinkText | null = null;
let targetProto: Record<string, unknown> | null = null;

/** The installation link opens the bridge; repeated calls are idempotent (return directly when installed) */
export function installLinkOpenBridge(app: App, getMode: () => LinkOpenMode): void {
  if (original) return;
  const proto = Object.getPrototypeOf(app.workspace) as Record<string, unknown> | null;
  if (!proto) return;
  const fn = proto.openLinkText as OpenLinkText | undefined;
  if (typeof fn !== 'function') return;

  const patched = function (
    this: unknown,
    linktext: string,
    sourcePath: string,
    newLeaf?: PaneType | boolean,
    openViewState?: unknown
  ): Promise<void> {
    const mode = getMode();
    // The setting is only applied if "the caller did not specify an opening location":
    // Ctrl/Cmd+click (Obsidian passes 'tab'), Ctrl/Cmd+Alt+click (passes 'split'),
    // Explicit values passed in by other plug-ins are released as is, and the modifier key behavior is naturally retained.
    const unspecified = newLeaf == null || newLeaf === false;
    const internal = !/^(?:https?|mailto|tel):/i.test(linktext);
    const next = unspecified && internal && mode !== 'current' ? mode : newLeaf;
    return fn.call(this, linktext, sourcePath, next, openViewState);
  };

  proto.openLinkText = patched;
  original = fn;
  targetProto = proto;
}

/** Uninstall and restore the original method (called when the plug-in is uninstalled) */
export function uninstallLinkOpenBridge(): void {
  if (targetProto && original) targetProto.openLinkText = original;
  original = null;
  targetProto = null;
}
