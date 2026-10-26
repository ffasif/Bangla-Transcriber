// web/api/status.js
// Vercel Serverless Function: Checks system readiness without revealing secret keys

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  const workerUrl = process.env.WORKER_URL || (process.env.VERCEL ? '' : 'http://localhost:4000');
  const geminiKey = process.env.GEMINI_API_KEY;

  let workerConnected = false;
  let workerKeyConfigured = false;

  if (workerUrl) {
    try {
      const response = await fetch(`${workerUrl.replace(/\/$/, '')}/health`, {
        signal: AbortSignal.timeout(3500)
      });
      if (response.ok) {
        const data = await response.json();
        workerConnected = true;
        workerKeyConfigured = Boolean(data.isConfigured);
      }
    } catch {
      workerConnected = false;
    }
  }

  const geminiConfigured = Boolean(
    geminiKey && geminiKey.trim().length > 0 && geminiKey !== 'YOUR_GEMINI_API_KEY_HERE'
  );

  const isConfigured = Boolean(workerKeyConfigured || geminiConfigured);

  return res.status(200).json({
    status: 'ok',
    isConfigured,
    geminiConfigured,
    workerConfigured: Boolean(process.env.WORKER_URL || workerConnected),
    workerConnected,
    workerUrl: workerConnected ? workerUrl : null
  });
};
