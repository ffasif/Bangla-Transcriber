// Bangla Transcriber - Web Frontend Logic (Browser-compatible, zero Electron dependencies)

document.addEventListener('DOMContentLoaded', () => {
  // UI Elements - Navigation & Modes
  const modeUploadBtn = document.getElementById('modeUploadBtn');
  const modeYoutubeBtn = document.getElementById('modeYoutubeBtn');
  const dropZone = document.getElementById('dropZone');
  const youtubeZone = document.getElementById('youtubeZone');
  const browseBtn = document.getElementById('browseBtn');
  const fileInput = document.getElementById('fileInput');

  // UI Elements - Video URL Input
  const youtubeForm = document.getElementById('youtubeForm');
  const youtubeUrlInput = document.getElementById('youtubeUrlInput');
  const clearYoutubeUrlBtn = document.getElementById('clearYoutubeUrlBtn');
  const transcribeYoutubeBtn = document.getElementById('transcribeYoutubeBtn');

  // UI Elements - File / Media Card
  const fileCard = document.getElementById('fileCard');
  const fileIconBox = document.getElementById('fileIconBox');
  const fileNameEl = document.getElementById('fileName');
  const fileSizeEl = document.getElementById('fileSize');
  const clearFileBtn = document.getElementById('clearFileBtn');

  // UI Elements - Loading Card
  const loadingCard = document.getElementById('loadingCard');
  const loadingTitle = document.getElementById('loadingTitle');
  const loadingSubtitle = document.getElementById('loadingSubtitle');

  // UI Elements - Transcript & Translation
  const transcriptCard = document.getElementById('transcriptCard');
  const transcriptTitle = document.getElementById('transcriptTitle');
  const transcriptSourceTag = document.getElementById('transcriptSourceTag');
  const transcriptEditor = document.getElementById('transcriptEditor');
  const viewTabs = document.getElementById('viewTabs');
  const tabOriginal = document.getElementById('tabOriginal');
  const tabBangla = document.getElementById('tabBangla');
  const translateBtn = document.getElementById('translateBtn');

  // UI Elements - Progress
  const translationProgressContainer = document.getElementById('translationProgressContainer');
  const translationStatusLabel = document.getElementById('translationStatusLabel');
  const translationPercentLabel = document.getElementById('translationPercentLabel');
  const translationProgressBar = document.getElementById('translationProgressBar');

  // UI Elements - Actions & Status
  const copyTranscriptBtn = document.getElementById('copyTranscriptBtn');
  const copyBtnText = document.getElementById('copyBtnText');
  const newFileBtn = document.getElementById('newFileBtn');
  const toastMessage = document.getElementById('toastMessage');
  const envStatusPill = document.getElementById('envStatusPill');
  const envStatusText = document.getElementById('envStatusText');

  // SVGs
  const fileAudioIconSvg = `
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <path d="M9 18V5l12-2v13"/>
      <circle cx="6" cy="18" r="3"/>
      <circle cx="18" cy="16" r="3"/>
    </svg>`;

  const youtubeIconSvg = `
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="color: #D93025;">
      <path d="M2.5 17a24.12 24.12 0 0 1 0-10 2 2 0 0 1 1.4-1.4 49.56 49.56 0 0 1 16.2 0A2 2 0 0 1 21.5 7a24.12 24.12 0 0 1 0 10 2 2 0 0 1-1.4 1.4 49.55 49.55 0 0 1-16.2 0A2 2 0 0 1 2.5 17"/>
      <polygon points="10 15 15 12 10 9 10 15"/>
    </svg>`;

  // State
  let currentMode = 'upload'; // 'upload' | 'youtube'
  let selectedFileObj = null;
  let selectedVideo = null;
  let isTranscribing = false;
  let isTranslating = false;
  let copyResetTimer = null;
  let activeEventSource = null;

  let originalTranscript = '';
  let banglaTranscript = '';
  let activeView = 'original'; // 'original' | 'bangla'
  let transcriptSource = 'audio';

  // Worker Base URL Configuration:
  // For local development, target http://localhost:4000
  // Production must use the configured WORKER_URL (or discovered via /api/status, or fallback to relative /api)
  function getInitialWorkerBase() {
    if (typeof window !== 'undefined') {
      if (window.WORKER_URL) return window.WORKER_URL.replace(/\/$/, '');
      if (window.__WORKER_URL__) return window.__WORKER_URL__.replace(/\/$/, '');
      const meta = document.querySelector('meta[name="worker-url"]');
      if (meta && meta.content && !meta.content.startsWith('__') && meta.content.trim().length > 0) {
        return meta.content.trim().replace(/\/$/, '');
      }
      try {
        const params = new URLSearchParams(window.location.search);
        const q = params.get('workerUrl');
        if (q) return q.trim().replace(/\/$/, '');
        const stored = localStorage.getItem('WORKER_URL');
        if (stored) return stored.trim().replace(/\/$/, '');
      } catch {}

      const isLocalhost = (
        window.location.hostname === 'localhost' ||
        window.location.hostname === '127.0.0.1' ||
        window.location.hostname === '[::1]' ||
        window.location.hostname === ''
      );
      if (isLocalhost) {
        return 'http://localhost:4000';
      }
    }
    return '';
  }

  let configuredWorkerBase = getInitialWorkerBase();
  let apiBaseUrl = configuredWorkerBase ? `${configuredWorkerBase}/api` : '/api';

  // 1. Initial Status Check
  checkBackendStatus();

  // Allow clicking the status pill to manually refresh backend connection
  if (envStatusPill) {
    envStatusPill.style.cursor = 'pointer';
    envStatusPill.addEventListener('click', () => {
      checkBackendStatus();
    });
  }

  // Periodic status poll if backend was unreachable
  setInterval(() => {
    if (envStatusPill && envStatusPill.classList.contains('missing') && !isTranscribing && !isTranslating) {
      checkBackendStatus();
    }
  }, 8000);

  async function checkBackendStatus() {
    const isLocalhost = (
      window.location.hostname === 'localhost' ||
      window.location.hostname === '127.0.0.1' ||
      window.location.hostname === '[::1]' ||
      window.location.hostname === ''
    );

    // List candidate health check endpoints to query
    const candidates = [];

    // If configured worker base is set (e.g. http://localhost:4000 or custom WORKER_URL)
    if (configuredWorkerBase) {
      candidates.push({
        url: `${configuredWorkerBase}/api/status`,
        apiBase: `${configuredWorkerBase}/api`,
        label: isLocalhost ? 'Local Worker Connected' : 'Worker Connected'
      });
      candidates.push({
        url: `${configuredWorkerBase}/health`,
        apiBase: `${configuredWorkerBase}/api`,
        label: isLocalhost ? 'Local Worker Connected' : 'Worker Connected'
      });
    }

    // Relative endpoint (e.g. Vercel deployment with serverless gateway)
    candidates.push({
      url: '/api/status',
      apiBase: '/api',
      label: 'Backend & API Key Ready'
    });

    // Fallback direct check for localhost if running standalone
    if (isLocalhost && configuredWorkerBase !== 'http://localhost:4000') {
      candidates.push({
        url: 'http://localhost:4000/api/status',
        apiBase: 'http://localhost:4000/api',
        label: 'Local Worker Connected'
      });
      candidates.push({
        url: 'http://localhost:4000/health',
        apiBase: 'http://localhost:4000/api',
        label: 'Local Worker Connected'
      });
    }

    for (const candidate of candidates) {
      try {
        const res = await fetch(candidate.url, {
          headers: { 'Accept': 'application/json' },
          signal: AbortSignal.timeout(3000)
        });

        if (res.ok) {
          const data = await res.json().catch(() => ({}));

          // If the endpoint reported a specific worker URL (e.g. from Vercel /api/status)
          if (data.workerUrl) {
            configuredWorkerBase = data.workerUrl.replace(/\/$/, '');
            apiBaseUrl = `${configuredWorkerBase}/api`;
          } else {
            apiBaseUrl = candidate.apiBase;
          }

          if (data.isConfigured !== false && (data.isConfigured || data.status === 'ok' || data.workerConnected)) {
            envStatusPill.className = 'env-pill ready';
            envStatusText.textContent = candidate.label;
            return true;
          } else if (data.workerConfigured && !data.workerConnected) {
            envStatusPill.className = 'env-pill missing';
            envStatusText.textContent = 'Connecting to backend...';
            return false;
          } else {
            envStatusPill.className = 'env-pill missing';
            envStatusText.textContent = 'API Key needed in environment';
            return false;
          }
        }
      } catch (err) {
        // Continue to try next candidate
      }
    }

    envStatusPill.className = 'env-pill missing';
    envStatusText.textContent = 'Backend unreachable';
    return false;
  }

  // 2. Mode Switcher (Upload File vs YouTube)
  modeUploadBtn.addEventListener('click', () => {
    if (isTranscribing || isTranslating) return;
    switchInputMode('upload');
  });

  modeYoutubeBtn.addEventListener('click', () => {
    if (isTranscribing || isTranslating) return;
    switchInputMode('youtube');
  });

  function switchInputMode(mode) {
    currentMode = mode;
    hideToast();

    if (mode === 'upload') {
      modeUploadBtn.classList.add('active');
      modeUploadBtn.setAttribute('aria-selected', 'true');
      modeYoutubeBtn.classList.remove('active');
      modeYoutubeBtn.setAttribute('aria-selected', 'false');

      dropZone.classList.remove('hidden');
      youtubeZone.classList.add('hidden');
    } else {
      modeYoutubeBtn.classList.add('active');
      modeYoutubeBtn.setAttribute('aria-selected', 'true');
      modeUploadBtn.classList.remove('active');
      modeUploadBtn.setAttribute('aria-selected', 'false');

      youtubeZone.classList.remove('hidden');
      dropZone.classList.add('hidden');
      youtubeUrlInput.focus();
    }
  }

  // 3. YouTube URL Handling
  youtubeUrlInput.addEventListener('input', () => {
    const val = youtubeUrlInput.value.trim();
    if (val.length > 0) {
      clearYoutubeUrlBtn.classList.remove('hidden');
    } else {
      clearYoutubeUrlBtn.classList.add('hidden');
    }
    hideToast();
  });

  clearYoutubeUrlBtn.addEventListener('click', () => {
    youtubeUrlInput.value = '';
    clearYoutubeUrlBtn.classList.add('hidden');
    youtubeUrlInput.focus();
    hideToast();
  });

  youtubeForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (isTranscribing || isTranslating) return;
    await handleVideoSubmit();
  });

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

  async function handleVideoSubmit() {
    const rawUrl = youtubeUrlInput.value.trim();
    if (!rawUrl) {
      showToast('Please enter a YouTube video URL.', 'info');
      youtubeUrlInput.focus();
      return;
    }

    if (/(?:bilibili\.com|b23\.tv)/i.test(rawUrl)) {
      showToast('Bilibili videos are no longer supported. Please enter a valid YouTube video URL.', 'error');
      youtubeUrlInput.focus();
      return;
    }

    const detected = detectVideoUrlPlatform(rawUrl);
    if (!detected) {
      showToast('Please enter a valid YouTube video URL (e.g., https://www.youtube.com/watch?v=... or https://youtu.be/...).', 'error');
      youtubeUrlInput.focus();
      return;
    }

    await runVideoUrlTranscription(rawUrl, detected);
  }

  // 4. File Browsing via HTML5 file input
  browseBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (isTranscribing || isTranslating) return;
    fileInput.click();
  });

  dropZone.addEventListener('click', (e) => {
    if (isTranscribing || isTranslating) return;
    if (e.target !== browseBtn) {
      fileInput.click();
    }
  });

  dropZone.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      if (!isTranscribing && !isTranslating) {
        fileInput.click();
      }
    }
  });

  fileInput.addEventListener('change', async (e) => {
    if (e.target.files && e.target.files.length > 0) {
      const file = e.target.files[0];
      await handleFileSelected(file);
    }
  });

  // 5. Drag and Drop events (Standard HTML5 Drag & Drop)
  ['dragenter', 'dragover'].forEach(eventName => {
    dropZone.addEventListener(eventName, (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (!isTranscribing && !isTranslating) {
        dropZone.classList.add('drag-over');
      }
    });
  });

  ['dragleave', 'dragend'].forEach(eventName => {
    dropZone.addEventListener(eventName, (e) => {
      e.preventDefault();
      e.stopPropagation();
      dropZone.classList.remove('drag-over');
    });
  });

  dropZone.addEventListener('drop', async (e) => {
    e.preventDefault();
    e.stopPropagation();
    dropZone.classList.remove('drag-over');
    if (isTranscribing || isTranslating) return;
    hideToast();

    const dt = e.dataTransfer;
    if (!dt || !dt.files || dt.files.length === 0) return;

    const file = dt.files[0];
    await handleFileSelected(file);
  });

  // 6. File Selected Handler & Auto-Transcription
  async function handleFileSelected(file) {
    const ext = file.name.split('.').pop().toLowerCase();
    const validExtensions = ['mp3', 'wav', 'm4a', 'mp4', 'mov', 'webm'];

    if (!validExtensions.includes(ext)) {
      showToast(`Unsupported file format (.${ext}). Supported formats: MP3, WAV, M4A, MP4, MOV.`, 'error');
      return;
    }

    selectedFileObj = file;
    displaySelectedFile(file);
    await runFileTranscription(file);
  }

  function displaySelectedFile(file) {
    selectedVideo = null;
    fileIconBox.innerHTML = fileAudioIconSvg;
    fileNameEl.textContent = file.name;
    const ext = file.name.split('.').pop().toUpperCase();
    fileSizeEl.textContent = formatBytes(file.size) + ' • ' + ext;
    fileCard.classList.remove('hidden');
    hideToast();
  }

  function displayVideoSelected(rawUrl, detected) {
    selectedVideo = { url: rawUrl, detected };
    selectedFileObj = null;

    fileIconBox.innerHTML = youtubeIconSvg;
    fileNameEl.textContent = `YouTube Video (${detected.id || 'Web Link'})`;
    fileSizeEl.textContent = `${rawUrl} • Public Video`;

    fileCard.classList.remove('hidden');
    hideToast();
  }

  // 7. Track Job Progress (SSE with Polling fallback)
  function trackJobProgress(jobId, onProgress) {
    return new Promise((resolve, reject) => {
      let resolved = false;
      let pollInterval = null;

      function cleanup() {
        if (activeEventSource) {
          activeEventSource.close();
          activeEventSource = null;
        }
        if (pollInterval) {
          clearInterval(pollInterval);
          pollInterval = null;
        }
      }

      function handleJobPayload(data) {
        if (!data || resolved) return;

        if (typeof onProgress === 'function') {
          onProgress(data);
        }

        if (data.status === 'completed') {
          resolved = true;
          cleanup();
          resolve(data.result);
        } else if (data.status === 'failed') {
          resolved = true;
          cleanup();
          reject(new Error(data.error || 'Job failed'));
        }
      }

      // Try Server-Sent Events first
      try {
        const eventsUrl = `${apiBaseUrl}/jobs/${encodeURIComponent(jobId)}/events`;
        const es = new EventSource(eventsUrl);
        activeEventSource = es;

        es.onmessage = (event) => {
          try {
            const data = JSON.parse(event.data);
            handleJobPayload(data);
          } catch (parseErr) {
            console.warn('[SSE] Parse error:', parseErr);
          }
        };

        es.onerror = () => {
          // Fall back to HTTP polling if SSE encounters an issue or proxies buffer
          if (!pollInterval && !resolved) {
            console.log('[Job Tracker] SSE stream closed/interrupted, switching to polling...');
            if (activeEventSource) {
              activeEventSource.close();
              activeEventSource = null;
            }
            startPolling();
          }
        };
      } catch (err) {
        startPolling();
      }

      function startPolling() {
        if (pollInterval || resolved) return;
        pollInterval = setInterval(async () => {
          try {
            const res = await fetch(`${apiBaseUrl}/jobs/${encodeURIComponent(jobId)}`);
            if (res.ok) {
              const data = await res.json();
              handleJobPayload(data);
            } else if (res.status === 404) {
              resolved = true;
              cleanup();
              reject(new Error('Job not found on server.'));
            }
          } catch (pollErr) {
            console.warn('[Job Tracker] Polling error:', pollErr);
          }
        }, 1200);
      }
    });
  }

  // 8. File Transcription Pipeline
  async function runFileTranscription(file) {
    if (isTranscribing) return;
    isTranscribing = true;

    originalTranscript = '';
    banglaTranscript = '';
    transcriptSource = 'audio';
    activeView = 'original';
    viewTabs.classList.add('hidden');
    translationProgressContainer.classList.add('hidden');
    translateBtn.disabled = false;
    if (transcriptSourceTag) transcriptSourceTag.classList.add('hidden');

    loadingTitle.textContent = 'Uploading media...';
    loadingSubtitle.textContent = 'Preparing audio file for speech-to-text processing';
    loadingCard.classList.remove('hidden');
    transcriptCard.classList.add('hidden');
    clearFileBtn.style.pointerEvents = 'none';
    clearFileBtn.style.opacity = '0.5';
    hideToast();

    try {
      const formData = new FormData();
      formData.append('file', file);

      // Post to transcribe endpoint
      const uploadRes = await fetch(`${apiBaseUrl}/transcribe/file`, {
        method: 'POST',
        body: formData
      });

      if (!uploadRes.ok) {
        const errorMsg = await parseResponseError(uploadRes, `Upload failed (HTTP ${uploadRes.status})`);
        throw new Error(errorMsg);
      }

      const uploadData = await uploadRes.json();
      if (!uploadData.jobId) {
        if (uploadData.transcript) {
          originalTranscript = uploadData.transcript || '';
          transcriptSource = uploadData.source || 'audio';
          activeView = 'original';
          transcriptTitle.textContent = 'Original Transcript';
          transcriptEditor.value = originalTranscript;
          copyBtnText.textContent = 'Copy Transcript';
          updateSourceTag(uploadData);
          transcriptCard.classList.remove('hidden');
          transcriptCard.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
          return;
        }
        throw new Error(uploadData.error || 'Server did not return a job ID.');
      }

      loadingTitle.textContent = 'Transcribing audio...';
      loadingSubtitle.textContent = 'Detecting spoken language, speakers, and transcribing verbatim';

      const result = await trackJobProgress(uploadData.jobId, (progress) => {
        if (progress.statusText) loadingTitle.textContent = progress.statusText;
        if (progress.totalChunks > 1) {
          loadingSubtitle.textContent = `Processing chunk ${progress.currentChunk} of ${progress.totalChunks} (${progress.progress}%)...`;
        } else if (progress.progress) {
          loadingSubtitle.textContent = `Transcribing audio (${progress.progress}%)...`;
        }
      });

      if (result) {
        originalTranscript = result.transcript || '';
        transcriptSource = result.source || 'audio';
        activeView = 'original';
        transcriptTitle.textContent = 'Original Transcript';
        transcriptEditor.value = originalTranscript;
        copyBtnText.textContent = 'Copy Transcript';

        updateSourceTag(result);

        transcriptCard.classList.remove('hidden');
        transcriptCard.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      }
    } catch (err) {
      showToast('Transcription failed: ' + (err.message || 'Unknown error'), 'error');
    } finally {
      isTranscribing = false;
      loadingCard.classList.add('hidden');
      clearFileBtn.style.pointerEvents = 'auto';
      clearFileBtn.style.opacity = '1';
    }
  }

  // 9. Video URL Transcription Pipeline (YouTube)
  async function runVideoUrlTranscription(rawUrl, detected) {
    if (isTranscribing) return;
    isTranscribing = true;

    originalTranscript = '';
    banglaTranscript = '';
    transcriptSource = 'audio';
    activeView = 'original';
    viewTabs.classList.add('hidden');
    translationProgressContainer.classList.add('hidden');
    translateBtn.disabled = false;
    if (transcriptSourceTag) transcriptSourceTag.classList.add('hidden');

    displayVideoSelected(rawUrl, detected);

    const platformName = 'YouTube';
    loadingTitle.textContent = `Transcribing ${platformName} video...`;
    loadingSubtitle.textContent = 'Checking captions and processing audio stream in original language...';
    loadingCard.classList.remove('hidden');
    transcriptCard.classList.add('hidden');
    clearFileBtn.style.pointerEvents = 'none';
    clearFileBtn.style.opacity = '0.5';
    hideToast();

    try {
      const res = await fetch(`${apiBaseUrl}/transcribe/url`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: rawUrl })
      });

      if (!res.ok) {
        const errorMsg = await parseResponseError(res, `Request failed (HTTP ${res.status})`);
        throw new Error(errorMsg);
      }

      const data = await res.json();
      if (!data.jobId) {
        // Direct response if captions resolved immediately
        if (data.transcript) {
          renderTranscriptionResult(data, platformName);
          return;
        }
        throw new Error(data.error || 'Server did not return a job ID.');
      }

      const result = await trackJobProgress(data.jobId, (progress) => {
        if (progress.statusText) loadingTitle.textContent = progress.statusText;
        if (progress.totalChunks > 1) {
          loadingSubtitle.textContent = `Processing chunk ${progress.currentChunk} of ${progress.totalChunks} (${progress.progress}%)...`;
        } else if (progress.progress) {
          loadingSubtitle.textContent = `${progress.statusText || 'Transcribing'} (${progress.progress}%)...`;
        }
      });

      if (result) {
        renderTranscriptionResult(result, platformName);
      }
    } catch (err) {
      showToast(`${platformName} transcription failed: ` + (err.message || 'Unknown error'), 'error');
      fileCard.classList.add('hidden');
    } finally {
      isTranscribing = false;
      loadingCard.classList.add('hidden');
      clearFileBtn.style.pointerEvents = 'auto';
      clearFileBtn.style.opacity = '1';
    }
  }

  function renderTranscriptionResult(result, platformName) {
    originalTranscript = result.transcript || '';
    transcriptSource = result.source || 'audio';
    activeView = 'original';
    transcriptTitle.textContent = 'Original Transcript';
    transcriptEditor.value = originalTranscript;
    copyBtnText.textContent = 'Copy Transcript';

    updateSourceTag(result);

    if (result.title) {
      fileNameEl.textContent = `${platformName}: ${result.title}`;
    }

    transcriptCard.classList.remove('hidden');
    transcriptCard.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  function updateSourceTag(result) {
    if (!transcriptSourceTag) return;
    const sType = result?.sourceType || (result?.source === 'captions' ? 'original-captions' : 'ai-audio');
    const sLabel = result?.sourceLabel || (
      sType === 'original-captions' ? 'Original Captions' :
      (sType === 'auto-captions' ? 'Auto-Generated Captions' :
      (sType === 'translated-captions' ? 'Translated Captions' : 'AI Audio Transcription'))
    );

    transcriptSourceTag.textContent = sLabel;
    if (sType === 'auto-captions' || sType === 'captions-asr') {
      transcriptSourceTag.className = 'source-tag captions-asr';
    } else if (sType === 'translated-captions') {
      transcriptSourceTag.className = 'source-tag captions-translated';
    } else if (sType === 'original-captions' || sType === 'captions') {
      transcriptSourceTag.className = 'source-tag captions captions-original';
    } else {
      transcriptSourceTag.className = 'source-tag audio';
    }
    transcriptSourceTag.classList.remove('hidden');
  }

  // 10. Action: Translate to Bangla with Honest Progress Tracking
  translateBtn.addEventListener('click', async () => {
    if (isTranslating || isTranscribing) return;

    const textToTranslate = transcriptEditor.value.trim();
    if (!textToTranslate) {
      showToast('No transcript text available to translate.', 'info');
      return;
    }

    isTranslating = true;
    translateBtn.disabled = true;
    hideToast();

    translationStatusLabel.textContent = 'Translating to Bangla...';
    translationPercentLabel.textContent = '0%';
    translationProgressBar.style.width = '0%';
    translationProgressContainer.classList.remove('hidden');

    try {
      const res = await fetch(`${apiBaseUrl}/translate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: textToTranslate })
      });

      if (!res.ok) {
        const errorMsg = await parseResponseError(res, `Translation request failed (HTTP ${res.status})`);
        throw new Error(errorMsg);
      }

      const data = await res.json();
      if (!data.jobId && !data.translation) {
        throw new Error('Server did not return a valid translation or job ID.');
      }

      let finalTranslation = '';
      if (data.translation) {
        finalTranslation = data.translation;
      } else {
        const jobResult = await trackJobProgress(data.jobId, (progress) => {
          const pct = Math.min(100, Math.max(0, progress.progress || 0));
          translationPercentLabel.textContent = `${pct}%`;
          translationProgressBar.style.width = `${pct}%`;
          if (progress.statusText) {
            translationStatusLabel.textContent = progress.statusText;
          }
        });
        finalTranslation = jobResult.translation;
      }

      banglaTranscript = finalTranslation || '';
      translationPercentLabel.textContent = '100%';
      translationProgressBar.style.width = '100%';
      translationStatusLabel.textContent = 'Translating to Bangla...';

      await new Promise(resolve => setTimeout(resolve, 450));

      translationProgressContainer.classList.add('hidden');
      switchView('bangla');
      viewTabs.classList.remove('hidden');
    } catch (err) {
      showToast('Translation failed: ' + (err.message || 'Unknown error'), 'error');
      translationProgressContainer.classList.add('hidden');
      translationProgressBar.style.width = '0%';
      translationPercentLabel.textContent = '0%';
    } finally {
      isTranslating = false;
      translateBtn.disabled = false;
    }
  });

  // 11. View Switcher Tabs: Original vs Bangla
  tabOriginal.addEventListener('click', () => {
    if (activeView !== 'original') {
      switchView('original');
    }
  });

  tabBangla.addEventListener('click', () => {
    if (activeView !== 'bangla') {
      switchView('bangla');
    }
  });

  function switchView(view) {
    activeView = view;
    if (view === 'original') {
      tabOriginal.classList.add('active');
      tabBangla.classList.remove('active');
      transcriptTitle.textContent = 'Original Transcript';
      transcriptEditor.value = originalTranscript;
      copyBtnText.textContent = banglaTranscript ? 'Copy Original' : 'Copy Transcript';
      if (transcriptSourceTag) {
        transcriptSourceTag.classList.remove('hidden');
      }
    } else {
      tabBangla.classList.add('active');
      tabOriginal.classList.remove('active');
      transcriptTitle.textContent = 'Bangla Translation';
      transcriptEditor.value = banglaTranscript;
      copyBtnText.textContent = 'Copy Bangla';
      if (transcriptSourceTag) {
        transcriptSourceTag.classList.add('hidden');
      }
    }
  }

  // 12. Keep Transcript Editable & Sync State
  transcriptEditor.addEventListener('input', () => {
    if (activeView === 'original') {
      originalTranscript = transcriptEditor.value;
    } else {
      banglaTranscript = transcriptEditor.value;
    }
  });

  // 13. Copy Transcript
  copyTranscriptBtn.addEventListener('click', async () => {
    const textToCopy = transcriptEditor.value;
    if (!textToCopy || textToCopy.trim().length === 0) {
      return;
    }

    try {
      await navigator.clipboard.writeText(textToCopy);

      if (copyResetTimer) clearTimeout(copyResetTimer);
      copyTranscriptBtn.classList.add('copied');
      copyBtnText.textContent = 'Copied';

      copyResetTimer = setTimeout(() => {
        copyTranscriptBtn.classList.remove('copied');
        if (banglaTranscript) {
          copyBtnText.textContent = activeView === 'original' ? 'Copy Original' : 'Copy Bangla';
        } else {
          copyBtnText.textContent = 'Copy Transcript';
        }
      }, 2200);
    } catch (err) {
      showToast('Failed to copy to clipboard: ' + err.message, 'error');
    }
  });

  // 14. Reset Workflow
  clearFileBtn.addEventListener('click', () => {
    if (isTranscribing || isTranslating) return;
    resetWorkflow();
  });

  if (newFileBtn) {
    newFileBtn.addEventListener('click', () => {
      if (isTranscribing || isTranslating) return;
      resetWorkflow();
      const targetZone = currentMode === 'youtube' ? youtubeZone : dropZone;
      targetZone.scrollIntoView({ behavior: 'smooth', block: 'center' });
    });
  }

  function resetWorkflow() {
    selectedFileObj = null;
    selectedVideo = null;
    isTranscribing = false;
    isTranslating = false;
    originalTranscript = '';
    banglaTranscript = '';
    activeView = 'original';
    transcriptSource = 'audio';

    if (activeEventSource) {
      activeEventSource.close();
      activeEventSource = null;
    }

    fileInput.value = '';
    fileCard.classList.add('hidden');
    loadingCard.classList.add('hidden');
    transcriptCard.classList.add('hidden');
    viewTabs.classList.add('hidden');
    translationProgressContainer.classList.add('hidden');
    if (transcriptSourceTag) transcriptSourceTag.classList.add('hidden');
    transcriptEditor.value = '';
    translateBtn.disabled = false;
    youtubeUrlInput.value = '';
    clearYoutubeUrlBtn.classList.add('hidden');
    fileIconBox.innerHTML = fileAudioIconSvg;
    hideToast();

    if (copyResetTimer) clearTimeout(copyResetTimer);
    copyTranscriptBtn.classList.remove('copied');
    copyBtnText.textContent = 'Copy Transcript';
  }

  async function parseResponseError(res, defaultMsg) {
    let errorMsg = defaultMsg;
    try {
      const text = await res.text();
      try {
        const json = JSON.parse(text);
        if (json && json.error) {
          errorMsg = json.error;
        }
      } catch {
        if (text && text.trim().length > 0 && text.length < 300 && !text.includes('<!DOCTYPE')) {
          errorMsg = text.trim();
        }
      }
    } catch {}
    return errorMsg;
  }

  function showToast(message, type = 'info') {
    toastMessage.textContent = message;
    toastMessage.className = `toast-message ${type}`;
    toastMessage.classList.remove('hidden');
  }

  function hideToast() {
    toastMessage.classList.add('hidden');
  }

  function formatBytes(bytes) {
    if (bytes === 0) return '0 Bytes';
    const k = 1024;
    const sizes = ['Bytes', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
  }
});
