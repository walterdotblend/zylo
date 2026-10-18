import express from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { nanoid } from 'nanoid';
import { UPLOAD_DIR, getBaseUrl } from '../config/constants.js';
import {
  mediaDb,
  bannersDb,
  announcementData,
  statsDb,
  saveDb,
  saveBannersDb,
  saveStatsDb,
  recordVisit,
  selectWeightedBanner,
  getClientCountry,
  getClientLanguage
} from '../db/store.js';
import {
  parseClientDetails,
  validateMediaMagicBytes,
  checkUploadRateLimit,
  resolveSilentUserTier
} from '../middleware/security.js';
import * as r2 from '../services/r2.js';
import {
  registerDiscordSession,
  isDiscordSessionConsumed,
  getDiscordSession,
  notifyDiscordClipUploaded
} from '../services/discord.js';
import {
  handleTopggWebhook,
  getVoterTierStatus,
  consumeVoterCredit
} from '../services/topgg.js';

const router = express.Router();

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, UPLOAD_DIR);
  },
  filename: (req, file, cb) => {
    let ext = path.extname(file.originalname);
    if (!ext || ext === '') {
      if (file.mimetype && file.mimetype.includes('mp4')) ext = '.mp4';
      else if (file.mimetype && file.mimetype.includes('png')) ext = '.png';
      else ext = '.webm';
    }
    const uniqueName = `${nanoid(10)}${ext}`;
    cb(null, uniqueName);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: 150 * 1024 * 1024 } // 150 MB limit
});

// Health / Keep-Awake Ping
router.get('/api/ping', (req, res) => res.send('pong'));

// Visit Analytics
router.post('/api/stats/visit', (req, res) => {
  const type = req.body.type || 'unknown';
  const isNew = req.body.isNew === true || req.body.isNew === 'true';
  recordVisit(type, req, isNew);
  res.json({ ok: true });
});

router.post('/api/stats/track-watch', (req, res) => {
  const secs = Math.min(30, Math.max(1, parseInt(req.body.seconds, 10) || 5));
  statsDb.playerWatchTimeSecondsTotal = (statsDb.playerWatchTimeSecondsTotal || 0) + secs;
  saveStatsDb();
  res.json({ success: true, totalWatchSecs: statsDb.playerWatchTimeSecondsTotal });
});

// System Announcement Public Endpoint
router.get('/api/announcement', (req, res) => {
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  if (!announcementData || !announcementData.active) {
    return res.json({ active: false });
  }
  const lang = (req.query.lang || 'en').toLowerCase();
  const tr = (announcementData.translations && announcementData.translations[lang]) || {};
  return res.json({
    active: true,
    id: announcementData.id,
    title: tr.title || announcementData.title,
    message: tr.message || announcementData.message,
    mediaUrl: announcementData.mediaUrl,
    mediaType: announcementData.mediaType,
    actionText: tr.actionText || announcementData.actionText,
    actionUrl: announcementData.actionUrl,
    createdAt: announcementData.createdAt
  });
});

// First-Party AdBlock-Proof Banners
router.get('/api/banners/:slot', (req, res) => {
  const slot = req.params.slot;
  const lang = getClientLanguage(req);
  const country = getClientCountry(req);

  const banner = selectWeightedBanner(slot, lang);
  if (!banner) {
    return res.json({ found: false });
  }

  let activeMediaUrl = banner.mediaUrl;
  let activeMediaType = banner.mediaType || (banner.mediaUrl.match(/\.(mp4|webm)($|\?)/i) ? 'video' : 'image');

  if (banner.mediaVariants && banner.mediaVariants[lang]) {
    activeMediaUrl = banner.mediaVariants[lang];
    activeMediaType = activeMediaUrl.match(/\.(mp4|webm)($|\?)/i) ? 'video' : 'image';
  }

  banner.impressions = (banner.impressions || 0) + 1;
  statsDb.bannerImpressionsTotal = (statsDb.bannerImpressionsTotal || 0) + 1;

  if (!banner.geoStats) banner.geoStats = { countries: {}, languages: {} };
  if (!banner.geoStats.countries) banner.geoStats.countries = {};
  if (!banner.geoStats.languages) banner.geoStats.languages = {};

  banner.geoStats.countries[country] = banner.geoStats.countries[country] || { impressions: 0, clicks: 0 };
  banner.geoStats.countries[country].impressions++;

  banner.geoStats.languages[lang] = banner.geoStats.languages[lang] || { impressions: 0, clicks: 0 };
  banner.geoStats.languages[lang].impressions++;

  if (!statsDb.countryBreakdown) statsDb.countryBreakdown = {};
  statsDb.countryBreakdown[country] = (statsDb.countryBreakdown[country] || 0) + 1;

  if (!statsDb.languageBreakdown) statsDb.languageBreakdown = {};
  statsDb.languageBreakdown[lang] = (statsDb.languageBreakdown[lang] || 0) + 1;

  saveBannersDb();
  saveStatsDb();

  res.json({
    found: true,
    id: banner.id,
    slot: banner.slot,
    name: banner.name,
    mediaUrl: activeMediaUrl,
    mediaType: activeMediaType,
    targetUrl: banner.targetUrl,
    languages: banner.languages || ['all'],
    mediaVariants: banner.mediaVariants || {},
    clickUrl: `/api/banner-click/${banner.id}?lang=${encodeURIComponent(lang)}`
  });
});

router.get('/api/banner-click/:id', (req, res) => {
  const banner = bannersDb.find(b => b.id === req.params.id);
  if (!banner) return res.redirect('/');

  const lang = getClientLanguage(req);
  const country = getClientCountry(req);

  banner.clicks = (banner.clicks || 0) + 1;
  statsDb.bannerClicksTotal = (statsDb.bannerClicksTotal || 0) + 1;

  if (!banner.geoStats) banner.geoStats = { countries: {}, languages: {} };
  if (!banner.geoStats.countries) banner.geoStats.countries = {};
  if (!banner.geoStats.languages) banner.geoStats.languages = {};

  banner.geoStats.countries[country] = banner.geoStats.countries[country] || { impressions: 0, clicks: 0 };
  banner.geoStats.countries[country].clicks++;

  banner.geoStats.languages[lang] = banner.geoStats.languages[lang] || { impressions: 0, clicks: 0 };
  banner.geoStats.languages[lang].clicks++;

  saveBannersDb();
  saveStatsDb();

  const target = banner.targetUrl && (banner.targetUrl.startsWith('http://') || banner.targetUrl.startsWith('https://') || banner.targetUrl.startsWith('/'))
    ? banner.targetUrl
    : '/';
  res.redirect(302, target);
});

// Silent Tier Engine Endpoints (Active in backend, hidden in UI until launch)
router.post('/api/webhooks/topgg', handleTopggWebhook);

router.get('/api/tiers/status', (req, res) => {
  const discordUserId = req.query.discordUserId || '';
  const tier = resolveSilentUserTier(req, getVoterTierStatus);
  const voterStatus = discordUserId ? getVoterTierStatus(discordUserId) : { active: false, creditsRemaining: 0, expiresAt: 0 };
  res.json({
    tier: tier.id,
    limits: {
      maxFileSizeBytes: tier.maxFileSizeBytes,
      maxDurationSec: tier.maxDurationSec,
      maxFps: tier.maxFps,
      maxWidth: tier.maxWidth,
      ttlHours: tier.ttlHours
    },
    voter: voterStatus
  });
});

// Upload Endpoint (100% Client-Encoded -> Validated -> Direct to Cloudflare R2)
router.post('/api/upload', (req, res, next) => {
  const rateCheck = checkUploadRateLimit(req);
  if (!rateCheck.allowed) {
    return res.status(429).json({
      error: `Upload rate limit exceeded. Try again in ${rateCheck.retryAfterSec}s.`
    });
  }
  upload.single('media')(req, res, (err) => {
    if (err) {
      if (err.code === 'LIMIT_FILE_SIZE' || err.message?.includes('File too large')) {
        return res.status(413).json({ error: 'File exceeds the maximum allowed size limit (150 MB).' });
      }
      return res.status(400).json({ error: 'Upload error: ' + err.message });
    }
    next();
  });
}, async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No media file uploaded' });
  }

  const localFilePath = path.join(UPLOAD_DIR, req.file.filename);

  // Security Gate: O(1) Magic-Byte Header Inspection
  const magicCheck = validateMediaMagicBytes(localFilePath);
  if (!magicCheck.valid) {
    try { fs.unlinkSync(localFilePath); } catch (_) {}
    return res.status(400).json({ error: magicCheck.reason || 'Invalid media file header' });
  }

  // Silent Tier Resolution
  const userTier = resolveSilentUserTier(req, getVoterTierStatus);
  if (req.file.size > userTier.maxFileSizeBytes) {
    try { fs.unlinkSync(localFilePath); } catch (_) {}
    return res.status(413).json({ error: `File size exceeds your tier limit (${Math.round(userTier.maxFileSizeBytes / (1024 * 1024))} MB).` });
  }

  // Prevent overwriting existing clip IDs
  const requestedId = (req.body.customMediaId && /^[a-zA-Z0-9_-]{5,20}$/.test(req.body.customMediaId))
    ? req.body.customMediaId
    : null;
  const mediaId = (requestedId && !mediaDb[requestedId]) ? requestedId : nanoid(7);

  const adminSecret = (req.body.creatorKey && /^[a-zA-Z0-9_-]{8,30}$/.test(req.body.creatorKey))
    ? req.body.creatorKey
    : nanoid(12);

  const ttlHours = userTier.ttlHours || 6;
  const now = Date.now();
  const expiresAt = now + (ttlHours * 60 * 60 * 1000);

  const filename = req.file.filename;
  const fileSize = req.file.size;
  let mimetype = req.file.mimetype;

  const lowerName = (req.file.originalname || '').toLowerCase();
  const lowerFile = filename.toLowerCase();

  if (lowerFile.endsWith('.webm') || lowerName.endsWith('.webm')) {
    mimetype = 'video/webm';
  } else if (lowerFile.endsWith('.mp4') || lowerName.endsWith('.mp4')) {
    mimetype = 'video/mp4';
  } else if (lowerFile.endsWith('.png') || lowerName.endsWith('.png')) {
    mimetype = 'image/png';
  } else if (lowerFile.endsWith('.jpg') || lowerFile.endsWith('.jpeg') || lowerName.endsWith('.jpg') || lowerName.endsWith('.jpeg')) {
    mimetype = 'image/jpeg';
  } else if (!mimetype || mimetype === 'application/octet-stream' || mimetype === 'text/plain') {
    mimetype = magicCheck.detectedMime || 'video/webm';
  }

  const privacyActive = req.body.privacyActive === 'true' || req.body.privacyActive === true;

  let maxViews = 0;
  if (req.body.maxViews !== undefined && req.body.maxViews !== '') {
    maxViews = parseInt(req.body.maxViews, 10);
    if (isNaN(maxViews) || maxViews < 0) maxViews = 0;
  } else if (privacyActive) {
    maxViews = 2;
  }

  const mobileOnly = req.body.mobileOnly === 'true' || req.body.mobileOnly === true;
  const singleViewPerDevice = req.body.singleViewPerDevice === 'true' || req.body.singleViewPerDevice === true;
  const uniqueDevicesOnly = req.body.uniqueDevicesOnly === 'true' || req.body.uniqueDevicesOnly === true;
  const lockDevice = req.body.lockDevice === 'true' || req.body.lockDevice === true;
  const singlePlayPerVisit = req.body.singlePlayPerVisit === 'true' || req.body.singlePlayPerVisit === true;
  const watermarkEnabled = (req.body.watermarkEnabled === 'true' || req.body.watermarkEnabled === true);
  const watermarkMoving = req.body.watermarkMoving === 'true' || req.body.watermarkMoving === true;
  const watermarkIncludeCustom = req.body.watermarkIncludeCustom !== 'false' && req.body.watermarkIncludeCustom !== false;
  const watermarkIncludeIp = req.body.watermarkIncludeIp !== 'false' && req.body.watermarkIncludeIp !== false;
  const watermarkIncludeDevice = req.body.watermarkIncludeDevice !== 'false' && req.body.watermarkIncludeDevice !== false;
  const customWatermarkText = (req.body.customWatermarkText || '').trim();

  const rawUploaderIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress || '127.0.0.1';
  const uploaderUserAgent = req.headers['user-agent'] || '';
  const uploaderDetails = parseClientDetails(uploaderUserAgent, rawUploaderIp);

  const fileData = {
    id: mediaId,
    adminSecret,
    filename,
    originalName: req.file.originalname,
    mimetype,
    size: fileSize,
    tier: userTier.id,
    createdAt: now,
    expiresAt,
    views: 0,
    publicExpired: false,
    uploader: {
      ip: uploaderDetails.ip,
      os: uploaderDetails.os,
      browser: uploaderDetails.browser,
      deviceType: uploaderDetails.deviceType,
      deviceName: uploaderDetails.deviceName,
      userAgent: uploaderUserAgent,
      uploadDate: new Date(now).toLocaleString()
    },
    viewsLog: [],
    privacy: {
      active: privacyActive,
      maxViews,
      singleViewPerDevice,
      uniqueDevicesOnly,
      lockDevice,
      singlePlayPerVisit,
      activeSessionId: null,
      seenDevices: [],
      mobileOnly,
      noDownload: privacyActive,
      blockEmbed: privacyActive,
      netflixShield: privacyActive,
      watermarkEnabled,
      watermarkMoving,
      watermarkIncludeCustom,
      watermarkIncludeIp,
      watermarkIncludeDevice,
      customWatermarkText,
      boundDeviceId: null,
      boundIp: null
    }
  };

  const discordSessionId = (req.body.discordSession || '').trim();
  if (discordSessionId) {
    const dSession = getDiscordSession(discordSessionId);
    if (dSession) {
      fileData.discordUserId = dSession.userId;
      fileData.discordChannelId = dSession.channelId;
    }
  }

  // If voter tier credit used, consume 1 credit
  if (userTier.id === 'voter' && (fileData.discordUserId || req.body.discordUserId)) {
    consumeVoterCredit(fileData.discordUserId || req.body.discordUserId);
  }

  // Upload to Cloudflare R2 and remove local file once uploaded so Render disk stays at 0 MB
  if (r2.enabled) {
    await r2.storeNewClip(fileData, localFilePath);
  }

  const clipDuration = parseFloat(req.body.clipDuration) || parseFloat(req.body.duration) || 0;
  if (clipDuration > 0) {
    fileData.duration = clipDuration;
    statsDb.clipsDurationSecondsTotal = (statsDb.clipsDurationSecondsTotal || 0) + clipDuration;
  }
  const clipWidth = parseInt(req.body.clipWidth, 10);
  const clipHeight = parseInt(req.body.clipHeight, 10);
  if (!isNaN(clipWidth) && clipWidth > 0) fileData.width = clipWidth;
  if (!isNaN(clipHeight) && clipHeight > 0) fileData.height = clipHeight;

  mediaDb[mediaId] = fileData;
  saveDb();

  if (!Array.isArray(statsDb.clipsLog)) statsDb.clipsLog = [];
  statsDb.clipsLog.push({
    t: Date.now(),
    dur: clipDuration,
    privacy: privacyActive
  });
  if (statsDb.clipsLog.length > 5000) {
    statsDb.clipsLog = statsDb.clipsLog.slice(-5000);
  }
  saveStatsDb();

  const baseUrl = getBaseUrl(req);
  const shareUrl = `${baseUrl}/v/${mediaId}`;
  const creatorUrl = `${baseUrl}/v/${mediaId}?key=${adminSecret}`;
  const rawUrl = `${baseUrl}/raw/${mediaId}`;

  if (discordSessionId) {
    notifyDiscordClipUploaded(discordSessionId, fileData, baseUrl)
      .then(r => console.log(`[Discord Bot] Auto-post result for clip ${mediaId}: ${r}`))
      .catch(err => console.error(`[Discord Bot] Auto-post error for clip ${mediaId}:`, err.message));
  }

  res.json({
    success: true,
    id: mediaId,
    shareUrl,
    creatorUrl,
    isPrivacyActive: privacyActive,
    rawUrl,
    expiresAt: new Date(expiresAt).toISOString(),
    ttlHours,
    discordLinked: !!discordSessionId
  });
});

// Discord Bot Recording Sessions Endpoints
router.post('/api/discord/session', (req, res) => {
  const sessionId = registerDiscordSession(req.body);
  res.json({ success: true, sessionId });
});

router.get('/api/discord/session/:id', (req, res) => {
  const sessionId = req.params.id;
  if (isDiscordSessionConsumed(sessionId)) {
    return res.status(410).json({ error: 'This recording session token has already been used.', used: true });
  }
  const session = getDiscordSession(sessionId);
  if (!session) return res.status(404).json({ error: 'Session not found or expired' });
  res.json({ session });
});

// Real Network SpeedTest & Ping Endpoints
router.post('/api/speedtest', (req, res) => {
  let bytesReceived = 0;
  req.on('data', chunk => {
    bytesReceived += chunk.length;
  });
  req.on('end', () => {
    res.json({ success: true, bytesReceived, timestamp: Date.now() });
  });
});

router.get('/api/speedtest/ping', (req, res) => {
  res.json({ pong: Date.now() });
});

export default router;
