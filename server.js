// server.js - Luc_Meme_Engine (Audio + Video Processing Only)
// Cleaned up: no overlay/logo references, renamed endpoints properly

const express = require('express');
const ffmpeg = require('fluent-ffmpeg');
const axios = require('axios');
const fs = require('fs').promises;
const path = require('path');
const { v4: uuidv4 } = require('uuid');

// Set ffmpeg and ffprobe paths
const ffmpegPath = '/usr/bin/ffmpeg';
const ffprobePath = '/usr/bin/ffprobe';
ffmpeg.setFfmpegPath(ffmpegPath);
ffmpeg.setFfprobePath(ffprobePath);

const app = express();
const PORT = process.env.PORT || 8080;

app.use(express.json({ limit: '50mb' }));
app.use(express.static('public'));

const TEMP_DIR = '/tmp';
const OUTPUT_DIR = path.join(TEMP_DIR, 'output');

async function ensureDirectories() {
  try {
    await fs.mkdir(OUTPUT_DIR, { recursive: true });
    await fs.mkdir('/tmp/uploads', { recursive: true });
  } catch (error) {
    console.log('Directories already exist or error creating:', error.message);
  }
}

async function downloadFile(url, filepath) {
  const response = await axios({
    method: 'GET',
    url: url,
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

async function getVideoDuration(videoPath) {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(videoPath, (err, metadata) => {
      if (err) reject(err);
      else resolve(metadata?.format?.duration || null);
    });
  });
}

async function stitchVideos(videoPaths, outputPath) {
  return new Promise((resolve, reject) => {
    const command = ffmpeg();
    videoPaths.forEach(videoPath => command.input(videoPath));

    const filterComplex =
      videoPaths.map((_, index) => `[${index}:v]`).join('') +
      `concat=n=${videoPaths.length}:v=1:a=0[outv]`;

    command
      .complexFilter(filterComplex)
      .outputOptions(['-map', '[outv]'])
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

// ----------------- ROUTES -----------------

// POST /api/add-audio (single video + background music)
app.post('/api/add-audio', async (req, res) => {
  const jobId = uuidv4();
  console.log(`Starting add-audio job ${jobId}`);

  try {
    const { video_url, music_url } = req.body;
    if (!video_url || !music_url) {
      return res.status(400).json({ error: 'Missing video_url or music_url' });
    }

    const jobDir = path.join(TEMP_DIR, jobId);
    await fs.mkdir(jobDir, { recursive: true });

    const videoPath = path.join(jobDir, 'input_video.mp4');
    await downloadFile(video_url, videoPath);

    const audioPath = path.join(jobDir, 'audio.mp3');
    await downloadFile(music_url, audioPath);

    const videoDuration = await getVideoDuration(videoPath);
    if (!videoDuration) throw new Error('Could not determine video duration');

    const trimmedAudioPath = path.join(jobDir, 'audio_trimmed.mp3');
    await trimAudio(audioPath, trimmedAudioPath, videoDuration);

    const finalVideoPath = path.join(OUTPUT_DIR, `final_video_${jobId}.mp4`);
    await addAudioToVideo(videoPath, trimmedAudioPath, finalVideoPath);

    const stats = await fs.stat(finalVideoPath);

    // cleanup
    await fs.rm(jobDir, { recursive: true, force: true });

    res.json({
      success: true,
      jobId,
      downloadUrl: `/download/${jobId}`,
      finalVideoUrl: `${req.protocol}://${req.get('host')}/download/${jobId}`,
      fileSizeMB: (stats.size / (1024 * 1024)).toFixed(2),
      message: 'Music added to video successfully'
    });

  } catch (error) {
    console.error(`Job ${jobId} failed:`, error);
    res.status(500).json({ success: false, error: error.message, jobId });
  }
});

// POST /api/stitch-videos (multiple clips + background music)
app.post('/api/stitch-videos', async (req, res) => {
  const jobId = uuidv4();
  console.log(`Starting stitch-videos job ${jobId}`);

  try {
    const { videos, music_url } = req.body;
    if (!videos || !Array.isArray(videos) || !music_url) {
      return res.status(400).json({ error: 'Expected videos array and music_url' });
    }

    const jobDir = path.join(TEMP_DIR, jobId);
    await fs.mkdir(jobDir, { recursive: true });

    const audioPath = path.join(jobDir, 'audio.mp3');
    await downloadFile(music_url, audioPath);

    const sortedVideos = videos.sort((a, b) => a.scene_number - b.scene_number);
    const videoPaths = [];

    for (const v of sortedVideos) {
      const videoPath = path.join(jobDir, `scene_${v.scene_number}.mp4`);
      await downloadFile(v.video_url, videoPath);
      videoPaths.push(videoPath);
    }

    const stitchedPath = path.join(jobDir, 'stitched.mp4');
    await stitchVideos(videoPaths, stitchedPath);

    const stitchedDuration = await getVideoDuration(stitchedPath);
    const trimmedAudioPath = path.join(jobDir, 'audio_trimmed.mp3');
    await trimAudio(audioPath, trimmedAudioPath, stitchedDuration);

    const finalVideoPath = path.join(OUTPUT_DIR, `final_video_${jobId}.mp4`);
    await addAudioToVideo(stitchedPath, trimmedAudioPath, finalVideoPath);

    const stats = await fs.stat(finalVideoPath);

    await fs.rm(jobDir, { recursive: true, force: true });

    res.json({
      success: true,
      jobId,
      downloadUrl: `/download/${jobId}`,
      finalVideoUrl: `${req.protocol}://${req.get('host')}/download/${jobId}`,
      processedVideos: videos.length,
      fileSizeMB: (stats.size / (1024 * 1024)).toFixed(2),
      message: 'Videos stitched with music successfully'
    });

  } catch (error) {
    console.error(`Job ${jobId} failed:`, error);
    res.status(500).json({ success: false, error: error.message, jobId });
  }
});

// Download & status endpoints
app.get('/download/:jobId', async (req, res) => {
  const filePath = path.join(OUTPUT_DIR, `final_video_${req.params.jobId}.mp4`);
  try {
    await fs.access(filePath);
    res.download(filePath);
  } catch {
    res.status(404).json({ error: 'Video not found' });
  }
});

app.get('/api/status/:jobId', async (req, res) => {
  const filePath = path.join(OUTPUT_DIR, `final_video_${req.params.jobId}.mp4`);
  try {
    await fs.access(filePath);
    res.json({ status: 'completed', jobId: req.params.jobId });
  } catch {
    res.json({ status: 'processing', jobId: req.params.jobId });
  }
});

app.get('/health', (req, res) => {
  res.json({ status: 'OK', service: 'Luc_Meme_Engine', version: 'clean-no-overlay' });
});

app.get('/', (req, res) => {
  res.json({
    service: 'Luc_Meme_Engine',
    endpoints: {
      addAudio: 'POST /api/add-audio',
      stitchVideos: 'POST /api/stitch-videos',
      download: 'GET /download/:jobId',
      status: 'GET /api/status/:jobId',
      health: 'GET /health'
    }
  });
});

async function startServer() {
  await ensureDirectories();
  app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
  });
}

startServer().catch(console.error);
