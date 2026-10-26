// web/api/translate.js
// Vercel Serverless Function: Forwards translation requests to background worker with direct Gemini fallback

const { GoogleGenAI } = require('@google/genai');

const CANDIDATE_MODELS = [
  'gemini-2.5-flash',
  'gemini-2.5-flash-lite',
  'gemini-2.0-flash',
  'gemini-3.5-flash-lite',
  'gemini-flash-lite-latest',
  'gemini-flash-latest'
];

function cleanTranscript(rawText) {
  if (!rawText) return '';
  let text = rawText.trim();
  text = text.replace(/^```[a-z]*\r?\n?/i, '').replace(/\r?\n?```$/i, '').trim();
  if (text.startsWith('"') && text.endsWith('"') && text.length > 2) {
    text = text.slice(1, -1).trim();
  }
  return text;
}

async function runDirectGeminiTranslation(text, apiKey) {
  const ai = new GoogleGenAI({ apiKey });
  const prompt = `You are an expert translator.
TASK: Translate the following text accurately and fluently into natural, authentic Bangla (বাংলা).
Rules:
- Preserve the original meaning and context accurately.
- If speaker labels (e.g. Speaker 1:, Speaker 2:) are present at the beginning, preserve them exactly on separate lines.
- Do NOT add timestamps, commentary, introductory notes, or explanations.
- Output ONLY the translated Bangla text.

Text to translate:
${text.trim()}`;

  let lastError = null;
  for (const modelName of CANDIDATE_MODELS) {
    try {
      const response = await ai.models.generateContent({
        model: modelName,
        contents: prompt
      });
      if (response && response.text) {
        return cleanTranscript(response.text);
      }
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError || new Error('Translation could not be completed.');
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed. Use POST.' });
  }

  const { text } = req.body || {};
  if (!text || typeof text !== 'string' || text.trim().length === 0) {
    return res.status(400).json({ error: 'No transcript text provided for translation.' });
  }

  const workerUrl = process.env.WORKER_URL || (process.env.VERCEL ? '' : 'http://localhost:4000');

  if (workerUrl) {
    try {
      const workerRes = await fetch(`${workerUrl.replace(/\/$/, '')}/api/translate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text }),
        signal: AbortSignal.timeout(45000)
      });

      const data = await workerRes.json();
      return res.status(workerRes.status).json(data);
    } catch (err) {
      console.warn('[Vercel Translate] Worker unreachable, checking direct Gemini fallback:', err.message);
    }
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (apiKey && apiKey.trim().length > 0 && apiKey !== 'YOUR_GEMINI_API_KEY_HERE') {
    try {
      const translation = await runDirectGeminiTranslation(text, apiKey.trim());
      return res.status(200).json({ success: true, translation });
    } catch (geminiErr) {
      return res.status(500).json({
        error: 'Direct Gemini translation failed: ' + (geminiErr.message || 'Unknown error')
      });
    }
  }

  return res.status(502).json({
    error: `Could not connect to processing worker${workerUrl ? ` at ${workerUrl}` : ''}. Please ensure WORKER_URL or GEMINI_API_KEY is configured in your Vercel project settings.`
  });
};
