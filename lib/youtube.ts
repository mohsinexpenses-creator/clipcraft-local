import ytdl from '@distube/ytdl-core';
import fs from 'fs';
import path from 'path';

export interface YoutubeVideoInfo {
  title: string;
  duration: number; // in seconds
  videoId: string;
}

export async function downloadYoutubeVideo(
  youtubeUrl: string,
  outputFilePath: string
): Promise<YoutubeVideoInfo> {
  console.log(`[YouTube Downloader] Validating YouTube URL: ${youtubeUrl}`);
  if (!ytdl.validateURL(youtubeUrl)) {
    throw new Error('Invalid YouTube URL provided.');
  }

  const info = await ytdl.getInfo(youtubeUrl);
  const title = info.videoDetails.title || 'YouTube Video';
  const duration = parseInt(info.videoDetails.lengthSeconds, 10) || 0;
  const videoId = info.videoDetails.videoId;

  const outputDir = path.dirname(outputFilePath);
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  console.log(`[YouTube Downloader] Downloading '${title}' (${duration}s) to ${outputFilePath}...`);

  return new Promise((resolve, reject) => {
    // Request combined audio/video MP4 stream (highest 720p/1080p format)
    const stream = ytdl(youtubeUrl, {
      quality: 'highestvideo',
      filter: (format) => format.container === 'mp4' && !!format.hasVideo && !!format.hasAudio,
    });

    const fileStream = fs.createWriteStream(outputFilePath);

    stream.pipe(fileStream);

    stream.on('error', (err) => {
      console.error('[YouTube Downloader] Stream error:', err);
      // Fallback: try default highest format if filtered mp4 fails
      const fallbackStream = ytdl(youtubeUrl, { quality: 'highest' });
      const fallbackFileStream = fs.createWriteStream(outputFilePath);
      fallbackStream.pipe(fallbackFileStream);

      fallbackFileStream.on('finish', () => {
        resolve({ title, duration, videoId });
      });

      fallbackStream.on('error', (fallbackErr) => {
        reject(new Error(`Failed to download YouTube video: ${fallbackErr.message}`));
      });
    });

    fileStream.on('finish', () => {
      console.log(`[YouTube Downloader] Download completed for '${title}'`);
      resolve({ title, duration, videoId });
    });

    fileStream.on('error', (err) => {
      reject(new Error(`Failed to save video stream to disk: ${err.message}`));
    });
  });
}
