// web/api/transcribe/url.js
// Vercel Serverless Function: Handles YouTube URL transcription requests with direct caption fallback

function extractYouTubeVideoId(url) {
  if (!url || typeof url !== 'string') return null;
  const trimmed = url.trim();
  const ytMatch = trimmed.match(/(?:youtube\.com\/(?:watch\?.*v=|shorts\/|live\/|embed\/|v\/)|youtu\.be\/)([a-zA-Z0-9_-]{11})/i);
  if (ytMatch) return ytMatch[1];
  if (/^[a-zA-Z0-9_-]{11}$/.test(trimmed)) return trimmed;
  return null;
}

function parseCaptionXml(rawXml) {
  if (!rawXml) return '';
  const pRegex = /<p\s+t="(\d+)"(?:\s+d="(\d+)")?[^>]*>([\s\S]*?)<\/p>/gi;
  const textRegex = /<text\s+start="([\d.]+)"(?:\s+dur="([\d.]+)")?[^>]*>([\s\S]*?)<\/text>/gi;
  const segments = [];
  let match;

  const decodeEntities = (str) =>
    str
      .replace(/<s[^>]*>([\s\S]*?)<\/s>/gi, '$1')
      .replace(/<[^>]+>/g, '')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/\n/g, ' ')
      .trim();

  while ((match = pRegex.exec(rawXml)) !== null) {
    const text = decodeEntities(match[3]);
    if (text) segments.push(text);
  }
  if (segments.length === 0) {
    while ((match = textRegex.exec(rawXml)) !== null) {
      const text = decodeEntities(match[3]);
      if (text) segments.push(text);
    }
  }
  return segments.join(' ').replace(/\s+/g, ' ').trim();
}

async function fetchYouTubeCaptionsDirectly(url) {
  const videoId = extractYouTubeVideoId(url);
  if (!videoId) throw new Error('Invalid YouTube URL provided.');

  const STATIC_INNERTUBE_KEY = 'AIzaSyA8eiZmM1FaDVjRy-df2KTyQ_vz_yYM39w';
  const playerRes = await fetch(`https://www.youtube.com/youtubei/v1/player?key=${STATIC_INNERTUBE_KEY}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      context: {
        client: {
          clientName: 'ANDROID',
          clientVersion: '20.10.38',
          hl: 'en',
          gl: 'US'
        }
      },
      videoId
    })
  });

  if (!playerRes.ok) {
    throw new Error('Could not fetch YouTube video metadata.');
  }

  const playerData = await playerRes.json();
  const title = playerData?.videoDetails?.title || `YouTube Video (${videoId})`;
  const captionTracks = playerData?.captions?.playerCaptionsTracklistRenderer?.captionTracks || [];

  for (const track of captionTracks) {
    if (!track.baseUrl) continue;
    try {
      const res = await fetch(track.baseUrl);
      if (!res.ok) continue;
      const xml = await res.text();
      const transcript = parseCaptionXml(xml);
      if (transcript && transcript.length > 10) {
        const isAuto = track.kind === 'asr' || (typeof track.vssId === 'string' && track.vssId.startsWith('a.'));
        return {
          transcript,
          source: 'captions',
          sourceType: isAuto ? 'auto-captions' : 'original-captions',
          sourceLabel: isAuto ? 'Auto-Generated Captions' : 'Original Captions',
          platform: 'youtube',
          title,
          videoId
        };
      }
    } catch {}
  }

  throw new Error('Captions are unavailable for this video on serverless fallback. Connect WORKER_URL for full audio stream extraction.');
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed. Use POST.' });
  }

  const { url } = req.body || {};
  if (!url || typeof url !== 'string') {
    return res.status(400).json({ error: 'A valid video URL is required.' });
  }

  const workerUrl = process.env.WORKER_URL || (process.env.VERCEL ? '' : 'http://localhost:4000');

  if (workerUrl) {
    try {
      const workerRes = await fetch(`${workerUrl.replace(/\/$/, '')}/api/transcribe/url`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url }),
        signal: AbortSignal.timeout(45000)
      });

      const data = await workerRes.json();
      return res.status(workerRes.status).json(data);
    } catch (workerErr) {
      console.warn('[Vercel API] Worker unreachable, attempting direct YouTube caption extraction:', workerErr.message);
    }
  }

  try {
    const directResult = await fetchYouTubeCaptionsDirectly(url);
    return res.status(200).json(directResult);
  } catch (fallbackErr) {
    return res.status(502).json({
      error: workerUrl
        ? `Could not connect to processing worker at ${workerUrl}, and direct caption fallback failed: ${fallbackErr.message}`
        : fallbackErr.message
    });
  }
};
