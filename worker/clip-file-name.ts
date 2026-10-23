/** Build a filesystem-safe render name as rank_title_hashtags. */
export function buildClipFileName(
  rank: number | undefined,
  title: string | undefined,
  hashtags: string[] | undefined
): string {
  const safeTitle = sanitizePart(title ?? '');
  if (!safeTitle) return '';

  const safeHashtags = (hashtags ?? [])
    .map((hashtag) => hashtag.replace(/\s+/g, ''))
    .filter(Boolean)
    .join('');
  const prefix = Number.isFinite(rank) && rank! > 0 ? `${rank}_` : '';
  const suffix = safeHashtags ? `_${sanitizePart(safeHashtags)}` : '';
  return `${prefix}${safeTitle}${suffix}`.slice(0, 80).replace(/[ ._-]+$/g, '');
}

function sanitizePart(value: string): string {
  return value
    .replace(/[\/\\:*?"<>|\u0000-\u001f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}