const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const cp = require('child_process');
require('dotenv').config();
const { GoogleGenAI } = require('@google/genai');
const ffmpegInstaller = require('@ffmpeg-installer/ffmpeg');

let mainWindow;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 860,
    height: 740,
    minWidth: 680,
    minHeight: 600,
    backgroundColor: '#FAFBFC',
    title: 'Bangla Transcriber',
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });

  mainWindow.loadFile(path.join(__dirname, 'src', 'index.html'));

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
  });
}

app.whenReady().then(() => {
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// IPC: Open Native File Dialog
ipcMain.handle('dialog:open-file', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Select Audio or Video File',
    properties: ['openFile'],
    filters: [
      {
        name: 'Audio & Video Files',
        extensions: ['mp3', 'wav', 'm4a', 'mp4', 'mov']
      },
      {
        name: 'Audio Files (*.mp3, *.wav, *.m4a)',
        extensions: ['mp3', 'wav', 'm4a']
      },
      {
        name: 'Video Files (*.mp4, *.mov)',
        extensions: ['mp4', 'mov']
      }
    ]
  });

  if (result.canceled || result.filePaths.length === 0) {
    return null;
  }

  const filePath = result.filePaths[0];
  return getFileInfo(filePath);
});

// IPC: Get File Information from File Path (for Drag & Drop)
ipcMain.handle('file:get-info', async (event, filePath) => {
  return getFileInfo(filePath);
});

// Helper to inspect selected file safely
function getFileInfo(filePath) {
  try {
    if (!fs.existsSync(filePath)) return null;
    const stats = fs.statSync(filePath);
    const ext = path.extname(filePath).toLowerCase().replace('.', '');
    const validExtensions = ['mp3', 'wav', 'm4a', 'mp4', 'mov'];

    if (!validExtensions.includes(ext)) {
      return {
        error: `Unsupported file format (.${ext}). Supported formats: MP3, WAV, M4A, MP4, MOV.`
      };
    }

    return {
      name: path.basename(filePath),
      path: filePath,
      sizeBytes: stats.size,
      extension: ext
    };
  } catch (err) {
    return { error: err.message };
  }
}

// IPC: Check if API key is configured in .env (without exposing secret key)
ipcMain.handle('env:check-api-key', async () => {
  const key = process.env.GEMINI_API_KEY;
  const isConfigured = Boolean(key && key.trim().length > 0 && key !== 'YOUR_GEMINI_API_KEY_HERE');
  return { isConfigured };
});

// IPC: Transcribe Media File (Audio / Video with Chunking for Long Files)
ipcMain.handle('media:transcribe', async (event, filePath) => {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey || apiKey.trim().length === 0 || apiKey === 'YOUR_GEMINI_API_KEY_HERE') {
    return { error: 'Gemini API key is not configured in .env file.' };
  }

  if (!filePath || !fs.existsSync(filePath)) {
    return { error: 'Selected file was not found on your system.' };
  }

  const ext = path.extname(filePath).toLowerCase().replace('.', '');
  const mimeMap = {
    mp3: 'audio/mp3',
    wav: 'audio/wav',
    m4a: 'audio/m4a',
    mp4: 'video/mp4',
    mov: 'video/quicktime'
  };

  const mimeType = mimeMap[ext];
  if (!mimeType) {
    return { error: `Unsupported file format (.${ext}). Supported formats: MP3, WAV, M4A, MP4, MOV.` };
  }

  try {
    const transcript = await processAudioFileWithChunking(filePath, mimeType, apiKey.trim(), event.sender);
    return {
      success: true,
      transcript,
      source: 'audio',
      sourceType: 'ai-audio',
      sourceLabel: 'AI Audio Transcription'
    };
  } catch (err) {
    const safeError = sanitizeErrorMessage(err.message, apiKey.trim());
    return { error: safeError };
  }
});

// Detect supported video platform (YouTube)
function detectVideoUrlPlatform(url) {
  if (!url || typeof url !== 'string') return null;
  const trimmed = url.trim();

  // YouTube match:
  const ytMatch = trimmed.match(/(?:youtube\.com\/(?:watch\?.*v=|shorts\/|live\/|embed\/|v\/)|youtu\.be\/)([a-zA-Z0-9_-]{11})/i);
  if (ytMatch) {
    return {
      platform: 'youtube',
      id: ytMatch[1],
      canonicalUrl: `https://www.youtube.com/watch?v=${ytMatch[1]}`
    };
  }

  if (/^[a-zA-Z0-9_-]{11}$/.test(trimmed)) {
    return {
      platform: 'youtube',
      id: trimmed,
      canonicalUrl: `https://www.youtube.com/watch?v=${trimmed}`
    };
  }

  return null;
}

// Backward-compatible YouTube ID extractor
function extractYouTubeVideoId(url) {
  const detected = detectVideoUrlPlatform(url);
  return (detected && detected.platform === 'youtube') ? detected.id : null;
}

// IPC: Transcribe Video URL (YouTube with Captions check and STT fallback)
ipcMain.handle('video:transcribe', async (event, url) => {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey || apiKey.trim().length === 0 || apiKey === 'YOUR_GEMINI_API_KEY_HERE') {
    return { error: 'Gemini API key is not configured in .env file.' };
  }

  if (typeof url === 'string' && /(?:bilibili\.com|b23\.tv)/i.test(url)) {
    return {
      error: 'Bilibili videos are no longer supported. Please enter a valid YouTube video URL.'
    };
  }

  const detected = detectVideoUrlPlatform(url);
  if (!detected) {
    return {
      error: 'Unsupported or invalid URL. Please enter a valid YouTube video link (e.g., https://www.youtube.com/watch?v=... or https://youtu.be/...).'
    };
  }

  try {
    const result = await runGeminiYouTubeTranscription(detected.canonicalUrl, apiKey.trim(), event.sender);
    return { success: true, ...result };
  } catch (err) {
    const safeError = sanitizeErrorMessage(err.message, apiKey.trim());
    return { error: safeError };
  }
});

// Alias for backwards compatibility
ipcMain.handle('youtube:transcribe', async (event, url) => {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey || apiKey.trim().length === 0 || apiKey === 'YOUR_GEMINI_API_KEY_HERE') {
    return { error: 'Gemini API key is not configured in .env file.' };
  }

  if (typeof url === 'string' && /(?:bilibili\.com|b23\.tv)/i.test(url)) {
    return {
      error: 'Bilibili videos are no longer supported. Please enter a valid YouTube video URL.'
    };
  }

  const detected = detectVideoUrlPlatform(url);
  if (!detected) {
    return {
      error: 'Unsupported or invalid URL. Please enter a valid YouTube video link.'
    };
  }

  try {
    const result = await runGeminiYouTubeTranscription(detected.canonicalUrl, apiKey.trim(), event.sender);
    return { success: true, ...result };
  } catch (err) {
    const safeError = sanitizeErrorMessage(err.message, apiKey.trim());
    return { error: safeError };
  }
});

// IPC: Translate Transcript to Bangla with honest chunk progress tracking
ipcMain.handle('media:translate-to-bangla', async (event, text) => {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey || apiKey.trim().length === 0 || apiKey === 'YOUR_GEMINI_API_KEY_HERE') {
    return { error: 'Gemini API key is not configured in .env file.' };
  }

  if (!text || typeof text !== 'string' || text.trim().length === 0) {
    return { error: 'No transcript text available to translate.' };
  }

  try {
    const translation = await runGeminiTranslation(text.trim(), apiKey.trim(), event.sender);
    return { success: true, translation };
  } catch (err) {
    const safeError = sanitizeErrorMessage(err.message, apiKey.trim());
    return { error: safeError };
  }
});

// Candidate models for graceful fallback across free-tier and standard quotas
const CANDIDATE_MODELS = [
  'gemini-3.5-flash-lite',
  'gemini-flash-lite-latest',
  'gemini-3.7-flash',
  'gemini-3.6-flash',
  'gemini-3.5-flash',
  'gemini-3.8-flash',
  'gemini-flash-latest',
  'gemini-3.1-flash-lite'
];

// Helper: Inspect audio duration via ffmpeg
function getAudioDuration(filePath) {
  return new Promise((resolve) => {
    cp.execFile(ffmpegInstaller.path, ['-i', filePath], (err, stdout, stderr) => {
      const output = (stderr || '') + (stdout || '');
      const match = output.match(/Duration:\s*(\d{2}):(\d{2}):(\d{2}(?:\.\d+)?)/);
      if (match) {
        const sec = parseInt(match[1], 10) * 3600 + parseInt(match[2], 10) * 60 + parseFloat(match[3]);
        resolve(sec);
      } else {
        resolve(0);
      }
    });
  });
}

// Helper: Extract audio to 16kHz mono MP3 via ffmpeg
function extractAudioWithFfmpeg(inputPath, outputPath) {
  return new Promise((resolve, reject) => {
    cp.execFile(ffmpegInstaller.path, [
      '-y',
      '-i', inputPath,
      '-vn',
      '-ar', '16000',
      '-ac', '1',
      '-b:a', '32k',
      outputPath
    ], (err, stdout, stderr) => {
      if (err) return reject(new Error(`Audio extraction failed: ${stderr || err.message}`));
      resolve(outputPath);
    });
  });
}

// Helper: Split long audio into manageable chunks with boundary overlap
async function splitAudioIntoChunks(audioPath, durationSec, chunkLengthSec = 600, overlapSec = 8) {
  if (durationSec <= chunkLengthSec + 30) {
    return [{ path: audioPath, isTemp: false }];
  }

  const chunks = [];
  let startSec = 0;
  let idx = 0;

  while (startSec < durationSec) {
    const chunkPath = path.join(os.tmpdir(), `stt_chunk_${Date.now()}_${idx++}.mp3`);
    const thisDuration = Math.min(chunkLengthSec, durationSec - startSec);

    await new Promise((resolve, reject) => {
      cp.execFile(ffmpegInstaller.path, [
        '-y',
        '-ss', startSec.toString(),
        '-t', thisDuration.toString(),
        '-i', audioPath,
        '-vn',
        '-ar', '16000',
        '-ac', '1',
        '-b:a', '32k',
        chunkPath
      ], (err, stdout, stderr) => {
        if (err) return reject(new Error(`Audio chunking failed: ${stderr || err.message}`));
        resolve();
      });
    });

    chunks.push({ path: chunkPath, isTemp: true, startSec, duration: thisDuration });
    startSec += (chunkLengthSec - overlapSec);
  }

  return chunks;
}

// Helper: Seamlessly merge transcripts across chunk boundaries without missing or repeating speech
function mergeOverlappingTranscripts(textA, textB) {
  if (!textA || !textA.trim()) return (textB || '').trim();
  if (!textB || !textB.trim()) return textA.trim();

  const cleanA = textA.trim();
  const cleanB = textB.trim();

  const wordsA = cleanA.split(/\s+/);
  const wordsB = cleanB.split(/\s+/);

  const maxCheckA = Math.min(wordsA.length, 60);
  const maxCheckB = Math.min(wordsB.length, 60);

  const tailWordsA = wordsA.slice(-maxCheckA);
  const headWordsB = wordsB.slice(0, maxCheckB);

  const normA = tailWordsA.map(w => w.toLowerCase().replace(/[^\p{L}\p{N}]/gu, ''));
  const normB = headWordsB.map(w => w.toLowerCase().replace(/[^\p{L}\p{N}]/gu, ''));

  let bestOverlapLen = 0;
  let bestMatchIndexB = -1;

  for (let len = Math.min(normA.length, normB.length); len >= 3; len--) {
    const subA = normA.slice(normA.length - len).join(' ');
    const subB = normB.slice(0, len).join(' ');
    if (subA && subA === subB) {
      bestOverlapLen = len;
      bestMatchIndexB = len;
      break;
    }
  }

  if (bestOverlapLen >= 3 && bestMatchIndexB > 0) {
    const remainingWordsB = wordsB.slice(bestMatchIndexB);
    if (remainingWordsB.length > 0) {
      return cleanA + ' ' + remainingWordsB.join(' ');
    }
    return cleanA;
  }

  return cleanA + '\n\n' + cleanB;
}

// Process audio file (local or streamed) with chunking for long media
async function processAudioFileWithChunking(filePath, mimeType, apiKey, sender = null) {
  const tPrepStart = Date.now();
  // If video or non-mp3/wav, extract clean audio stream first
  let workingAudioPath = filePath;
  let tempExtracted = null;

  const ext = path.extname(filePath).toLowerCase().replace('.', '');
  if (['mp4', 'mov', 'webm', 'm4s', 'm4a'].includes(ext)) {
    tempExtracted = path.join(os.tmpdir(), `extracted_${Date.now()}.mp3`);
    await extractAudioWithFfmpeg(filePath, tempExtracted);
    workingAudioPath = tempExtracted;
    mimeType = 'audio/mp3';
  }

  try {
    const durationSec = await getAudioDuration(workingAudioPath);
    console.log(`[Performance] Audio preparation completed in ${Date.now() - tPrepStart}ms (duration: ${durationSec}s)`);
    const CHUNK_LIMIT_SEC = 600; // 10 minutes per chunk

    if (durationSec <= CHUNK_LIMIT_SEC + 30) {
      const tReqStart = Date.now();
      const transcript = await runGeminiTranscription(workingAudioPath, mimeType, apiKey);
      console.log(`[Performance] Single chunk Gemini API request took ${Date.now() - tReqStart}ms`);
      console.log(`[Performance] Total transcription completed in ${Date.now() - tPrepStart}ms`);
      return transcript;
    }

    // Long video processing: split into overlapping chunks preserving speech at boundaries
    const tSplitStart = Date.now();
    const chunks = await splitAudioIntoChunks(workingAudioPath, durationSec, CHUNK_LIMIT_SEC, 8);
    const totalChunks = chunks.length;
    console.log(`[Performance] Audio split into ${totalChunks} chunks in ${Date.now() - tSplitStart}ms`);

    // Array to store completed chunk transcripts strictly by index to preserve order
    const chunkResults = new Array(totalChunks).fill(null);
    let completedChunks = 0;

    if (sender && !sender.isDestroyed()) {
      sender.send('transcription:progress', {
        percent: 5,
        status: 'Transcribing video audio...',
        currentChunk: 0,
        totalChunks
      });
    }

    // Worker pool with controlled concurrency = 2 (safeguards quota and API rate limits)
    const CONCURRENCY_LIMIT = 2;
    let nextIndex = 0;

    async function worker() {
      while (true) {
        const i = nextIndex++;
        if (i >= totalChunks) break;

        const chunk = chunks[i];
        const tChunkStart = Date.now();

        // Retry loop for this specific chunk with bounded exponential backoff
        let chunkTranscript = null;
        let lastChunkErr = null;
        const maxChunkAttempts = 3;

        for (let attempt = 0; attempt < maxChunkAttempts; attempt++) {
          try {
            chunkTranscript = await runGeminiTranscription(chunk.path, 'audio/mp3', apiKey);
            break;
          } catch (err) {
            lastChunkErr = err;
            const msg = (err && err.message) ? err.message : '';
            console.warn(`[Performance] Chunk ${i + 1}/${totalChunks} attempt ${attempt + 1} failed: ${msg.slice(0, 80)}`);
            if (attempt < maxChunkAttempts - 1) {
              const backoffMs = Math.min(8000, 1500 * Math.pow(2, attempt) + Math.random() * 500);
              await new Promise(r => setTimeout(r, backoffMs));
            }
          }
        }

        if (chunkTranscript === null) {
          throw lastChunkErr || new Error(`Failed to transcribe chunk ${i + 1} of ${totalChunks}.`);
        }

        const chunkDuration = Date.now() - tChunkStart;
        console.log(`[Performance] Chunk ${i + 1}/${totalChunks} Gemini API request took ${chunkDuration}ms`);

        // Save result at exact index so completed chunk results are never lost or re-transcribed
        chunkResults[i] = chunkTranscript;
        completedChunks++;

        if (sender && !sender.isDestroyed()) {
          const percent = Math.min(95, Math.round(5 + (completedChunks / totalChunks) * 90));
          sender.send('transcription:progress', {
            percent,
            status: 'Transcribing video audio...',
            currentChunk: completedChunks,
            totalChunks
          });
        }
      }
    }

    const workerPromises = [];
    for (let w = 0; w < Math.min(CONCURRENCY_LIMIT, totalChunks); w++) {
      workerPromises.push(worker());
    }

    await Promise.all(workerPromises);

    // Merge in exact chronological order without losing or misordering chunks
    let mergedTranscript = '';
    for (let i = 0; i < totalChunks; i++) {
      if (chunkResults[i] && chunkResults[i].trim()) {
        mergedTranscript = mergeOverlappingTranscripts(mergedTranscript, chunkResults[i]);
      }
    }

    console.log(`[Performance] Total multi-chunk transcription completed in ${Date.now() - tPrepStart}ms`);
    return cleanTranscript(mergedTranscript);
  } finally {
    if (tempExtracted && fs.existsSync(tempExtracted)) {
      try { fs.unlinkSync(tempExtracted); } catch {}
    }
  }
}

// Quality check: Determine whether caption track is usable and sufficiently complete
function isCaptionSufficientlyComplete(segments, durationSeconds) {
  if (!segments || segments.length === 0) return false;

  const coveredDuration = segments.reduce((acc, s) => acc + (s.durSec || 0), 0);
  const totalChars = segments.reduce((acc, s) => acc + (s.text ? s.text.trim().length : 0), 0);

  if (durationSeconds <= 20) {
    return totalChars >= 5;
  }

  if (durationSeconds > 20) {
    const coverageRatio = coveredDuration / durationSeconds;
    if (coverageRatio < 0.20 && totalChars < 50) {
      return false;
    }
    if (durationSeconds > 120 && totalChars < 40) {
      return false;
    }
  }

  return totalChars > 10;
}

// YouTube Transcription Service with Captions & Audio Stream Fallback
async function runGeminiYouTubeTranscription(canonicalUrl, apiKey, sender = null) {
  const videoId = extractYouTubeVideoId(canonicalUrl);
  if (!videoId) {
    throw new Error('Invalid YouTube URL provided.');
  }
  console.log(`[YouTube Pipeline] Stage 1: URL parsed successfully (Video ID: ${videoId})`);

  const STATIC_INNERTUBE_KEY = 'AIzaSyA8eiZmM1FaDVjRy-df2KTyQ_vz_yYM39w';

  // 1. Fetch anonymous visitor session context to ensure public requests pass bot verification
  let visitorData = null;
  let sessionCookies = '';
  try {
    const embedRes = await fetch(`https://www.youtube.com/embed/${videoId}`, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36'
      }
    });
    if (embedRes.ok) {
      const cookieHeaders = embedRes.headers.getSetCookie ? embedRes.headers.getSetCookie() : [embedRes.headers.get('set-cookie')];
      sessionCookies = (cookieHeaders || []).map(c => (c ? c.split(';')[0] : '')).filter(Boolean).join('; ');
      const html = await embedRes.text();
      const m = html.match(/ytcfg\.set\(({.+?})\);/s);
      if (m) {
        const cfg = JSON.parse(m[1]);
        if (cfg.VISITOR_DATA) visitorData = cfg.VISITOR_DATA;
      }
    }
  } catch (embedErr) {
    console.warn('[YouTube Pipeline] Embed session context notice:', embedErr.message);
  }

  // 2. Fetch video metadata and player data
  console.log(`[YouTube Pipeline] Stage 2: Requesting player metadata...`);
  let playerData = null;
  const playerHeaders = {
    'Content-Type': 'application/json',
    ...(sessionCookies ? { Cookie: sessionCookies } : {})
  };

  const clientContext = {
    clientName: 'ANDROID',
    clientVersion: '20.10.38',
    hl: 'en',
    gl: 'US',
    ...(visitorData ? { visitorData } : {})
  };

  try {
    const playerRes = await fetch(`https://www.youtube.com/youtubei/v1/player?key=${STATIC_INNERTUBE_KEY}`, {
      method: 'POST',
      headers: playerHeaders,
      body: JSON.stringify({
        context: { client: clientContext },
        videoId: videoId
      })
    });
    if (playerRes.ok) {
      playerData = await playerRes.json();
    }
  } catch (err) {
    console.warn('[YouTube Pipeline] InnerTube player request error:', err.message);
  }

  const playability = playerData?.playabilityStatus;
  const captionTracks = playerData?.captions?.playerCaptionsTracklistRenderer?.captionTracks || [];
  const durationSeconds = parseInt(playerData?.videoDetails?.lengthSeconds || '0', 10);
  const title = playerData?.videoDetails?.title || `YouTube Video (${videoId})`;
  console.log(`[YouTube Pipeline] Stage 2: Player status: ${playability?.status || 'UNKNOWN'}${playability?.reason ? ` (${playability.reason})` : ''}`);
  console.log(`[YouTube Pipeline] Stage 3: Discovered ${captionTracks.length} caption track(s)`);

  // Step 1: Inspect caption tracks and select candidates matching the original spoken language
  if (captionTracks.length > 0) {
    const inspectedTracks = inspectAllCaptionTracks(captionTracks);
    console.log(`[YouTube Pipeline] Stage 3: Inspected ${inspectedTracks.length} caption track(s):`);
    inspectedTracks.forEach(t => {
      console.log(`  [Track ${t.index}] lang=${t.languageCode} (${t.displayName}), kind=${t.kind}, vssId=${t.vssId}, manual=${t.isManual}`);
    });

    const origLangInfo = determineOriginalLanguage(inspectedTracks, playerData);
    console.log(`[YouTube Pipeline] Stage 3.1: Detected original spoken language: ${origLangInfo.language || 'UNKNOWN'} (source: ${origLangInfo.source}, confidence: ${origLangInfo.confidence})`);

    const candidateTracks = selectCandidateCaptionTracks(inspectedTracks, origLangInfo);
    console.log(`[YouTube Pipeline] Stage 3.2: Selected ${candidateTracks.length} candidate track(s) matching original language`);

    for (const item of candidateTracks) {
      try {
        console.log(`[YouTube Pipeline] Stage 4: Testing candidate caption track [${item.languageCode}] (kind: ${item.kind}, name: "${item.displayName}")`);
        const segments = await fetchCaptionSegments(item.track, videoId, sessionCookies);
        console.log(`[YouTube Pipeline] Stage 5: Retrieved ${segments.length} segment(s) for track [${item.languageCode}]`);

        if (segments.length > 0 && isCaptionSufficientlyComplete(segments, durationSeconds)) {
          const formatted = formatCaptionSegments(segments, durationSeconds);
          const cleaned = cleanTranscript(formatted);

          if (cleaned && cleaned.trim().length > 0) {
            const isAuto = item.isAutoGenerated;
            const sourceLabel = isAuto ? 'Auto-Generated Captions' : 'Original Captions';
            const sourceType = isAuto ? 'auto-captions' : 'original-captions';
            console.log(`[YouTube Pipeline] Stage 6: Caption transcription succeeded (${cleaned.length} chars, source: ${sourceLabel})`);
            return {
              transcript: cleaned,
              source: 'captions',
              sourceType,
              sourceLabel,
              platform: 'youtube',
              title,
              videoId
            };
          }
        }
      } catch (trackErr) {
        console.warn(`[YouTube Pipeline] Error fetching candidate caption track [${item.languageCode}]:`, trackErr.message);
      }
    }

    if (candidateTracks.length === 0) {
      const foundLangs = inspectedTracks.map(t => t.displayName || t.languageCode).join(', ');
      console.log(`[YouTube Pipeline] No captions matching original language (${origLangInfo.language || 'unknown'}) found. Available tracks: [${foundLangs}]. Proceeding to audio stream transcription...`);
    }
  }

  // Step 2: Fall back to speech-to-text transcription from video audio stream
  console.log('[YouTube Pipeline] Stage 7: Reliable original captions unavailable or incomplete. Checking direct audio streams...');
  const adaptiveFormats = playerData?.streamingData?.adaptiveFormats || [];
  const regularFormats = playerData?.streamingData?.formats || [];
  const audioFormats = adaptiveFormats.filter(f => f.mimeType && f.mimeType.startsWith('audio/'));
  const chosenAudio = audioFormats.find(f => f.mimeType && f.mimeType.includes('audio/mp4') && f.url)
    || audioFormats.find(f => f.url)
    || regularFormats.find(f => f.url && f.mimeType && f.mimeType.includes('audio'));

  if (chosenAudio && chosenAudio.url) {
    const isMp4 = chosenAudio.mimeType.includes('mp4');
    const ext = isMp4 ? 'm4a' : (chosenAudio.mimeType.includes('webm') ? 'webm' : 'mp4');
    const tempAudioPath = path.join(os.tmpdir(), `yt_stream_${Date.now()}_${videoId}.${ext}`);

    try {
      console.log(`[YouTube Pipeline] Stage 8: Attempting authorized audio stream download (${chosenAudio.mimeType})...`);
      const dlRes = await fetch(chosenAudio.url, {
        headers: {
          'User-Agent': 'com.google.android.youtube/20.10.38 (Linux; U; Android 14; en_US) gzip'
        }
      });

      if (dlRes.ok || dlRes.status === 206) {
        const fileStream = fs.createWriteStream(tempAudioPath);
        const reader = dlRes.body.getReader();
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          fileStream.write(Buffer.from(value));
        }
        fileStream.end();
        await new Promise(resolve => fileStream.on('finish', resolve));

        const stats = fs.statSync(tempAudioPath);
        if (stats.size > 1000) {
          console.log(`[YouTube Pipeline] Stage 9: Direct audio stream downloaded (${stats.size} bytes). Transcribing via speech-to-text...`);
          const transcript = await processAudioFileWithChunking(tempAudioPath, isMp4 ? 'audio/mp4' : 'audio/webm', apiKey, sender);
          return {
            transcript,
            source: 'audio',
            sourceType: 'ai-audio',
            sourceLabel: 'AI Audio Transcription',
            platform: 'youtube',
            title,
            videoId
          };
        }
      }
    } catch (audioErr) {
      console.warn('[YouTube Pipeline] Audio streaming transcription error:', audioErr.message);
    } finally {
      if (fs.existsSync(tempAudioPath)) {
        try { fs.unlinkSync(tempAudioPath); } catch {}
      }
    }
  }

  // If reliable original captions are unavailable and audio cannot be accessed through permitted methods
  const reason = playability?.reason || (playability?.status && playability.status !== 'OK' ? playability.status : 'Platform access controls / Sign in required');
  console.warn(`[YouTube Pipeline] Direct access unavailable: ${reason}`);

  if (captionTracks.length > 0) {
    const inspected = inspectAllCaptionTracks(captionTracks);
    const trackNames = inspected.map(t => `${t.displayName || t.languageCode} (${t.isAutoGenerated ? 'auto-generated' : 'translated'})`).join(', ');
    throw new Error(`Original spoken-language captions are unavailable for this YouTube video (found only translated/unmatched caption tracks: ${trackNames}), and direct audio streaming was restricted by YouTube (${reason}). You can upload a locally saved audio/video file using the 'Upload File' tab.`);
  }

  throw new Error(`Captions are unavailable for this YouTube video, and direct audio streaming was restricted by YouTube (${reason}). You can upload a locally saved audio/video file using the 'Upload File' tab.`);
}

// Inspect all available YouTube caption tracks with detailed properties
function inspectAllCaptionTracks(captionTracks) {
  if (!Array.isArray(captionTracks)) return [];
  return captionTracks.map((track, index) => {
    const langCode = (track.languageCode || '').toLowerCase().trim();
    const baseLang = langCode.split(/[-_]/)[0];
    const displayName = (
      track.name?.runs?.[0]?.text ||
      track.name?.simpleText ||
      track.trackName ||
      track.languageCode ||
      ''
    ).trim();

    const isAutoGenerated = track.kind === 'asr' ||
      (typeof track.vssId === 'string' && track.vssId.startsWith('a.')) ||
      /auto-generated/i.test(displayName);
    const isManual = !isAutoGenerated;

    return {
      index,
      track,
      languageCode: langCode,
      baseLanguage: baseLang,
      displayName,
      vssId: track.vssId || '',
      isAutoGenerated,
      isManual,
      kind: track.kind || (isAutoGenerated ? 'asr' : 'manual'),
      baseUrl: track.baseUrl
    };
  });
}

// Determine the video's original spoken language from YouTube metadata
function determineOriginalLanguage(inspectedTracks, playerData) {
  // 1. YouTube ASR (Automatic Speech Recognition) track
  // ASR is generated exclusively from the primary spoken audio of the video.
  const asrTrack = inspectedTracks.find(t => t.isAutoGenerated);
  if (asrTrack && asrTrack.baseLanguage) {
    return {
      language: asrTrack.baseLanguage,
      source: 'asr',
      confidence: 'high',
      asrTrack
    };
  }

  // 2. Video Details audio language metadata
  const detailsAudioLang = (
    playerData?.videoDetails?.defaultAudioLanguage ||
    playerData?.videoDetails?.audioLanguage ||
    ''
  ).toLowerCase().trim().split(/[-_]/)[0];

  if (detailsAudioLang) {
    return {
      language: detailsAudioLang,
      source: 'videoDetails',
      confidence: 'high'
    };
  }

  // 3. Audio tracks metadata in captions renderer
  const renderer = playerData?.captions?.playerCaptionsTracklistRenderer;
  const defAudioIdx = renderer?.defaultAudioTrackIndex;
  const defAudioTrack = (defAudioIdx !== undefined && renderer?.audioTracks)
    ? renderer.audioTracks[defAudioIdx]
    : null;

  if (defAudioTrack && defAudioTrack.audioTrackId) {
    const audioTrackLang = defAudioTrack.audioTrackId.split(/[-._]/)[0].toLowerCase();
    if (audioTrackLang && audioTrackLang.length >= 2) {
      return {
        language: audioTrackLang,
        source: 'audioTrackId',
        confidence: 'medium'
      };
    }
  }

  // 4. Single unique language across all available caption tracks
  const uniqueLanguages = [...new Set(inspectedTracks.map(t => t.baseLanguage).filter(Boolean))];
  if (uniqueLanguages.length === 1) {
    return {
      language: uniqueLanguages[0],
      source: 'singleLanguageInTracks',
      confidence: 'medium'
    };
  }

  // Cannot be determined reliably from caption metadata alone
  return {
    language: null,
    source: 'unknown',
    confidence: 'none',
    availableLanguages: uniqueLanguages
  };
}

// Select candidate caption tracks matching the original spoken language
function selectCandidateCaptionTracks(inspectedTracks, detectedOriginalLang) {
  if (!detectedOriginalLang || !detectedOriginalLang.language) {
    return [];
  }

  const target = detectedOriginalLang.language.toLowerCase();
  const candidates = [];

  // Group 1: Manual captions matching exact language code (e.g. 'en')
  const exactManual = inspectedTracks.filter(t => t.isManual && t.languageCode === target);
  candidates.push(...exactManual);

  // Group 2: Manual captions matching dialect or base language (e.g. 'en-US', 'en-GB' for target 'en')
  const dialectManual = inspectedTracks.filter(t => t.isManual && t.languageCode !== target && (t.baseLanguage === target || t.languageCode.startsWith(target + '-')));
  candidates.push(...dialectManual);

  // Group 3: Auto-generated captions (ASR) in the original spoken language
  const asrTracks = inspectedTracks.filter(t => t.isAutoGenerated && (t.languageCode === target || t.baseLanguage === target));
  candidates.push(...asrTracks);

  // Deduplicate candidate tracks
  const seenIndices = new Set();
  return candidates.filter(t => {
    if (seenIndices.has(t.index)) return false;
    seenIndices.add(t.index);
    return true;
  });
}

// Download and parse caption segments with robust format fallbacks (clean XML, json3, srv1, original)
async function fetchCaptionSegments(track, videoId = '', cookies = '') {
  if (!track || !track.baseUrl) return [];

  const browserHeaders = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
    'Accept': '*/*',
    'Accept-Language': 'en-US,en;q=0.9,bn;q=0.8',
    'Sec-Fetch-Mode': 'cors',
    'Sec-Fetch-Site': 'same-origin',
    'Sec-Fetch-Dest': 'empty',
    'Referer': videoId ? `https://www.youtube.com/watch?v=${videoId}` : 'https://www.youtube.com/',
    ...(cookies ? { Cookie: cookies } : {})
  };

  const urlsToTry = [];
  try {
    const uClean = new URL(track.baseUrl);
    uClean.searchParams.delete('fmt');
    urlsToTry.push({ url: uClean.toString(), format: 'xml' });

    const uJson = new URL(track.baseUrl);
    uJson.searchParams.set('fmt', 'json3');
    urlsToTry.push({ url: uJson.toString(), format: 'json3' });

    urlsToTry.push({ url: track.baseUrl, format: 'xml' });
  } catch {
    urlsToTry.push({ url: track.baseUrl, format: 'xml' });
  }

  for (const item of urlsToTry) {
    try {
      const res = await fetch(item.url, { headers: browserHeaders });
      if (!res.ok) {
        console.log(`[YouTube Pipeline] Caption fetch [${item.format}] HTTP ${res.status}`);
        continue;
      }

      const bodyText = await res.text();
      if (!bodyText || bodyText.length === 0 || bodyText.includes('<title>Sorry...</title>')) {
        console.log(`[YouTube Pipeline] Caption response [${item.format}] empty or rate-limited (len: ${bodyText ? bodyText.length : 0})`);
        continue;
      }

      if (item.format === 'json3') {
        try {
          const jsonData = JSON.parse(bodyText);
          const segments = parseJson3TimedText(jsonData);
          if (segments.length > 0) return segments;
        } catch {}
      } else {
        const segments = parseCaptionTimedText(bodyText);
        if (segments.length > 0) return segments;
      }
    } catch (fetchErr) {
      console.log(`[YouTube Pipeline] Caption fetch exception [${item.format}]:`, fetchErr.message);
    }
  }

  return [];
}

// Parse structured JSON3 timed text from YouTube
function parseJson3TimedText(jsonData) {
  if (!jsonData || !Array.isArray(jsonData.events)) return [];
  const segments = [];

  for (const event of jsonData.events) {
    if (!event.segs || !Array.isArray(event.segs)) continue;
    const text = event.segs
      .map(s => s.utf8 || '')
      .join('')
      .replace(/\n/g, ' ')
      .trim();

    if (text) {
      const startSec = (event.tStartMs || 0) / 1000;
      const durSec = (event.dDurationMs || 0) / 1000;
      segments.push({ startSec, durSec, text });
    }
  }

  return segments;
}

// Parse timed text XML from YouTube caption response
function parseCaptionTimedText(rawXml) {
  if (!rawXml) return [];
  const pRegex = /<p\s+t="(\d+)"(?:\s+d="(\d+)")?[^>]*>([\s\S]*?)<\/p>/gi;
  const textRegex = /<text\s+start="([\d.]+)"(?:\s+dur="([\d.]+)")?[^>]*>([\s\S]*?)<\/text>/gi;
  const segments = [];
  let match;

  while ((match = pRegex.exec(rawXml)) !== null) {
    const startMs = parseInt(match[1], 10);
    const durMs = match[2] ? parseInt(match[2], 10) : 0;
    let text = match[3]
      .replace(/<s[^>]*>([\s\S]*?)<\/s>/gi, '$1')
      .replace(/<[^>]+>/g, '')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/\n/g, ' ')
      .trim();

    if (text) {
      segments.push({
        startSec: startMs / 1000,
        durSec: durMs / 1000,
        text
      });
    }
  }

  if (segments.length === 0) {
    while ((match = textRegex.exec(rawXml)) !== null) {
      const startSec = parseFloat(match[1]);
      const durSec = match[2] ? parseFloat(match[2]) : 0;
      let text = match[3]
        .replace(/<[^>]+>/g, '')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/\n/g, ' ')
        .trim();

      if (text) {
        segments.push({
          startSec,
          durSec,
          text
        });
      }
    }
  }

  return segments;
}

// Format caption segments into natural paragraphs with smart speaker diarization
function formatCaptionSegments(segments, durationSeconds) {
  if (!segments || segments.length === 0) return '';

  const speakerNameMap = new Map();
  let speakerCounter = 1;
  let turns = [];
  let currentSpeaker = null;
  let currentLines = [];

  const speakerRegex = /^([A-Z0-9\s._'-]{2,25}):/i;

  for (const seg of segments) {
    let text = seg.text.trim();
    if (text.startsWith('>>')) {
      text = text.replace(/^>>\s*/, '');
    }

    const match = text.match(speakerRegex);
    let speakerInSeg = null;

    if (match) {
      const rawName = match[1].trim();
      const isSystemWord = /^(NOTE|HTTP|HTTPS|WWW|CHORUS|VERSE|INTRO|OUTRO)$/i.test(rawName);
      if (!isSystemWord) {
        speakerInSeg = rawName;
        text = text.substring(match[0].length).trim();
      }
    }

    if (speakerInSeg) {
      const upper = speakerInSeg.toUpperCase();
      if (!speakerNameMap.has(upper)) {
        speakerNameMap.set(upper, `Speaker ${speakerCounter++}`);
      }
      const label = speakerNameMap.get(upper);

      if (currentLines.length > 0) {
        turns.push({ speaker: currentSpeaker, text: currentLines.join(' ') });
        currentLines = [];
      }
      currentSpeaker = label;
    }

    if (text) {
      currentLines.push(text);
    }
  }

  if (currentLines.length > 0) {
    turns.push({ speaker: currentSpeaker, text: currentLines.join(' ') });
  }

  const isMultiSpeaker = speakerNameMap.size > 1;

  if (!isMultiSpeaker) {
    const fullText = turns.map(t => t.text).join(' ');
    return assembleNaturalParagraphs(fullText);
  }

  return turns
    .map(t => `${t.speaker || 'Speaker 1'}: ${assembleNaturalParagraphs(t.text)}`)
    .join('\n\n');
}

// Assemble text sentences into natural, readable paragraphs
function assembleNaturalParagraphs(text) {
  let clean = text.replace(/\s+/g, ' ').trim();
  const parts = clean.split(/([.!?]+["']?\s+)/g);
  let paragraphs = [];
  let currentPara = '';
  let count = 0;

  for (let i = 0; i < parts.length; i += 2) {
    const s = parts[i] + (parts[i + 1] || '');
    if (!s.trim()) continue;
    currentPara += (currentPara ? ' ' : '') + s.trim();
    count++;

    if (count >= 4 || currentPara.length > 350) {
      paragraphs.push(currentPara);
      currentPara = '';
      count = 0;
    }
  }

  if (currentPara.trim()) {
    paragraphs.push(currentPara.trim());
  }

  return paragraphs.join('\n\n') || clean;
}

// Transcription Service with Gemini
async function runGeminiTranscription(filePath, mimeType, apiKey) {
  const ai = new GoogleGenAI({ apiKey });
  const stats = fs.statSync(filePath);
  const fileSize = stats.size;
  const isInline = fileSize <= 20 * 1024 * 1024; // Fast inline base64 if <= 20MB

  const prompt = `You are an expert audio/video speech transcriber.
Analyze the provided recording carefully.

TASK:
1. Automatically detect the spoken language.
2. Transcribe all spoken speech verbatim into text in the SAME language and writing system that is spoken.
   - For example: English speech → English text; Hindi speech → Hindi text in Devanagari script; Arabic speech → Arabic text in Arabic script; Japanese speech → Japanese text; Chinese speech → Chinese characters; Bangla speech → Bangla text in Bengali script; Spanish speech → Spanish text, etc.
   - Preserve the speaker's actual words as accurately as possible.
3. Do NOT translate automatically. Keep the original language and writing system intact.
4. Smart speaker detection:
   - If ONLY ONE person speaks: Output ONLY the transcript text without any speaker label (do NOT output 'Speaker 1:' or similar).
   - If MULTIPLE people speak: Separate their dialogue using clean speaker turns on separate lines:
     Speaker 1: [transcript in original language]
     Speaker 2: [transcript in original language]
5. Strict output rules:
   - Do NOT include timestamps or timeline markers (e.g. no [00:00], no 01:23).
   - Do NOT include any introductory or concluding remarks, explanations, metadata, or notes.
   - Output ONLY the transcript text.`;

  let contentPart;
  let uploadedFile = null;

  if (isInline) {
    const fileBuffer = fs.readFileSync(filePath);
    contentPart = {
      inlineData: {
        mimeType: mimeType,
        data: fileBuffer.toString('base64')
      }
    };
  } else {
    // Upload larger media file via File API
    uploadedFile = await ai.files.upload({
      file: filePath,
      mimeType: mimeType
    });

    let fileState = uploadedFile.state;
    let attempts = 0;
    while (fileState === 'PROCESSING' && attempts < 30) {
      await new Promise(resolve => setTimeout(resolve, 2000));
      const checked = await ai.files.get({ name: uploadedFile.name });
      fileState = checked.state;
      attempts++;
    }

    if (fileState !== 'ACTIVE') {
      throw new Error(`File processing state is ${fileState || 'UNKNOWN'}. Could not process media.`);
    }

    contentPart = {
      fileData: {
        fileUri: uploadedFile.uri,
        mimeType: uploadedFile.mimeType
      }
    };
  }

  try {
    let lastError = null;

    for (const modelName of CANDIDATE_MODELS) {
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const response = await ai.models.generateContent({
            model: modelName,
            contents: [contentPart, prompt]
          });

          const rawText = (response && response.text) ? response.text : '';
          return cleanTranscript(rawText);
        } catch (err) {
          lastError = err;
          const msg = (err && err.message) ? err.message : '';
          if (msg.includes('RESOURCE_EXHAUSTED') || msg.includes('Quota exceeded') || msg.includes('429')) {
            break; // Switch to next candidate model immediately if quota reached
          }
          if (attempt < 2 && (msg.includes('503') || msg.includes('UNAVAILABLE') || msg.includes('high demand'))) {
            await new Promise(r => setTimeout(r, 1200 * (attempt + 1)));
            continue;
          }
          break; // Try next fallback model
        }
      }
    }

    throw lastError || new Error('Transcription could not be completed.');
  } finally {
    if (uploadedFile && uploadedFile.name) {
      try {
        await ai.files.delete({ name: uploadedFile.name });
      } catch (cleanupErr) {
        // Silently ignore cleanup errors
      }
    }
  }
}

// Split transcript into logical chunks for honest progress tracking
function splitIntoChunks(text) {
  if (!text || !text.trim()) return [];
  const trimmed = text.trim();

  // 1. If multi-speaker transcript, split by speaker turns
  const speakerRegex = /^(Speaker\s*\d+\s*:)/im;
  if (speakerRegex.test(trimmed)) {
    const turns = trimmed
      .split(/(?=^Speaker\s*\d+\s*:)/im)
      .map(t => t.trim())
      .filter(Boolean);
    if (turns.length > 1) return turns;
  }

  // 2. Split by paragraphs
  const paragraphs = trimmed
    .split(/\r?\n\s*\r?\n/)
    .map(p => p.trim())
    .filter(Boolean);
  if (paragraphs.length > 1) return paragraphs;

  // 3. If single long paragraph with multiple sentences, chunk by 1-2 sentences
  const sentences = trimmed.match(/[^.!?।]+[.!?।]+|\S[^.!?।]*$/g);
  if (sentences && sentences.length > 2) {
    const chunks = [];
    for (let i = 0; i < sentences.length; i += 2) {
      chunks.push(sentences.slice(i, i + 2).join(' ').trim());
    }
    return chunks.filter(Boolean);
  }

  return [trimmed];
}

// Translation Service with Gemini and honest chunk progress reporting
async function runGeminiTranslation(text, apiKey, sender) {
  const ai = new GoogleGenAI({ apiKey });
  const chunks = splitIntoChunks(text);
  const totalChunks = chunks.length;

  if (sender && !sender.isDestroyed()) {
    sender.send('translation:progress', {
      percent: 10,
      status: 'Translating to Bangla...',
      currentChunk: 0,
      totalChunks
    });
  }

  const translatedChunks = [];

  for (let i = 0; i < totalChunks; i++) {
    const chunk = chunks[i];
    const prompt = `You are an expert translator.
TASK: Translate the following text accurately and fluently into natural, authentic Bangla (বাংলা).
Rules:
- Preserve the original meaning and context accurately.
- If speaker labels (e.g. Speaker 1:, Speaker 2:) are present at the beginning, preserve them exactly on separate lines.
- Do NOT add timestamps, commentary, introductory notes, or explanations.
- Output ONLY the translated Bangla text.

Text to translate:
${chunk}`;

    let chunkResult = null;
    let lastError = null;

    for (const modelName of CANDIDATE_MODELS) {
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const response = await ai.models.generateContent({
            model: modelName,
            contents: prompt
          });
          const rawText = (response && response.text) ? response.text : '';
          chunkResult = cleanTranscript(rawText);
          break;
        } catch (err) {
          lastError = err;
          const msg = (err && err.message) ? err.message : '';
          if (msg.includes('RESOURCE_EXHAUSTED') || msg.includes('Quota exceeded') || msg.includes('429')) {
            break; // Switch to next candidate model immediately if quota reached
          }
          if (attempt < 2 && (msg.includes('503') || msg.includes('UNAVAILABLE') || msg.includes('high demand'))) {
            await new Promise(r => setTimeout(r, 1200 * (attempt + 1)));
            continue;
          }
          break;
        }
      }
      if (chunkResult !== null) break;
    }

    if (chunkResult === null) {
      throw lastError || new Error(`Failed to translate section ${i + 1} of ${totalChunks}.`);
    }

    translatedChunks.push(chunkResult);

    const completed = i + 1;
    if (completed < totalChunks) {
      const percent = Math.min(95, Math.round(10 + (completed / totalChunks) * 85));
      if (sender && !sender.isDestroyed()) {
        sender.send('translation:progress', {
          percent,
          status: 'Translating to Bangla...',
          currentChunk: completed,
          totalChunks
        });
      }
    }
  }

  const finalTranslation = translatedChunks.join('\n\n');

  if (sender && !sender.isDestroyed()) {
    sender.send('translation:progress', {
      percent: 100,
      status: 'Translating to Bangla...',
      currentChunk: totalChunks,
      totalChunks
    });
  }

  return finalTranslation;
}

// Clean and sanitize model transcript output
function cleanTranscript(rawText) {
  if (!rawText) return '';
  let text = rawText.trim();

  // Strip code blocks if present
  text = text.replace(/^```[a-z]*\r?\n?/i, '').replace(/\r?\n?```$/i, '').trim();

  // Strip timestamps [00:00], (00:00), 00:00 - 00:05
  text = text.replace(/\[\d{1,2}:\d{2}(?::\d{2})?\]/g, '');
  text = text.replace(/\(\d{1,2}:\d{2}(?::\d{2})?\)/g, '');
  text = text.replace(/^\d{1,2}:\d{2}(?::\d{2})?\s*-\s*\d{1,2}:\d{2}(?::\d{2})?\s*/gm, '');

  // Strip common conversational introductory remarks
  text = text.replace(/^(?:Here is the (?:verbatim |full )?transcript(?: of the (?:video|audio))?:?\s*)/i, '').trim();

  // Strip enclosing quotes if model wrapped output in quotes
  if (text.startsWith('"') && text.endsWith('"') && text.length > 2) {
    text = text.slice(1, -1).trim();
  }

  // Check if multiple speakers exist
  const hasSpeaker2 = /Speaker\s*2/i.test(text);
  if (!hasSpeaker2) {
    // Single speaker: remove any "Speaker 1:" or "বক্তা ১:" prefix
    text = text.replace(/^Speaker\s*1\s*:\s*/i, '');
    text = text.replace(/^বক্তা\s*[১1]\s*:\s*/i, '');
  } else {
    // Standardize Speaker labels
    text = text.replace(/^(Speaker\s*\d+)\s*:\s*/gim, '$1: ');
  }

  // Normalize paragraphs
  const lines = text
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean);

  return lines.join('\n\n');
}

// Sanitize error messages to ensure API keys are NEVER exposed
function sanitizeErrorMessage(msg, apiKey) {
  if (!msg) return 'An error occurred during transcription. Please try again.';
  let safe = msg;
  if (apiKey && apiKey.length > 5) {
    safe = safe.split(apiKey).join('***');
  }
  if (safe.includes('503') || safe.includes('UNAVAILABLE') || safe.includes('high demand')) {
    return 'The Gemini transcription service is currently experiencing high demand. Please try again in a moment.';
  }
  if (safe.includes('API_KEY_INVALID') || safe.includes('API key not valid')) {
    return 'Invalid Gemini API key. Please check your .env configuration.';
  }
  if (safe.includes('RESOURCE_EXHAUSTED')) {
    return 'Gemini API quota exceeded. Please check your API quota limits.';
  }
  if (
    safe.toLowerCase() === 'terminated' ||
    safe === 'fetch failed' ||
    safe.includes('UND_ERR_SOCKET') ||
    safe.includes('other side closed') ||
    safe.includes('socket hang up')
  ) {
    return 'The media download connection was terminated by the remote server. Please try again or verify video availability.';
  }
  try {
    const parsed = JSON.parse(safe);
    if (parsed.error && parsed.error.message) {
      return parsed.error.message;
    }
  } catch {}
  return safe;
}
