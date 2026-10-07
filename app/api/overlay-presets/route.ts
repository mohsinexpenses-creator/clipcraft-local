import { NextResponse } from 'next/server';
import {
  deleteOverlayStylePreset,
  getOverlayStylePreset,
  listOverlayStylePresets,
  resetOverlayStylePresets,
  saveOverlayStylePreset,
  setDefaultOverlayStylePreset,
} from '@/lib/db';
import { toErrorMessage, toErrorStatus } from '@/lib/errors';
import { OverlayStylePreset } from '@/lib/types';

function coercePreset(body: Record<string, unknown>, fallbackKind: 'hook' | 'cta'): OverlayStylePreset {
  const kind = body.kind === 'hook' || body.kind === 'cta' ? body.kind : fallbackKind;
  return {
    _id: typeof body._id === 'string' && body._id ? body._id : `overlay_${Date.now()}_${Math.random().toString(36).substring(7)}`,
    kind,
    name: String(body.name || (kind === 'hook' ? 'New Hook Style' : 'New CTA Style')),
    description: body.description ? String(body.description) : '',
    fontFamily: String(body.fontFamily || 'Inter, system-ui, sans-serif'),
    fontSize: Number(body.fontSize) || (kind === 'hook' ? 38 : 32),
    fontWeight: (body.fontWeight as OverlayStylePreset['fontWeight']) || 'black',
    textColor: String(body.textColor || '#FFFFFF'),
    backgroundColor: String(body.backgroundColor || 'rgba(15, 23, 42, 0.92)'),
    borderColor: String(body.borderColor || 'rgba(255, 255, 255, 0.25)'),
    borderWidth: Number(body.borderWidth ?? 2),
    borderRadius: Number(body.borderRadius ?? 16),
    textTransform: body.textTransform === 'none' ? 'none' : 'uppercase',
    positionY: Number(body.positionY ?? (kind === 'hook' ? 12 : 64)),
    animationStyle: (body.animationStyle as OverlayStylePreset['animationStyle']) || 'pop',
    showBadge: body.showBadge != null ? body.showBadge === true : kind === 'hook',
    badgeText: body.badgeText ? String(body.badgeText) : 'Hook Intro',
    isDefault: body.isDefault === true,
  };
}

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const id = searchParams.get('id');
    const kind = searchParams.get('kind');

    if (id) {
      const preset = await getOverlayStylePreset(id);
      return NextResponse.json({ preset });
    }

    const presets = await listOverlayStylePresets(
      kind === 'hook' || kind === 'cta' ? kind : undefined
    );
    return NextResponse.json({ presets });
  } catch (error) {
    return NextResponse.json(
      { error: toErrorMessage(error, 'Failed to load overlay style presets.') },
      { status: toErrorStatus(error, 500) }
    );
  }
}

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as Record<string, unknown>;

    if (body.action === 'reset') {
      const presets = await resetOverlayStylePresets();
      return NextResponse.json({ success: true, presets });
    }

    const saved = await saveOverlayStylePreset(coercePreset(body, 'hook'));
    return NextResponse.json({ success: true, preset: saved });
  } catch (error) {
    return NextResponse.json(
      { error: toErrorMessage(error, 'Failed to create overlay style preset.') },
      { status: toErrorStatus(error, 500) }
    );
  }
}

export async function PUT(request: Request) {
  try {
    const body = (await request.json()) as Record<string, unknown>;
    if (!body._id) {
      return NextResponse.json({ error: 'Missing preset _id' }, { status: 400 });
    }

    const existing = await getOverlayStylePreset(String(body._id));
    const saved = await saveOverlayStylePreset(
      coercePreset({ ...existing, ...body }, existing?.kind ?? 'hook')
    );
    return NextResponse.json({ success: true, preset: saved });
  } catch (error) {
    return NextResponse.json(
      { error: toErrorMessage(error, 'Failed to update overlay style preset.') },
      { status: toErrorStatus(error, 500) }
    );
  }
}

export async function PATCH(request: Request) {
  try {
    const body = (await request.json()) as Record<string, unknown>;
    const id = typeof body._id === 'string' ? body._id.trim() : '';
    if (!id) return NextResponse.json({ error: 'Missing preset _id' }, { status: 400 });

    const preset = await setDefaultOverlayStylePreset(id);
    return NextResponse.json({ success: true, preset });
  } catch (error) {
    return NextResponse.json(
      { error: toErrorMessage(error, 'Failed to set default overlay style preset.') },
      { status: toErrorStatus(error, 500) }
    );
  }
}

export async function DELETE(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const id = searchParams.get('id');
    if (!id) {
      return NextResponse.json({ error: 'Missing preset id' }, { status: 400 });
    }

    await deleteOverlayStylePreset(id);
    return NextResponse.json({ success: true });
  } catch (error) {
    return NextResponse.json(
      { error: toErrorMessage(error, 'Failed to delete overlay style preset.') },
      { status: toErrorStatus(error, 500) }
    );
  }
}
