/** Pure prefetch-time frame plan. Never blur or decode a source photograph per video frame. */
export function planVisualFrame(width: number, height: number): {
  mode: 'cover' | 'blur-fill'; upscale: number; filter: string;
} {
  if (!(width > 0 && height > 0)) throw new Error('Invalid visual dimensions');
  const mode = width / height <= 0.85 ? 'cover' : 'blur-fill';
  const upscale = mode === 'cover' ? Math.max(1080 / width, 1920 / height) : 1080 / width;
  if (upscale > 1.5) throw new Error(`Visual requires ${upscale.toFixed(2)}x upscale (maximum 1.5x)`);
  return {
    mode, upscale,
    filter: mode === 'cover'
      ? '[0:v]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,setsar=1[frame]'
      : '[0:v]split=2[bg][fg];[bg]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,boxblur=30:2,eq=brightness=-0.18[blur];[fg]scale=1080:-2[sharp];[blur][sharp]overlay=(W-w)/2:(H-h)/2,setsar=1[frame]',
  };
}
