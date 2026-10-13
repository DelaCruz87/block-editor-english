import { TEXT } from './strings';
import type { InsertActionId, InsertSpec, TurnIntoItem } from './types';

export const HANDLE_W = 20;
export const HANDLE_H = 20;

/** 「转换为」菜单项 */
export const TURN_INTO: TurnIntoItem[] = [
  ['paragraph', TEXT.message0144],
  ['h1', TEXT.message0145],
  ['h2', TEXT.message0146],
  ['h3', TEXT.message0147],
  ['h4', TEXT.message0148],
  ['h5', TEXT.message0149],
  ['h6', TEXT.message0150],
  ['ul', TEXT.message0151],
  ['ol', TEXT.message0152],
  ['todo', TEXT.message0153],
  ['quote', TEXT.message0154],
  ['callout', 'Callout'],
  ['toggle', TEXT.message0155],
  ['code', TEXT.message0156],
  ['math', TEXT.message0157],
  ['table', TEXT.message0158],
  ['divider', TEXT.message0159],
];

/** 块 ID 的词表：Obsidian 只认拉丁字母、数字和连字符，所以用「易拼写的短单词 + 序号」 */
export const ID_WORDS = [
  'amber', 'anchor', 'arbor', 'aspen', 'autumn', 'bamboo', 'beacon', 'birch', 'bloom', 'breeze',
  'brook', 'candle', 'canyon', 'cedar', 'cherry', 'cinder', 'clover', 'coral', 'cotton', 'dawn',
  'delta', 'drizzle', 'dusk', 'ember', 'falcon', 'fable', 'fern', 'flint', 'forest', 'frost',
  'garden', 'glacier', 'harbor', 'harvest', 'hazel', 'hollow', 'honey', 'indigo', 'ivory', 'jade',
  'lantern', 'linden', 'meadow', 'meteor', 'mirror', 'mist', 'nectar', 'north', 'orchid', 'pebble',
  'pepper', 'pine', 'pond', 'poppy', 'quartz', 'quill', 'raven', 'ribbon', 'river', 'saffron',
  'shadow', 'shell', 'silver', 'snow', 'spark', 'spring', 'stone', 'storm', 'summit', 'sunset',
  'thistle', 'tide', 'timber', 'valley', 'velvet', 'violet', 'walnut', 'willow', 'winter', 'zephyr',
];

/** Obsidian 官方 Callout 类型（canonical 名称，菜单用） */
export const CALLOUT_TYPES: [string, string][] = [
  ['note', TEXT.message0160],
  ['abstract', TEXT.message0161],
  ['todo', TEXT.message0162],
  ['tip', TEXT.message0163],
  ['success', TEXT.message0164],
  ['question', TEXT.message0165],
  ['warning', TEXT.message0166],
  ['failure', TEXT.message0167],
  ['danger', TEXT.message0168],
  ['bug', TEXT.message0169],
  ['example', TEXT.message0170],
  ['quote', TEXT.message0171],
  // M5：更多官方 callout 类型
  ['cite', TEXT.message0172],
  ['info', TEXT.message0173],
  ['help', TEXT.message0174],
  ['check', TEXT.message0175],
  ['cross', TEXT.message0176],
  ['key', TEXT.message0177],
  ['pencil', TEXT.message0178],
  ['search', TEXT.message0179],
  ['love', TEXT.message0180],
  ['rocket', TEXT.message0181],
  ['image', TEXT.message0182],
  ['location', TEXT.message0183],
  ['home', TEXT.message0184],
  ['target', TEXT.message0185],
];

/** 代码块语言 */
export const CODE_LANGS: [string, string][] = [
  ['', TEXT.message0186],
  ['js', 'JavaScript'],
  ['ts', 'TypeScript'],
  ['python', 'Python'],
  ['java', 'Java'],
  ['c', 'C / C++'],
  ['go', 'Go'],
  ['rust', 'Rust'],
  ['sql', 'SQL'],
  ['bash', 'Bash'],
  ['json', 'JSON'],
  ['yaml', 'YAML'],
  ['html', 'HTML'],
  ['css', 'CSS'],
  ['mermaid', 'Mermaid'],
  // M5：代码语言扩展
  ['cpp', 'C++'],
  ['csharp', 'C#'],
  ['php', 'PHP'],
  ['ruby', 'Ruby'],
  ['swift', 'Swift'],
  ['kotlin', 'Kotlin'],
  ['dart', 'Dart'],
  ['shell', 'Shell'],
  ['powershell', 'PowerShell'],
  ['latex', 'LaTeX'],
  ['docker', 'Dockerfile'],
  ['xml', 'XML'],
  ['scss', 'SCSS'],
  ['less', 'Less'],
  ['graphql', 'GraphQL'],
];

/** 斜杠「插入类」动作（与 TURN_INTO 合并进斜杠建议列表） */
export const INSERT_ACTIONS: [InsertActionId, string][] = [
  ['image', TEXT.message0187],
  ['audio', TEXT.message0188],
  ['video', TEXT.message0189],
  ['pdf', 'PDF'],
  ['date', TEXT.message0190],
  ['time', TEXT.message0191],
  ['datetime', TEXT.message0192],
  ['math', TEXT.message0193],
  ['inlinecode', TEXT.message0194],
  ['highlight', TEXT.message0195],
  ['note', TEXT.message0196],
  ['embednote', TEXT.message0197],
  ['blockref', TEXT.message0198],
  ['blockembed', TEXT.message0199],
];

/** 日期 / 时间格式默认值（token 说明见 insert-actions.ts 的 formatDateTime） */
export const DEFAULT_DATE_FORMAT = 'YYYY-MM-DD';
export const DEFAULT_TIME_FORMAT = 'HH:mm';

/** 媒体选择器的扩展名白名单（小写、不含点） */
export const MEDIA_EXTS: Record<'image' | 'audio' | 'video' | 'pdf', string[]> = {
  image: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'avif'],
  audio: ['mp3', 'wav', 'm4a', 'ogg', 'flac'],
  video: ['mp4', 'webm', 'mov', 'mkv', 'avi'],
  pdf: ['pdf'],
};

/**
 * 各插入动作怎么执行（BlockInserter 按 kind 分派）。与 INSERT_ACTIONS 一一对应。
 * 必须排在 MEDIA_EXTS 之后：对象字面量在模块求值时就会读取它。
 */
export const INSERT_SPECS: Record<InsertActionId, InsertSpec> = {
  image: { kind: 'pick', exts: MEDIA_EXTS.image },
  audio: { kind: 'pick', exts: MEDIA_EXTS.audio },
  video: { kind: 'pick', exts: MEDIA_EXTS.video },
  pdf: { kind: 'pick', exts: MEDIA_EXTS.pdf },
  date: { kind: 'dynamic', dyn: 'date' },
  time: { kind: 'dynamic', dyn: 'time' },
  datetime: { kind: 'dynamic', dyn: 'datetime' },
  // 光标落在两个标记中间（caret = 1 或 2），否则插完还得手动往回挪
  math: { kind: 'snippet', text: '$$', caret: 1 },
  inlinecode: { kind: 'snippet', text: '``', caret: 1 },
  highlight: { kind: 'snippet', text: '====', caret: 2 },
  note: { kind: 'note', embed: false },
  embednote: { kind: 'note', embed: true },
  blockref: { kind: 'blockref', embed: false },
  blockembed: { kind: 'blockref', embed: true },
};
