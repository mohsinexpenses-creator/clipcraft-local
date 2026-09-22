import { NextResponse } from 'next/server';
import {
  deleteCaptionPreset,
  getCaptionPreset,
  listCaptionPresets,
  saveCaptionPreset,
} from '@/lib/db';
import { toErrorMessage, toErrorStatus } from '@/lib/errors';
import { CaptionPreset } from '@/lib/types';

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
    return NextResponse.json(
      { error: toErrorMessage(error, 'Failed to load caption presets.') },
      { status: toErrorStatus(error, 500) }
    );
  }
}

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const presetId = body._id || `preset_${Date.now()}_${Math.random().toString(36).substring(7)}`;

    const newPreset: CaptionPreset = {
      _id: presetId,
      name: body.name || 'New Caption Preset',
      fontFamily: body.fontFamily || 'Inter, sans-serif',
      fontSize: Number(body.fontSize) || 48,
      fontWeight: body.fontWeight || 'bold',
      textColor: body.textColor || '#FFFFFF',
      highlightColor: body.highlightColor || '#FFE600',
      strokeColor: body.strokeColor || '#000000',
      strokeWidth: Number(body.strokeWidth) || 3,
      positionY: Number(body.positionY) || 25,
      animationStyle: body.animationStyle || 'karaoke',
      uppercase: body.uppercase ?? true,
      isDefault: false,
    };

    const saved = await saveCaptionPreset(newPreset);
    return NextResponse.json({ success: true, preset: saved });
  } catch (error) {
    return NextResponse.json(
      { error: toErrorMessage(error, 'Failed to create caption preset.') },
      { status: toErrorStatus(error, 500) }
    );
  }
}

export async function PUT(request: Request) {
  try {
    const body = await request.json();
    if (!body._id) {
      return NextResponse.json({ error: 'Missing preset _id' }, { status: 400 });
    }

    const saved = await saveCaptionPreset(body);
    return NextResponse.json({ success: true, preset: saved });
  } catch (error) {
    return NextResponse.json(
      { error: toErrorMessage(error, 'Failed to update caption preset.') },
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

    await deleteCaptionPreset(id);
    return NextResponse.json({ success: true });
  } catch (error) {
    return NextResponse.json(
      { error: toErrorMessage(error, 'Failed to delete caption preset.') },
      { status: toErrorStatus(error, 500) }
    );
  }
}
