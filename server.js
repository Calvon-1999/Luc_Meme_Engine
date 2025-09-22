// server.js - Single Video + Trimmed Music

const express = require('express');
const ffmpeg = require('fluent-ffmpeg');
const axios = require('axios');
const fs = require('fs').promises;
const path = require('path');
const { v4: uuidv4 } = require('uuid');

const ffmpeg = require('fluent-ffmpeg');
const ffmpegPath = require('@ffmpeg-installer/ffmpeg').path;
const ffprobePath = require('@ffprobe-installer/ffprobe').path;

ffmpeg.setFfmpegPath(ffmpegPath);
ffmpeg.setFfprobePath(ffprobePath);

const app = express();
const PORT = process.env.PORT || 8080;

app.use(express.json({ limit: '50mb' }));

const TEMP_DIR = '/tmp';
const OUTPUT_DIR = path.join(TEMP_DIR, 'output');

async function ensureDirectories() {
  await fs.mkdir(OUTPUT_DIR, { recursive: true });
}

async function downloadFile(url, filepath) {
  const response = await axios({
    method: 'GET',
    url,
    responseType: 'stream',
    timeout: 30000
  });

  const writer = require('fs').createWriteStream(filepath);
  response.data.pipe(writer);

  return new Promise((resolve, reject) => {
    writer.on('finish', resolve);
    writer.on('error', reject);
  });
}

async function getVideoDuration(videoPath) {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(videoPath, (err, metadata) => {
      if (err) reject(err);
      else resolve(metadata?.format?.duration || null);
    });
  });
}

async function trimAudio(inputPath, outputPath, duration) {
  return new Promise((resolve, reject) => {
    ffmpeg(inputPath)
      .setStartTime(0)
      .duration(duration)
      .output(outputPath)
      .on('end', resolve)
      .on('error', reject)
      .run();
  });
}

async function addAudioToVideo(videoPath, audioPath, outputPath) {
  return new Promise((resolve, reject) => {
    ffmpeg(videoPath)
      .input(audioPath)
      .complexFilter('[1:a]volume=1.0[music]')
      .outputOptions([
        '-map', '0:v:0',
        '-map', '[music]',
        '-c:v', 'copy',
        '-c:a', 'aac',
        '-shortest'
      ])
      .output(outputPath)
      .on('end', resolve)
      .on('error', reject)
      .run();
  });
}

// POST /api/add-audio (Single Video + Trimmed Music)
app.post('/api/add-audio', async (req, res) => {
  const jobId = uuidv4();
  console.log(`Job ${jobId} started`);

  try {
    const { video_url, music_url } = req.body;
    if (!video_url || !music_url) {
      return res.status(400).json({ error: 'Missing video_url or music_url' });
    }

    const jobDir = path.join(TEMP_DIR, jobId);
    await fs.mkdir(jobDir, { recursive: true });

    const videoPath = path.join(jobDir, 'video.mp4');
    const audioPath = path.join(jobDir, 'music.mp3');
    const trimmedAudioPath = path.join(jobDir, 'trimmed_music.mp3');
    const finalOutputPath = path.join(OUTPUT_DIR, `output_${jobId}.mp4`);

    await downloadFile(video_url, videoPath);
    await downloadFile(music_url, audioPath);

    const videoDuration = await getVideoDuration(videoPath);
    if (!videoDuration) throw new Error('Could not get video duration');

    await trimAudio(audioPath, trimmedAudioPath, videoDuration);
    await addAudioToVideo(videoPath, trimmedAudioPath, finalOutputPath);

    const stats = await fs.stat(finalOutputPath);
    await fs.rm(jobDir, { recursive: true, force: true });

    res.json({
      success: true,
      jobId,
      downloadUrl: `/download/${jobId}`,
      finalVideoUrl: `${req.protocol}://${req.get('host')}/download/${jobId}`,
      fileSizeMB: (stats.size / (1024 * 1024)).toFixed(2),
      message: 'Audio added to video successfully'
    });

  } catch (err) {
    console.error(`Job ${jobId} failed`, err);
    res.status(500).json({ success: false, error: err.message, jobId });
  }
});

// Download endpoint
app.get('/download/:jobId', async (req, res) => {
  const filePath = path.join(OUTPUT_DIR, `output_${req.params.jobId}.mp4`);
  try {
    await fs.access(filePath);
    res.download(filePath);
  } catch {
    res.status(404).json({ error: 'File not found' });
  }
});

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'OK', service: 'Video+Audio Merge API' });
});

async function start() {
  await ensureDirectories();
  app.listen(PORT, () => {
    console.log(`Server listening on port ${PORT}`);
  });
}

start().catch(console.error);
