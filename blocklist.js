const fs = require('fs');
const path = require('path');
const https = require('https');

const SNAPSHOT_PATH = path.join(__dirname, 'disposable_email_blocklist.conf');
const ALLOWLIST_PATH = process.env.ALLOWLIST_PATH || path.join(__dirname, 'allowlist.conf');
const REMOTE_URL = 'https://raw.githubusercontent.com/disposable-email-domains/disposable-email-domains/master/disposable_email_blocklist.conf';
const UPDATE_INTERVAL_MS = parseInt(process.env.UPDATE_INTERVAL_HOURS, 10) * 3600000 || 24 * 3600000;

let blocklist = new Set();
let allowlist = new Set();

function loadFileToSet(filePath) {
  const result = new Set();
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    for (const line of content.split('\n')) {
      const domain = line.trim().toLowerCase();
      if (domain && !domain.startsWith('#')) {
        result.add(domain);
      }
    }
  } catch (err) {
    if (err.code !== 'ENOENT') {
      console.error(`Error reading ${filePath}:`, err.message);
    }
  }
  return result;
}

function downloadToString(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { timeout: 15000 }, (res) => {
      if (res.statusCode !== 200) {
        reject(new Error(`HTTP ${res.statusCode}`));
        res.resume();
        return;
      }
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
  });
}

async function updateFromRemote() {
  try {
    const content = await downloadToString(REMOTE_URL);
    const newSet = new Set();
    for (const line of content.split('\n')) {
      const domain = line.trim().toLowerCase();
      if (domain && !domain.startsWith('#')) {
        newSet.add(domain);
      }
    }
    if (newSet.size > 100) {
      blocklist = newSet;
      fs.writeFileSync(SNAPSHOT_PATH, content, 'utf-8');
      console.log(`[blocklist] Updated from remote: ${blocklist.size} domains`);
    } else {
      console.warn('[blocklist] Remote list too small, keeping current list');
    }
  } catch (err) {
    console.warn(`[blocklist] Remote update failed (keeping current): ${err.message}`);
  }
}

function reloadAllowlist() {
  allowlist = loadFileToSet(ALLOWLIST_PATH);
  console.log(`[allowlist] Loaded: ${allowlist.size} domains`);
}

function init() {
  blocklist = loadFileToSet(SNAPSHOT_PATH);
  console.log(`[blocklist] Loaded snapshot: ${blocklist.size} domains`);
  reloadAllowlist();

  setInterval(() => {
    updateFromRemote();
    reloadAllowlist();
  }, UPDATE_INTERVAL_MS);

  updateFromRemote();
}

function isDisposable(domain) {
  const d = domain.toLowerCase();
  if (allowlist.has(d)) return false;
  return blocklist.has(d);
}

function stats() {
  return { blocklist: blocklist.size, allowlist: allowlist.size };
}

module.exports = { init, isDisposable, stats };
