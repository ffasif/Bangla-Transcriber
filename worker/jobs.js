// worker/jobs.js
// In-memory job manager with EventEmitters for Server-Sent Events (SSE) and polling

const { EventEmitter } = require('events');

class JobManager {
  constructor() {
    this.jobs = new Map();
    this.events = new EventEmitter();
    this.events.setMaxListeners(100);

    // Clean up jobs older than 1 hour periodically
    setInterval(() => this.cleanupOldJobs(), 15 * 60 * 1000);
  }

  createJob(type, metadata = {}) {
    const id = `job_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
    const job = {
      id,
      type,
      status: 'pending', // 'pending' | 'processing' | 'completed' | 'failed'
      progress: 0,
      statusText: 'Job queued...',
      currentChunk: 0,
      totalChunks: 1,
      result: null,
      error: null,
      metadata,
      createdAt: Date.now(),
      updatedAt: Date.now()
    };

    this.jobs.set(id, job);
    this.emitUpdate(job);
    return job;
  }

  getJob(id) {
    return this.jobs.get(id) || null;
  }

  updateJob(id, updates = {}) {
    const job = this.jobs.get(id);
    if (!job) return null;

    Object.assign(job, updates, { updatedAt: Date.now() });
    this.emitUpdate(job);
    return job;
  }

  emitUpdate(job) {
    this.events.emit(`job:${job.id}`, job);
  }

  subscribe(id, callback) {
    const channel = `job:${id}`;
    this.events.on(channel, callback);
    return () => {
      this.events.off(channel, callback);
    };
  }

  cleanupOldJobs(maxAgeMs = 3600 * 1000) {
    const now = Date.now();
    for (const [id, job] of this.jobs.entries()) {
      if (now - job.updatedAt > maxAgeMs) {
        this.jobs.delete(id);
      }
    }
  }
}

const jobManager = new JobManager();
module.exports = jobManager;
