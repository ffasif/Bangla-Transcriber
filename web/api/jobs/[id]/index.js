// web/api/jobs/[id]/index.js
// Vercel Serverless Function: Proxies job status requests to the background worker

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  const { id } = req.query;
  const workerUrl = process.env.WORKER_URL || 'http://localhost:4000';

  if (!id) {
    return res.status(400).json({ error: 'Missing job ID parameter.' });
  }

  try {
    const targetUrl = `${workerUrl.replace(/\/$/, '')}/api/jobs/${encodeURIComponent(id)}`;
    const workerRes = await fetch(targetUrl);

    if (!workerRes.ok) {
      return res.status(workerRes.status).json({ error: 'Job not found on processing worker.' });
    }

    const data = await workerRes.json();
    return res.status(200).json(data);
  } catch (err) {
    return res.status(502).json({
      error: 'Could not connect to processing worker: ' + err.message
    });
  }
};
