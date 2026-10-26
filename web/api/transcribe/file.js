// web/api/transcribe/file.js
// Vercel Serverless Function: Streams uploaded media file to background worker with direct Gemini fallback

const http = require('http');
const https = require('https');
const { URL } = require('url');
const path = require('path');
const { GoogleGenAI } = require('@google/genai');

// Disable Vercel's default body parser so multipart audio/video stream passes intact
module.exports.config = {
  api: {
    bodyParser: false,
    responseLimit: false
  }
};

const CANDIDATE_MODELS = [
  'gemini-2.5-flash',
  'gemini-2.5-flash-lite',
  'gemini-2.0-flash',
  'gemini-3.5-flash-lite',
  'gemini-flash-lite-latest',
  'gemini-flash-latest'
];

function extractMultipartFile(rawBuffer, contentTypeHeader) {
  const match = (contentTypeHeader || '').match(/boundary=(?:"([^"]+)"|([^;]+))/i);
  if (!match) return null;
  const boundary = match[1] || match[2];
  const boundaryBuf = Buffer.from(`--${boundary}`);
  const headerEndMarker = Buffer.from('\r\n\r\n');

  let pos = rawBuffer.indexOf(boundaryBuf);
  while (pos !== -1) {
    const partStart = pos + boundaryBuf.length;
    if (rawBuffer.slice(partStart, partStart + 2).toString() === '--') break;

    const headerEnd = rawBuffer.indexOf(headerEndMarker, partStart);
    if (headerEnd === -1) break;

    const headersText = rawBuffer.slice(partStart, headerEnd).toString('utf8');
    const dataStart = headerEnd + 4;
    const nextBoundary = rawBuffer.indexOf(boundaryBuf, dataStart);
    if (nextBoundary === -1) break;

    const dataEnd = nextBoundary - 2; // Strip trailing \r\n before boundary
    if (/filename=/i.test(headersText)) {
      const fnMatch = headersText.match(/filename="([^"]+)"/i);
      const fileName = fnMatch ? fnMatch[1] : 'audio.mp3';
      const ext = path.extname(fileName).toLowerCase().replace('.', '') || 'mp3';
      const mimeMap = {
        mp3: 'audio/mp3',
        wav: 'audio/wav',
        m4a: 'audio/m4a',
        mp4: 'video/mp4',
        mov: 'video/quicktime',
        webm: 'audio/webm'
      };
      return {
        fileName,
        mimeType: mimeMap[ext] || 'audio/mp3',
        buffer: rawBuffer.slice(dataStart, Math.max(dataStart, dataEnd))
      };
    }
    pos = nextBoundary;
  }
  return null;
}

async function runDirectGeminiFileTranscription(fileBuffer, mimeType, apiKey) {
  const ai = new GoogleGenAI({ apiKey });
  const prompt = `You are an expert audio/video speech transcriber.
Analyze the provided recording carefully.
1. Automatically detect the spoken language.
2. Transcribe all spoken speech verbatim into text in the SAME language and writing system that is spoken.
3. Do NOT translate automatically. Keep the original language and writing system intact.
4. If MULTIPLE people speak, separate their dialogue using Speaker 1:, Speaker 2: on separate lines. If ONLY ONE person speaks, output ONLY the transcript text without speaker labels.
5. Output ONLY the transcript text without timestamps or commentary.`;

  const contentPart = {
    inlineData: {
      mimeType,
      data: fileBuffer.toString('base64')
    }
  };

  let lastError = null;
  for (const modelName of CANDIDATE_MODELS) {
    try {
      const response = await ai.models.generateContent({
        model: modelName,
        contents: [contentPart, prompt]
      });
      if (response && response.text) {
        return response.text.trim();
      }
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError || new Error('Transcription could not be completed.');
}

module.exports = function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed. Use POST.' });
  }

  const workerUrl = process.env.WORKER_URL || (process.env.VERCEL ? '' : 'http://localhost:4000');
  const apiKey = process.env.GEMINI_API_KEY;
  const hasDirectGemini = Boolean(apiKey && apiKey.trim().length > 0 && apiKey !== 'YOUR_GEMINI_API_KEY_HERE');

  // If no workerUrl is configured on Vercel and GEMINI_API_KEY is available, transcribe directly
  if (!workerUrl && hasDirectGemini) {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', async () => {
      try {
        const rawBuffer = Buffer.concat(chunks);
        const parsed = extractMultipartFile(rawBuffer, req.headers['content-type']);
        if (!parsed || !parsed.buffer || parsed.buffer.length === 0) {
          return res.status(400).json({ error: 'No valid media file found in upload request.' });
        }
        const transcript = await runDirectGeminiFileTranscription(parsed.buffer, parsed.mimeType, apiKey.trim());
        return res.status(200).json({
          success: true,
          transcript,
          source: 'audio',
          sourceType: 'ai-audio',
          sourceLabel: 'AI Audio Transcription',
          fileName: parsed.fileName
        });
      } catch (err) {
        return res.status(500).json({ error: 'Direct transcription failed: ' + (err.message || 'Unknown error') });
      }
    });
    return;
  }

  if (!workerUrl) {
    return res.status(502).json({
      error: 'Neither WORKER_URL nor GEMINI_API_KEY is configured in your Vercel project settings.'
    });
  }

  let targetUrlObj;
  try {
    targetUrlObj = new URL(`${workerUrl.replace(/\/$/, '')}/api/transcribe/file`);
  } catch (err) {
    return res.status(500).json({ error: 'Invalid WORKER_URL configured: ' + err.message });
  }

  const client = targetUrlObj.protocol === 'https:' ? https : http;

  const headers = { ...req.headers };
  delete headers.host;
  headers.host = targetUrlObj.host;

  const proxyReq = client.request(
    targetUrlObj,
    {
      method: 'POST',
      headers: headers
    },
    (proxyRes) => {
      res.writeHead(proxyRes.statusCode, proxyRes.headers);
      proxyRes.pipe(res);
    }
  );

  proxyReq.on('error', (err) => {
    console.error('[Vercel File Proxy Error]:', err.message);
    if (!res.headersSent) {
      res.status(502).json({
        error: `Could not connect to processing worker at ${workerUrl}. Please ensure the worker is running and accessible.`
      });
    }
  });

  // Pipe the multipart upload stream directly to the worker
  req.pipe(proxyReq);
};
