/**
 * Pure helpers for the visual CARD BACKGROUND picker in the overlay style
 * editor: parse a CSS background string (solid color or linear-gradient) into
 * editable pieces, and build the CSS string back from them.
 */

export interface RgbParts {
  /** #rrggbb */
  hex: string;
  /** 0..1 */
  alpha: number;
}

export type BackgroundParts =
  | { mode: 'solid'; color: RgbParts }
  | {
      mode: 'gradient';
      angle: number;
      from: RgbParts;
      to: RgbParts;
    }
  | { mode: 'raw' };

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

export function rgbToHex(r: number, g: number, b: number): string {
  const part = (v: number) =>
    Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0');
  return `#${part(r)}${part(g)}${part(b)}`;
}

export function hexToRgb(hex: string): [number, number, number] {
  let h = hex.trim().replace(/^#/, '');
  if (h.length === 3) {
    h = h
      .split('')
      .map((c) => c + c)
      .join('');
  }
  return [
    parseInt(h.slice(0, 2), 16) || 0,
    parseInt(h.slice(2, 4), 16) || 0,
    parseInt(h.slice(4, 6), 16) || 0,
  ];
}

function formatAlpha(alpha: number): string {
  return String(Math.round(alpha * 100) / 100);
}

/** `#rrggbb` + alpha -> `rgb(...)` / `rgba(...)` (what the previews consume). */
export function rgbaCss(color: RgbParts): string {
  const [r, g, b] = hexToRgb(color.hex);
  return color.alpha >= 1
    ? `rgb(${r}, ${g}, ${b})`
    : `rgba(${r}, ${g}, ${b}, ${formatAlpha(clamp01(color.alpha))})`;
}

/** Parse `rgb(...)`, `rgba(...)`, `#rgb`, `#rrggbb`, `#rrggbbaa`. */
export function parseColor(css: string): RgbParts | null {
  const text = css.trim();
  const rgbaMatch = text.match(
    /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)$/i
  );
  if (rgbaMatch) {
    return {
      hex: rgbToHex(Number(rgbaMatch[1]), Number(rgbaMatch[2]), Number(rgbaMatch[3])),
      alpha: rgbaMatch[4] === undefined ? 1 : clamp01(Number(rgbaMatch[4])),
    };
  }
  const hexMatch = text.match(/^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i);
  if (hexMatch) {
    const h = hexMatch[1].toLowerCase();
    const expanded =
      h.length === 3
        ? h
            .split('')
            .map((c) => c + c)
            .join('')
        : h;
    return {
      hex: `#${expanded.slice(0, 6)}`,
      alpha: expanded.length === 8 ? clamp01(parseInt(expanded.slice(6, 8), 16) / 255) : 1,
    };
  }
  return null;
}

/** Split `linear-gradient(...)` args at top-level commas (stops contain commas). */
function splitTopLevel(inner: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = '';
  for (const ch of inner) {
    if (ch === '(') depth += 1;
    if (ch === ')') depth -= 1;
    if (ch === ',' && depth === 0) {
      parts.push(current.trim());
      current = '';
      continue;
    }
    current += ch;
  }
  if (current.trim()) parts.push(current.trim());
  return parts;
}

/** Parse a full `background` value into solid / gradient pieces. */
export function parseBackground(css: string): BackgroundParts {
  const text = (css ?? '').trim();
  const gradientMatch = text.match(/^linear-gradient\((.*)\)$/i);
  if (gradientMatch) {
    const args = splitTopLevel(gradientMatch[1]);
    const angleMatch = args[0]?.match(/^([\d.]+)deg$/i);
    const from = args.length >= 3 ? parseColor(args[1]) : null;
    const to = args.length >= 3 ? parseColor(args.slice(2).join(', ')) : null;
    if (angleMatch && from && to) {
      return {
        mode: 'gradient',
        angle: Number(angleMatch[1]),
        from,
        to,
      };
    }
    return { mode: 'raw' };
  }
  const solid = parseColor(text);
  if (solid) return { mode: 'solid', color: solid };
  return { mode: 'raw' };
}

export function buildBackground(parts: BackgroundParts): string {
  if (parts.mode === 'solid') return rgbaCss(parts.color);
  if (parts.mode === 'gradient') {
    return `linear-gradient(${Math.round(parts.angle)}deg, ${rgbaCss(parts.from)}, ${rgbaCss(parts.to)})`;
  }
  return '';
}
