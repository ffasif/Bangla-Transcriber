// worker/pipeline.js
// Core transcription, audio processing, FFmpeg chunking, and Gemini integration

const fs = require('fs');
const path = require('path');
const os = require('os');
const cp = require('child_process');
const { GoogleGenAI } = require('@google/genai');

// Resolve FFmpeg binary across platforms (Docker, Railway, Render, Windows, Linux)
let ffmpegPath = process.env.FFMPEG_PATH || 'ffmpeg';
if (!process.env.FFMPEG_PATH) {
  try {
    const ffmpegInstaller = require('@ffmpeg-installer/ffmpeg');
    if (ffmpegInstaller && ffmpegInstaller.path && fs.existsSync(ffmpegInstaller.path)) {
      ffmpegPath = ffmpegInstaller.path;
    }
  } catch {
    // Use system ffmpeg if installer is unavailable
  }
}

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
    cp.execFile(ffmpegPath, ['-i', filePath], (err, stdout, stderr) => {
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
    cp.execFile(ffmpegPath, [
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
      cp.execFile(ffmpegPath, [
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

// Helper: Single chunk Gemini STT
async function runGeminiTranscription(filePath, mimeType, apiKey) {
  const ai = new GoogleGenAI({ apiKey });
  const stats = fs.statSync(filePath);
  const fileSize = stats.size;
  const isInline = fileSize <= 20 * 1024 * 1024; // Inline if <= 20MB

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
            break; // Switch to next candidate model
          }
          if (attempt < 2 && (msg.includes('503') || msg.includes('UNAVAILABLE') || msg.includes('high demand'))) {
            await new Promise(r => setTimeout(r, 1200 * (attempt + 1)));
            continue;
          }
          break;
        }
      }
    }

    throw lastError || new Error('Transcription could not be completed.');
  } finally {
    if (uploadedFile && uploadedFile.name) {
      try {
        await ai.files.delete({ name: uploadedFile.name });
      } catch {}
    }
  }
}

// Process audio file with chunking and concurrency control
async function processAudioFileWithChunking(filePath, mimeType, apiKey, onProgress = null) {
  const tPrepStart = Date.now();
  let workingAudioPath = filePath;
  let tempExtracted = null;
  let chunks = [];

  const ext = path.extname(filePath).toLowerCase().replace('.', '');
  if (['mp4', 'mov', 'webm', 'm4s', 'm4a'].includes(ext)) {
    tempExtracted = path.join(os.tmpdir(), `extracted_${Date.now()}.mp3`);
    await extractAudioWithFfmpeg(filePath, tempExtracted);
    workingAudioPath = tempExtracted;
    mimeType = 'audio/mp3';
  }

  try {
    const durationSec = await getAudioDuration(workingAudioPath);
    console.log(`[Worker Pipeline] Audio duration: ${durationSec}s`);
    const CHUNK_LIMIT_SEC = 600; // 10 minutes per chunk

    if (durationSec <= CHUNK_LIMIT_SEC + 30) {
      if (typeof onProgress === 'function') {
        onProgress({
          percent: 30,
          status: 'Transcribing audio with Gemini...',
          currentChunk: 1,
          totalChunks: 1
        });
      }
      const transcript = await runGeminiTranscription(workingAudioPath, mimeType, apiKey);
      if (typeof onProgress === 'function') {
        onProgress({
          percent: 100,
          status: 'Transcription completed',
          currentChunk: 1,
          totalChunks: 1
        });
      }
      return transcript;
    }

    // Long media chunking
    chunks = await splitAudioIntoChunks(workingAudioPath, durationSec, CHUNK_LIMIT_SEC, 8);
    const totalChunks = chunks.length;
    console.log(`[Worker Pipeline] Split into ${totalChunks} chunks`);

    const chunkResults = new Array(totalChunks).fill(null);
    let completedChunks = 0;

    if (typeof onProgress === 'function') {
      onProgress({
        percent: 5,
        status: 'Transcribing audio in segments...',
        currentChunk: 0,
        totalChunks
      });
    }

    const CONCURRENCY_LIMIT = 2;
    let nextIndex = 0;

    async function worker() {
      while (true) {
        const i = nextIndex++;
        if (i >= totalChunks) break;

        const chunk = chunks[i];
        let chunkTranscript = null;
        let lastChunkErr = null;
        const maxChunkAttempts = 3;

        for (let attempt = 0; attempt < maxChunkAttempts; attempt++) {
          try {
            chunkTranscript = await runGeminiTranscription(chunk.path, 'audio/mp3', apiKey);
            break;
          } catch (err) {
            lastChunkErr = err;
            if (attempt < maxChunkAttempts - 1) {
              const backoffMs = Math.min(8000, 1500 * Math.pow(2, attempt) + Math.random() * 500);
              await new Promise(r => setTimeout(r, backoffMs));
            }
          }
        }

        if (chunkTranscript === null) {
          throw lastChunkErr || new Error(`Failed to transcribe chunk ${i + 1} of ${totalChunks}.`);
        }

        chunkResults[i] = chunkTranscript;
        completedChunks++;

        if (typeof onProgress === 'function') {
          const percent = Math.min(95, Math.round(5 + (completedChunks / totalChunks) * 90));
          onProgress({
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

    let mergedTranscript = '';
    for (let i = 0; i < totalChunks; i++) {
      if (chunkResults[i] && chunkResults[i].trim()) {
        mergedTranscript = mergeOverlappingTranscripts(mergedTranscript, chunkResults[i]);
      }
    }

    if (typeof onProgress === 'function') {
      onProgress({
        percent: 100,
        status: 'Transcription completed',
        currentChunk: totalChunks,
        totalChunks
      });
    }

    return cleanTranscript(mergedTranscript);
  } finally {
    // Safely clean up all temporary audio chunks and extractions
    if (Array.isArray(chunks)) {
      for (const c of chunks) {
        if (c && c.isTemp && c.path && fs.existsSync(c.path)) {
          try { fs.unlinkSync(c.path); } catch {}
        }
      }
    }
    if (tempExtracted && fs.existsSync(tempExtracted)) {
      try { fs.unlinkSync(tempExtracted); } catch {}
    }
  }
}

// Detect supported video platform
function detectVideoUrlPlatform(url) {
  if (!url || typeof url !== 'string') return null;
  const trimmed = url.trim();

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

function extractYouTubeVideoId(url) {
  const detected = detectVideoUrlPlatform(url);
  return (detected && detected.platform === 'youtube') ? detected.id : null;
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
    if (coverageRatio < 0.20 && totalChars < 50) return false;
    if (durationSeconds > 120 && totalChars < 40) return false;
  }

  return totalChars > 10;
}

// Run YouTube transcription: Captions first, then audio stream fallback
async function runGeminiYouTubeTranscription(canonicalUrl, apiKey, onProgress = null) {
  const videoId = extractYouTubeVideoId(canonicalUrl);
  if (!videoId) {
    throw new Error('Invalid YouTube URL provided.');
  }

  const STATIC_INNERTUBE_KEY = 'AIzaSyA8eiZmM1FaDVjRy-df2KTyQ_vz_yYM39w';

  if (typeof onProgress === 'function') {
    onProgress({ percent: 10, status: 'Fetching YouTube video metadata...', currentChunk: 0, totalChunks: 1 });
  }

  // 1. Fetch visitor session context
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
    console.warn('[Worker YouTube] Embed session context notice:', embedErr.message);
  }

  // 2. Fetch video metadata via InnerTube
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
    console.warn('[Worker YouTube] InnerTube player request error:', err.message);
  }

  const playability = playerData?.playabilityStatus;
  const captionTracks = playerData?.captions?.playerCaptionsTracklistRenderer?.captionTracks || [];
  const durationSeconds = parseInt(playerData?.videoDetails?.lengthSeconds || '0', 10);
  const title = playerData?.videoDetails?.title || `YouTube Video (${videoId})`;

  // Step 1: Check original spoken language captions
  if (captionTracks.length > 0) {
    if (typeof onProgress === 'function') {
      onProgress({ percent: 30, status: 'Checking captions matching original speech...', currentChunk: 0, totalChunks: 1 });
    }
    const inspectedTracks = inspectAllCaptionTracks(captionTracks);
    const origLangInfo = determineOriginalLanguage(inspectedTracks, playerData);
    const candidateTracks = selectCandidateCaptionTracks(inspectedTracks, origLangInfo);

    for (const item of candidateTracks) {
      try {
        const segments = await fetchCaptionSegments(item.track, videoId, sessionCookies);
        if (segments.length > 0 && isCaptionSufficientlyComplete(segments, durationSeconds)) {
          const formatted = formatCaptionSegments(segments, durationSeconds);
          const cleaned = cleanTranscript(formatted);

          if (cleaned && cleaned.trim().length > 0) {
            const isAuto = item.isAutoGenerated;
            const sourceLabel = isAuto ? 'Auto-Generated Captions' : 'Original Captions';
            const sourceType = isAuto ? 'auto-captions' : 'original-captions';

            if (typeof onProgress === 'function') {
              onProgress({ percent: 100, status: 'Captions retrieved successfully', currentChunk: 1, totalChunks: 1 });
            }

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
        console.warn(`[Worker YouTube] Candidate caption track [${item.languageCode}] error:`, trackErr.message);
      }
    }
  }

  // Step 2: Fall back to audio stream download + STT
  if (typeof onProgress === 'function') {
    onProgress({ percent: 40, status: 'Downloading audio stream for speech-to-text...', currentChunk: 0, totalChunks: 1 });
  }

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
          const transcript = await processAudioFileWithChunking(
            tempAudioPath,
            isMp4 ? 'audio/mp4' : 'audio/webm',
            apiKey,
            onProgress
          );
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
      console.warn('[Worker YouTube] Audio streaming transcription error:', audioErr.message);
    } finally {
      if (fs.existsSync(tempAudioPath)) {
        try { fs.unlinkSync(tempAudioPath); } catch {}
      }
    }
  }

  const reason = playability?.reason || (playability?.status && playability.status !== 'OK' ? playability.status : 'Platform access controls / Sign in required');
  throw new Error(`Captions are unavailable for this YouTube video, and direct audio streaming was restricted by YouTube (${reason}). You can upload a locally saved audio/video file using the 'Upload File' tab.`);
}

// Inspect caption tracks
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

// Determine original spoken language from YouTube metadata
function determineOriginalLanguage(inspectedTracks, playerData) {
  const asrTrack = inspectedTracks.find(t => t.isAutoGenerated);
  if (asrTrack && asrTrack.baseLanguage) {
    return {
      language: asrTrack.baseLanguage,
      source: 'asr',
      confidence: 'high',
      asrTrack
    };
  }

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

  const uniqueLanguages = [...new Set(inspectedTracks.map(t => t.baseLanguage).filter(Boolean))];
  if (uniqueLanguages.length === 1) {
    return {
      language: uniqueLanguages[0],
      source: 'singleLanguageInTracks',
      confidence: 'medium'
    };
  }

  return {
    language: null,
    source: 'unknown',
    confidence: 'none',
    availableLanguages: uniqueLanguages
  };
}

// Select candidate caption tracks
function selectCandidateCaptionTracks(inspectedTracks, detectedOriginalLang) {
  if (!detectedOriginalLang || !detectedOriginalLang.language) return [];

  const target = detectedOriginalLang.language.toLowerCase();
  const candidates = [];

  const exactManual = inspectedTracks.filter(t => t.isManual && t.languageCode === target);
  candidates.push(...exactManual);

  const dialectManual = inspectedTracks.filter(t => t.isManual && t.languageCode !== target && (t.baseLanguage === target || t.languageCode.startsWith(target + '-')));
  candidates.push(...dialectManual);

  const asrTracks = inspectedTracks.filter(t => t.isAutoGenerated && (t.languageCode === target || t.baseLanguage === target));
  candidates.push(...asrTracks);

  const seenIndices = new Set();
  return candidates.filter(t => {
    if (seenIndices.has(t.index)) return false;
    seenIndices.add(t.index);
    return true;
  });
}

// Fetch caption segments
async function fetchCaptionSegments(track, videoId = '', cookies = '') {
  if (!track || !track.baseUrl) return [];

  const browserHeaders = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
    'Accept': '*/*',
    'Accept-Language': 'en-US,en;q=0.9,bn;q=0.8',
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
      if (!res.ok) continue;

      const bodyText = await res.text();
      if (!bodyText || bodyText.length === 0 || bodyText.includes('<title>Sorry...</title>')) continue;

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
    } catch {}
  }

  return [];
}

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
      segments.push({ startSec: startMs / 1000, durSec: durMs / 1000, text });
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
        segments.push({ startSec, durSec, text });
      }
    }
  }

  return segments;
}

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
    if (text.startsWith('>>')) text = text.replace(/^>>\s*/, '');

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

    if (text) currentLines.push(text);
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

  if (currentPara.trim()) paragraphs.push(currentPara.trim());
  return paragraphs.join('\n\n') || clean;
}

// Split into chunks for honest translation progress
function splitIntoChunks(text) {
  if (!text || !text.trim()) return [];
  const trimmed = text.trim();

  const speakerRegex = /^(Speaker\s*\d+\s*:)/im;
  if (speakerRegex.test(trimmed)) {
    const turns = trimmed
      .split(/(?=^Speaker\s*\d+\s*:)/im)
      .map(t => t.trim())
      .filter(Boolean);
    if (turns.length > 1) return turns;
  }

  const paragraphs = trimmed
    .split(/\r?\n\s*\r?\n/)
    .map(p => p.trim())
    .filter(Boolean);
  if (paragraphs.length > 1) return paragraphs;

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

// Translate to Bangla with Gemini
async function runGeminiTranslation(text, apiKey, onProgress = null) {
  const ai = new GoogleGenAI({ apiKey });
  const chunks = splitIntoChunks(text);
  const totalChunks = chunks.length;

  if (typeof onProgress === 'function') {
    onProgress({
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
            break;
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
      if (typeof onProgress === 'function') {
        onProgress({
          percent,
          status: 'Translating to Bangla...',
          currentChunk: completed,
          totalChunks
        });
      }
    }
  }

  const finalTranslation = translatedChunks.join('\n\n');

  if (typeof onProgress === 'function') {
    onProgress({
      percent: 100,
      status: 'Translation completed',
      currentChunk: totalChunks,
      totalChunks
    });
  }

  return finalTranslation;
}

// Clean and sanitize transcript
function cleanTranscript(rawText) {
  if (!rawText) return '';
  let text = rawText.trim();

  text = text.replace(/^```[a-z]*\r?\n?/i, '').replace(/\r?\n?```$/i, '').trim();
  text = text.replace(/\[\d{1,2}:\d{2}(?::\d{2})?\]/g, '');
  text = text.replace(/\(\d{1,2}:\d{2}(?::\d{2})?\)/g, '');
  text = text.replace(/^\d{1,2}:\d{2}(?::\d{2})?\s*-\s*\d{1,2}:\d{2}(?::\d{2})?\s*/gm, '');
  text = text.replace(/^(?:Here is the (?:verbatim |full )?transcript(?: of the (?:video|audio))?:?\s*)/i, '').trim();

  if (text.startsWith('"') && text.endsWith('"') && text.length > 2) {
    text = text.slice(1, -1).trim();
  }

  const hasSpeaker2 = /Speaker\s*2/i.test(text);
  if (!hasSpeaker2) {
    text = text.replace(/^Speaker\s*1\s*:\s*/i, '');
    text = text.replace(/^বক্তা\s*[১1]\s*:\s*/i, '');
  } else {
    text = text.replace(/^(Speaker\s*\d+)\s*:\s*/gim, '$1: ');
  }

  const lines = text
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean);

  return lines.join('\n\n');
}

// Sanitize errors so API keys are never leaked
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
    return 'Invalid Gemini API key. Please check your environment configuration.';
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

module.exports = {
  detectVideoUrlPlatform,
  extractYouTubeVideoId,
  getAudioDuration,
  extractAudioWithFfmpeg,
  splitAudioIntoChunks,
  processAudioFileWithChunking,
  runGeminiYouTubeTranscription,
  runGeminiTranslation,
  cleanTranscript,
  sanitizeErrorMessage
};
