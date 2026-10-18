import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import path from 'path';
import fs from 'fs';
import cron from 'node-cron';

import {
  PUBLIC_DIR,
  UPLOAD_DIR,
  BANNERS_UPLOAD_DIR,
  ANNOUNCEMENTS_UPLOAD_DIR,
  PORT,
  PUBLIC_URL,
  BASE_URL,
  ADMIN_SECRET_PATH
} from './src/config/constants.js';
import * as r2 from './src/services/r2.js';
import {
  mediaDb,
  loadAllDatabases,
  saveDb,
  deleteMediaItem,
  recordVisit
} from './src/db/store.js';
import { loadVotersDb } from './src/services/topgg.js';
import { initDiscordBot } from './src/services/discord.js';
import apiRouter from './src/routes/api.js';
import playerRouter from './src/routes/player.js';
import adminRouter from './src/routes/admin.js';

// Restore persistent JSON files + banner/announcement media from Cloudflare R2 before loading DBs
await r2.restoreOnBoot();
loadAllDatabases();
loadVotersDb();

const app = express();
app.set('trust proxy', true);

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use('/uploads/banners', express.static(BANNERS_UPLOAD_DIR));
app.use('/uploads/announcements', express.static(ANNOUNCEMENTS_UPLOAD_DIR));
app.use(express.static(PUBLIC_DIR, {
  index: false,
  setHeaders: (res) => {
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
  }
}));

// Main Studio & Mobile WebApp Entrypoints
app.get('/', (req, res) => {
  recordVisit('studio', req);
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
});

app.get('/app', (req, res) => {
  recordVisit('webapp', req);
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  res.sendFile(path.join(PUBLIC_DIR, 'app.html'));
});

// Mount Modular Routers
app.use(apiRouter);
app.use(playerRouter);
app.use(adminRouter);

// Initialize Discord Bot Service with guaranteed public domain for Discord links
initDiscordBot(mediaDb, deleteMediaItem, PUBLIC_URL);

// Keep-awake self-ping (Render anti-sleep)
setInterval(() => {
  if (PUBLIC_URL && PUBLIC_URL.startsWith('http')) {
    fetch(PUBLIC_URL + '/api/ping').catch(() => {});
  }
}, 10 * 60 * 1000);

// Ephemeral 6-Hour Clip Auto-Destruction Cron (Deletes from R2 & local disk)
cron.schedule('*/10 * * * *', () => {
  const now = Date.now();
  let deletedCount = 0;

  for (const [, item] of Object.entries(mediaDb)) {
    if (now >= item.expiresAt && !item.publicExpired) {
      item.publicExpired = true;
      deletedCount++;
      const filePath = path.join(UPLOAD_DIR, item.filename);
      if (fs.existsSync(filePath)) {
        try { fs.unlinkSync(filePath); } catch (e) {}
      }
      item.local = false;
      r2.removeClip(item).catch(() => {});
    }
  }

  if (deletedCount > 0) {
    saveDb();
    console.log(`[Cleaner] Purged and freed ${deletedCount} expired clip(s) from R2 & disk.`);
  }
});

// Flush pending durable writes to R2 before Render stops the instance
for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, async () => {
    try {
      await r2.flushDirty();
      await r2.syncAssetsUp();
    } catch (e) {}
    process.exit(0);
  });
}

app.listen(PORT, () => {
  console.log(`🚀 Zylo Studio & Shared Viewer active at ${BASE_URL}`);
  console.log(`☁️ Cloudflare R2 Direct Delivery: ${r2.enabled ? 'ENABLED (Zero Render Bandwidth)' : 'DISABLED (Local fallback)'}`);
  console.log(`🔒 Secret Admin Console active at: ${BASE_URL}/${ADMIN_SECRET_PATH}`);
  if (r2.enabled) {
    r2.reconcileLocalFlags(mediaDb, UPLOAD_DIR);
  }
});
