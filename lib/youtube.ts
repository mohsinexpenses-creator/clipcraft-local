import ytdl from '@distube/ytdl-core';
import fs from 'fs';
import path from 'path';
import { AppError, toErrorMessage } from './errors';
import { runFfmpeg } from './ffmpeg';

export interface YoutubeVideoInfo {
  title: string;
  duration: number;
  videoId: string;
}

export async function downloadYoutubeVideo(
  youtubeUrl: string,
  outputFilePath: string
): Promise<YoutubeVideoInfo> {
  console.log(`[YouTube Downloader] Validating YouTube URL: ${youtubeUrl}`);

  if (!ytdl.validateURL(youtubeUrl)) {
    throw new AppError('Invalid YouTube URL format.', {
      status: 400,
      resolution: 'Paste a full YouTube watch URL, for example https://www.youtube.com/watch?v=VIDEO_ID.',
    });
  }

  const outputDir = path.dirname(outputFilePath);
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  try {
    return await downloadWithYtdlCore(youtubeUrl, outputFilePath);
  } catch (error) {
    throw new AppError('YouTube download failed.', {
      status: 502,
      details: toErrorMessage(error),
      resolution:
        'Retry with a public YouTube URL, or upload the MP4 file manually if YouTube blocks automated access for this video.',
    });
  }
}

async function downloadWithYtdlCore(
  youtubeUrl: string,
  outputFilePath: string
): Promise<YoutubeVideoInfo> {
  const info = await ytdl.getInfo(youtubeUrl, {
    requestOptions: {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
      },
    },
  });

  const title = info.videoDetails.title || 'YouTube Video';
  const duration = parseInt(info.videoDetails.lengthSeconds, 10) || 0;
  const videoId = info.videoDetails.videoId;

  console.log(`[YouTube Downloader] Found YouTube video '${title}' (${duration}s)`);

  const combinedFormats = ytdl.filterFormats(info.formats, 'videoandaudio');

  if (combinedFormats.length > 0) {
    console.log('[YouTube Downloader] Single combined video+audio stream available. Downloading directly...');
    const chosenFormat = ytdl.chooseFormat(combinedFormats, { quality: 'highest' });

    return new Promise((resolve, reject) => {
      const stream = ytdl.downloadFromInfo(info, { format: chosenFormat });
      const fileStream = fs.createWriteStream(outputFilePath);

      stream.pipe(fileStream);

      fileStream.on('finish', () => {
        console.log(`[YouTube Downloader] Direct stream download finished for '${title}'`);
        resolve({ title, duration, videoId });
      });

      stream.on('error', (error) => reject(error));
      fileStream.on('error', (error) => reject(error));
    });
  }

  console.log('[YouTube Downloader] Adaptive formats detected. Downloading separate video and audio streams for FFmpeg merge...');
  const tmpVideoPath = `${outputFilePath}.tmp_video.mp4`;
  const tmpAudioPath = `${outputFilePath}.tmp_audio.m4a`;

  const videoFormats = ytdl.filterFormats(info.formats, 'videoonly');
  const audioFormats = ytdl.filterFormats(info.formats, 'audioonly');

  if (videoFormats.length === 0 || audioFormats.length === 0) {
    throw new AppError('No playable YouTube video/audio formats were found.', {
      status: 502,
      resolution: 'Try another public video URL or upload the source video file directly.',
    });
  }

  const bestVideoFormat = ytdl.chooseFormat(videoFormats, { quality: 'highestvideo' });
  const bestAudioFormat = ytdl.chooseFormat(audioFormats, { quality: 'highestaudio' });

  await new Promise<void>((resolve, reject) => {
    const videoStream = ytdl.downloadFromInfo(info, { format: bestVideoFormat });
    const videoFile = fs.createWriteStream(tmpVideoPath);
    videoStream.pipe(videoFile);
    videoFile.on('finish', () => resolve());
    videoStream.on('error', (error) => reject(error));
    videoFile.on('error', (error) => reject(error));
  });

  await new Promise<void>((resolve, reject) => {
    const audioStream = ytdl.downloadFromInfo(info, { format: bestAudioFormat });
    const audioFile = fs.createWriteStream(tmpAudioPath);
    audioStream.pipe(audioFile);
    audioFile.on('finish', () => resolve());
    audioStream.on('error', (error) => reject(error));
    audioFile.on('error', (error) => reject(error));
  });

  console.log('[YouTube Downloader] Merging video and audio streams with FFmpeg...');
  const mergeArgs = [
    '-y',
    '-i', tmpVideoPath,
    '-i', tmpAudioPath,
    '-c:v', 'copy',
    '-c:a', 'aac',
    outputFilePath,
  ];

  await runFfmpeg(mergeArgs);

  try {
    if (fs.existsSync(tmpVideoPath)) fs.unlinkSync(tmpVideoPath);
    if (fs.existsSync(tmpAudioPath)) fs.unlinkSync(tmpAudioPath);
  } catch {
    // Ignore cleanup errors after a successful merge.
  }

  console.log(`[YouTube Downloader] Successfully merged and saved YouTube video '${title}'`);
  return { title, duration, videoId };
}
