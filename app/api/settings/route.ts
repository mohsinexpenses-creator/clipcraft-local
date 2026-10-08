import { NextResponse } from 'next/server';
import { APP_SETTINGS_SECTIONS, AppSettingsSection } from '@/lib/types';
import { buildAppSettingsSnapshot, clearSettingsSection, saveSettingsSection } from '@/lib/app-settings';
import { getCaptionPreset, getOverlayStylePreset, listCaptionPresets, listOverlayStylePresets } from '@/lib/db';
import { AppError, toErrorMessage, toErrorStatus } from '@/lib/errors';

export const runtime = 'nodejs';

/**
 * GET /api/settings
 *
 * Everything the Settings page shows in one round trip: what is stored, what is
 * actually in effect (stored -> `.env.local` -> built-in default), where each value
 * came from, and the option lists its selects need. Secrets are masked - the response
 * never contains a key it did not already have.
 */
export async function GET() {
  try {
    const [snapshot, captions, overlays] = await Promise.all([
      buildAppSettingsSnapshot(),
      listCaptionPresets(),
      listOverlayStylePresets(),
    ]);

    return NextResponse.json({
      ...snapshot,
      options: {
        captionPresets: captions.map((preset) => ({
          id: preset._id,
          name: preset.name,
          isDefault: preset.isDefault,
        })),
        overlayPresets: overlays.map((preset) => ({
          id: preset._id,
          kind: preset.kind,
          name: preset.name,
          isDefault: preset.isDefault,
        })),
      },
    });
  } catch (error) {
    return NextResponse.json(
      { error: toErrorMessage(error, 'Could not load settings.') },
      { status: toErrorStatus(error, 500) }
    );
  }
}

function readSection(body: Record<string, unknown>): AppSettingsSection {
  const section = String(body.section ?? '').trim() as AppSettingsSection;
  if (!APP_SETTINGS_SECTIONS.includes(section)) {
    throw new AppError(`Unknown settings section "${section || '(missing)'}".`, {
      status: 400,
      resolution: `Send one of: ${APP_SETTINGS_SECTIONS.join(', ')}.`,
    });
  }
  return section;
}

/**
 * Storing a preset id that no longer exists would silently render something else, so
 * the id is checked here - the only place that has both the settings row and the
 * preset tables. An empty value means "use the preset the preset table marks default".
 */
async function assertPresetsExist(sanitized: Record<string, unknown>): Promise<void> {
  if (typeof sanitized.captionPresetId === 'string') {
    const preset = await getCaptionPreset(sanitized.captionPresetId);
    if (!preset) throw new AppError(`Caption preset "${sanitized.captionPresetId}" no longer exists.`, { status: 400, resolution: 'Pick one of the listed presets, or choose "Database default".' });
  }

  for (const [field, kind] of [
    ['hookStylePresetId', 'hook'],
    ['ctaStylePresetId', 'cta'],
  ] as const) {
    const id = sanitized[field];
    if (typeof id !== 'string') continue;
    const preset = await getOverlayStylePreset(id);
    if (!preset) {
      throw new AppError(`Overlay style preset "${id}" no longer exists.`, { status: 400, resolution: 'Pick one of the listed presets, or choose "Database default".' });
    }
    if (preset.kind !== kind) {
      throw new AppError(`"${preset.name}" is a ${preset.kind} preset, so it cannot be used as the ${kind} style.`, {
        status: 400,
        resolution: `Choose a ${kind} preset.`,
      });
    }
  }
}

/**
 * PUT /api/settings   { section, value }
 *
 * Saves one section. `value` is a partial object: fields that are omitted keep their
 * stored value, and a masked secret placeholder means "keep the key I already have"
 * (the browser never sees the real one). Values are validated and clamped here, never
 * at render time, so a typo is a 400 with a fix rather than a broken clip.
 */
export async function PUT(request: Request) {
  try {
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    const section = readSection(body);
    const { updatedAt, saved } = await saveSettingsSection(section, body.value, {
      // Rejected before the write, so a bad preset id never lands in the table.
      ...(section === 'render' ? { validate: assertPresetsExist } : {}),
    });

    return NextResponse.json({ success: true, section, updatedAt, saved, snapshot: await buildAppSettingsSnapshot() });
  } catch (error) {
    return NextResponse.json(
      { error: toErrorMessage(error, 'These settings could not be saved.') },
      { status: toErrorStatus(error, 400) }
    );
  }
}

/**
 * DELETE /api/settings?section=render
 *
 * Clears a whole section, which is how a value goes back to "whatever .env.local
 * says". Nothing destructive: uploads, clips and presets are untouched.
 */
export async function DELETE(request: Request) {
  try {
    const url = new URL(request.url);
    const section = readSection({ section: url.searchParams.get('section') ?? '' });
    await clearSettingsSection(section);
    return NextResponse.json({ success: true, section, snapshot: await buildAppSettingsSnapshot() });
  } catch (error) {
    return NextResponse.json(
      { error: toErrorMessage(error, 'Could not reset this section.') },
      { status: toErrorStatus(error, 400) }
    );
  }
}
