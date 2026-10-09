import { NextResponse } from 'next/server';
import { APP_SETTINGS_SECTIONS, AppSettingsSection, ResolvedPaths } from '@/lib/types';
import { buildAppSettingsSnapshot, clearSettingsSection, envAiSectionForImport, saveSettingsSection } from '@/lib/app-settings';
import { getCaptionPreset, getOverlayStylePreset, listCaptionPresets, listOverlayStylePresets } from '@/lib/db';
import { getFfmpegPath, getFfprobePath } from '@/lib/ffmpeg';
import { getWhisperCliPath } from '@/lib/whisper';
import { getUploadDirValue } from '@/lib/upload';
import { getClipsDirValue } from '@/lib/paths';
import { AppError, toErrorMessage, toErrorStatus } from '@/lib/errors';

export const runtime = 'nodejs';

/**
 * The locations/binaries the app actually uses right now (stored value,
 * otherwise the automatic chain). Shown on the Settings page as the "current"
 * placeholder under each field, so an empty field is never a mystery.
 */
function resolveCurrentPaths(): ResolvedPaths {
  try {
    return {
      uploadDir: getUploadDirValue(),
      clipsDir: getClipsDirValue(),
      ffmpegPath: getFfmpegPath(),
      ffprobePath: getFfprobePath(),
      whisperCliPath: getWhisperCliPath() ?? '',
    };
  } catch {
    return { uploadDir: '', clipsDir: '', ffmpegPath: '', ffprobePath: '', whisperCliPath: '' };
  }
}

/**
 * The snapshot the page renders, plus the resolved locations/binaries. Every
 * response that carries a snapshot carries both, so a save can never blank the
 * "currently in use" lines on the Paths & binaries card.
 */
async function settingsPayload() {
  const snapshot = await buildAppSettingsSnapshot();
  return { ...snapshot, resolvedPaths: resolveCurrentPaths() };
}

/**
 * GET /api/settings
 *
 * Everything the Settings page shows in one round trip: what is stored, what is
 * actually in effect (a saved value, otherwise the built-in default), and the option
 * lists its selects need. `.env.local` is not a tier in that chain, so the page cannot
 * disagree with the app. Secrets are masked - the response never contains a key it did
 * not already have.
 */
export async function GET() {
  try {
    const [payload, captions, overlays] = await Promise.all([
      settingsPayload(),
      listCaptionPresets(),
      listOverlayStylePresets(),
    ]);

    return NextResponse.json({
      ...payload,
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

    return NextResponse.json({
      success: true,
      section,
      updatedAt,
      saved,
      snapshot: await settingsPayload(),
    });
  } catch (error) {
    return NextResponse.json(
      { error: toErrorMessage(error, 'These settings could not be saved.') },
      { status: toErrorStatus(error, 400) }
    );
  }
}

/**
 * POST /api/settings   { action: 'import-env' }
 *
 * The one place `.env.local` is read on purpose: copying the keys that file already
 * holds into Settings, so an existing setup is not stranded the moment env stopped being
 * a fallback. It is an explicit click, it writes (it does not shadow), and it can only
 * move secrets - there is no read of them in the response.
 */
export async function POST(request: Request) {
  try {
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    if (body.action !== 'import-env') {
      throw new AppError('Unsupported action.', { status: 400, resolution: "Send { action: 'import-env' }." });
    }

    const value = await envAiSectionForImport();
    if (!value) {
      throw new AppError('There is nothing to copy - .env.local has no usable GEMINI_API_KEY or DEEPGRAM_API_KEY.', {
        status: 400,
        resolution: 'Add the key under Settings -> AI providers instead.',
      });
    }

    const { saved } = await saveSettingsSection('ai', value);
    return NextResponse.json({
      success: true,
      // Only the shape is reported back; the values are secrets.
      copied: { geminiKeys: ((saved.geminiApiKeys as string[] | undefined) ?? []).length, deepgram: Boolean(saved.deepgramApiKey) },
      snapshot: await settingsPayload(),
    });
  } catch (error) {
    return NextResponse.json(
      { error: toErrorMessage(error, 'Those keys could not be copied.') },
      { status: toErrorStatus(error, 400) }
    );
  }
}

/**
 * DELETE /api/settings?section=render
 *
 * Deletes a whole section's row, which leaves the built-in defaults for it - not
 * `.env.local`, which these keys no longer come from. Nothing destructive: uploads,
 * clips and presets are untouched.
 */
export async function DELETE(request: Request) {
  try {
    const url = new URL(request.url);
    const section = readSection({ section: url.searchParams.get('section') ?? '' });
    await clearSettingsSection(section);
    return NextResponse.json({ success: true, section, snapshot: await settingsPayload() });
  } catch (error) {
    return NextResponse.json(
      { error: toErrorMessage(error, 'Could not reset this section.') },
      { status: toErrorStatus(error, 400) }
    );
  }
}
