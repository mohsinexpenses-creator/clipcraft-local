import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { AppError } from './errors';
import {
  deleteCustomFont as deleteCustomFontRow,
  listCustomFonts,
  saveCustomFont,
} from './db';
import { resolveCustomFontsDir } from './paths';
import type {
  CaptionPreset,
  CaptionFontWeight,
  CustomFont,
  CustomFontFormat,
  OverlayStylePreset,
  RemotionCustomFontFace,
} from './types';

/** Large enough for normal display fonts, small enough to keep render props bounded. */
export const MAX_CUSTOM_FONT_BYTES = 5 * 1024 * 1024;

const FORMAT_META: Record<CustomFontFormat, { mimeType: string; signatures: Uint8Array[] }> = {
  ttf: {
    mimeType: 'font/ttf',
    signatures: [new Uint8Array([0x00, 0x01, 0x00, 0x00]), new TextEncoder().encode('true')],
  },
  otf: { mimeType: 'font/otf', signatures: [new TextEncoder().encode('OTTO')] },
  woff: { mimeType: 'font/woff', signatures: [new TextEncoder().encode('wOFF')] },
  woff2: { mimeType: 'font/woff2', signatures: [new TextEncoder().encode('wOF2')] },
};

const EXTENSION_TO_FORMAT: Record<string, CustomFontFormat> = {
  '.ttf': 'ttf',
  '.otf': 'otf',
  '.woff': 'woff',
  '.woff2': 'woff2',
};

const WEIGHTS: readonly CaptionFontWeight[] = ['normal', 'bold', 'extra-bold', 'black'];

function bytesStartWith(bytes: Uint8Array, signature: Uint8Array): boolean {
  return signature.every((value, index) => bytes[index] === value);
}

function safeOriginalName(value: unknown): string {
  if (typeof value !== 'string') throw invalidFont('A font file name is required.');
  const name = value.trim();
  if (!name || name.length > 180 || name !== path.basename(name) || /[\u0000-\u001f]/.test(name)) {
    throw invalidFont('Choose a plain font file name without folders or control characters.');
  }
  return name;
}

function invalidFont(message: string, status = 400): AppError {
  return new AppError(message, {
    status,
    resolution: 'Upload a local .ttf, .otf, .woff, or .woff2 font smaller than 5 MB.',
  });
}

/** A family is data, never an arbitrary CSS declaration. */
export function normalizeCustomFontFamily(value: unknown, fallbackFileName?: string): string {
  const candidate = typeof value === 'string' && value.trim()
    ? value.trim()
    : fallbackFileName
      ? path.basename(fallbackFileName, path.extname(fallbackFileName)).replace(/[-_]+/g, ' ')
      : '';
  const compact = candidate.replace(/\s+/g, ' ').trim();
  if (!compact || compact.length > 80 || !/^[\p{L}\p{N} ._-]+$/u.test(compact)) {
    throw invalidFont('Font family names may contain letters, numbers, spaces, dots, underscores, and dashes only.');
  }
  return compact;
}

export function customFontWeight(value: unknown): CaptionFontWeight {
  return WEIGHTS.includes(value as CaptionFontWeight)
    ? value as CaptionFontWeight
    : 'normal';
}

export function cssWeightForCustomFont(weight: CaptionFontWeight): number {
  switch (weight) {
    case 'black': return 900;
    case 'extra-bold': return 800;
    case 'bold': return 700;
    default: return 400;
  }
}

/** CSS value placed into the caption/overlay preset after the picker chooses a font. */
export function customFontCssFamily(family: string): string {
  return `'${family}', sans-serif`;
}

/** First CSS family of a normal `font-family` value, normalized for lookup. */
export function firstFontFamily(fontFamily: string | undefined): string {
  return (fontFamily ?? '')
    .split(',')[0]
    .trim()
    .replace(/^['"]|['"]$/g, '')
    .toLocaleLowerCase();
}

export function validateCustomFontUpload(
  originalName: unknown,
  bytes: Uint8Array,
): { originalName: string; format: CustomFontFormat; mimeType: string } {
  const name = safeOriginalName(originalName);
  if (bytes.byteLength === 0) throw invalidFont('The font file is empty.');
  if (bytes.byteLength > MAX_CUSTOM_FONT_BYTES) {
    throw invalidFont(`The font file is larger than ${Math.floor(MAX_CUSTOM_FONT_BYTES / 1024 / 1024)} MB.`, 413);
  }
  const format = EXTENSION_TO_FORMAT[path.extname(name).toLowerCase()];
  if (!format) throw invalidFont('Unsupported font extension.');
  if (!FORMAT_META[format].signatures.some((signature) => bytesStartWith(bytes, signature))) {
    throw invalidFont('The file signature does not match its font extension.');
  }
  return { originalName: name, format, mimeType: FORMAT_META[format].mimeType };
}

/** Resolve a registry entry without trusting any path segment stored in SQLite. */
export function customFontFilePath(font: Pick<CustomFont, 'directory' | 'storageName'>): string {
  const directory = path.resolve(font.directory);
  const storageName = path.basename(font.storageName);
  if (storageName !== font.storageName || !/^[a-f\d-]{36}\.(?:ttf|otf|woff2?)$/i.test(storageName)) {
    throw invalidFont('The registered font file name is invalid.');
  }
  const filePath = path.resolve(directory, storageName);
  const directoryWithSeparator = directory.endsWith(path.sep) ? directory : `${directory}${path.sep}`;
  if (!filePath.startsWith(directoryWithSeparator)) throw invalidFont('The registered font path is invalid.');
  return filePath;
}

export interface CustomFontUploadInput {
  originalName: string;
  family?: string;
  weight?: CaptionFontWeight;
  bytes: Uint8Array;
}

/**
 * Write a validated font atomically, then make it visible in the registry.
 * If a duplicate registry row wins a concurrent race, the just-written file is
 * removed so the configured folder does not accumulate unusable files.
 */
export async function registerCustomFont(input: CustomFontUploadInput): Promise<CustomFont> {
  const checked = validateCustomFontUpload(input.originalName, input.bytes);
  const family = normalizeCustomFontFamily(input.family, checked.originalName);
  const weight = customFontWeight(input.weight);
  const id = randomUUID();
  const directory = resolveCustomFontsDir();
  const storageName = `${id}.${checked.format}`;
  const filePath = customFontFilePath({ directory, storageName });
  const tempPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  const bytes = Buffer.from(input.bytes);
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const font: CustomFont & { sha256: string } = {
    id,
    family,
    weight,
    originalName: checked.originalName,
    storageName,
    directory,
    format: checked.format,
    mimeType: checked.mimeType,
    byteSize: bytes.byteLength,
    sha256,
    createdAt: new Date().toISOString(),
  };

  try {
    fs.writeFileSync(tempPath, bytes, { flag: 'wx' });
    fs.renameSync(tempPath, filePath);
    return await saveCustomFont(font);
  } catch (error) {
    try { fs.rmSync(tempPath, { force: true }); } catch { /* best effort */ }
    try { fs.rmSync(filePath, { force: true }); } catch { /* best effort */ }
    throw error;
  }
}

/**
 * Registry-first delete. Saved caption/overlay presets deliberately retain the
 * family string; a browser/renderer simply follows its CSS fallback chain after
 * deletion instead of losing the user's preset or crashing a queued render.
 */
export async function removeCustomFont(id: string): Promise<CustomFont | null> {
  const font = await deleteCustomFontRow(id);
  if (!font) return null;
  try {
    fs.rmSync(customFontFilePath(font), { force: true });
  } catch {
    // The row is already gone, so a stale unreadable file can no longer be served.
  }
  return font;
}

function familiesUsedBy(
  preset: CaptionPreset,
  hook: OverlayStylePreset,
  cta: OverlayStylePreset,
): Set<string> {
  const families = new Set<string>();
  const add = (fontFamily: string | undefined) => {
    const normalized = firstFontFamily(fontFamily);
    if (normalized) families.add(normalized);
  };
  add(preset.fontFamily);
  for (const line of preset.lineStyles ?? []) add(line.fontFamily);
  add(hook.fontFamily);
  add(cta.fontFamily);
  return families;
}

/** A selected local font file exposed through the worker's throwaway loopback server. */
export interface CustomFontRenderFile {
  id: string;
  family: string;
  weight: number;
  filePath: string;
  format: CustomFontFormat;
}

/**
 * Resolve just the custom faces referenced by this render. The caller serves
 * these paths through a 127.0.0.1-only throwaway server for Chromium. Missing
 * or manually deleted files are skipped so saved presets use CSS fallbacks
 * rather than causing a queued render to fail.
 */
export async function customFontFilesForRender(
  preset: CaptionPreset,
  hook: OverlayStylePreset,
  cta: OverlayStylePreset,
): Promise<CustomFontRenderFile[]> {
  const wanted = familiesUsedBy(preset, hook, cta);
  if (wanted.size === 0) return [];
  const registered = await listCustomFonts();
  const files: CustomFontRenderFile[] = [];
  for (const font of registered) {
    if (!wanted.has(font.family.toLocaleLowerCase())) continue;
    try {
      const filePath = customFontFilePath(font);
      const stat = fs.statSync(filePath);
      if (!stat.isFile() || !stat.size || stat.size > MAX_CUSTOM_FONT_BYTES) continue;
      files.push({
        id: font.id,
        family: font.family,
        weight: cssWeightForCustomFont(font.weight),
        filePath,
        format: font.format,
      });
    } catch {
      // A manually removed font is the same as a deleted registry item: fall back.
    }
  }
  return files;
}

/**
 * Compatibility helper for static/unit callers that need an isolated source
 * without starting a server. The worker itself deliberately uses
 * `customFontFilesForRender()` plus its loopback server.
 */
export async function customFontFacesForRender(
  preset: CaptionPreset,
  hook: OverlayStylePreset,
  cta: OverlayStylePreset,
): Promise<RemotionCustomFontFace[]> {
  const files = await customFontFilesForRender(preset, hook, cta);
  return files.flatMap((font) => {
    try {
      const bytes = fs.readFileSync(font.filePath);
      return [{
        family: font.family,
        weight: font.weight,
        source: `data:font/${font.format};base64,${bytes.toString('base64')}`,
        format: font.format,
      }];
    } catch {
      return [];
    }
  });
}
