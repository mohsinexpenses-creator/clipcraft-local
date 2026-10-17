/** Pure prefetch-time frame plan. Never blur or decode a source photograph per video frame. */
export function planVisualFrame(width: number, height: number, face?: { x: number; y: number; width: number; height: number }): {
  mode: 'cover' | 'blur-fill'; upscale: number; filter: string;
} {
  if (!(width > 0 && height > 0)) throw new Error('Invalid visual dimensions');
  let forceFit = false;
  if (face) {
    const cropW = Math.min(width, height * 9 / 16); const cropH = cropW * 16 / 9;
    const x = Math.max(0, Math.min(width - cropW, face.x + face.width / 2 - cropW / 2));
    const y = Math.max(0, Math.min(height - cropH, face.y - face.height * 0.65));
    const safe = face.x - face.width * 0.2 >= x && face.x + face.width * 1.2 <= x + cropW && face.y - face.height * 0.4 >= y && face.y + face.height * 1.3 <= y + cropH;
    if (safe) {
      const upscale = 1080 / cropW; if (upscale > 1.5) throw new Error('Face crop exceeds maximum 1.5x upscale');
      return { mode: 'cover', upscale, filter: `[0:v]crop=${Math.floor(cropW / 2) * 2}:${Math.floor(cropH / 2) * 2}:${Math.floor(x / 2) * 2}:${Math.floor(y / 2) * 2},scale=1080:1920,setsar=1[frame]` };
    }
    forceFit = true;
  }
  const mode = !forceFit && width / height <= 0.85 ? 'cover' : 'blur-fill';
  const upscale = mode === 'cover' ? Math.max(1080 / width, 1920 / height) : Math.min(1080 / width, 1920 / height);
  if (upscale > 1.5) throw new Error(`Visual requires ${upscale.toFixed(2)}x upscale (maximum 1.5x)`);
  return {
    mode, upscale,
    filter: mode === 'cover'
      ? '[0:v]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,setsar=1[frame]'
      : '[0:v]split=2[bg][fg];[bg]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,boxblur=30:2,eq=brightness=-0.18[blur];[fg]scale=1080:1920:force_original_aspect_ratio=decrease[sharp];[blur][sharp]overlay=(W-w)/2:(H-h)/2,setsar=1[frame]',
  };
}
