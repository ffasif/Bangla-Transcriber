// web/api/jobs/[id]/events.js
// Vercel Serverless Function: Redirects or proxies Server-Sent Events to the processing worker

module.exports = async function handler(req, res) {
  const { id } = req.query;
  const workerUrl = process.env.WORKER_URL || 'http://localhost:4000';

  if (!id) {
    return res.status(400).json({ error: 'Missing job ID parameter.' });
  }

  const targetStreamUrl = `${workerUrl.replace(/\/$/, '')}/api/jobs/${encodeURIComponent(id)}/events`;

  // Redirect client directly to the worker SSE stream to prevent Vercel serverless timeout
  return res.redirect(307, targetStreamUrl);
};
