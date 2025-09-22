// server.js - Luc_Meme_Engine (no logo/overlay support)
// All overlay/logo/image handling removed

const express = require('express');
const ffmpeg = require('fluent-ffmpeg');
const axios = require('axios');
const fs = require('fs').promises;
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const multer = require('multer');

const app = express();
const PORT = process.env.PORT || 8080;

app.use(express.json({ limit: '50mb' }));
app.use(express.static('public'));

const upload = multer({
  dest: '/tmp/uploads/',
  limits: { fileSize: 10 * 1024 * 1024 }
});

const TEMP_DIR = '/tmp';
const OUTPUT_DIR = path.join(TEMP_DIR, 'output');

async function ensureDirectories() {
  try {
    await fs.mkdir(OUTPUT_DIR, { recursive: true });
    await fs.mkdir('/tmp/uploads', { recursive: true });
    await fs.mkdir('uploads', { recursive: true });
    await fs.mkdir('outputs', { recursive: true });
    await fs.mkdir('temp', { recursive: true });
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
      .on('end', () => {
        console.log(`Audio trimmed to ${duration}s`);
        resolve();
      })
      .on('error', (err) => {
        console.error('Audio trimming error:', err);
        reject(err);
      })
      .run();
  });
}

async function getVideoDuration(videoPath) {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(videoPath, (err, metadata) => {
      if (err) {
        reject(err);
      } else {
        const duration = metadata && metadata.format ? metadata.format.duration : null;
        resolve(duration);
      }
    });
  });
}

async function stitchVideos(videoPaths, outputPath) {
  return new Promise((resolve, reject) => {
    const command = ffmpeg();
    videoPaths.forEach(videoPath => {
      command.input(videoPath);
    });

    // concatenate video streams only (strip audio)
    const filterComplex = videoPaths.map((_, index) => `[${index}:v]`).join('') +
      `concat=n=${videoPaths.length}:v=1:a=0[outv]`;

    command
      .complexFilter(filterComplex)
      .outputOptions(['-map', '[outv]'])
      .output(outputPath)
      .on('end', () => {
        console.log('Video stitching completed');
        resolve();
      })
      .on('error', (err) => {
        console.error('Video stitching error:', err);
        reject(err);
      })
      .run();
  });
}

// Add music to a video (no overlay/logo) — maps only the provided music and ignores original audio
async function addAudioToVideo(videoPath, audioPath, outputPath) {
  return new Promise((resolve, reject) => {
    try {
      ffmpeg(videoPath)
        .input(audioPath)
        .complexFilter('[1:a]volume=1.0[music]')
        .outputOptions([
          '-map', '0:v:0',   // video only from input 0 (original video)
          '-map', '[music]', // music only from trimmed audio
          '-c:v', 'copy',
          '-c:a', 'aac',
          '-shortest'
        ])
        .output(outputPath)
        .on('end', () => {
          console.log('Added music to video (original audio ignored)');
          resolve();
        })
        .on('error', (err) => {
          console.error('addAudioToVideo error:', err);
          reject(err);
        })
        .run();
    } catch (err) {
      reject(err);
    }
  });
}

// ----------------- ROUTES -----------------

// POST /api/add-overlay
// NOTE: kept name for compatibility but this endpoint now ONLY adds music to a single video (no logo)
app.post('/api/add-overlay', async (req, res) => {
  const jobId = uuidv4();
  console.log(`Starting add-overlay (audio-only) job ${jobId}`);

  try {
    const { final_stitch_video, final_music_url } = req.body;

    if (!final_stitch_video || !final_music_url) {
      return res.status(400).json({
        error: 'Invalid input. Expected final_stitch_video and final_music_url'
      });
    }

    const jobDir = path.join(TEMP_DIR, jobId);
    await fs.mkdir(jobDir, { recursive: true });

    console.log('Downloading video...');
    const videoPath = path.join(jobDir, 'input_video.mp4');
    await downloadFile(final_stitch_video, videoPath);

    console.log('Downloading audio...');
    const audioPath = path.join(jobDir, 'audio.mp3');
    await downloadFile(final_music_url, audioPath);

    const videoDuration = await getVideoDuration(videoPath);
    if (!videoDuration) throw new Error('Could not determine video duration');

    const trimmedAudioPath = path.join(jobDir, 'audio_trimmed.mp3');
    await trimAudio(audioPath, trimmedAudioPath, videoDuration);

    const finalVideoPath = path.join(OUTPUT_DIR, `final_video_${jobId}.mp4`);
    await addAudioToVideo(videoPath, trimmedAudioPath, finalVideoPath);

    const finalDuration = await getVideoDuration(finalVideoPath);
    const stats = await fs.stat(finalVideoPath);

    // cleanup
    await fs.rm(jobDir, { recursive: true, force: true });

    res.json({
      success: true,
      jobId,
      downloadUrl: `/download/${jobId}`,
      finalVideoUrl: `${req.protocol}://${req.get('host')}/download/${jobId}`,
      videoStats: {
        duration: finalDuration,
        fileSize: stats.size,
        fileSizeMB: (stats.size / (1024 * 1024)).toFixed(2)
      },
      message: 'Successfully added background music to video (no logo applied)'
    });

  } catch (error) {
    console.error(`Job ${jobId} failed:`, error);
    try { await fs.rm(path.join(TEMP_DIR, jobId), { recursive: true, force: true }); } catch (_) {}
    res.status(500).json({
      success: false,
      error: error.message,
      jobId
    });
  }
});

// POST /api/stitch-videos
// expects `videos` array (with items having final_video_url and scene_number) and `mv_audio` (music URL)
app.post('/api/stitch-videos', async (req, res) => {
  const jobId = uuidv4();
  console.log(`Starting video stitching job ${jobId}`);

  try {
    const { videos, mv_audio } = req.body;

    if (!videos || !Array.isArray(videos) || !mv_audio) {
      return res.status(400).json({
        error: 'Invalid input. Expected videos array and mv_audio URL'
      });
    }

    const jobDir = path.join(TEMP_DIR, jobId);
    await fs.mkdir(jobDir, { recursive: true });

    console.log('Downloading audio...');
    const audioPath = path.join(jobDir, 'audio.mp3');
    await downloadFile(mv_audio, audioPath);

    console.log('Sorting and downloading videos...');
    const sortedVideos = videos.sort((a, b) => {
      const sceneA = parseInt(a.scene_number, 10);
      const sceneB = parseInt(b.scene_number, 10);
      return sceneA - sceneB;
    });

    const videoPaths = [];
    for (let i = 0; i < sortedVideos.length; i++) {
      const video = sortedVideos[i];
      const videoPath = path.join(jobDir, `video_${String(video.scene_number).padStart(3, '0')}.mp4`);
      await downloadFile(video.final_video_url, videoPath);
      videoPaths.push(videoPath);
      console.log(`Downloaded video ${i + 1}/${sortedVideos.length}: Scene ${video.scene_number}`);
    }

    console.log('Stitching videos...');
    const stitchedVideoPath = path.join(jobDir, 'stitched_video.mp4');
    await stitchVideos(videoPaths, stitchedVideoPath);

    console.log('Trimming audio to stitched video duration...');
    const stitchedDuration = await getVideoDuration(stitchedVideoPath);
    if (!stitchedDuration) throw new Error('Could not determine stitched video duration');
    const trimmedAudioPath = path.join(jobDir, 'audio_trimmed.mp3');
    await trimAudio(audioPath, trimmedAudioPath, stitchedDuration);

    console.log('Adding trimmed audio to final video...');
    const finalVideoPath = path.join(OUTPUT_DIR, `final_video_${jobId}.mp4`);
    await addAudioToVideo(stitchedVideoPath, trimmedAudioPath, finalVideoPath);

    const finalDuration = await getVideoDuration(finalVideoPath);
    const stats = await fs.stat(finalVideoPath);

    // cleanup
    await fs.rm(jobDir, { recursive: true, force: true });

    res.json({
      success: true,
      jobId,
      downloadUrl: `/download/${jobId}`,
      finalVideoUrl: `${req.protocol}://${req.get('host')}/download/${jobId}`,
      videoStats: {
        duration: finalDuration,
        fileSize: stats.size,
        fileSizeMB: (stats.size / (1024 * 1024)).toFixed(2)
      },
      processedVideos: videos.length,
      sceneOrder: sortedVideos.map(v => parseInt(v.scene_number, 10)),
      message: `Successfully processed ${videos.length} videos with background music trimmed to match video length`
    });

  } catch (error) {
    console.error(`Job ${jobId} failed:`, error);
    try { await fs.rm(path.join(TEMP_DIR, jobId), { recursive: true, force: true }); } catch (_) {}
    res.status(500).json({
      success: false,
      error: error.message,
      jobId
    });
  }
});

// Download endpoint
app.get('/download/:jobId', async (req, res) => {
  try {
    const { jobId } = req.params;
    const filePath = path.join(OUTPUT_DIR, `final_video_${jobId}.mp4`);

    await fs.access(filePath);
    const stats = await fs.stat(filePath);

    res.setHeader('Content-Type', 'video/mp4');
    res.setHeader('Content-Disposition', `attachment; filename="final_video_${jobId}.mp4"`);
    res.setHeader('Content-Length', stats.size);

    const fileStream = require('fs').createReadStream(filePath);
    return fileStream.pipe(res);

  } catch (error) {
    res.status(404).json({
      error: 'Video file not found or not accessible',
      details: error.message
    });
  }
});

// Stream endpoint with range support
app.get('/stream/:jobId', async (req, res) => {
  try {
    const { jobId } = req.params;
    const filePath = path.join(OUTPUT_DIR, `final_video_${jobId}.mp4`);

    await fs.access(filePath);
    const stats = await fs.stat(filePath);

    const range = req.headers.range;
    if (!range) {
      res.setHeader('Content-Type', 'video/mp4');
      res.setHeader('Content-Length', stats.size);
      res.setHeader('Accept-Ranges', 'bytes');
      const fileStream = require('fs').createReadStream(filePath);
      return fileStream.pipe(res);
    }

    const parts = range.replace(/bytes=/, '').split('-');
    const start = parseInt(parts[0], 10);
    const end = parts[1] ? parseInt(parts[1], 10) : stats.size - 1;
    const chunkSize = (end - start) + 1;

    res.status(206);
    res.setHeader('Content-Range', `bytes ${start}-${end}/${stats.size}`);
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Content-Length', chunkSize);
    res.setHeader('Content-Type', 'video/mp4');

    const stream = require('fs').createReadStream(filePath, { start, end });
    stream.pipe(res);

  } catch (error) {
    res.status(404).json({
      error: 'Video file not found or not accessible',
      details: error.message
    });
  }
});

// Status check for job
app.get('/api/status/:jobId', async (req, res) => {
  try {
    const { jobId } = req.params;
    const filePath = path.join(OUTPUT_DIR, `final_video_${jobId}.mp4`);

    try {
      await fs.access(filePath);
      const stats = await fs.stat(filePath);
      const duration = await getVideoDuration(filePath);

      res.json({
        status: 'completed',
        jobId,
        completed: true,
        downloadUrl: `/download/${jobId}`,
        streamUrl: `/stream/${jobId}`,
        finalVideoUrl: `${req.protocol}://${req.get('host')}/download/${jobId}`,
        videoStats: {
          duration,
          fileSize: stats.size,
          fileSizeMB: (stats.size / (1024 * 1024)).toFixed(2),
          createdAt: stats.birthtime
        }
      });

    } catch (err) {
      res.json({
        status: 'processing',
        jobId,
        completed: false,
        message: 'Video is still being processed or job not found'
      });
    }

  } catch (error) {
    res.status(500).json({
      status: 'error',
      jobId: req.params.jobId,
      completed: false,
      error: error.message
    });
  }
});

app.get('/health', (req, res) => {
  res.json({
    status: 'OK',
    service: 'Integrated Video Processing Service (no overlay)',
    timestamp: new Date().toISOString()
  });
});

app.get('/', (req, res) => {
  res.json({
    service: 'Integrated Video Processing Service (no overlay)',
    version: '5.0.0',
    endpoints: {
      addOverlay: 'POST /api/add-overlay (single video + audio — no logo/overlay)',
      stitchVideos: 'POST /api/stitch-videos (multiple videos + audio — no logo/overlay)',
      download: 'GET /download/:jobId (download video file)',
      stream: 'GET /stream/:jobId (stream video in browser)',
      status: 'GET /api/status/:jobId (check job status)',
      health: 'GET /health'
    }
  });
});

async function startServer() {
  await ensureDirectories();

  app.listen(PORT, () => {
    console.log(`Integrated Video Processing Service running on port ${PORT}`);
    console.log(`Health check: http://localhost:${PORT}/health`);
    console.log(`API documentation: http://localhost:${PORT}/`);
  });
}

startServer().catch(console.error);
