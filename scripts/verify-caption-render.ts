/** Real Chromium -> transparent theme frames -> FFmpeg -> ffprobe/pixel smoke test. No AI/provider calls. */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { bundle } from '@remotion/bundler';
import { selectComposition, renderFrames } from '@remotion/renderer';
import { DEFAULT_CAPTION_PRESETS } from '../lib/presets';
import { processVideoSegment } from '../worker/ffmpeg-pipeline';
import { getFfmpegPath, getFfprobePath } from '../lib/ffmpeg';
import { Jimp } from 'jimp';

async function main(){
 const dir=path.resolve('data/final-render-validation');fs.mkdirSync(dir,{recursive:true});
 const serveUrl=await bundle({entryPoint:path.resolve('remotion/index.tsx')});
 const browserExecutable=process.argv[2] ? path.resolve(process.argv[2]) : undefined;
 const source=path.join(dir,'speaker.mp4'),photo=path.join(dir,'object.png');
 const run=spawnSync(getFfmpegPath(),['-y','-v','error','-f','lavfi','-i','color=blue:s=1080x1920:r=30:d=1.2','-c:v','libx264','-preset','ultrafast',source]);if(run.status!==0)throw Error(run.stderr.toString());
 await new Jimp({width:1080,height:1920,color:0x772200ff}).write(photo as `${string}.png`);
 const results=[];
 for(const name of ['kinetic-01','pop','podcast']){
  const start=performance.now();const outputDir=path.join(dir,name);fs.mkdirSync(outputDir,{recursive:true});
  const inputProps={preset:DEFAULT_CAPTION_PRESETS.find(p=>p.captionTheme===name),hookText:'',hookDuration:0,ctaText:'',ctaDuration:0,totalDuration:1.2,words:[{word:'BOOK',start:0,end:0.6},{word:'CLUB',start:0.6,end:1.2}]};
  const composition=await selectComposition({serveUrl,id:'CaptionOverlayComposition',inputProps,browserExecutable});
  await renderFrames({serveUrl,composition:{...composition,durationInFrames:36},inputProps,outputDir,imageFormat:'png',imageSequencePattern:'overlay_[frame].[ext]',browserExecutable,concurrency:1,chromiumOptions:{gl:'swiftshader'},logLevel:'warn',onStart:()=>undefined,onFrameUpdate:()=>undefined});
  const files=fs.readdirSync(outputDir).filter(p=>p.endsWith('.png')).sort();
  if(files.length!==36)throw Error(`Expected 36 frames, got ${files.length}`);
  // Normalize the frame names to the exact sequence contract used by FFmpeg.
  const normalized=path.join(outputDir,'sequence');fs.mkdirSync(normalized,{recursive:true});files.forEach((f,i)=>fs.copyFileSync(path.join(outputDir,f),path.join(normalized,`overlay_${String(i+1).padStart(5,'0')}.png`)));
  const output=path.join(dir,name+'.mp4');
  await processVideoSegment({sourceVideoPath:source,outputPath:output,start:0,end:1.2,hookDuration:0,hookStart:0,filterPresetId:'none',plan:{mode:'single',cropW:1080,cropH:1920,points:[],faceAnchorY:0.35},sourceWidth:1080,sourceHeight:1920,targetFps:30,sourceHasAudio:false,overlays:[{name:'captions',inputPattern:path.join(normalized,'overlay_%05d.png'),startAtSeconds:0}],visualOverlays:[{id:'object',imagePath:photo,x:0,y:0,width:1080,height:1920,start:0.1,end:1.1,animation:'fade'}]});
  const probe=spawnSync(getFfprobePath(),['-v','error','-show_entries','stream=width,height,codec_name,duration,nb_frames','-of','json',output]);if(probe.status!==0)throw Error(probe.stderr.toString());
  const metadata = JSON.parse(probe.stdout.toString()) as { streams: Array<{ codec_name: string; width?: number; height?: number; duration?: string; nb_frames?: string }> };
  const video = metadata.streams.find((stream) => stream.codec_name === 'h264');
  if (!video || video.width !== 1080 || video.height !== 1920 || Number(video.nb_frames) !== 36 || Math.abs(Number(video.duration) - 1.2) > 0.05) throw Error(`Invalid output for ${name}`);
  const pixels=spawnSync(getFfmpegPath(),['-v','error','-ss','0.5','-i',output,'-frames:v','1','-f','rawvideo','-pix_fmt','rgb24','pipe:1'],{maxBuffer:8*1024*1024}).stdout;
  const mask=await Jimp.read(path.join(outputDir,files[15]));let white=0;for(let j=0;j<1080*1920;j++){const i=j*3;if(mask.bitmap.data[j*4+3]>200 && Math.abs(pixels[i]-119)+Math.abs(pixels[i+1]-34)+Math.abs(pixels[i+2])>80)white++;}
  if(white<50)throw Error(`Caption pixels missing for ${name}: ${white}`);
  const result={theme:name,ms:Math.round(performance.now()-start),bytes:fs.statSync(output).size,captionPixels:white,probe:metadata};results.push(result);console.log(JSON.stringify(result));
 }
 fs.writeFileSync(path.join(dir,'results.json'),JSON.stringify(results,null,2));
}
main().catch(e=>{console.error(e);process.exitCode=1});
