// worker/server.js
// Standalone processing server for long-running audio/video FFmpeg jobs and Gemini STT

const express = require('express');
const cors = require('cors');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const os = require('os');
require('dotenv').config();
// Also attempt loading parent .env for convenient local testing
if (!process.env.GEMINI_API_KEY && fs.existsSync(path.join(__dirname, '..', '.env'))) {
  require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
}

const jobManager = require('./jobs');
const {
  detectVideoUrlPlatform,
  processAudioFileWithChunking,
  runGeminiYouTubeTranscription,
  runGeminiTranslation,
  sanitizeErrorMessage
} = require('./pipeline');

const app = express();
const PORT = process.env.PORT || 4000;
const HOST = process.env.HOST || '0.0.0.0';

// Enable CORS for web frontend (Vercel deployment or local dev)
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'Accept', 'Origin', 'X-Requested-With']
}));
app.options('*', cors());

app.use(express.json({ limit: '10mb' }));

// Ensure upload directory exists
const uploadDir = path.join(os.tmpdir(), 'bangla_uploads');
if (!fs.existsSync(uploadDir)) {
  try {
    fs.mkdirSync(uploadDir, { recursive: true });
  } catch {}
}

// Periodically clean up any orphaned upload files older than 1 hour
const cleanOrphanedUploads = () => {
  try {
    if (!fs.existsSync(uploadDir)) return;
    const now = Date.now();
    const files = fs.readdirSync(uploadDir);
    for (const f of files) {
      const fullPath = path.join(uploadDir, f);
      try {
        const stats = fs.statSync(fullPath);
        if (now - stats.mtimeMs > 3600000) {
          fs.unlinkSync(fullPath);
        }
      } catch {}
    }
  } catch {}
};
cleanOrphanedUploads();
setInterval(cleanOrphanedUploads, 3600000);

// Configure Multer for audio/video uploads
const upload = multer({
  dest: uploadDir,
  limits: {
    fileSize: 500 * 1024 * 1024 // 500 MB upload limit
  },
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase().replace('.', '');
    const allowed = ['mp3', 'wav', 'm4a', 'mp4', 'mov', 'webm'];
    if (allowed.includes(ext)) {
      cb(null, true);
    } else {
      cb(new Error(`Unsupported file type .${ext}. Allowed formats: MP3, WAV, M4A, MP4, MOV.`));
    }
  }
});

// Middleware to reliably extract single uploaded media file regardless of form field name
const uploadSingleMedia = (req, res, next) => {
  upload.any()(req, res, (err) => {
    if (err) return next(err);
    if (req.files && req.files.length > 0) {
      req.file = req.files.find(f => f.fieldname === 'file') || req.files[0];
    }
    next();
  });
};

// Health & Status Check Helper
const getHealthData = () => {
  const key = process.env.GEMINI_API_KEY;
  const isConfigured = Boolean(key && key.trim().length > 0 && key !== 'YOUR_GEMINI_API_KEY_HERE');
  return {
    status: 'ok',
    service: 'bangla-transcriber-worker',
    isConfigured,
    workerConnected: true,
    uptimeSeconds: Math.floor(process.uptime())
  };
};

app.get(['/health', '/api/health'], (req, res) => {
  res.json(getHealthData());
});

app.get(['/status', '/api/status'], (req, res) => {
  res.json(getHealthData());
});

// Endpoint: Transcribe Uploaded Media File
app.post(['/api/transcribe/file', '/transcribe/file'], uploadSingleMedia, async (req, res) => {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey || apiKey.trim().length === 0 || apiKey === 'YOUR_GEMINI_API_KEY_HERE') {
    return res.status(400).json({ error: 'Gemini API key is not configured on the worker server.' });
  }

  if (!req.file) {
    return res.status(400).json({ error: 'No media file was uploaded.' });
  }

  const originalName = req.file.originalname;
  const tempPath = req.file.path;
  const ext = path.extname(originalName).toLowerCase().replace('.', '') || 'mp3';

  // Ensure file retains proper extension in temp folder for ffmpeg
  const targetTempPath = `${tempPath}.${ext}`;
  try {
    fs.renameSync(tempPath, targetTempPath);
  } catch {
    // If rename fails, continue with original tempPath
  }
  const workingPath = fs.existsSync(targetTempPath) ? targetTempPath : tempPath;

  const mimeMap = {
    mp3: 'audio/mp3',
    wav: 'audio/wav',
    m4a: 'audio/m4a',
    mp4: 'video/mp4',
    mov: 'video/quicktime',
    webm: 'audio/webm'
  };
  const mimeType = mimeMap[ext] || 'audio/mp3';

  // Create job
  const job = jobManager.createJob('transcription-file', {
    fileName: originalName,
    fileSize: req.file.size
  });

  // Respond immediately with Job ID so client never times out
  res.status(202).json({
    success: true,
    jobId: job.id,
    fileName: originalName
  });

  // Process asynchronously in worker background
  (async () => {
    try {
      jobManager.updateJob(job.id, {
        status: 'processing',
        progress: 10,
        statusText: 'Preparing audio file...'
      });

      const transcript = await processAudioFileWithChunking(
        workingPath,
        mimeType,
        apiKey.trim(),
        (progress) => {
          jobManager.updateJob(job.id, {
            progress: progress.percent,
            statusText: progress.status,
            currentChunk: progress.currentChunk,
            totalChunks: progress.totalChunks
          });
        }
      );

      jobManager.updateJob(job.id, {
        status: 'completed',
        progress: 100,
        statusText: 'Transcription complete',
        result: {
          transcript,
          source: 'audio',
          sourceType: 'ai-audio',
          sourceLabel: 'AI Audio Transcription',
          fileName: originalName
        }
      });
    } catch (err) {
      console.error(`[Job ${job.id}] Failed:`, err);
      const safeError = sanitizeErrorMessage(err.message, apiKey.trim());
      jobManager.updateJob(job.id, {
        status: 'failed',
        error: safeError,
        statusText: 'Transcription failed'
      });
    } finally {
      // Clean up uploaded temp file
      if (fs.existsSync(workingPath)) {
        try { fs.unlinkSync(workingPath); } catch {}
      }
      if (tempPath && tempPath !== workingPath && fs.existsSync(tempPath)) {
        try { fs.unlinkSync(tempPath); } catch {}
      }
    }
  })();
});

// Endpoint: Transcribe YouTube URL
app.post(['/api/transcribe/url', '/transcribe/url'], async (req, res) => {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey || apiKey.trim().length === 0 || apiKey === 'YOUR_GEMINI_API_KEY_HERE') {
    return res.status(400).json({ error: 'Gemini API key is not configured on the worker server.' });
  }

  const { url } = req.body || {};
  if (!url || typeof url !== 'string') {
    return res.status(400).json({ error: 'A valid YouTube URL is required.' });
  }

  const detected = detectVideoUrlPlatform(url);
  if (!detected) {
    return res.status(400).json({
      error: 'Unsupported or invalid URL. Please enter a valid YouTube video link (e.g., https://www.youtube.com/watch?v=... or https://youtu.be/...).'
    });
  }

  const job = jobManager.createJob('transcription-url', {
    url: detected.canonicalUrl,
    videoId: detected.id
  });

  res.status(202).json({
    success: true,
    jobId: job.id,
    canonicalUrl: detected.canonicalUrl,
    videoId: detected.id
  });

  // Process asynchronously in worker background
  (async () => {
    try {
      jobManager.updateJob(job.id, {
        status: 'processing',
        progress: 10,
        statusText: 'Connecting to YouTube...'
      });

      const result = await runGeminiYouTubeTranscription(
        detected.canonicalUrl,
        apiKey.trim(),
        (progress) => {
          jobManager.updateJob(job.id, {
            progress: progress.percent,
            statusText: progress.status,
            currentChunk: progress.currentChunk,
            totalChunks: progress.totalChunks
          });
        }
      );

      jobManager.updateJob(job.id, {
        status: 'completed',
        progress: 100,
        statusText: 'Transcription complete',
        result
      });
    } catch (err) {
      console.error(`[Job ${job.id}] YouTube failed:`, err);
      const safeError = sanitizeErrorMessage(err.message, apiKey.trim());
      jobManager.updateJob(job.id, {
        status: 'failed',
        error: safeError,
        statusText: 'YouTube transcription failed'
      });
    }
  })();
});

// Endpoint: Translate Text to Bangla
app.post(['/api/translate', '/translate'], async (req, res) => {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey || apiKey.trim().length === 0 || apiKey === 'YOUR_GEMINI_API_KEY_HERE') {
    return res.status(400).json({ error: 'Gemini API key is not configured on the worker server.' });
  }

  const { text } = req.body || {};
  if (!text || typeof text !== 'string' || text.trim().length === 0) {
    return res.status(400).json({ error: 'No transcript text provided for translation.' });
  }

  const job = jobManager.createJob('translation', {
    textLength: text.length
  });

  res.status(202).json({
    success: true,
    jobId: job.id
  });

  (async () => {
    try {
      jobManager.updateJob(job.id, {
        status: 'processing',
        progress: 10,
        statusText: 'Translating to Bangla...'
      });

      const translation = await runGeminiTranslation(
        text.trim(),
        apiKey.trim(),
        (progress) => {
          jobManager.updateJob(job.id, {
            progress: progress.percent,
            statusText: progress.status,
            currentChunk: progress.currentChunk,
            totalChunks: progress.totalChunks
          });
        }
      );

      jobManager.updateJob(job.id, {
        status: 'completed',
        progress: 100,
        statusText: 'Translation complete',
        result: { translation }
      });
    } catch (err) {
      console.error(`[Job ${job.id}] Translation failed:`, err);
      const safeError = sanitizeErrorMessage(err.message, apiKey.trim());
      jobManager.updateJob(job.id, {
        status: 'failed',
        error: safeError,
        statusText: 'Translation failed'
      });
    }
  })();
});

// Endpoint: Query Job Status (Polling)
app.get(['/api/jobs/:id', '/jobs/:id'], (req, res) => {
  const job = jobManager.getJob(req.params.id);
  if (!job) {
    return res.status(404).json({ error: 'Job not found or expired.' });
  }
  res.json(job);
});

// Endpoint: Real-time Job Events (Server-Sent Events)
app.get(['/api/jobs/:id/events', '/jobs/:id/events'], (req, res) => {
  const jobId = req.params.id;
  const job = jobManager.getJob(jobId);

  if (!job) {
    return res.status(404).json({ error: 'Job not found.' });
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();

  // Send current state immediately
  res.write(`data: ${JSON.stringify(job)}\n\n`);

  if (job.status === 'completed' || job.status === 'failed') {
    res.end();
    return;
  }

  // Subscribe to updates
  const unsubscribe = jobManager.subscribe(jobId, (updatedJob) => {
    res.write(`data: ${JSON.stringify(updatedJob)}\n\n`);
    if (updatedJob.status === 'completed' || updatedJob.status === 'failed') {
      res.end();
      unsubscribe();
    }
  });

  req.on('close', () => {
    unsubscribe();
  });
});

// Express error handler to return useful JSON errors instead of HTML error pages
app.use((err, req, res, next) => {
  const safeMessage = err && err.message ? err.message : 'An unexpected error occurred during processing';
  console.error('[Worker Error]:', safeMessage);
  if (res.headersSent) {
    return next(err);
  }
  const statusCode = err.status || (err instanceof multer.MulterError ? 400 : 400);
  res.status(statusCode).json({
    error: safeMessage
  });
});

app.listen(PORT, HOST, () => {
  console.log(`[Worker Service] Bangla Transcriber Worker listening on http://${HOST}:${PORT}`);
});
