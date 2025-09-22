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
        // duration can be fractional seconds (float)
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

async function getVideoDimensions(videoPath) {
    return new Promise((resolve, reject) => {
        ffmpeg.ffprobe(videoPath, (err, metadata) => {
            if (err) {
                reject(err);
            } else {
                const videoStream = metadata.streams.find(stream => stream.codec_type === 'video');
                resolve({
                    width: videoStream.width,
                    height: videoStream.height
                });
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

async function addAudioAndOverlayToVideo(videoPath, audioPath, outputPath, overlayImagePath = null, overlayOptions = {}) {
    return new Promise((resolve, reject) => {
        try {
            // Start from the video (video path is input 0), music as input 1, overlay (if present) as input 2
            const command = ffmpeg(videoPath).input(audioPath);

            if (overlayImagePath) {
                command.input(overlayImagePath);
            }

            const {
                position = 'bottom-right',
                size = '150',
                margin = '20'
            } = overlayOptions || {};

            // compute overlay coords (use ffmpeg expression syntax)
            let x, y;
            switch (position) {
                case 'top-left': 
                    x = margin; 
                    y = margin; 
                    break;
                case 'top-right': 
                    x = `W-w-${margin}`; 
                    y = margin; 
                    break;
                case 'bottom-left': 
                    x = margin; 
                    y = `H-h-${margin}`; 
                    break;
                case 'bottom-right':
                default:
                    x = `W-w-${margin}`;
                    y = `H-h-${margin}`;
                    break;
            }

            // We explicitly ignore any original audio/voice in the video.
            // Map only the music (input 1) as the audio in output.
            if (overlayImagePath) {
                // inputs: 0 = video, 1 = audio (music), 2 = overlay image
                const complexFilters = [
                    `[1:a]volume=1.0[music]`,
                    `[2:v]scale=${size}:-1[overlay]`,
                    // overlay image onto video, then format to yuv420p
                    `[0:v][overlay]overlay=${x}:${y}:format=auto,format=yuv420p[vout]`
                ];

                command
                    .complexFilter(complexFilters)
                    .outputOptions([
                        '-map', '[vout]',
                        '-map', '[music]',
                        '-c:a', 'aac',
                        '-shortest'
                    ]);
            } else {
                // No overlay image; just use video frames (0:v) and music (1:a)
                command
                    .complexFilter([`[1:a]volume=1.0[music]`])
                    .outputOptions([
                        '-map', '0:v:0',
                        '-map', '[music]',
                        '-c:v', 'copy',
                        '-c:a', 'aac',
                        '-shortest'
                    ]);
            }

            command
                .output(outputPath)
                .on('end', () => {
                    console.log('Audio + overlay added (ignoring original audio)');
                    resolve();
                })
                .on('error', (err) => {
                    console.error('addAudioAndOverlayToVideo error:', err);
                    reject(err);
                })
                .run();
        } catch (err) {
            reject(err);
        }
    });
}

async function addOverlayToImage(baseImagePath, overlayImagePath, outputPath, overlayOptions = {}) {
    return new Promise((resolve, reject) => {
        const {
            position = 'bottom-right',
            size = '150',
            margin = '20'
        } = overlayOptions;

        let x, y;
        switch (position) {
            case 'top-left': x = margin; y = margin; break;
            case 'top-right': x = `W-w-${margin}`; y = margin; break;
            case 'bottom-left': x = margin; y = `H-h-${margin}`; break;
            default: x = `W-w-${margin}`; y = `H-h-${margin}`; break;
        }

        ffmpeg()
            .input(baseImagePath)
            .input(overlayImagePath)
            .complexFilter(`[1:v]scale=${size}:-1[overlay]; [0:v][overlay]overlay=${x}:${y}[out]`)
            .outputOptions([
                '-map', '[out]',
                '-vframes', '1'
            ])
            .output(outputPath)
            .on('end', () => {
                console.log('Image overlay processing completed');
                resolve();
            })
            .on('error', (err) => {
                console.error('Image overlay processing error:', err);
                // fallback: copy original base image to output
                require('fs').createReadStream(baseImagePath).pipe(require('fs').createWriteStream(outputPath))
                    .on('close', () => {
                        console.log('Fallback: returned original image without overlay');
                        resolve();
                    })
                    .on('error', reject);
            })
            .run();
    });
}

// ----------------- Routes -----------------

app.post('/api/add-overlay', async (req, res) => {
    const jobId = uuidv4();
    console.log(`Starting overlay job ${jobId}`);
    
    try {
        const { final_stitch_video, final_music_url, overlay_image_url, overlay_options } = req.body;
        
        if (!final_stitch_video || !final_music_url) {
            return res.status(400).json({ 
                error: 'Invalid input. Expected final_stitch_video and final_music_url' 
            });
        }

        const jobDir = path.join(TEMP_DIR, jobId);
        await fs.mkdir(jobDir, { recursive: true });

        console.log('Step 1: Downloading video...');
        const videoPath = path.join(jobDir, 'input_video.mp4');
        await downloadFile(final_stitch_video, videoPath);

        console.log('Step 2: Processing audio...');
        const audioPath = path.join(jobDir, 'audio.mp3');
        const trimmedAudioPath = path.join(jobDir, 'audio_trimmed.mp3');
        await downloadFile(final_music_url, audioPath);

        const videoDuration = await getVideoDuration(videoPath);
        if (!videoDuration) {
            throw new Error('Could not determine video duration');
        }
        await trimAudio(audioPath, trimmedAudioPath, videoDuration);

        let overlayImagePath = null;
        if (overlay_image_url) {
            console.log('Step 3: Downloading overlay image...');
            overlayImagePath = path.join(jobDir, 'overlay_image.png');
            await downloadFile(overlay_image_url, overlayImagePath);
        }

        console.log('Step 4: Adding audio and overlay...');
        const finalVideoPath = path.join(OUTPUT_DIR, `final_video_${jobId}.mp4`);
        await addAudioAndOverlayToVideo(videoPath, trimmedAudioPath, finalVideoPath, overlayImagePath, overlay_options || {});

        const finalDuration = await getVideoDuration(finalVideoPath);
        const stats = await fs.stat(finalVideoPath);

        await fs.rm(jobDir, { recursive: true, force: true });

        console.log(`Job ${jobId} completed successfully`);

        res.json({
            success: true,
            jobId: jobId,
            downloadUrl: `/download/${jobId}`,
            finalVideoUrl: `${req.protocol}://${req.get('host')}/download/${jobId}`,
            videoStats: {
                duration: finalDuration,
                fileSize: stats.size,
                fileSizeMB: (stats.size / (1024 * 1024)).toFixed(2)
            },
            overlayApplied: !!overlay_image_url,
            message: 'Successfully added audio and overlay to video'
        });

    } catch (error) {
        console.error(`Job ${jobId} failed:`, error);
        // try to cleanup jobDir if exists
        try { await fs.rm(path.join(TEMP_DIR, jobId), { recursive: true, force: true }); } catch (_) {}
        res.status(500).json({
            success: false,
            error: error.message,
            jobId: jobId
        });
    }
});

app.post('/api/add-image-overlay', async (req, res) => {
    const jobId = uuidv4();
    console.log(`Starting image overlay job ${jobId}`);
    
    try {
        const { final_image_url, overlay_image_url, overlay_options } = req.body;
        
        if (!final_image_url || !overlay_image_url) {
            return res.status(400).json({ 
                error: 'Invalid input. Expected final_image_url and overlay_image_url' 
            });
        }

        const jobDir = path.join(TEMP_DIR, jobId);
        await fs.mkdir(jobDir, { recursive: true });

        console.log('Step 1: Downloading base image...');
        const baseImagePath = path.join(jobDir, 'base_image.png');
        await downloadFile(final_image_url, baseImagePath);

        console.log('Step 2: Downloading overlay image...');
        const overlayImagePath = path.join(jobDir, 'overlay_image.png');
        await downloadFile(overlay_image_url, overlayImagePath);

        console.log('Step 3: Adding overlay to image...');
        const finalImagePath = path.join(OUTPUT_DIR, `final_image_${jobId}.png`);
        await addOverlayToImage(baseImagePath, overlayImagePath, finalImagePath, overlay_options || {});

        const stats = await fs.stat(finalImagePath);

        await fs.rm(jobDir, { recursive: true, force: true });

        console.log(`Image overlay job ${jobId} completed successfully`);

        res.json({
            success: true,
            jobId: jobId,
            downloadUrl: `/download-image/${jobId}`,
            finalImageUrl: `${req.protocol}://${req.get('host')}/download-image/${jobId}`,
            imageStats: {
                fileSize: stats.size,
                fileSizeMB: (stats.size / (1024 * 1024)).toFixed(2)
            },
            overlayApplied: true,
            message: 'Successfully added overlay to image'
        });

    } catch (error) {
        console.error(`Image overlay job ${jobId} failed:`, error);
        try { await fs.rm(path.join(TEMP_DIR, jobId), { recursive: true, force: true }); } catch (_) {}
        res.status(500).json({
            success: false,
            error: error.message,
            jobId: jobId
        });
    }
});

app.post('/api/stitch-videos', async (req, res) => {
    const jobId = uuidv4();
    console.log(`Starting video stitching job ${jobId}`);
    
    try {
        const { videos, mv_audio, overlay_image_url, overlay_options } = req.body;
        
        if (!videos || !Array.isArray(videos) || !mv_audio) {
            return res.status(400).json({ 
                error: 'Invalid input. Expected videos array and mv_audio URL' 
            });
        }

        const jobDir = path.join(TEMP_DIR, jobId);
        await fs.mkdir(jobDir, { recursive: true });

        console.log('Step 1: Downloading audio...');
        const audioPath = path.join(jobDir, 'audio.mp3');
        await downloadFile(mv_audio, audioPath);

        let overlayImagePath = null;
        if (overlay_image_url) {
            console.log('Step 2: Downloading overlay image...');
            overlayImagePath = path.join(jobDir, 'overlay_image.png');
            await downloadFile(overlay_image_url, overlayImagePath);
        }

        console.log('Step 3: Sorting and downloading videos...');
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

        console.log('Step 4: Stitching videos...');
        const stitchedVideoPath = path.join(jobDir, 'stitched_video.mp4');
        await stitchVideos(videoPaths, stitchedVideoPath);

        console.log('Step 5: Trim audio to stitched video duration...');
        const stitchedDuration = await getVideoDuration(stitchedVideoPath);
        if (!stitchedDuration) {
            throw new Error('Could not determine stitched video duration');
        }
        const trimmedAudioPath = path.join(jobDir, 'audio_trimmed.mp3');
        await trimAudio(audioPath, trimmedAudioPath, stitchedDuration);

        console.log('Step 6: Adding audio and overlay to final video...');
        const finalVideoPath = path.join(OUTPUT_DIR, `final_video_${jobId}.mp4`);
        await addAudioAndOverlayToVideo(stitchedVideoPath, trimmedAudioPath, finalVideoPath, overlayImagePath, overlay_options || {});

        const finalDuration = await getVideoDuration(finalVideoPath);
        const stats = await fs.stat(finalVideoPath);

        await fs.rm(jobDir, { recursive: true, force: true });

        console.log(`Job ${jobId} completed successfully`);

        res.json({
            success: true,
            jobId: jobId,
            downloadUrl: `/download/${jobId}`,
            finalVideoUrl: `${req.protocol}://${req.get('host')}/download/${jobId}`,
            videoStats: {
                duration: finalDuration,
                fileSize: stats.size,
                fileSizeMB: (stats.size / (1024 * 1024)).toFixed(2)
            },
            processedVideos: videos.length,
            sceneOrder: sortedVideos.map(v => parseInt(v.scene_number, 10)),
            overlayApplied: !!overlay_image_url,
            message: `Successfully processed ${videos.length} videos with background music trimmed to match video length${overlay_image_url ? ' and image overlay' : ''}`
        });

    } catch (error) {
        console.error(`Job ${jobId} failed:`, error);
        try { await fs.rm(path.join(TEMP_DIR, jobId), { recursive: true, force: true }); } catch (_) {}
        res.status(500).json({
            success: false,
            error: error.message,
            jobId: jobId
        });
    }
});

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
        fileStream.pipe(res);
        
    } catch (error) {
        res.status(404).json({ 
            error: 'Video file not found or not accessible',
            details: error.message 
        });
    }
});

app.get('/download-image/:jobId', async (req, res) => {
    try {
        const { jobId } = req.params;
        const filePath = path.join(OUTPUT_DIR, `final_image_${jobId}.png`);
        
        await fs.access(filePath);
        
        res.json({
            success: true,
            imageUrl: `${req.protocol}://${req.get('host')}/serve-image/${jobId}`,
            jobId: jobId
        });
        
    } catch (error) {
        res.status(404).json({ 
            error: 'Image file not found or not accessible',
            details: error.message 
        });
    }
});

app.get('/serve-image/:jobId', async (req, res) => {
    try {
        const { jobId } = req.params;
        const filePath = path.join(OUTPUT_DIR, `final_image_${jobId}.png`);
        
        await fs.access(filePath);
        const stats = await fs.stat(filePath);
        
        res.setHeader('Content-Type', 'image/png');
        res.setHeader('Content-Length', stats.size);
        
        const fileStream = require('fs').createReadStream(filePath);
        fileStream.pipe(res);
        
    } catch (error) {
        res.status(404).json({ 
            error: 'Image file not found or not accessible',
            details: error.message 
        });
    }
});

app.get('/stream/:jobId', async (req, res) => {
    try {
        const { jobId } = req.params;
        const filePath = path.join(OUTPUT_DIR, `final_video_${jobId}.mp4`);
        
        await fs.access(filePath);
        const stats = await fs.stat(filePath);

        // Support range requests for proper streaming/seeking
        const range = req.headers.range;
        if (!range) {
            // no range header — send the entire file
            res.setHeader('Content-Type', 'video/mp4');
            res.setHeader('Content-Length', stats.size);
            res.setHeader('Accept-Ranges', 'bytes');
            const fileStream = require('fs').createReadStream(filePath);
            return fileStream.pipe(res);
        }

        // Parse range header, e.g. "bytes=0-"
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
                jobId: jobId,
                completed: true,
                downloadUrl: `/download/${jobId}`,
                streamUrl: `/stream/${jobId}`,
                finalVideoUrl: `${req.protocol}://${req.get('host')}/download/${jobId}`,
                videoStats: {
                    duration: duration,
                    fileSize: stats.size,
                    fileSizeMB: (stats.size / (1024 * 1024)).toFixed(2),
                    createdAt: stats.birthtime
                }
            });
        } catch (error) {
            res.json({
                status: 'processing',
                jobId: jobId,
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
        service: 'Integrated Video Processing Service',
        timestamp: new Date().toISOString()
    });
});

app.get('/', (req, res) => {
    res.json({
        service: 'Integrated Video Processing Service',
        version: '5.0.0',
        endpoints: {
            addOverlay: 'POST /api/add-overlay (single video + audio + overlay)',
            addImageOverlay: 'POST /api/add-image-overlay (image + overlay)',
            stitchVideos: 'POST /api/stitch-videos (multiple videos + audio + overlay)',
            download: 'GET /download/:jobId (download video file)',
            downloadImage: 'GET /download-image/:jobId (download image file)',
            serveImage: 'GET /serve-image/:jobId (serve image binary)',
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
