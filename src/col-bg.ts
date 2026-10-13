/**
 * Column background color dual theme tool: light/dark dual value model + dark automatic derivation + rendering variable writing.
 *
 *Data model:
 * - Document metadata syntax: `>> [!col|bg=#xxxxxx]` (light color, compatible with old data) with optional
 * `|bg-dark=#yyyyyy` (the background under the dark theme will be dropped only when the user explicitly overrides it).
 * - Normalized to `ColBg { light, dark }` when reading: dark is automatically derived by the algorithm when only bg is given
 * (deriveDarkColor), both sets default to no background (null).
 * - Automatically derived dark is not written back to the document (read side reproduces according to the same deterministic algorithm, keeping the old single value
 * Format compatibility, avoid document expansion); only the dark explicitly set by the user through the "Override Dark" entry
 * Only write `bg-dark=` to ensure cross-end consistency.
 *
 * Rendering link:
 * - Reading mode postProcessor and Live Preview ColumnsWidget both write two CSS on the element
 * Variables: `--col-bg-light` / `--col-bg-dark` (inline style), no longer hard-coded monochrome;
 * styles.css consumes `--col-bg` (default is light, body.theme-dark is dark).
 * - Text contrast colors are also calculated independently according to light/dark (--col-bg-text-light /
 * --col-bg-text-dark), ensuring that the text is readable under both themes. */

/** Column background two-color model (dark is the background under the dark theme; if light is missing, there is no background) */
export interface ColBg {
  light: string | null;
  dark: string | null;
}

/** Subcolumn metadata parameters: bg=#xxxxxx (light color, required to take effect); bg-dark=#yyyyyy (dark overlay, optional) */
const COL_META_BG_RE = /(?:^|[\s|])bg=([#0-9a-fA-F]{3,8})(?:$|[\s|])/;
const COL_META_BG_DARK_RE = /(?:^|[\s|])bg-dark=([#0-9a-fA-F]{3,8})(?:$|[\s|])/;

/** Parse subcolumn callout metadata (`bg=#fff|bg-dark=#111` or legacy single value `bg=#fff`) → ColBg */
export function parseColBgMeta(meta: string): ColBg | null {
  const lm = meta.match(COL_META_BG_RE);
  const dm = meta.match(COL_META_BG_DARK_RE);
  return normalizeColBg(lm ? lm[1] : null, dm ? dm[1] : null);
}

/** Normalization: only light → automatically derive dark; both light/dark default → null (no background) */
export function normalizeColBg(light: string | null, dark: string | null): ColBg | null {
  if (!light) return null;
  if (dark && /^#[0-9a-fA-F]{3,8}$/.test(dark)) return { light, dark };
  return { light, dark: deriveDarkColor(light) };
}

/** hex → [r, g, b, a] (a is 0~1; #rgb / #rgba / #rrggbb / #rrggbbaa are all supported) */
function hexToRgba(hex: string): [number, number, number, number] {
  let h = hex.replace('#', '');
  if (h.length === 3 || h.length === 4) h = h.split('').map((c) => c + c).join('');
  if (h.length !== 6 && h.length !== 8) h = h.slice(0, 6).padEnd(6, '0');
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  const a = h.length === 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1;
  return [r, g, b, a];
}

/** [r, g, b, a] → hex (keep alpha bit, consistent with input transparency) */
function rgbaToHex(r: number, g: number, b: number, a: number): string {
  const to = (v: number): string =>
    Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, '0');
  let hex = '#' + to(r) + to(g) + to(b);
  if (a < 1) hex += to(a * 255);
  return hex;
}

function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h: number;
  if (max === rn) h = ((gn - bn) / d + (gn < bn ? 6 : 0)) / 6;
  else if (max === gn) h = ((bn - rn) / d + 2) / 6;
  else h = ((rn - gn) / d + 4) / 6;
  return [h, s, l];
}

function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  const hue2rgb = (p: number, q: number, t: number): number => {
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  if (s === 0) {
    const v = Math.round(l * 255);
    return [v, v, v];
  }
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  return [
    Math.round(hue2rgb(p, q, h + 1 / 3) * 255),
    Math.round(hue2rgb(p, q, h) * 255),
    Math.round(hue2rgb(p, q, h - 1 / 3) * 255),
  ];
}

/** WCAG relative brightness (0~1) */
function relativeLuminance(r: number, g: number, b: number): number {
  const f = (v: number): number => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}

/**
 * Automatic derivation of dark colors: HSL transformation - the hue remains unchanged, and the brightness is reduced to 8%~25% (maintained when the light color is darker)
 * Or raise it to the lower limit of 8% to avoid dead black), saturation ×0.5, transparency unchanged; the derivation results are consistent with dark colors
 * The theme background (dark typical value of --background-primary #1e1e1e) is not enough in contrast.
 * The background color is fine-tuned (brightened) to prevent the dark bar from blending into the page background under the dark theme. */
export function deriveDarkColor(light: string): string {
  const [r, g, b, a] = hexToRgba(light);
  const [h, s, l] = rgbToHsl(r, g, b);
  let nl: number;
  if (l > 0.5) {
    nl = 0.08 + ((l - 0.5) * (0.25 - 0.08)) / 0.5;
  } else {
    nl = Math.max(l, 0.08);
  }
  const ns = Math.max(0, Math.min(1, s * 0.5));
  const [br, bg, bb] = hexToRgba('#1e1e1e');
  const lumBg = relativeLuminance(br, bg, bb);
  let curL = nl;
  let nr = 0;
  let ng = 0;
  let nb = 0;
  for (let guard = 0; guard < 60; guard++) {
    [nr, ng, nb] = hslToRgb(h, ns, curL);
    const lum = relativeLuminance(nr, ng, nb);
    if ((lum + 0.05) / (lumBg + 0.05) >= 1.4 || curL >= 0.45) break;
    curL += 0.01;
  }
  return rgbaToHex(nr, ng, nb, a);
}

/** Select contrasting text color according to background brightness (near black/near white, YIQ threshold 150) */
export function pickContrastText(bg: string): string {
  const [r, g, b] = hexToRgba(bg);
  const yiq = (r * 299 + g * 587 + b * 114) / 1000;
  return yiq >= 150 ? '#1a1a1a' : '#f2f2f2';
}

/**
 * Write the two-color background to the element's inline CSS variable (reading mode postProcessor and live preview
 * Common to ColumnsWidget):
 * - --col-bg-light / --col-bg-dark: background color under two themes (not set when there is no background)
 * - --col-bg-text-light / --col-bg-text-dark: Contrast color of the text under the corresponding theme
 * `--col-bg` in styles.css defaults to light, and body.theme-dark defaults to dark;
 * The same applies to `--col-bg-text` (see styles.css "Column: Background Color Dual Theme" paragraph). */
export function setColBgVars(el: HTMLElement, bg: ColBg | null): void {
  const set = (name: string, v: string | null): void => {
    if (v) el.style.setProperty(name, v);
    else el.style.removeProperty(name);
  };
  set('--col-bg-light', bg?.light ?? null);
  set('--col-bg-text-light', bg?.light ? pickContrastText(bg.light) : null);
  set('--col-bg-dark', bg?.dark ?? null);
  set('--col-bg-text-dark', bg?.dark ? pickContrastText(bg.dark) : null);
}
