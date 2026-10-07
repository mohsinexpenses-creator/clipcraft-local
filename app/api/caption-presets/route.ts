import { NextResponse } from 'next/server';
import {
  deleteCaptionPreset,
  getCaptionPreset,
  listCaptionPresets,
  saveCaptionPreset,
  setDefaultCaptionPreset,
} from '@/lib/db';
import { toErrorMessage, toErrorStatus } from '@/lib/errors';
import type {
  CaptionAnimationStyle,
  CaptionFontWeight,
  CaptionLineStyle,
  CaptionPreset,
} from '@/lib/types';

const FONT_WEIGHTS: CaptionFontWeight[] = ['normal', 'bold', 'extra-bold', 'black'];
const ANIMATIONS: CaptionAnimationStyle[] = ['karaoke', 'word-pop', 'fade-in', 'static'];

function boundedNumber(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? Math.max(min, Math.min(max, parsed)) : fallback;
}

function optionalColor(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const color = value.trim();
  return color.length > 0 && color.length <= 64 ? color : undefined;
}

function coerceLineStyle(value: unknown): CaptionLineStyle {
  const source = value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
  const fontWeight = FONT_WEIGHTS.includes(source.fontWeight as CaptionFontWeight)
    ? source.fontWeight as CaptionFontWeight
    : undefined;
  const animationStyle = ANIMATIONS.includes(source.animationStyle as CaptionAnimationStyle)
    ? source.animationStyle as CaptionAnimationStyle
    : undefined;
  return {
    ...(typeof source.fontFamily === 'string' && source.fontFamily.trim()
      ? { fontFamily: source.fontFamily.trim().slice(0, 160) }
      : {}),
    ...(source.fontSize !== undefined ? { fontSize: boundedNumber(source.fontSize, 48, 12, 160) } : {}),
    ...(fontWeight ? { fontWeight } : {}),
    ...(optionalColor(source.textColor) ? { textColor: optionalColor(source.textColor) } : {}),
    ...(optionalColor(source.highlightColor) ? { highlightColor: optionalColor(source.highlightColor) } : {}),
    ...(optionalColor(source.strokeColor) ? { strokeColor: optionalColor(source.strokeColor) } : {}),
    ...(source.strokeWidth !== undefined ? { strokeWidth: boundedNumber(source.strokeWidth, 3, 0, 20) } : {}),
    ...(typeof source.italic === 'boolean' ? { italic: source.italic } : {}),
    ...(typeof source.uppercase === 'boolean' ? { uppercase: source.uppercase } : {}),
    ...(source.letterSpacing !== undefined ? { letterSpacing: boundedNumber(source.letterSpacing, 0, -5, 30) } : {}),
    ...(source.maxWords !== undefined ? { maxWords: Math.round(boundedNumber(source.maxWords, 4, 1, 8)) } : {}),
    ...(animationStyle ? { animationStyle } : {}),
    ...(source.lineHeight !== undefined ? { lineHeight: boundedNumber(source.lineHeight, 1.12, 0.75, 2.5) } : {}),
  };
}

function coerceCaptionPreset(body: Record<string, unknown>, id: string): CaptionPreset {
  const fontWeight = FONT_WEIGHTS.includes(body.fontWeight as CaptionFontWeight)
    ? body.fontWeight as CaptionFontWeight
    : 'bold';
  const animationStyle = ANIMATIONS.includes(body.animationStyle as CaptionAnimationStyle)
    ? body.animationStyle as CaptionAnimationStyle
    : 'karaoke';
  const lineStyles = Array.isArray(body.lineStyles)
    ? body.lineStyles.slice(0, 6).map(coerceLineStyle)
    : undefined;
  const lineAlignment = body.lineAlignment === 'left' || body.lineAlignment === 'right'
    ? body.lineAlignment
    : body.lineAlignment === 'center'
      ? 'center'
      : undefined;

  return {
    _id: id,
    name: typeof body.name === 'string' && body.name.trim() ? body.name.trim().slice(0, 100) : 'New Caption Preset',
    fontFamily: typeof body.fontFamily === 'string' && body.fontFamily.trim()
      ? body.fontFamily.trim().slice(0, 160)
      : 'Arial, sans-serif',
    fontSize: boundedNumber(body.fontSize, 48, 12, 160),
    fontWeight,
    textColor: optionalColor(body.textColor) ?? '#FFFFFF',
    highlightColor: optionalColor(body.highlightColor) ?? '#FFE600',
    strokeColor: optionalColor(body.strokeColor) ?? '#000000',
    strokeWidth: boundedNumber(body.strokeWidth, 3, 0, 20),
    positionY: boundedNumber(body.positionY, 25, 0, 100),
    animationStyle,
    uppercase: typeof body.uppercase === 'boolean' ? body.uppercase : true,
    ...(lineStyles !== undefined ? { lineStyles } : {}),
    ...(body.lineGap !== undefined ? { lineGap: boundedNumber(body.lineGap, 4, 0, 80) } : {}),
    ...(lineAlignment ? { lineAlignment } : {}),
    ...(typeof body.isDefault === 'boolean' ? { isDefault: body.isDefault } : {}),
    ...(typeof body.createdAt === 'string' ? { createdAt: body.createdAt } : {}),
    ...(typeof body.updatedAt === 'string' ? { updatedAt: body.updatedAt } : {}),
  };
}

async function getErrorResponse(error: unknown, fallback: string) {
  return NextResponse.json(
    { error: toErrorMessage(error, fallback) },
    { status: toErrorStatus(error, 500) }
  );
}

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const id = searchParams.get('id');
    if (id) {
      const preset = await getCaptionPreset(id);
      return NextResponse.json({ preset });
    }
    const presets = await listCaptionPresets();
    return NextResponse.json({ presets });
  } catch (error) {
    return getErrorResponse(error, 'Failed to load caption presets.');
  }
}

export async function POST(request: Request) {
  try {
    const body = await request.json() as Record<string, unknown>;
    const id = typeof body._id === 'string' && body._id.trim()
      ? body._id.trim()
      : `preset_${Date.now()}_${Math.random().toString(36).substring(7)}`;
    const preset = coerceCaptionPreset(body, id);
    preset.isDefault = false;
    const saved = await saveCaptionPreset(preset);
    return NextResponse.json({ success: true, preset: saved });
  } catch (error) {
    return getErrorResponse(error, 'Failed to create caption preset.');
  }
}

export async function PUT(request: Request) {
  try {
    const body = await request.json() as Record<string, unknown>;
    const id = typeof body._id === 'string' ? body._id.trim() : '';
    if (!id) return NextResponse.json({ error: 'Missing preset _id' }, { status: 400 });
    const existing = await getCaptionPreset(id);
    const preset = coerceCaptionPreset({ ...existing, ...body }, id);
    const saved = await saveCaptionPreset(preset);
    return NextResponse.json({ success: true, preset: saved });
  } catch (error) {
    return getErrorResponse(error, 'Failed to update caption preset.');
  }
}

export async function PATCH(request: Request) {
  try {
    const body = await request.json() as Record<string, unknown>;
    const id = typeof body._id === 'string' ? body._id.trim() : '';
    if (!id) return NextResponse.json({ error: 'Missing preset _id' }, { status: 400 });
    const preset = await setDefaultCaptionPreset(id);
    return NextResponse.json({ success: true, preset });
  } catch (error) {
    return getErrorResponse(error, 'Failed to set the default caption preset.');
  }
}

export async function DELETE(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const id = searchParams.get('id');
    if (!id) return NextResponse.json({ error: 'Missing preset id' }, { status: 400 });
    await deleteCaptionPreset(id);
    return NextResponse.json({ success: true });
  } catch (error) {
    return getErrorResponse(error, 'Failed to delete caption preset.');
  }
}
