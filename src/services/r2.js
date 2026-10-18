// ============================================================================
// Zylo — Cloudflare R2 Storage & Direct Zero-Egress CDN Service
//  - All clips are stored directly in R2 and served from the R2 Public CDN.
//  - Once uploaded to R2, temporary local disk copies on Render are removed.
//  - JSON databases & banner/announcement assets are mirrored to R2.
// ============================================================================
import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { pipeline } from 'stream/promises';
import {
  S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand, ListObjectsV2Command
} from '@aws-sdk/client-s3';
import { CDN_URL } from '../config/constants.js';

const { R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY } = process.env;
const R2_BUCKET = process.env.R2_BUCKET || process.env.R2_BUCKET_NAME;

export const enabled = !!(R2_ACCOUNT_ID && R2_ACCESS_KEY_ID && R2_SECRET_ACCESS_KEY && R2_BUCKET);
export const publicUrl = CDN_URL;

const MAX_BYTES = Math.floor(parseFloat(process.env.R2_MAX_GB || '9.5') * 1024 * 1024 * 1024);

export const DATA_FILES = [
  'media_db.json', 'stats_db.json', 'banners_db.json',
  'announcements_db.json', 'quota_config.json', 'admin_config.json', 'voters_db.json'
];

const client = enabled ? new S3Client({
  region: 'auto',
  endpoint: process.env.R2_ENDPOINT || `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  forcePathStyle: true,
  credentials: { accessKeyId: R2_ACCESS_KEY_ID, secretAccessKey: R2_SECRET_ACCESS_KEY },
  requestChecksumCalculation: 'WHEN_REQUIRED',
  responseChecksumValidation: 'WHEN_REQUIRED'
}) : null;

const isMissing = (e) => e && (e.name === 'NoSuchKey' || e.$metadata?.httpStatusCode === 404);

// ---------------------------------------------------------------- primitives
export async function putFile(key, filePath, contentType) {
  if (!enabled) return false;
  try {
    const size = fs.statSync(filePath).size;
    await client.send(new PutObjectCommand({
      Bucket: R2_BUCKET, Key: key, Body: fs.createReadStream(filePath),
      ContentLength: size, ContentType: contentType || 'application/octet-stream'
    }));
    return true;
  } catch (e) {
    console.error(`[R2] putFile failed (${key}):`, e.message);
    return false;
  }
}

export async function putBuffer(key, buf, contentType) {
  if (!enabled) return false;
  try {
    await client.send(new PutObjectCommand({
      Bucket: R2_BUCKET, Key: key, Body: buf, ContentLength: buf.length,
      ContentType: contentType || 'application/octet-stream'
    }));
    return true;
  } catch (e) {
    console.error(`[R2] putBuffer failed (${key}):`, e.message);
    return false;
  }
}

export async function downloadToFile(key, dest) {
  if (!enabled) return false;
  const tmp = dest + '.part';
  try {
    const out = await client.send(new GetObjectCommand({ Bucket: R2_BUCKET, Key: key }));
    await pipeline(out.Body, fs.createWriteStream(tmp));
    fs.renameSync(tmp, dest);
    return true;
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch (_) {}
    if (!isMissing(e)) console.error(`[R2] download failed (${key}):`, e.message);
    return false;
  }
}

export async function deleteKey(key) {
  if (!enabled) return false;
  try {
    await client.send(new DeleteObjectCommand({ Bucket: R2_BUCKET, Key: key }));
    return true;
  } catch (e) {
    console.error(`[R2] delete failed (${key}):`, e.message);
    return false;
  }
}

async function listKeys(prefix) {
  const keys = [];
  let token;
  do {
    const out = await client.send(new ListObjectsV2Command({
      Bucket: R2_BUCKET, Prefix: prefix, ContinuationToken: token
    }));
    (out.Contents || []).forEach(o => keys.push(o.Key));
    token = out.IsTruncated ? out.NextContinuationToken : undefined;
  } while (token);
  return keys;
}

export async function getObjectStream(key, rangeHeader) {
  if (!enabled) return null;
  try {
    const out = await client.send(new GetObjectCommand({
      Bucket: R2_BUCKET, Key: key, Range: rangeHeader || undefined
    }));
    return {
      body: out.Body,
      contentLength: out.ContentLength,
      contentRange: out.ContentRange,
      partial: !!out.ContentRange
    };
  } catch (e) {
    if (!isMissing(e)) console.error(`[R2] getObjectStream failed (${key}):`, e.message);
    return null;
  }
}

// ----------------------------------------------------- durable JSON databases
let rootDir = process.cwd();
const dirty = new Set();
let flushTimer = null;

export function schedulePersist(name) {
  if (!enabled) return;
  dirty.add(name);
  if (flushTimer) return;
  flushTimer = setTimeout(() => { flushTimer = null; flushDirty().catch(() => {}); }, 10000);
}

export async function flushDirty() {
  if (!enabled) return;
  const names = [...dirty];
  dirty.clear();
  for (const name of names) {
    try {
      const p = path.join(rootDir, name);
      if (!fs.existsSync(p)) continue;
      await putBuffer(`data/${name}`, fs.readFileSync(p), 'application/json');
    } catch (e) {
      dirty.add(name);
      console.error(`[R2] persist failed (${name}):`, e.message);
    }
  }
}

// ------------------------------------------------- banner / announcement files
const ASSET_DIRS = {};
const knownAssets = new Map();
let assetTimer = null;

export function scheduleAssetSync() {
  if (!enabled || assetTimer) return;
  assetTimer = setTimeout(() => { assetTimer = null; syncAssetsUp().catch(() => {}); }, 6000);
}

const mimeFromName = (n) => {
  const e = path.extname(n).toLowerCase();
  return ({
    '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
    '.webp': 'image/webp', '.avif': 'image/avif', '.apng': 'image/apng',
    '.mp4': 'video/mp4', '.webm': 'video/webm'
  })[e] || 'application/octet-stream';
};

export async function syncAssetsUp() {
  if (!enabled) return;
  for (const [prefix, dir] of Object.entries(ASSET_DIRS)) {
    if (!fs.existsSync(dir)) continue;
    const localFiles = new Set(fs.readdirSync(dir).filter(n => {
      try { return fs.statSync(path.join(dir, n)).isFile(); } catch(e) { return false; }
    }));

    for (const name of localFiles) {
      const full = path.join(dir, name);
      const key = prefix + name;
      if (!knownAssets.has(key)) {
        if (await putFile(key, full, mimeFromName(name))) {
          knownAssets.set(key, true);
        }
      }
    }

    try {
      const remoteKeys = await listKeys(prefix);
      for (const remoteKey of remoteKeys) {
        const remoteName = remoteKey.slice(prefix.length);
        if (!remoteName) continue;
        if (!localFiles.has(remoteName)) {
          await deleteKey(remoteKey);
          knownAssets.delete(remoteKey);
          console.log(`[R2 Asset Sync] Deleted obsolete banner/announcement: ${remoteKey}`);
        }
      }
    } catch(e) {
      console.warn('[R2 Asset Sync] Error pruning remote assets:', e.message);
    }
  }
}

// ------------------------------------------------------------------ boot sync
export async function restoreOnBoot(root, { bannersDir, announcementsDir }) {
  rootDir = root;
  ASSET_DIRS['assets/banners/'] = bannersDir;
  ASSET_DIRS['assets/announcements/'] = announcementsDir;
  if (!enabled) {
    console.log('[R2] Disabled (R2_* env vars missing) - using local disk only.');
    return;
  }
  console.log('[R2] Enabled - restoring durable data from bucket:', R2_BUCKET);
  for (const name of DATA_FILES) {
    const dest = path.join(root, name);
    try {
      const out = await client.send(new GetObjectCommand({ Bucket: R2_BUCKET, Key: `data/${name}` }));
      const body = await out.Body.transformToString();
      fs.writeFileSync(dest, body);
      console.log(`[R2] restored ${name}`);
    } catch (e) {
      if (isMissing(e)) {
        if (fs.existsSync(dest)) {
          await putBuffer(`data/${name}`, fs.readFileSync(dest), 'application/json');
          console.log(`[R2] seeded ${name} from local`);
        }
      } else {
        console.error(`[R2] restore failed (${name}):`, e.message);
      }
    }
  }
  for (const [prefix, dir] of Object.entries(ASSET_DIRS)) {
    fs.mkdirSync(dir, { recursive: true });
    try {
      const keys = await listKeys(prefix);
      for (const key of keys) {
        const name = key.slice(prefix.length);
        if (!name) continue;
        const dest = path.join(dir, name);
        if (!fs.existsSync(dest)) await downloadToFile(key, dest);
        knownAssets.set(key, true);
      }
    } catch (e) {
      console.error(`[R2] asset restore failed (${prefix}):`, e.message);
    }
  }
  await syncAssetsUp();
}

// --------------------------------------------------------------- clip storage
export const clipKey = (item) => `clips/${item.filename}`;

export function getPublicClipUrl(item) {
  if (!enabled || !publicUrl || !item || !item.filename) return null;
  return `${publicUrl}/clips/${encodeURIComponent(item.filename)}`;
}

/**
 * Upload a freshly received clip to R2.
 * Once uploaded to R2, removes the temporary local file on Render so all clips
 * live and stream exclusively from R2.
 */
export async function storeNewClip(item, localPath) {
  if (!enabled) return false;
  const ok = await putFile(clipKey(item), localPath, item.mimetype);
  item.r2 = ok;
  if (ok) {
    try { fs.unlinkSync(localPath); } catch (_) {}
    item.local = false;
  } else {
    item.local = true;
  }
  return ok;
}

export async function removeClip(item) {
  if (!enabled || !item || !item.r2) return;
  await deleteKey(clipKey(item));
  item.r2 = false;
}

export async function streamClip(item, req, res, contentType) {
  const obj = await getObjectStream(clipKey(item), req.headers.range);
  if (!obj) return false;
  const headers = {
    'Content-Type': contentType,
    'Accept-Ranges': 'bytes',
    'Content-Length': obj.contentLength
  };
  if (obj.partial && obj.contentRange) {
    headers['Content-Range'] = obj.contentRange;
    res.writeHead(206, headers);
  } else {
    res.writeHead(200, headers);
  }
  obj.body.on('error', () => { try { res.destroy(); } catch (_) {} });
  obj.body.pipe(res);
  return true;
}

let tiering = Promise.resolve();

export function enforceTiering(getDb, uploadDir, saveDb) {
  if (!enabled) return Promise.resolve();
  tiering = tiering.then(() => runTiering(getDb(), uploadDir, saveDb)).catch(e => {
    console.error('[R2] tiering error:', e.message);
  });
  return tiering;
}

async function runTiering(db, uploadDir, saveDb) {
  const items = Object.values(db)
    .filter(i => i && i.r2 && i.filename && !i.publicExpired)
    .sort((a, b) => b.createdAt - a.createdAt);

  // Ensure local temp copies are cleaned up when stored in R2
  for (const it of items) {
    const p = path.join(uploadDir, it.filename);
    if (fs.existsSync(p)) {
      try { fs.unlinkSync(p); } catch (_) {}
    }
    it.local = false;
  }

  // If R2 exceeds MAX_BYTES, evict oldest clips cleanly
  let total = items.reduce((s, i) => s + (i.size || 0), 0);
  if (total > MAX_BYTES) {
    const oldestFirst = [...items].reverse();
    for (const it of oldestFirst) {
      if (total <= MAX_BYTES) break;
      if (await deleteKey(clipKey(it))) {
        it.r2 = false;
        it.publicExpired = true;
        total -= (it.size || 0);
        console.log(`[R2] Evicted oldest clip ${it.id} due to quota limit`);
      }
    }
  }
  saveDb();
}

export function reconcileLocalFlags(db, uploadDir) {
  for (const it of Object.values(db)) {
    if (!it || !it.filename) continue;
    const exists = fs.existsSync(path.join(uploadDir, it.filename));
    it.local = exists;
  }
}

export async function sweepExpiredR2Clips(activeValidFilenames) {
  if (!enabled) return 0;
  try {
    const keys = await listKeys('clips/');
    let purged = 0;
    for (const key of keys) {
      const fname = key.slice('clips/'.length);
      if (!fname) continue;
      if (!activeValidFilenames || !activeValidFilenames.has(fname)) {
        await deleteKey(key);
        purged++;
        console.log(`[R2 Garbage Collector] Purged expired/orphaned clip: ${key}`);
      }
    }
    return purged;
  } catch (e) {
    console.error('[R2 Garbage Collector] Sweep failed:', e.message);
    return 0;
  }
}
