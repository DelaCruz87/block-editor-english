import { TEXT } from './strings';
import { PluginSettingTab, setIcon } from 'obsidian';
import type {
  SettingDefinition,
  SettingDefinitionItem,
  SettingDefinitionRender,
  SliderComponent,
} from 'obsidian';
import type BlockEditorPlugin from './main';
import { DEFAULT_DATE_FORMAT, DEFAULT_TIME_FORMAT } from './constants';
import { recomputeColumnsEditors } from './columns-preview';
import { DONATE_CODES, type DonateCode } from './donate';
import { ImagePreviewModal } from './modal';
import { colValignToCss } from './util';

/** The opening position when clicking on the internal link; 'current' means following Obsidian's native behavior */
export type LinkOpenMode = 'current' | 'tab' | 'split' | 'window';

export interface BlockEditorSettings {
  /** Show block handles */
  showHandle: boolean;
  /** The handle follows the block where the cursor is located */
  handleFollowsCursor: boolean;
  /** Highlight the block corresponding to the handle when hovering */
  blockHoverHighlight: boolean;
  /** Hover highlight color (empty string means follow the theme --background-modifier-hover) */
  blockHoverHighlightColor: string;
  /** Hover highlight transparency (0~1) */
  blockHoverHighlightOpacity: number;
  /** Enable / slash command */
  slashCommands: boolean;
  /** Inline slash command: non-first-line input/trigger (only insert classes for attachments) */
  slashInlineCommands: boolean;
  /** Drag to the edge of the editing area to automatically scroll */
  dragAutoScroll: boolean;
  /** Indentation length (number of spaces), 0 means automatically detecting the minimum indentation of the full text */
  indentStep: number;
  /** Experiment: Columns are self-rendered by the plug-in in Live Preview (off by default; native nested callout is displayed when off) */
  livePreviewWidget: boolean;
  // M4: Default appearance of columns (effective when gap/valign/radius/border parameters are not written in the column shell)
  /** Default column spacing for columns (px) */
  columnsGap: number;
  /** Column default rounded corners (px) */
  columnsRadius: number;
  /** Columns are aligned vertically by default */
  columnsValign: 'top' | 'center' | 'bottom' | 'stretch';
  /** Default border for columns */
  columnsBorder: boolean;
  // M4: Adjustable handle/drag threshold
  /** Block handle size (px) */
  handleSize: number;
  /** Drag judgment threshold (px), a displacement smaller than this is considered a click */
  dragThreshold: number;
  /** The opening position when clicking on the internal link */
  linkOpenMode: LinkOpenMode;
  // Slash "insert class" command
  /** Date format (token: YYYY/MM/DD/ddd/dddd) */
  dateFormat: string;
  /** Time format (token: HH/mm/ss) */
  timeFormat: string;
  /** Command switch: date */
  insDate: boolean;
  /** Command switch: time */
  insTime: boolean;
  /** Command switch: date and time */
  insDateTime: boolean;
  /** Command switch: inline formula */
  insMath: boolean;
  /** Command switch: inline code */
  insInlineCode: boolean;
  /** Command switch: highlight */
  insHighlight: boolean;
  /** Command switch: Note link */
  insNote: boolean;
  /** Command switch: embed notes */
  insEmbedNote: boolean;
  /** Command switch: block quote */
  insBlockRef: boolean;
  /** Command switch: embedded block */
  insBlockEmbed: boolean;
}

// Except for new items, the default value is equal to the built-in behavior before the refactoring
export const DEFAULT_SETTINGS: BlockEditorSettings = {
  showHandle: true,
  handleFollowsCursor: true,
  blockHoverHighlight: true,
  blockHoverHighlightColor: '',
  blockHoverHighlightOpacity: 0.55,
  slashCommands: true,
  slashInlineCommands: true,
  dragAutoScroll: true,
  indentStep: 0,
  livePreviewWidget: true,
  columnsGap: 10,
  columnsRadius: 8,
  columnsValign: 'stretch',
  columnsBorder: false,
  handleSize: 20,
  dragThreshold: 4,
  linkOpenMode: 'current',
  dateFormat: DEFAULT_DATE_FORMAT,
  timeFormat: DEFAULT_TIME_FORMAT,
  insDate: true,
  insTime: true,
  insDateTime: true,
  insMath: true,
  insInlineCode: true,
  insHighlight: true,
  insNote: true,
  insEmbedNote: true,
  insBlockRef: true,
  insBlockEmbed: true,
};

/** M4: Write the default appearance/handle size of the column to the body CSS variable, and consume styles.css with var().
 * Called when settings are changed; reading mode without Live Preview also gets this variable. */
export function applyColumnsCssVars(settings: BlockEditorSettings): void {
  const body = document.body;
  body.style.setProperty('--be-hintMove', JSON.stringify(TEXT.hintMove));
  body.style.setProperty('--be-hintNest', JSON.stringify(TEXT.hintNest));
  body.style.setProperty('--be-hintCopy', JSON.stringify(TEXT.hintCopy));
  body.style.setProperty('--be-hintMoveDocument', JSON.stringify(TEXT.hintMoveDocument));
  body.style.setProperty('--be-hintCopyDocument', JSON.stringify(TEXT.hintCopyDocument));
  body.style.setProperty('--be-hintColumnLeft', JSON.stringify(TEXT.hintColumnLeft));
  body.style.setProperty('--be-hintColumnRight', JSON.stringify(TEXT.hintColumnRight));
  body.style.setProperty('--be-hintAddColumn', JSON.stringify(TEXT.hintAddColumn));
  body.style.setProperty('--be-hintCopyColumn', JSON.stringify(TEXT.hintCopyColumn));
  body.style.setProperty('--be-hintEditColumn', JSON.stringify(TEXT.hintEditColumn));

  body.style.setProperty('--be-col-gap', settings.columnsGap + 'px');
  body.style.setProperty('--be-col-radius', settings.columnsRadius + 'px');
  body.style.setProperty('--be-col-valign', colValignToCss(settings.columnsValign));
  body.style.setProperty('--be-col-border', settings.columnsBorder ? '1px' : '0px');
  body.style.setProperty('--be-handle-size', settings.handleSize + 'px');
}

/** The color/transparency of the block hover highlight is written to the body CSS variable, and styles.css is consumed with var().
 * When the color is an empty string, it will fall back to the --background-modifier-hover of the Obsidian theme, and the dark and light themes will automatically follow. */
export function applyHoverHighlightCssVars(settings: BlockEditorSettings): void {
  const body = document.body;
  const color = settings.blockHoverHighlightColor.trim();
  body.style.setProperty(
    '--be-hover-color',
    color || 'var(--background-modifier-hover)'
  );
  body.style.setProperty('--be-hover-opacity', String(settings.blockHoverHighlightOpacity));
}

/** A setting item key presented as a numerical value (slider) with a "restore default value" entry */
type NumericSettingKey =
  | 'blockHoverHighlightOpacity'
  | 'indentStep'
  | 'columnsGap'
  | 'columnsRadius'
  | 'handleSize'
  | 'dragThreshold';

export class BlockEditorSettingTab extends PluginSettingTab {
  constructor(private plugin: BlockEditorPlugin) {
    super(plugin.app, plugin);
  }

  /**
   * Numeric (slider) setting item: Declarative control does not provide a "restore default" entry, so use render to customize it
   * --Slider + restore default button (rotate-ccw). The slider can be changed and restored to default through setControlValue.
   * Persist and trigger side effects, behavior consistent with declarative control. */
  private numericSetting(opts: {
    name: string;
    desc: string;
    key: NumericSettingKey;
    min: number;
    max: number;
    step: number;
  }): SettingDefinition {
    const def = DEFAULT_SETTINGS[opts.key];
    const item: SettingDefinitionRender = {
      name: opts.name,
      desc: opts.desc,
      render: (setting) => {
        setting.setName(opts.name).setDesc(opts.desc);
        let slider: SliderComponent | null = null;
        setting.addSlider((s) => {
          slider = s;
          s.setLimits(opts.min, opts.max, opts.step)
            .setValue(this.getControlValue(opts.key) as number)
            .onChange((v) => void this.setControlValue(opts.key, v));
        });
        setting.addExtraButton((b) =>
          b
            .setIcon('rotate-ccw')
            .setTooltip(TEXT.message0270(def))
            .onClick(() => {
              // Refresh the slider appearance first, then persist it and trigger side effects
              slider?.setValue(def);
              void this.setControlValue(opts.key, def);
            })
        );
      },
    };
    return item;
  }

  getSettingDefinitions(): SettingDefinitionItem[] {
    return [
      {
        type: 'group',
        heading: TEXT.message0271,
        items: [
          {
            name: TEXT.message0272,
            desc: TEXT.message0273,
            control: { type: 'toggle', key: 'showHandle' },
          },
          {
            name: TEXT.message0274,
            desc: TEXT.message0275,
            control: { type: 'toggle', key: 'handleFollowsCursor' },
          },
          {
            name: TEXT.message0276,
            desc: TEXT.message0277,
            control: { type: 'toggle', key: 'blockHoverHighlight' },
          },
          {
            name: TEXT.message0278,
            desc: TEXT.message0279,
            control: { type: 'color', key: 'blockHoverHighlightColor' },
          },
          this.numericSetting({
            name: TEXT.message0280,
            desc: TEXT.message0281,
            key: 'blockHoverHighlightOpacity',
            min: 0,
            max: 1,
            step: 0.05,
          }),
          {
            name: TEXT.message0282,
            desc: TEXT.message0283,
            control: { type: 'toggle', key: 'livePreviewWidget' },
          },
          {
            name: TEXT.message0284,
            desc: TEXT.message0285,
            control: { type: 'toggle', key: 'slashCommands' },
          },
          {
            name: TEXT.message0286,
            desc: TEXT.message0287,
            control: { type: 'toggle', key: 'slashInlineCommands' },
          },
          {
            name: TEXT.message0288,
            desc: TEXT.message0289,
            control: { type: 'toggle', key: 'dragAutoScroll' },
          },
          this.numericSetting({
            name: TEXT.message0290,
            desc: TEXT.message0291,
            key: 'indentStep',
            min: 0,
            max: 8,
            step: 1,
          }),
          {
            name: TEXT.message0292,
            desc: TEXT.message0293,
            control: {
              type: 'dropdown',
              key: 'linkOpenMode',
              options: { current: TEXT.message0294, tab: TEXT.message0295, split: TEXT.message0296, window: TEXT.message0297 },
            },
          },
          this.numericSetting({
            name: TEXT.message0298,
            desc: TEXT.message0299,
            key: 'columnsGap',
            min: 0,
            max: 48,
            step: 1,
          }),
          this.numericSetting({
            name: TEXT.message0300,
            desc: TEXT.message0301,
            key: 'columnsRadius',
            min: 0,
            max: 24,
            step: 1,
          }),
          {
            name: TEXT.message0302,
            desc: TEXT.message0303,
            control: {
              type: 'dropdown',
              key: 'columnsValign',
              options: { stretch: TEXT.message0304, top: TEXT.message0305, center: TEXT.message0306, bottom: TEXT.message0307 },
            },
          },
          {
            name: TEXT.message0308,
            desc: TEXT.message0309,
            control: { type: 'toggle', key: 'columnsBorder' },
          },
          this.numericSetting({
            name: TEXT.message0310,
            desc: TEXT.message0311,
            key: 'handleSize',
            min: 12,
            max: 32,
            step: 1,
          }),
          this.numericSetting({
            name: TEXT.message0312,
            desc: TEXT.message0313,
            key: 'dragThreshold',
            min: 0,
            max: 16,
            step: 1,
          }),
        ],
      },
      {
        type: 'group',
        heading: TEXT.message0314,
        items: [
          {
            name: TEXT.message0315,
            desc: TEXT.message0316,
            control: { type: 'text', key: 'dateFormat' },
          },
          {
            name: TEXT.message0317,
            desc: TEXT.message0318,
            control: { type: 'text', key: 'timeFormat' },
          },
          {
            name: TEXT.message0319,
            desc: TEXT.message0320,
            control: { type: 'toggle', key: 'insDate' },
          },
          {
            name: TEXT.message0321,
            desc: TEXT.message0322,
            control: { type: 'toggle', key: 'insTime' },
          },
          {
            name: TEXT.message0323,
            desc: TEXT.message0324,
            control: { type: 'toggle', key: 'insDateTime' },
          },
          {
            name: TEXT.message0325,
            desc: TEXT.message0326,
            control: { type: 'toggle', key: 'insMath' },
          },
          {
            name: TEXT.message0327,
            desc: TEXT.message0328,
            control: { type: 'toggle', key: 'insInlineCode' },
          },
          {
            name: TEXT.message0329,
            desc: TEXT.message0330,
            control: { type: 'toggle', key: 'insHighlight' },
          },
          {
            name: TEXT.message0331,
            desc: TEXT.message0332,
            control: { type: 'toggle', key: 'insNote' },
          },
          {
            name: TEXT.message0333,
            desc: TEXT.message0334,
            control: { type: 'toggle', key: 'insEmbedNote' },
          },
          {
            name: TEXT.message0335,
            desc: TEXT.message0336,
            control: { type: 'toggle', key: 'insBlockRef' },
          },
          {
            name: TEXT.message0337,
            desc: TEXT.message0338,
            control: { type: 'toggle', key: 'insBlockEmbed' },
          },
        ],
      },
      ...this.donateGroups(),
    ];
  }

  /**
   * "Support Authors" group: Render the reward collection code into a collapsible block (collapsed by default, click to expand).
   * The payment code is inlined in src/donate.ts as Base64 Data URI and packaged into main.js during construction;
   * This group will not be generated when no pictures are configured. */
  private donateGroups(): SettingDefinitionItem[] {
    const codes: DonateCode[] = DONATE_CODES.filter((c) => c.src.trim().length > 0);
    if (codes.length === 0) return [];
    return [
      {
        type: 'group',
        cls: 'be-donate-group',
        items: [
          {
            name: TEXT.message0339,
            aliases: [TEXT.message0340, TEXT.message0341, TEXT.message0342, TEXT.message0343, 'donate', 'sponsor'],
            render: (setting) => {
              setting.settingEl.addClass('be-donate-row');
              const details = setting.settingEl.createEl('details', { cls: 'be-donate' });
              const summary = details.createEl('summary', { cls: 'be-donate-summary' });
              const chevron = summary.createSpan({ cls: 'be-donate-chevron' });
              setIcon(chevron, 'chevron-right');
              summary.createSpan({ cls: 'be-donate-label', text: TEXT.message0344 });
              summary.createSpan({
                cls: 'be-donate-hint',
                text: TEXT.message0345,
              });
              const body = details.createDiv({ cls: 'be-donate-body' });
              const list = body.createDiv({ cls: 'be-donate-codes' });
              for (const code of codes) {
                const fig = list.createEl('figure', { cls: 'be-donate-code' });
                const img = fig.createEl('img', {
                  attr: {
                    src: code.src,
                    alt: code.alt,
                    role: 'button',
                    tabindex: '0',
                    title: TEXT.message0346,
                    'aria-label': TEXT.message0347(code.alt),
                  },
                });
                const openPreview = () =>
                  new ImagePreviewModal(this.app, code.src, code.label).open();
                img.addEventListener('click', openPreview);
                img.addEventListener('keydown', (e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    openPreview();
                  }
                });
                fig.createEl('figcaption', { text: TEXT.message0348(code.label) });
              }
            },
          },
        ],
      },
    ];
  }

  /**
   * Declarative settings (getSettingDefinitions) are persisted directly to plugin.settings by the framework - framework
   * Do not execute the "one-time side effects" of the plug-in (writing body CSS variables, cutting body classes, rebuilding CM6 widgets,
   * Refresh hover highlighting). Changes to declarative controls will go through setControlValue (official type
   * SettingControlBase.key is passed into this method), so it is distributed uniformly here to avoid missing items one by one. */
  async setControlValue(key: string, value: unknown): Promise<void> {
    await super.setControlValue(key, value);
    SETTING_SIDE_EFFECTS[key]?.(this.plugin, value);
  }
}

/** Settings that require "one-time side effects": declarative settings are distributed to the application after the framework persists.
 * Lazy read settings (linkOpenMode/slashCommands/showHandle/indentStep/
 * dragThreshold / handleFollowsCursor, etc.) No need to register, consumers can read plugin.settings on demand. */
const SETTING_SIDE_EFFECTS: Record<
  string,
  (plugin: BlockEditorPlugin, value: unknown) => void
> = {
  // Column Live Preview master switch: cut the body class and immediately rebuild the column decoration
  livePreviewWidget: (plugin, value) => {
    document.body.classList.toggle('be-columns-live-on', Boolean(value));
    recomputeColumnsEditors(plugin.app);
  },
  // Default appearance of columns: write body CSS variable + rebuild widget (gap / radius / border changes must be rebuilt)
  columnsGap: applyColumnsSideEffects,
  columnsRadius: applyColumnsSideEffects,
  columnsValign: applyColumnsSideEffects,
  columnsBorder: applyColumnsSideEffects,
  // Handle size: just update the body variable
  handleSize: (plugin) => applyColumnsCssVars(plugin.settings),
  // Hover highlight: Redraw the current highlight immediately after writing the color/transparency to the body variable
  blockHoverHighlightColor: applyHoverSideEffects,
  blockHoverHighlightOpacity: applyHoverSideEffects,
  // Hover highlight switch: Just redraw (whether visible or not is determined by pressing the setting in the handle)
  blockHoverHighlight: (plugin) => plugin.handle.renderHighlight(),
};

/** Side effects of column appearance class settings: body CSS variable + forced reconstruction of column widgets in the editor */
function applyColumnsSideEffects(plugin: BlockEditorPlugin): void {
  applyColumnsCssVars(plugin.settings);
  recomputeColumnsEditors(plugin.app);
}

/** Side effects of hover highlight class setting: body CSS variable + immediate redraw of current highlight */
function applyHoverSideEffects(plugin: BlockEditorPlugin): void {
  applyHoverHighlightCssVars(plugin.settings);
  plugin.handle.renderHighlight();
}
