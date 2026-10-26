// web/build.js
// Production build validation script for Vercel and local environments

const { execFileSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const filesToCheck = [
  'app.js',
  'api/status.js',
  'api/translate.js',
  'api/transcribe/file.js',
  'api/transcribe/url.js',
  'api/jobs/[id].js',
  'api/jobs/[id]/index.js',
  'api/jobs/[id]/events.js'
];

console.log('[Bangla Transcriber Web] Validating production files...');

let hasError = false;

for (const relPath of filesToCheck) {
  const fullPath = path.join(__dirname, relPath);
  if (!fs.existsSync(fullPath)) {
    console.error(`[Error] Required file missing: ${relPath}`);
    hasError = true;
    continue;
  }

  try {
    execFileSync(process.execPath, ['--check', fullPath], { stdio: 'pipe' });
    console.log(`  ✓ ${relPath}`);
  } catch (err) {
    console.error(`[Error] Syntax check failed on ${relPath}:`, err.message);
    hasError = true;
  }
}

// Verify index.html and style.css exist
if (!fs.existsSync(path.join(__dirname, 'index.html'))) {
  console.error('[Error] index.html missing from web directory.');
  hasError = true;
} else {
  console.log('  ✓ index.html');
}

if (!fs.existsSync(path.join(__dirname, 'style.css'))) {
  console.error('[Error] style.css missing from web directory.');
  hasError = true;
} else {
  console.log('  ✓ style.css');
}

if (hasError) {
  console.error('[Bangla Transcriber Web] Production build failed.');
  process.exit(1);
}

console.log('[Bangla Transcriber Web] Build check passed successfully.');
