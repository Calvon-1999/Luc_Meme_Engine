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
                const duration = metadata.format.duration;
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
            const command = ffmpeg(videoPath).input(audioPath);

            if (overlayImagePath) {
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

                command
                    .complexFilter([
                        `[1:a]volume=1.0[music]`,
                        `[2:v]scale=${size}:-1[overlay]`,
                        `[0:v][overlay]overlay=${x}:${y}:format=auto,format=yuv420p[v]`
                    ])
                    .outputOptions([
                        '-map', '[v]',
                        '-map', '[music]',
                        '-c:a', 'aac',
                        '-shortest'
                    ]);
            } else {
                command
                    .complexFilter('[1:a]volume=1.0[music]')
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
                .on('error', reject)
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
        
        res.setHeader('Content-Type', 'video/mp4');
        res.setHeader('
