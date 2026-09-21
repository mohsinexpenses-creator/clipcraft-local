import ytdl from '@distube/ytdl-core';
import play from 'play-dl';
import fs from 'fs';
import path from 'path';
import { runFfmpeg } from './ffmpeg';

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

  const outputDir = path.dirname(outputFilePath);
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  // Attempt Method 1: @distube/ytdl-core with smart format selection & FFmpeg audio/video merge
  try {
    return await downloadWithYtdlCore(youtubeUrl, outputFilePath);
  } catch (err: any) {
    console.warn('[YouTube Downloader] Method 1 (@distube/ytdl-core) encountered an issue:', err.message || err);
  }

  // Attempt Method 2: play-dl fallback
  try {
    return await downloadWithPlayDl(youtubeUrl, outputFilePath);
  } catch (err: any) {
    console.warn('[YouTube Downloader] Method 2 (play-dl) encountered an issue:', err.message || err);
  }

  throw new Error(`Failed to download YouTube video. Please check the URL or try uploading a local MP4 file.`);
}

async function downloadWithYtdlCore(
  youtubeUrl: string,
  outputFilePath: string
): Promise<YoutubeVideoInfo> {
  if (!ytdl.validateURL(youtubeUrl)) {
    throw new Error('Invalid YouTube URL format.');
  }

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

  // Check for combined audio+video formats
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

      stream.on('error', (err) => reject(err));
      fileStream.on('error', (err) => reject(err));
    });
  }

  // Adaptive formats: download best video + best audio and merge with FFmpeg
  console.log('[YouTube Downloader] Adaptive formats detected. Downloading separate video and audio streams for FFmpeg merge...');
  const tmpVideoPath = `${outputFilePath}.tmp_video.mp4`;
  const tmpAudioPath = `${outputFilePath}.tmp_audio.m4a`;

  const videoFormats = ytdl.filterFormats(info.formats, 'videoonly');
  const audioFormats = ytdl.filterFormats(info.formats, 'audioonly');

  if (videoFormats.length === 0 || audioFormats.length === 0) {
    throw new Error('No playable video or audio formats found for this video.');
  }

  const bestVideoFormat = ytdl.chooseFormat(videoFormats, { quality: 'highestvideo' });
  const bestAudioFormat = ytdl.chooseFormat(audioFormats, { quality: 'highestaudio' });

  // Download video stream
  await new Promise<void>((resolve, reject) => {
    const vStream = ytdl.downloadFromInfo(info, { format: bestVideoFormat });
    const vFile = fs.createWriteStream(tmpVideoPath);
    vStream.pipe(vFile);
    vFile.on('finish', () => resolve());
    vStream.on('error', (e) => reject(e));
    vFile.on('error', (e) => reject(e));
  });

  // Download audio stream
  await new Promise<void>((resolve, reject) => {
    const aStream = ytdl.downloadFromInfo(info, { format: bestAudioFormat });
    const aFile = fs.createWriteStream(tmpAudioPath);
    aStream.pipe(aFile);
    aFile.on('finish', () => resolve());
    aStream.on('error', (e) => reject(e));
    aFile.on('error', (e) => reject(e));
  });

  // Merge video + audio using FFmpeg
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

  // Clean up temp files
  try {
    if (fs.existsSync(tmpVideoPath)) fs.unlinkSync(tmpVideoPath);
    if (fs.existsSync(tmpAudioPath)) fs.unlinkSync(tmpAudioPath);
  } catch (e) {
    // ignore
  }

  console.log(`[YouTube Downloader] Successfully merged and saved YouTube video '${title}'`);
  return { title, duration, videoId };
}

async function downloadWithPlayDl(
  youtubeUrl: string,
  outputFilePath: string
): Promise<YoutubeVideoInfo> {
  console.log('[YouTube Downloader] Attempting play-dl fallback stream...');

  const info = await play.video_basic_info(youtubeUrl);
  const title = info.video_details.title || 'YouTube Video';
  const duration = info.video_details.durationInSec || 0;
  const videoId = info.video_details.id || 'yt_video';

  const stream = await play.stream(youtubeUrl, { quality: 2 });
  const fileStream = fs.createWriteStream(outputFilePath);

  return new Promise((resolve, reject) => {
    stream.stream.pipe(fileStream);

    fileStream.on('finish', () => {
      console.log(`[YouTube Downloader] play-dl stream completed for '${title}'`);
      resolve({ title, duration, videoId });
    });

    stream.stream.on('error', (err) => reject(err));
    fileStream.on('error', (err) => reject(err));
  });
}
