# Block Editor English

An English-language fork of [MarcBolo's Block Editor](https://github.com/MarcBolo/block-editor/tree/43f80c0d9bf98659a48e37878799283975ac75f1) for Obsidian desktop. It provides Notion-style block handles, drag-and-drop reordering, multiple selection, block conversion, editable columns, colors, block references and slash commands.

The fork translates UI text, settings, commands, notices, diagnostics, source comments, development scripts and documentation. The plugin ID is `block-editor-english`, so community updates to the original cannot overwrite it. The original MIT license and author attribution are preserved. [Fork provenance and compatibility](FORK.md) describes the exact starting revision, inherited limitations and verification.

## Features

- **Block handles**: A six-dot handle appears beside the hovered block or the block containing the cursor. Optional highlighting makes its scope visible.
- **Drag and drop**: Move blocks within a note or between panes. A floating preview and insertion line show the destination. The editor scrolls near its edges. Hold Alt to copy instead of move. Splits of the same file use an in-document move.
- **Nesting**: Drop to the right of a list, quote or callout body to nest the block. Moving left reduces indentation. Dropping to the right of a paragraph or heading converts that target into a list item and nests the dragged block below it. The indent step is configurable; automatic drag nesting uses four spaces.
- **Quick columns**: Drop at the left or right edge of a target block to combine the two into columns.
- **Insert a column by dragging**: Drag a block or selected group into a rendered columns layout. An insertion band within 18 px of a gap takes priority; otherwise the left half of a column inserts before it, and the right half inserts after it. Multi-row layouts resolve the insertion band within the row under the pointer. Alt retains the source.
- **Extract a column**: Drag its top handle outside the layout. The upper or lower half of a destination line chooses insertion before or after it. The extracted text loses the column quote prefixes. If fewer than two columns remain, the layout becomes ordinary paragraphs. Remaining widths are redistributed proportionally. Alt copies the column instead.
- **Action hints**: The preview identifies moving, nesting, copying, cross-document transfer or a left/right column drop. Invalid destinations have no action hint.
- **Multiple selection**: Shift-click handles to select or deselect blocks. Drag, delete, copy or convert the selection together. Esc exits selection.
- **Block menu**: Convert to paragraphs, headings 1-6, lists, tasks, quotes, callouts, toggles, code, math, tables or dividers. Code conversion offers 30 language choices; callouts offer 26 types. The menu also inserts above/below, duplicates without reusing block IDs, moves blocks, sets colors, operates on columns, reports character length and deletes blocks. Deleting a heading removes its whole section.
- **Slash commands**: Type `/` at the start of a block to search conversion and insertion actions. Matching uses subsequences and relevance ranking. Inline `/` offers image, audio, video and PDF insertion. Paths such as `C:/` and `https://` do not trigger suggestions. Code fences suppress slash suggestions.
- **Insert actions**: Insert dates, times, inline math, inline code, highlights, note links, note embeds, block references or block embeds. Optional actions have individual settings switches. Media insertion selects an existing vault attachment.
- **Block IDs**: Generate easy-to-spell `^block-id` identifiers, copy block links, or select a note and block to insert a reference. Structured blocks receive IDs on separate lines where required. Clearing all IDs asks for confirmation because existing references would stop resolving.
- **Columns**: Combine adjacent selected blocks, splitting at blank lines. Reading view displays columns side by side. Live Preview supports rendered layouts and in-column editing. Operations include adding/splitting columns, merging right, adding/deleting rows, reordering rows and unwrapping the layout. Width metadata supports `60-40` and `60-40/50-50`. Layout parameters include `gap=`, `radius=`, `valign=` and `border`; individual columns accept `bg=` and `bg-dark=`.
- **Nested lists to columns**: "Columns by parent items" creates a column for each top-level item and its descendants. "Columns by child items" requires one parent and creates columns for its children, retaining the parent as introductory text outside the layout. Ordered and unordered lists work; code fences do not introduce split points. Ambiguous input or fewer than two columns disables the action.
- **Block colors**: Use preset swatches, a native color picker or custom hex values. Light colors derive dark-theme and contrasting text colors automatically; columns also support an explicit dark color override.
- **Internal links**: Choose the current tab, a new tab, a right split or a new window. Modifier-click behavior remains native.
- **Command palette**: Move blocks with Alt+Up/Down, indent/outdent, open the menu, generate IDs, reference or duplicate blocks, manage colors, clear IDs, convert types and inspect column diagnostics.

## Screenshots

Captured during native acceptance in Sandbox-1 on 2026-10-14.

![English block menu](docs/menu.png)

![English settings](docs/settings.png)

## Settings

Open Settings > Block Editor English. Numeric controls have a restore-default button.

| Setting | Default | Behavior |
| --- | --- | --- |
| Show block handles | On | Display editor handles; commands and slash suggestions also work without them. |
| Handle follows cursor | On | Follow the active block; disable to show handles only on hover. |
| Highlight hovered block | On | Highlight the block associated with the handle. |
| Highlight color | Theme | An empty value follows the theme hover color. |
| Highlight opacity | 0.55 | Range 0-1. |
| Render columns in Live Preview | On | Use plugin widgets; disable for native nested callouts. |
| Enable slash commands | On | Enable `/` suggestions. |
| Inline slash commands | On | Offer attachment insertion after text. |
| Drag auto-scroll | On | Scroll near editor edges. |
| Indent step | 0 (automatic) | Detect the smallest document indentation or specify 1-8 spaces. |
| Link open location | Current tab | Current tab, new tab, right split or new window. |
| Default column gap | 10 px | Used when `gap=` is absent. |
| Default corner radius | 8 px | Used when `radius=` is absent. |
| Default vertical alignment | Stretch | Stretch, top, center or bottom when `valign=` is absent. |
| Default border | Off | Used when `border` is absent. |
| Handle size | 20 px | Range 12-32 px. |
| Drag threshold | 4 px | Range 0-16 px; smaller pointer movements open the menu. |
| Date format | `YYYY-MM-DD` | Supports `YYYY`, `YY`, `MM`, `DD`, `ddd` and `dddd`. |
| Time format | `HH:mm` | Supports `HH`, `mm` and `ss`. |
| Optional insert actions | All on | Independent date, time, date/time, math, code, highlight, note and block reference/embed switches. |
| Support the original author | Collapsed | Original author's WeChat and Alipay QR codes; click to enlarge. |

Weekday tokens produce English values such as `Wed` and `Wednesday`. Other characters in a custom format remain unchanged. Stored settings keys and values are compatible with the original.

## Installation

Download `main.js`, `manifest.json` and `styles.css` from an English fork release. Put them in the vault's `.obsidian/plugins/block-editor-english/` directory, then enable **Block Editor English** in Community plugins.

When replacing the original, copy its `data.json` into the new directory before enabling the fork. Verify the fork loads and the settings are retained before uninstalling the original. Keep a backup of the original plugin and settings. Run only one of the two plugins in a vault at a time: both register the same editor behaviors and CSS classes.

## Development

```sh
npm ci
npm run build
npm test
npm run dev
```

The build type-checks TypeScript and generates `main.js`. `npm test` runs nine inherited regression suites plus an English-source, interpolation and weekday suite. The columns mutation suite deliberately introduces bad changes and passes only when the assertions catch every mutation.

Dependencies are pinned in the lockfile. `.npmrc` uses `legacy-peer-deps=true` because upstream's CodeMirror versions conflict with the Obsidian npm package's exact peer declaration. Runtime editor modules remain external to the generated bundle.

`npm run test:legacy-parity` and `npm run test:update` retain the historical parity harness. That harness needs `scripts/legacy-main.cjs`, which the specified upstream revision does not contain. It is not part of the default suite, and a missing reference is never treated as a pass. Other historical repro scripts are retained for investigation.

International document fixtures remain Unicode test data, represented by escapes. Their content and character positions are preserved so the parser is still tested with non-English notes. Test descriptions and source prose are English.

## License and attribution

MIT License. Original copyright: Marco Bolo, 2026. Original plugin author: MarcBolo. The original `LICENSE` is unchanged. English fork commissioned by Eme and prepared by Codex on 2026-10-14.
