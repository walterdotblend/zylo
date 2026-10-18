// ============================================================================
// Zylo — Unified Database Store & Analytics Engine
// ============================================================================
import fs from 'fs';
import path from 'path';
import geoip from 'geoip-lite';
import * as r2 from '../services/r2.js';
import {
  UPLOAD_DIR, BANNERS_UPLOAD_DIR, ANNOUNCEMENTS_UPLOAD_DIR,
  DB_FILE, BANNERS_DB_FILE, STATS_DB_FILE, ANNOUNCEMENTS_DB_FILE, QUOTA_CONFIG_FILE
} from '../config/constants.js';
import { parseClientDetails } from '../middleware/security.js';

// Ensure upload directories exist
for (const dir of [UPLOAD_DIR, BANNERS_UPLOAD_DIR, ANNOUNCEMENTS_UPLOAD_DIR]) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

export const mediaDb = {};
export const bannersDb = [];
export const quotaConfig = {
  all: 100, en: 100, es: 100, pt: 100, fr: 100, de: 100, ja: 100
};
export const announcementData = {
  id: '',
  title: '',
  message: '',
  mediaUrl: '',
  mediaType: null,
  actionText: '',
  actionUrl: '',
  active: false,
  createdAt: null,
  translations: {}
};
export const statsDb = {
  studioVisits: 0,
  viewerVisits: 0,
  webappVisits: 0,
  newUsersTotal: 0,
  clipsCreatedTotal: 0,
  clipsDurationSecondsTotal: 0,
  playerWatchTimeSecondsTotal: 0,
  bannerImpressionsTotal: 0,
  bannerClicksTotal: 0,
  privacyClipsTotal: 0,
  deviceBreakdown: { desktop: 0, mobile: 0, tablet: 0 },
  browserBreakdown: { chrome: 0, firefox: 0, edge: 0, safari: 0, opera: 0, discord: 0, other: 0 },
  countryBreakdown: {},
  languageBreakdown: {},
  visitsLog: [],
  clipsLog: [],
  lastResetAt: null
};

export function loadAllDatabases() {
  if (fs.existsSync(DB_FILE)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(DB_FILE, 'utf-8'));
      for (const k of Object.keys(mediaDb)) delete mediaDb[k];
      Object.assign(mediaDb, parsed);
    } catch (e) {}
  }

  if (fs.existsSync(BANNERS_DB_FILE)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(BANNERS_DB_FILE, 'utf-8'));
      if (Array.isArray(parsed)) {
        bannersDb.length = 0;
        bannersDb.push(...parsed);
      }
    } catch (e) {}
  }

  if (fs.existsSync(QUOTA_CONFIG_FILE)) {
    try {
      Object.assign(quotaConfig, JSON.parse(fs.readFileSync(QUOTA_CONFIG_FILE, 'utf-8')));
    } catch (e) {}
  }

  if (fs.existsSync(ANNOUNCEMENTS_DB_FILE)) {
    try {
      Object.assign(announcementData, JSON.parse(fs.readFileSync(ANNOUNCEMENTS_DB_FILE, 'utf-8')));
    } catch (e) {}
  }

  if (fs.existsSync(STATS_DB_FILE)) {
    try {
      Object.assign(statsDb, JSON.parse(fs.readFileSync(STATS_DB_FILE, 'utf-8')));
    } catch (e) {}
  }
  if (!Array.isArray(statsDb.visitsLog)) statsDb.visitsLog = [];
  if (!Array.isArray(statsDb.clipsLog)) statsDb.clipsLog = [];
}

export function saveDb() {
  try { fs.writeFileSync(DB_FILE, JSON.stringify(mediaDb, null, 2)); } catch (e) {}
  r2.schedulePersist('media_db.json');
}

export function saveBannersDb() {
  try { fs.writeFileSync(BANNERS_DB_FILE, JSON.stringify(bannersDb, null, 2)); } catch (e) {}
  r2.schedulePersist('banners_db.json');
  r2.scheduleAssetSync();
}

export function saveQuotaConfig() {
  try { fs.writeFileSync(QUOTA_CONFIG_FILE, JSON.stringify(quotaConfig, null, 2)); } catch (e) {}
  r2.schedulePersist('quota_config.json');
}

export function saveAnnouncementDb() {
  try { fs.writeFileSync(ANNOUNCEMENTS_DB_FILE, JSON.stringify(announcementData, null, 2)); } catch (e) {}
  r2.schedulePersist('announcements_db.json');
  r2.scheduleAssetSync();
}

export function saveStatsDb() {
  try { fs.writeFileSync(STATS_DB_FILE, JSON.stringify(statsDb, null, 2)); } catch (e) {}
  r2.schedulePersist('stats_db.json');
}

export function loadBannersDb() {
  if (fs.existsSync(BANNERS_DB_FILE)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(BANNERS_DB_FILE, 'utf-8'));
      if (Array.isArray(parsed)) {
        bannersDb.length = 0;
        bannersDb.push(...parsed);
      }
    } catch (e) {}
  }
}

export function setAnnouncementData(newData) {
  for (const k of Object.keys(announcementData)) delete announcementData[k];
  Object.assign(announcementData, newData);
  saveAnnouncementDb();
}

export function replaceStatsAndBanners(data) {
  if (data.statsDb && typeof data.statsDb === 'object') {
    Object.assign(statsDb, data.statsDb);
    saveStatsDb();
  }
  if (Array.isArray(data.bannersDb)) {
    bannersDb.length = 0;
    bannersDb.push(...data.bannersDb);
    saveBannersDb();
  }
}

export function resetAllStores() {
  for (const k of Object.keys(mediaDb)) delete mediaDb[k];
  saveDb();
  Object.assign(statsDb, {
    studioVisits: 0,
    viewerVisits: 0,
    webappVisits: 0,
    newUsersTotal: 0,
    clipsCreatedTotal: 0,
    clipsDurationSecondsTotal: 0,
    playerWatchTimeSecondsTotal: 0,
    bannerImpressionsTotal: 0,
    bannerClicksTotal: 0,
    privacyClipsTotal: 0,
    deviceBreakdown: { desktop: 0, mobile: 0, tablet: 0 },
    browserBreakdown: { chrome: 0, firefox: 0, edge: 0, safari: 0, opera: 0, discord: 0, other: 0 },
    countryBreakdown: {},
    languageBreakdown: {},
    visitsLog: [],
    clipsLog: [],
    lastResetAt: Date.now()
  });
  saveStatsDb();
  bannersDb.forEach(b => {
    b.impressions = 0;
    b.clicks = 0;
  });
  saveBannersDb();
}

export function deleteMediaItem(mediaId) {
  if (mediaDb[mediaId]) {
    const item = mediaDb[mediaId];
    item.publicExpired = true;
    const filePath = path.join(UPLOAD_DIR, item.filename);
    if (fs.existsSync(filePath)) {
      try { fs.unlinkSync(filePath); } catch (e) {}
    }
    r2.removeClip(item).catch(() => {});
    delete mediaDb[mediaId];
    saveDb();
    return true;
  }
  return false;
}

export function getDiskUsage() {
  let totalBytes = 0;
  let fileCount = 0;
  function scanDir(dir) {
    if (!fs.existsSync(dir)) return;
    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const ent of entries) {
        const full = path.join(dir, ent.name);
        if (ent.isDirectory()) {
          scanDir(full);
        } else if (ent.isFile()) {
          try {
            totalBytes += fs.statSync(full).size;
            fileCount++;
          } catch (e) {}
        }
      }
    } catch (e) {}
  }
  scanDir(UPLOAD_DIR);
  // Also include active R2 clips size in reported storage
  for (const it of Object.values(mediaDb)) {
    if (it && it.r2 && !it.local && it.size) {
      totalBytes += it.size;
      fileCount++;
    }
  }
  return {
    bytes: totalBytes,
    mb: (totalBytes / (1024 * 1024)).toFixed(1),
    gb: (totalBytes / (1024 * 1024 * 1024)).toFixed(2),
    files: fileCount
  };
}

export function getFilteredStats(period = 'all') {
  const now = Date.now();
  let threshold = 0;
  if (period === 'today') {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    threshold = d.getTime();
  } else if (period === '24h') {
    threshold = now - 24 * 3600 * 1000;
  } else if (period === '7d') {
    threshold = now - 7 * 24 * 3600 * 1000;
  } else if (period === '30d') {
    threshold = now - 30 * 24 * 3600 * 1000;
  }

  const disk = getDiskUsage();

  if (threshold === 0) {
    return {
      period: 'all',
      studioVisits: statsDb.studioVisits || 0,
      viewerVisits: statsDb.viewerVisits || 0,
      webappVisits: statsDb.webappVisits || 0,
      newUsersTotal: statsDb.newUsersTotal || 0,
      clipsCreatedTotal: statsDb.clipsCreatedTotal || 0,
      clipsDurationSecondsTotal: statsDb.clipsDurationSecondsTotal || 0,
      playerWatchTimeSecondsTotal: statsDb.playerWatchTimeSecondsTotal || 0,
      bannerImpressionsTotal: statsDb.bannerImpressionsTotal || 0,
      bannerClicksTotal: statsDb.bannerClicksTotal || 0,
      privacyClipsTotal: statsDb.privacyClipsTotal || 0,
      deviceBreakdown: statsDb.deviceBreakdown || { desktop: 0, mobile: 0, tablet: 0 },
      browserBreakdown: statsDb.browserBreakdown || { chrome: 0, firefox: 0, edge: 0, safari: 0, opera: 0, discord: 0, other: 0 },
      countryBreakdown: statsDb.countryBreakdown || {},
      languageBreakdown: statsDb.languageBreakdown || {},
      diskUsage: disk
    };
  }

  const visits = (statsDb.visitsLog || []).filter(v => v.t >= threshold);
  const clips = (statsDb.clipsLog || []).filter(c => c.t >= threshold);

  const res = {
    period,
    studioVisits: visits.filter(v => v.type === 'studio').length,
    viewerVisits: visits.filter(v => v.type === 'viewer').length,
    webappVisits: visits.filter(v => v.type === 'webapp').length,
    newUsersTotal: visits.filter(v => v.isNew).length,
    clipsCreatedTotal: clips.length,
    clipsDurationSecondsTotal: clips.reduce((sum, c) => sum + (c.dur || 0), 0),
    playerWatchTimeSecondsTotal: statsDb.playerWatchTimeSecondsTotal || 0,
    bannerImpressionsTotal: statsDb.bannerImpressionsTotal || 0,
    bannerClicksTotal: statsDb.bannerClicksTotal || 0,
    privacyClipsTotal: clips.filter(c => c.privacy).length,
    deviceBreakdown: { desktop: 0, mobile: 0, tablet: 0 },
    browserBreakdown: { chrome: 0, firefox: 0, edge: 0, safari: 0, opera: 0, discord: 0, other: 0 },
    countryBreakdown: {},
    languageBreakdown: {},
    diskUsage: disk
  };

  visits.forEach(v => {
    const d = (v.dev || '').toLowerCase();
    if (d.includes('móvil') || d.includes('movil') || d.includes('mobile')) res.deviceBreakdown.mobile++;
    else if (d.includes('tablet')) res.deviceBreakdown.tablet++;
    else res.deviceBreakdown.desktop++;

    const b = (v.br || '').toLowerCase();
    if (b.includes('chrome')) res.browserBreakdown.chrome++;
    else if (b.includes('firefox')) res.browserBreakdown.firefox++;
    else if (b.includes('edge')) res.browserBreakdown.edge++;
    else if (b.includes('safari')) res.browserBreakdown.safari++;
    else if (b.includes('opera')) res.browserBreakdown.opera++;
    else if (b.includes('discord')) res.browserBreakdown.discord++;
    else res.browserBreakdown.other++;

    if (v.country) res.countryBreakdown[v.country] = (res.countryBreakdown[v.country] || 0) + 1;
    if (v.lang) res.languageBreakdown[v.lang] = (res.languageBreakdown[v.lang] || 0) + 1;
  });

  return res;
}

export function getClientCountry(req) {
  if (!req) return 'UNKNOWN';
  const cfCountry = req.headers['cf-ipcountry'] || req.headers['x-country-code'];
  if (cfCountry && cfCountry !== 'XX' && cfCountry !== 'T1') {
    return cfCountry.toUpperCase();
  }
  let ip = req.headers['x-forwarded-for'] || req.socket?.remoteAddress || req.ip || '';
  if (typeof ip === 'string') {
    ip = ip.split(',')[0].trim();
  }
  ip = ip.replace(/^.*:/, '');
  if (!ip || ip === '127.0.0.1' || ip === 'localhost' || ip === '::1' || ip.startsWith('192.168.') || ip.startsWith('10.') || ip.startsWith('172.16.')) {
    return 'LOCAL';
  }
  try {
    const geo = geoip.lookup(ip);
    return geo?.country || 'UNKNOWN';
  } catch (e) {
    return 'UNKNOWN';
  }
}

export function getClientLanguage(req) {
  if (!req) return 'en';
  if (req.query && req.query.lang) {
    const l = req.query.lang.toLowerCase().split('-')[0].trim();
    if (l) return l;
  }
  if (req.headers && req.headers.cookie) {
    const match = req.headers.cookie.match(/(?:zylo_lang|mogi_lang|mbp_lang)=([a-z]{2})/i);
    if (match && match[1]) return match[1].toLowerCase();
  }
  const acceptLang = req.headers && req.headers['accept-language'];
  if (acceptLang) {
    const first = acceptLang.split(',')[0].trim().split(';')[0].trim().split('-')[0].toLowerCase();
    if (first && first.length === 2) return first;
  }
  return 'en';
}

const swrrCurrentWeights = {};

export function selectWeightedBanner(slot, lang = 'all') {
  const normLang = (lang || 'all').toLowerCase().split('-')[0].trim();
  const activeBanners = bannersDb.filter(b => {
    if (b.slot !== slot || b.active === false) return false;
    const langs = Array.isArray(b.languages) && b.languages.length > 0 ? b.languages : ['all'];
    if (langs.includes('all')) return true;
    return langs.includes(normLang);
  });
  if (activeBanners.length === 0) return null;
  if (activeBanners.length === 1) return activeBanners[0];

  const totalWeight = activeBanners.reduce((sum, b) => sum + Math.max(1, parseInt(b.weight, 10) || 1), 0);

  let bestBanner = null;
  let maxWeight = -Infinity;

  for (const b of activeBanners) {
    const effectiveWeight = Math.max(1, parseInt(b.weight, 10) || 1);
    swrrCurrentWeights[b.id] = (swrrCurrentWeights[b.id] || 0) + effectiveWeight;
    if (swrrCurrentWeights[b.id] > maxWeight) {
      maxWeight = swrrCurrentWeights[b.id];
      bestBanner = b;
    }
  }

  if (bestBanner) {
    swrrCurrentWeights[bestBanner.id] -= totalWeight;
    return bestBanner;
  }
  return activeBanners[0];
}

export function recordVisit(type, req, isNewUser = false) {
  const ua = req.headers['user-agent'] || '';
  if (/bot|crawler|spider|facebookexternalhit/i.test(ua)) return;
  const rawIp = req.headers['x-forwarded-for'] || req.socket?.remoteAddress || '';
  const details = parseClientDetails(ua, rawIp);

  if (type === 'studio') statsDb.studioVisits = (statsDb.studioVisits || 0) + 1;
  else if (type === 'viewer') statsDb.viewerVisits = (statsDb.viewerVisits || 0) + 1;
  else if (type === 'webapp') statsDb.webappVisits = (statsDb.webappVisits || 0) + 1;

  if (isNewUser) {
    statsDb.newUsersTotal = (statsDb.newUsersTotal || 0) + 1;
  }

  if (!statsDb.deviceBreakdown) statsDb.deviceBreakdown = { desktop: 0, mobile: 0, tablet: 0 };
  const dev = (details.deviceType || '').toLowerCase();
  if (dev === 'móvil' || dev === 'movil') statsDb.deviceBreakdown.mobile = (statsDb.deviceBreakdown.mobile || 0) + 1;
  else if (dev === 'tablet') statsDb.deviceBreakdown.tablet = (statsDb.deviceBreakdown.tablet || 0) + 1;
  else statsDb.deviceBreakdown.desktop = (statsDb.deviceBreakdown.desktop || 0) + 1;

  if (!statsDb.browserBreakdown) statsDb.browserBreakdown = { chrome: 0, firefox: 0, edge: 0, safari: 0, opera: 0, discord: 0, other: 0 };
  const br = (details.browser || '').toLowerCase();
  if (br.includes('chrome')) statsDb.browserBreakdown.chrome = (statsDb.browserBreakdown.chrome || 0) + 1;
  else if (br.includes('firefox')) statsDb.browserBreakdown.firefox = (statsDb.browserBreakdown.firefox || 0) + 1;
  else if (br.includes('edge')) statsDb.browserBreakdown.edge = (statsDb.browserBreakdown.edge || 0) + 1;
  else if (br.includes('safari')) statsDb.browserBreakdown.safari = (statsDb.browserBreakdown.safari || 0) + 1;
  else if (br.includes('opera')) statsDb.browserBreakdown.opera = (statsDb.browserBreakdown.opera || 0) + 1;
  else if (br.includes('discord')) statsDb.browserBreakdown.discord = (statsDb.browserBreakdown.discord || 0) + 1;
  else statsDb.browserBreakdown.other = (statsDb.browserBreakdown.other || 0) + 1;

  const country = getClientCountry(req);
  const lang = getClientLanguage(req);
  if (!statsDb.countryBreakdown) statsDb.countryBreakdown = {};
  statsDb.countryBreakdown[country] = (statsDb.countryBreakdown[country] || 0) + 1;
  if (!statsDb.languageBreakdown) statsDb.languageBreakdown = {};
  statsDb.languageBreakdown[lang] = (statsDb.languageBreakdown[lang] || 0) + 1;

  if (!Array.isArray(statsDb.visitsLog)) statsDb.visitsLog = [];
  statsDb.visitsLog.push({
    t: Date.now(),
    type,
    isNew: !!isNewUser,
    dev: details.deviceType || 'Escritorio',
    br: details.browser || 'Web',
    country,
    lang
  });
  if (statsDb.visitsLog.length > 10000) {
    statsDb.visitsLog = statsDb.visitsLog.slice(-10000);
  }

  saveStatsDb();
}
