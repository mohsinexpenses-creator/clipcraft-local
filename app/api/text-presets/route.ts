import { NextResponse } from 'next/server';
import { deleteTextPreset, listTextPresets, saveTextPreset } from '@/lib/db';
import { toErrorMessage, toErrorStatus } from '@/lib/errors';
import { TextPreset } from '@/lib/types';

/**
 * CRUD for hook / CTA text presets (collection "textPresets").
 *
 *   GET    /api/text-presets?kind=hook|cta   list (optionally filtered)
 *   POST   /api/text-presets                 create { kind, text }
 *   PUT    /api/text-presets                 update { _id, kind?, text }
 *   DELETE /api/text-presets                 delete { _id }
 */

function readBody(body: Record<string, unknown>): { _id?: string; kind?: TextPreset['kind']; text?: string } {
  const kind = body.kind === 'hook' || body.kind === 'cta' ? body.kind : undefined;
  const text = typeof body.text === 'string' ? body.text.trim() : undefined;
  const _id = typeof body._id === 'string' && body._id ? body._id : undefined;
  return { _id, kind, text };
}

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const kind = searchParams.get('kind');
    const presets = await listTextPresets(kind === 'hook' || kind === 'cta' ? kind : undefined);
    return NextResponse.json({ presets });
  } catch (error) {
    return NextResponse.json(
      { error: toErrorMessage(error, 'Failed to load text presets.') },
      { status: toErrorStatus(error, 500) }
    );
  }
}

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const { kind, text } = readBody(body);

    if (!kind || !text) {
      return NextResponse.json(
        { error: 'A text preset needs both "kind" (hook or cta) and a non-empty "text".' },
        { status: 400 }
      );
    }
    if (text.length > 60) {
      return NextResponse.json(
        { error: 'Text presets are burned onto video - keep them to 60 characters or fewer.' },
        { status: 400 }
      );
    }

    const preset: TextPreset = {
      _id: `text_${Date.now()}_${Math.random().toString(36).substring(7)}`,
      kind,
      text,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    const saved = await saveTextPreset(preset);
    return NextResponse.json({ success: true, preset: saved });
  } catch (error) {
    return NextResponse.json(
      { error: toErrorMessage(error, 'Failed to create text preset.') },
      { status: toErrorStatus(error, 500) }
    );
  }
}

export async function PUT(request: Request) {
  try {
    const body = await request.json();
    const { _id, kind, text } = readBody(body);
    if (!_id) {
      return NextResponse.json({ error: 'Missing preset id.' }, { status: 400 });
    }

    const existing = (await listTextPresets()).find((p) => p._id === _id);
    if (!existing) {
      return NextResponse.json({ error: 'Text preset not found.' }, { status: 404 });
    }

    const updated: TextPreset = {
      ...existing,
      ...(kind ? { kind } : {}),
      ...(text ? { text } : {}),
    };

    const saved = await saveTextPreset(updated);
    return NextResponse.json({ success: true, preset: saved });
  } catch (error) {
    return NextResponse.json(
      { error: toErrorMessage(error, 'Failed to update text preset.') },
      { status: toErrorStatus(error, 500) }
    );
  }
}

export async function DELETE(request: Request) {
  try {
    const body = await request.json();
    const _id = typeof body._id === 'string' ? body._id : new URL(request.url).searchParams.get('id');
    if (!_id) {
      return NextResponse.json({ error: 'Missing preset id.' }, { status: 400 });
    }
    await deleteTextPreset(_id);
    return NextResponse.json({ success: true });
  } catch (error) {
    return NextResponse.json(
      { error: toErrorMessage(error, 'Failed to delete text preset.') },
      { status: toErrorStatus(error, 500) }
    );
  }
}
