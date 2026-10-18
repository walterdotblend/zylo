import express from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { nanoid } from 'nanoid';
import {
  ROOT_DIR,
  UPLOAD_DIR,
  BANNERS_UPLOAD_DIR,
  ANNOUNCEMENTS_UPLOAD_DIR,
  ADMIN_SECRET_PATH,
  COUNTRY_NAMES,
  LANG_NAMES,
  getCountryFlag,
  getBaseUrl
} from '../config/constants.js';
import {
  mediaDb,
  bannersDb,
  quotaConfig,
  announcementData,
  statsDb,
  loadBannersDb,
  saveDb,
  saveBannersDb,
  saveQuotaConfig,
  saveAnnouncementDb,
  saveStatsDb,
  setAnnouncementData,
  resetAllStores,
  replaceStatsAndBanners,
  getDiskUsage,
  getFilteredStats
} from '../db/store.js';
import {
  getMasterAdminPassword,
  setMasterAdminPassword,
  computeAdminSessionToken,
  isAdminAuthed,
  checkAdminLoginRateLimit,
  recordAdminLoginFailure,
  clearAdminLoginFailures
} from '../middleware/security.js';
import * as r2 from '../services/r2.js';

const router = express.Router();

const bannerStorage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, BANNERS_UPLOAD_DIR),
  filename: (req, file, cb) => {
    let ext = path.extname(file.originalname).toLowerCase();
    if (!ext) {
      if (file.mimetype.includes('gif')) ext = '.gif';
      else if (file.mimetype.includes('webp')) ext = '.webp';
      else if (file.mimetype.includes('mp4')) ext = '.mp4';
      else if (file.mimetype.includes('webm')) ext = '.webm';
      else if (file.mimetype.includes('svg')) ext = '.svg';
      else ext = '.png';
    }
    cb(null, `banner_${nanoid(8)}${ext}`);
  }
});
const bannerUpload = multer({
  storage: bannerStorage,
  limits: { fileSize: 25 * 1024 * 1024 }
});

const announcementStorage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, ANNOUNCEMENTS_UPLOAD_DIR),
  filename: (req, file, cb) => {
    let ext = path.extname(file.originalname).toLowerCase();
    if (!ext) {
      if (file.mimetype.includes('mp4')) ext = '.mp4';
      else if (file.mimetype.includes('webm')) ext = '.webm';
      else if (file.mimetype.includes('gif')) ext = '.gif';
      else ext = '.png';
    }
    cb(null, `ann_${nanoid(8)}${ext}`);
  }
});
const announcementUpload = multer({
  storage: announcementStorage,
  limits: { fileSize: 50 * 1024 * 1024 }
});

// Obscurity guard: /admin or /admin/* returns 404
router.all('/admin*', (req, res) => {
  res.status(404).send(`<!DOCTYPE html><html><head><title>404 Not Found</title></head><body style="background:#0d0218;color:#fff;font-family:sans-serif;padding:50px;text-align:center;"><h1>404 Not Found</h1><p>The requested page does not exist.</p><a href="/" style="color:#ff851b;text-decoration:none;font-weight:bold;">← Return Home</a></body></html>`);
});

// Direct admin media stream (redirects to R2 CDN)
router.get('/' + ADMIN_SECRET_PATH + '/raw/:id', (req, res) => {
  if (!isAdminAuthed(req)) return res.status(401).send('Unauthorized');
  const item = mediaDb[req.params.id];
  if (!item) return res.status(404).send('Clip not found in database');
  const directR2Url = r2.getPublicClipUrl(item);
  if (directR2Url && item.r2) {
    return res.redirect(302, directR2Url);
  }
  const filePath = path.join(UPLOAD_DIR, item.filename);
  if (!fs.existsSync(filePath)) {
    if (item.r2 && r2.enabled) {
      return r2.streamClip(item, req, res, item.mimetype || 'video/webm').then(ok => {
        if (!ok && !res.headersSent) res.status(404).send('Clip not found in R2');
      });
    }
    return res.status(404).send('Clip not found on disk');
  }
  const stat = fs.statSync(filePath);
  res.setHeader('Content-Type', item.mimetype || 'video/webm');
  res.setHeader('Content-Length', stat.size);
  fs.createReadStream(filePath).pipe(res);
});

// Hardened Admin Login (Rate-limited + HMAC-SHA256 Session Token)
router.post('/' + ADMIN_SECRET_PATH + '/login', (req, res) => {
  const rateCheck = checkAdminLoginRateLimit(req);
  if (!rateCheck.allowed) {
    return res.status(429).send(`
      <!DOCTYPE html><html lang="es"><head><meta charset="utf-8"><title>Locked | Zylo Security</title></head>
      <body style="background:#0d0218; color:#fff; font-family:sans-serif; text-align:center; padding:50px;">
        <h2 style="color:#ef4444;">⏳ Demasiados intentos fallidos</h2>
        <p style="margin-top:12px; color:#cbd5e1;">Por seguridad, espera ${rateCheck.retryAfterSec} segundos antes de volver a intentar.</p>
        <p style="margin-top:16px;"><a href="/${ADMIN_SECRET_PATH}" style="color:#ff851b; text-decoration:none; font-weight:bold;">← Volver</a></p>
      </body></html>
    `);
  }

  const pwd = (req.body.password || '').trim();
  if (pwd && pwd === getMasterAdminPassword()) {
    clearAdminLoginFailures(req);
    const token = computeAdminSessionToken(pwd);
    res.setHeader('Set-Cookie', `zylo_admin_auth=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=86400`);
    return res.redirect('/' + ADMIN_SECRET_PATH);
  }

  recordAdminLoginFailure(req);
  return res.status(401).send(`
    <!DOCTYPE html>
    <html lang="es">
    <head><meta charset="utf-8"><title>Error | Zylo Security</title></head>
    <body style="background:#0d0218; color:#fff; font-family:sans-serif; text-align:center; padding:50px;">
      <h2 style="color:#ef4444;">❌ Contraseña incorrecta</h2>
      <p style="margin-top:12px;"><a href="/${ADMIN_SECRET_PATH}" style="color:#ff851b; text-decoration:none; font-weight:bold;">← Intentar de nuevo</a></p>
    </body>
    </html>
  `);
});

router.get('/' + ADMIN_SECRET_PATH + '/logout', (req, res) => {
  res.setHeader('Set-Cookie', 'zylo_admin_auth=; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT');
  res.redirect('/');
});

// Admin Moderation API Endpoints
router.post('/api/admin/revoke/:id', (req, res) => {
  if (!isAdminAuthed(req)) return res.status(401).json({ error: 'Unauthorized' });
  const item = mediaDb[req.params.id];
  if (!item) return res.status(404).json({ error: 'Not found' });
  item.publicExpired = true;
  saveDb();
  res.json({ success: true, id: req.params.id, publicExpired: true });
});

router.post('/api/admin/restore/:id', (req, res) => {
  if (!isAdminAuthed(req)) return res.status(401).json({ error: 'Unauthorized' });
  const item = mediaDb[req.params.id];
  if (!item) return res.status(404).json({ error: 'Not found' });
  item.publicExpired = false;
  saveDb();
  res.json({ success: true, id: req.params.id, publicExpired: false });
});

router.post('/api/admin/delete/:id', async (req, res) => {
  if (!isAdminAuthed(req)) return res.status(401).json({ error: 'Unauthorized' });
  const item = mediaDb[req.params.id];
  if (!item) return res.status(404).json({ error: 'Not found' });
  const filePath = path.join(UPLOAD_DIR, item.filename);
  if (fs.existsSync(filePath)) {
    try { fs.unlinkSync(filePath); } catch (e) {}
  }
  await r2.removeClip(item);
  delete mediaDb[req.params.id];
  saveDb();
  res.json({ success: true, id: req.params.id });
});

router.get('/api/admin/details/:id', (req, res) => {
  if (!isAdminAuthed(req)) return res.status(401).json({ error: 'Unauthorized' });
  const item = mediaDb[req.params.id];
  if (!item) return res.status(404).json({ error: 'Not found' });
  res.json({
    success: true,
    id: item.id,
    originalName: item.originalName,
    filename: item.filename,
    mimetype: item.mimetype,
    size: item.size,
    createdAt: item.createdAt,
    expiresAt: item.expiresAt,
    views: item.views,
    publicExpired: item.publicExpired,
    adminSecret: item.adminSecret,
    uploader: item.uploader || {
      ip: 'Not recorded',
      os: 'Unknown',
      browser: 'Unknown',
      deviceType: 'Unknown',
      deviceName: 'Unknown',
      uploadDate: new Date(item.createdAt).toLocaleString()
    },
    viewsLog: item.viewsLog || [],
    privacy: item.privacy || {}
  });
});

router.post('/api/admin/change-password', (req, res) => {
  if (!isAdminAuthed(req)) return res.status(401).json({ error: 'Unauthorized' });
  const { password } = req.body;
  if (!password || password.trim().length < 4) {
    return res.status(400).json({ error: 'Password must be at least 4 characters' });
  }
  const cleanPwd = password.trim();
  const ok = setMasterAdminPassword(cleanPwd);
  if (ok) {
    const newToken = computeAdminSessionToken(cleanPwd);
    res.setHeader('Set-Cookie', `zylo_admin_auth=${newToken}; Path=/; HttpOnly; SameSite=Lax; Max-Age=86400`);
    res.json({ success: true, message: 'Password updated successfully' });
  } else {
    res.status(500).json({ error: 'Error saving password' });
  }
});

// Admin Banners Management Endpoints
router.get('/api/admin/banners', (req, res) => {
  if (!isAdminAuthed(req)) return res.status(401).json({ error: 'Unauthorized' });
  res.json({
    success: true,
    banners: bannersDb,
    slots: {
      studio_left: bannersDb.filter(b => b.slot === 'studio_left'),
      studio_right: bannersDb.filter(b => b.slot === 'studio_right'),
      viewer_left: bannersDb.filter(b => b.slot === 'viewer_left'),
      viewer_right: bannersDb.filter(b => b.slot === 'viewer_right'),
      mobile_webapp: bannersDb.filter(b => b.slot === 'mobile_webapp')
    }
  });
});

router.post('/api/admin/banners', bannerUpload.any(), (req, res) => {
  if (!isAdminAuthed(req)) return res.status(401).json({ error: 'Unauthorized' });
  loadBannersDb();
  const slot = req.body.slot || 'studio_left';
  const name = (req.body.name || 'Ad Banner').trim();
  const targetUrl = (req.body.targetUrl || 'https://discord.com').trim();
  const weight = Math.max(1, parseInt(req.body.weight, 10) || 10);

  let languages = ['all'];
  if (req.body.languages) {
    try {
      languages = typeof req.body.languages === 'string' ? JSON.parse(req.body.languages) : req.body.languages;
    } catch (e) {
      if (typeof req.body.languages === 'string') languages = [req.body.languages];
    }
  }
  if (!Array.isArray(languages) || languages.length === 0) languages = ['all'];

  for (const l of languages) {
    const qBase = quotaConfig[l] || quotaConfig.all || 100;
    const currentAllocated = bannersDb
      .filter(b => b.slot === slot && b.active !== false && (b.languages.includes('all') || b.languages.includes(l)))
      .reduce((sum, b) => sum + (parseInt(b.weight, 10) || 0), 0);
    const availableQuota = Math.max(0, qBase - currentAllocated);
    if (weight > availableQuota) {
      return res.status(400).json({
        error: `Requested quota (${weight}) exceeds available quota (${availableQuota} of ${qBase}) for language "${l.toUpperCase()}" in slot "${slot}".`
      });
    }
  }

  let mediaUrl = '';
  let mediaType = 'image';
  const mainFile = (req.files || []).find(f => f.fieldname === 'bannerFile');

  if (mainFile) {
    mediaUrl = `/uploads/banners/${mainFile.filename}`;
    const ext = path.extname(mainFile.filename).toLowerCase();
    mediaType = (ext === '.mp4' || ext === '.webm') ? 'video' : 'image';
  } else if (req.body.mediaUrl) {
    mediaUrl = req.body.mediaUrl.trim();
    mediaType = mediaUrl.match(/\.(mp4|webm)($|\?)/i) ? 'video' : 'image';
  } else {
    return res.status(400).json({ error: 'Please upload a file or provide a media URL' });
  }

  const mediaVariants = {};
  const supportedLangs = ['es', 'en', 'pt', 'fr', 'de', 'ja'];
  supportedLangs.forEach(l => {
    const vFile = (req.files || []).find(f => f.fieldname === `variant_file_${l}`);
    if (vFile) {
      mediaVariants[l] = `/uploads/banners/${vFile.filename}`;
    } else if (req.body[`variant_url_${l}`] && req.body[`variant_url_${l}`].trim()) {
      mediaVariants[l] = req.body[`variant_url_${l}`].trim();
    }
  });

  const newBanner = {
    id: `ban_${nanoid(8)}`,
    slot,
    name,
    mediaUrl,
    mediaType,
    mediaVariants,
    targetUrl,
    weight,
    languages,
    active: true,
    impressions: 0,
    clicks: 0,
    geoStats: { countries: {}, languages: {} },
    createdAt: Date.now()
  };

  bannersDb.push(newBanner);
  saveBannersDb();
  res.json({ success: true, banner: newBanner });
});

router.post('/api/admin/banners/:id/toggle', (req, res) => {
  if (!isAdminAuthed(req)) return res.status(401).json({ error: 'Unauthorized' });
  const banner = bannersDb.find(b => b.id === req.params.id);
  if (!banner) return res.status(404).json({ error: 'Banner not found' });

  if (!banner.active) {
    const bLangs = Array.isArray(banner.languages) && banner.languages.length > 0 ? banner.languages : ['all'];
    for (const l of bLangs) {
      const qBase = quotaConfig[l] || quotaConfig.all || 100;
      const currentAllocated = bannersDb
        .filter(b => b.slot === banner.slot && b.id !== banner.id && b.active !== false && (b.languages.includes('all') || b.languages.includes(l)))
        .reduce((sum, b) => sum + (parseInt(b.weight, 10) || 0), 0);
      const availableQuota = Math.max(0, qBase - currentAllocated);
      if ((parseInt(banner.weight, 10) || 1) > availableQuota) {
        return res.status(400).json({
          error: `Cannot reactivate: quota (${banner.weight}) exceeds available (${availableQuota} of ${qBase}) for language "${l.toUpperCase()}" in "${banner.slot}".`
        });
      }
    }
  }

  banner.active = !banner.active;
  saveBannersDb();
  res.json({ success: true, banner });
});

router.delete('/api/admin/banners/:id', (req, res) => {
  if (!isAdminAuthed(req)) return res.status(401).json({ error: 'Unauthorized' });
  const idx = bannersDb.findIndex(b => b.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Banner not found' });
  const banner = bannersDb[idx];
  if (banner.mediaUrl && banner.mediaUrl.startsWith('/uploads/banners/')) {
    const filePath = path.join(ROOT_DIR, banner.mediaUrl);
    if (fs.existsSync(filePath)) { try { fs.unlinkSync(filePath); } catch(e) {} }
  }
  if (banner.mediaVariants && typeof banner.mediaVariants === 'object') {
    Object.values(banner.mediaVariants).forEach(vUrl => {
      if (vUrl && vUrl.startsWith('/uploads/banners/')) {
        const vPath = path.join(ROOT_DIR, vUrl);
        if (fs.existsSync(vPath)) { try { fs.unlinkSync(vPath); } catch(e){} }
      }
    });
  }
  bannersDb.splice(idx, 1);
  saveBannersDb();
  res.json({ success: true });
});

router.post('/api/admin/banners/:id/edit', bannerUpload.any(), (req, res) => {
  if (!isAdminAuthed(req)) return res.status(401).json({ error: 'Unauthorized' });
  const banner = bannersDb.find(b => b.id === req.params.id);
  if (!banner) return res.status(404).json({ error: 'Banner not found' });

  const targetSlot = req.body.slot || banner.slot;
  let languages = banner.languages || ['all'];
  if (req.body.languages) {
    try {
      languages = typeof req.body.languages === 'string' ? JSON.parse(req.body.languages) : req.body.languages;
    } catch(e) {
      if (typeof req.body.languages === 'string') languages = [req.body.languages];
    }
  }
  if (!Array.isArray(languages) || languages.length === 0) languages = ['all'];

  const newWeight = (req.body.weight !== undefined) ? Math.max(1, parseInt(req.body.weight, 10) || 10) : banner.weight;

  for (const l of languages) {
    const qBase = quotaConfig[l] || quotaConfig.all || 100;
    const otherAllocated = bannersDb
      .filter(b => b.slot === targetSlot && b.id !== banner.id && b.active !== false && (b.languages.includes('all') || b.languages.includes(l)))
      .reduce((sum, b) => sum + (parseInt(b.weight, 10) || 0), 0);
    const availableQuota = Math.max(0, qBase - otherAllocated);
    if (newWeight > availableQuota) {
      return res.status(400).json({
        error: `Quota (${newWeight}) exceeds available space (${availableQuota} of ${qBase}) for language "${l.toUpperCase()}" in "${targetSlot}".`
      });
    }
  }

  const mainFile = (req.files || []).find(f => f.fieldname === 'bannerFile');
  if (mainFile) {
    if (banner.mediaUrl && banner.mediaUrl.startsWith('/uploads/banners/')) {
      const oldPath = path.join(ROOT_DIR, banner.mediaUrl);
      if (fs.existsSync(oldPath)) { try { fs.unlinkSync(oldPath); } catch(e){} }
    }
    banner.mediaUrl = `/uploads/banners/${mainFile.filename}`;
    const ext = path.extname(mainFile.filename).toLowerCase();
    banner.mediaType = (ext === '.mp4' || ext === '.webm') ? 'video' : 'image';
  } else if (req.body.mediaUrl && req.body.mediaUrl.trim()) {
    banner.mediaUrl = req.body.mediaUrl.trim();
    banner.mediaType = banner.mediaUrl.match(/\.(mp4|webm)($|\?)/i) ? 'video' : 'image';
  }

  if (!banner.mediaVariants) banner.mediaVariants = {};
  const supportedLangs = ['es', 'en', 'pt', 'fr', 'de', 'ja'];
  supportedLangs.forEach(l => {
    const vFile = (req.files || []).find(f => f.fieldname === `variant_file_${l}`);
    if (vFile) {
      banner.mediaVariants[l] = `/uploads/banners/${vFile.filename}`;
    } else if (req.body[`variant_url_${l}`] !== undefined) {
      const vUrl = req.body[`variant_url_${l}`].trim();
      if (vUrl) banner.mediaVariants[l] = vUrl;
      else delete banner.mediaVariants[l];
    }
  });

  if (req.body.name) banner.name = req.body.name.trim();
  if (req.body.targetUrl) banner.targetUrl = req.body.targetUrl.trim();
  banner.slot = targetSlot;
  banner.weight = newWeight;
  banner.languages = languages;
  saveBannersDb();
  res.json({ success: true, banner });
});

router.get('/api/admin/quota-config', (req, res) => {
  if (!isAdminAuthed(req)) return res.status(401).json({ error: 'Unauthorized' });
  res.json({ success: true, quotaConfig });
});

router.post('/api/admin/quota-config', express.json(), (req, res) => {
  if (!isAdminAuthed(req)) return res.status(401).json({ error: 'Unauthorized' });
  const newConfig = req.body || {};
  ['all', 'en', 'es', 'pt', 'fr', 'de', 'ja'].forEach(k => {
    if (newConfig[k] !== undefined) {
      const val = parseInt(newConfig[k], 10);
      if (!isNaN(val) && val >= 10 && val <= 10000) {
        quotaConfig[k] = val;
      }
    }
  });
  saveQuotaConfig();
  res.json({ success: true, quotaConfig });
});

router.get('/api/admin/export-stats', (req, res) => {
  if (!isAdminAuthed(req)) return res.status(401).json({ error: 'Unauthorized' });
  const backup = {
    app: 'Zylo Web Studio',
    version: '2.0',
    exportedAt: new Date().toISOString(),
    statsDb,
    bannersDb,
    bannersPerformance: bannersDb.map(b => ({
      id: b.id,
      name: b.name,
      slot: b.slot,
      mediaUrl: b.mediaUrl,
      mediaVariants: b.mediaVariants || {},
      targetUrl: b.targetUrl,
      languages: b.languages,
      weight: b.weight,
      active: b.active,
      impressions: b.impressions || 0,
      clicks: b.clicks || 0,
      ctr: b.impressions > 0 ? ((b.clicks / b.impressions) * 100).toFixed(2) : '0.00',
      geoStats: b.geoStats || {}
    })),
    quotaConfig
  };
  const filename = `zylo_stats_backup_${new Date().toISOString().slice(0, 10)}.json`;
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.send(JSON.stringify(backup, null, 2));
});

router.get('/api/admin/export-stats-csv', (req, res) => {
  if (!isAdminAuthed(req)) return res.status(401).json({ error: 'Unauthorized' });
  let csv = 'Tipo,Fecha,Detalle,Pais,Idioma,Dispositivo,Valor\r\n';
  bannersDb.forEach(b => {
    const ctr = b.impressions > 0 ? ((b.clicks / b.impressions) * 100).toFixed(2) : '0.00';
    const langs = (b.languages || ['all']).join('|');
    csv += `"Banner","${new Date(b.createdAt || Date.now()).toISOString()}","${(b.name || '').replace(/"/g, '""')} [${b.slot}]","-","${langs}","-","${b.impressions} imp / ${b.clicks} clics (${ctr}% CTR)"\r\n`;
  });
  const vLog = statsDb.visitsLog || [];
  vLog.slice(-500).forEach(v => {
    csv += `"Visita","${new Date(v.t || v.timestamp || Date.now()).toISOString()}","${v.br || v.browser || ''}","${v.country || ''}","${v.lang || ''}","${v.dev || v.deviceType || ''}","-"\r\n`;
  });
  const filename = `zylo_metrics_${new Date().toISOString().slice(0, 10)}.csv`;
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.send('\uFEFF' + csv);
});

router.post('/api/admin/import-stats', express.json({ limit: '15mb' }), (req, res) => {
  if (!isAdminAuthed(req)) return res.status(401).json({ error: 'Unauthorized' });
  const data = req.body;
  if (!data || typeof data !== 'object') {
    return res.status(400).json({ error: 'Invalid backup format.' });
  }
  replaceStatsAndBanners(data);
  res.json({ success: true, message: 'Backup restored successfully.' });
});

router.get('/api/admin/announcement', (req, res) => {
  if (!isAdminAuthed(req)) return res.status(401).json({ error: 'Unauthorized' });
  res.json({ success: true, announcement: announcementData });
});

router.post('/api/admin/announcement', announcementUpload.single('mediaFile'), (req, res) => {
  if (!isAdminAuthed(req)) return res.status(401).json({ error: 'Unauthorized' });

  const active = req.body.active === 'true' || req.body.active === true;
  const title = (req.body.title || '').trim();
  const message = (req.body.message || '').trim();
  const actionText = (req.body.actionText || '').trim();
  const actionUrl = (req.body.actionUrl || '').trim();
  const removeMedia = req.body.removeMedia === 'true' || req.body.removeMedia === true;

  let translations = {};
  if (req.body.translations) {
    try {
      translations = typeof req.body.translations === 'string' ? JSON.parse(req.body.translations) : req.body.translations;
    } catch(e) {}
  }

  let mediaUrl = announcementData.mediaUrl || '';
  let mediaType = announcementData.mediaType || null;

  if (removeMedia) {
    if (mediaUrl && mediaUrl.startsWith('/uploads/announcements/')) {
      const p = path.join(ROOT_DIR, mediaUrl);
      if (fs.existsSync(p)) try { fs.unlinkSync(p); } catch(e){}
    }
    mediaUrl = '';
    mediaType = null;
  }

  if (req.file) {
    mediaUrl = `/uploads/announcements/${req.file.filename}`;
    const ext = path.extname(req.file.filename).toLowerCase();
    mediaType = (ext === '.mp4' || ext === '.webm' || req.file.mimetype.startsWith('video/')) ? 'video' : 'image';
  } else if (req.body.mediaUrl && req.body.mediaUrl.trim() && !removeMedia) {
    mediaUrl = req.body.mediaUrl.trim();
    mediaType = mediaUrl.match(/\.(mp4|webm)($|\?)/i) ? 'video' : 'image';
  }

  const contentChanged = (!announcementData.id || announcementData.title !== title || announcementData.message !== message || announcementData.mediaUrl !== mediaUrl);
  const annId = contentChanged ? `ann_${nanoid(8)}` : (announcementData.id || `ann_${nanoid(8)}`);

  setAnnouncementData({
    id: annId,
    title,
    message,
    mediaUrl,
    mediaType,
    actionText,
    actionUrl,
    active,
    translations,
    createdAt: Date.now()
  });

  res.json({ success: true, announcement: announcementData });
});

router.post('/api/admin/translate', async (req, res) => {
  if (!isAdminAuthed(req)) return res.status(401).json({ error: 'Unauthorized' });

  const { title = '', message = '', actionText = '', sourceLang = 'es' } = req.body || {};
  const targetLangs = ['en', 'pt', 'fr', 'de', 'ja'];
  const translations = {};

  async function callMyMemory(text, src, tgt) {
    if (!text || !text.trim()) return '';
    try {
      const url = `https://api.mymemory.translated.net/get?q=${encodeURIComponent(text.trim())}&langpair=${src}|${tgt}`;
      const response = await fetch(url, { headers: { 'User-Agent': 'Zylo-Studio-Translate/2.0' } });
      if (!response.ok) return text;
      const data = await response.json();
      if (data && data.responseData && data.responseData.translatedText) {
        return data.responseData.translatedText;
      }
    } catch(e) {
      console.warn(`Translation error for ${tgt}:`, e.message);
    }
    return text;
  }

  try {
    for (const tgt of targetLangs) {
      const [tTitle, tMsg, tBtn] = await Promise.all([
        callMyMemory(title, sourceLang, tgt),
        callMyMemory(message, sourceLang, tgt),
        callMyMemory(actionText, sourceLang, tgt)
      ]);
      translations[tgt] = {
        title: tTitle || title,
        message: tMsg || message,
        actionText: tBtn || actionText
      };
    }
    res.json({ success: true, translations });
  } catch(err) {
    res.status(500).json({ error: 'Translation failed: ' + err.message });
  }
});

router.get('/api/admin/stats', (req, res) => {
  if (!isAdminAuthed(req)) return res.status(401).json({ error: 'Unauthorized' });
  const period = req.query.period || 'all';
  const filtered = getFilteredStats(period);
  const disk = getDiskUsage();

  res.json({
    success: true,
    stats: filtered,
    period,
    diskUsage: disk,
    banners: bannersDb.map(b => ({
      id: b.id,
      name: b.name,
      slot: b.slot,
      weight: b.weight,
      active: b.active,
      impressions: b.impressions || 0,
      clicks: b.clicks || 0,
      ctr: (b.impressions > 0 ? ((b.clicks / b.impressions) * 100).toFixed(2) : '0.00') + '%'
    }))
  });
});

router.post('/api/admin/reset-test-data', (req, res) => {
  if (!isAdminAuthed(req)) return res.status(401).json({ error: 'Unauthorized' });

  const { password } = req.body || {};
  if (!password || password.trim() !== getMasterAdminPassword()) {
    return res.status(403).json({ error: 'Incorrect administrator password. Data purge denied.' });
  }

  let deletedFiles = 0;
  try {
    const files = fs.readdirSync(UPLOAD_DIR);
    for (const file of files) {
      if (file === 'banners' || file === 'announcements') continue;
      const fullPath = path.join(UPLOAD_DIR, file);
      try {
        const stat = fs.statSync(fullPath);
        if (stat.isFile()) {
          fs.unlinkSync(fullPath);
          deletedFiles++;
        }
      } catch(e) {}
    }
  } catch(e) {}

  resetAllStores();
  console.log(`[Admin] Test data purged successfully. ${deletedFiles} file(s) deleted.`);
  res.json({
    success: true,
    deletedFiles,
    message: 'Clips database, files, and stats reset to clean state.'
  });
});

// Admin Panel View (Secret Route)
router.get(['/' + ADMIN_SECRET_PATH, '/' + ADMIN_SECRET_PATH + '/'], (req, res) => {
  if (!isAdminAuthed(req)) {
    // Render Login Screen
    return res.send(`
      <!DOCTYPE html>
      <html lang="es">
      <head>
        <meta charset="UTF-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1.0" />
        <title>Acceso Administrador | Zylo</title>
        <link rel="icon" type="image/png" href="/favicon.png?v=5" />
        <link rel="apple-touch-icon" href="/favicon.png?v=5" />
        <style>
          * { box-sizing: border-box; margin: 0; padding: 0; }
          body {
            background: #0d0218;
            background: radial-gradient(circle at 50% 25%, #250742 0%, #0d0218 100%);
            color: #f3e8ff;
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
            display: flex;
            align-items: center;
            justify-content: center;
            min-height: 100vh;
            padding: 20px;
          }
          .login-card {
            background: rgba(22, 6, 38, 0.94);
            border: 1.5px solid #3d0d66;
            border-radius: 24px;
            padding: 40px;
            width: 100%;
            max-width: 420px;
            text-align: center;
            box-shadow: 0 16px 50px rgba(0,0,0,0.85);
          }
          .login-card img {
            height: 48px;
            margin-bottom: 20px;
            filter: drop-shadow(0 2px 12px rgba(255, 109, 0, 0.5));
          }
          h2 { font-size: 1.25rem; font-weight: 800; margin-bottom: 8px; color: #fff; }
          p { font-size: 0.85rem; color: #cbd5e1; margin-bottom: 24px; line-height: 1.4; }
          input {
            width: 100%;
            background: #140424;
            border: 1.5px solid #431275;
            color: #fff;
            padding: 14px 18px;
            border-radius: 12px;
            font-size: 14px;
            outline: none;
            margin-bottom: 18px;
            transition: border-color 0.2s;
          }
          input:focus { border-color: #ff851b; }
          button {
            width: 100%;
            background: linear-gradient(135deg, #ffa726, #ff6d00);
            border: none;
            color: #0f021c;
            padding: 14px;
            border-radius: 12px;
            font-size: 14px;
            font-weight: 800;
            cursor: pointer;
            box-shadow: 0 4px 18px rgba(255, 109, 0, 0.4);
            transition: all 0.2s;
          }
          button:hover { background: linear-gradient(135deg, #ffb74d, #ff7a00); transform: translateY(-1px); }
        </style>
      </head>
      <body>
        <div class="login-card">
          <img src="/logo.png" alt="Zylo" />
          <h2>Consola de Seguridad</h2>
          <p>Ingresa la contraseña maestra de administrador para auditar y gestionar todos los enlaces.</p>
          <form method="POST" action="/${ADMIN_SECRET_PATH}/login">
            <input type="password" name="password" placeholder="Contraseña maestra (por defecto: zylo2026)" autofocus required />
            <button type="submit">Entrar al Panel 🔒</button>
          </form>
        </div>
      </body>
      </html>
    `);
  }

  // Calculate Real-time Stats
  // Calculate Real-time Stats & Banners
  const items = Object.values(mediaDb).sort((a, b) => b.createdAt - a.createdAt);
  const totalClips = items.length;
  let totalBytes = 0;
  let activeCount = 0;
  let expiredCount = 0;

  items.forEach(it => {
    totalBytes += (it.size || 0);
    if (it.publicExpired || Date.now() >= it.expiresAt) {
      expiredCount++;
    } else {
      activeCount++;
    }
  });

  const totalMB = (totalBytes / (1024 * 1024)).toFixed(1);
  const baseUrl = getBaseUrl(req);

  // Compute active weights per slot for probability % display
  const slotWeights = { studio_left: 0, studio_right: 0, viewer_left: 0, viewer_right: 0, mobile_webapp: 0 };
  bannersDb.forEach(b => {
    if (b.active !== false && slotWeights[b.slot] !== undefined) {
      slotWeights[b.slot] += Math.max(1, parseInt(b.weight, 10) || 1);
    }
  });

  const slotLabels = {
    studio_left: 'Estudio • Lateral Izquierdo (160×600)',
    studio_right: 'Estudio • Lateral Derecho (160×600)',
    viewer_left: 'Reproductor • Lateral Izquierdo (160×600)',
    viewer_right: 'Reproductor • Lateral Derecho (160×600)',
    mobile_webapp: '📱 WebApp Móvil • Banner Uniforme (320×80 / 300×75)'
  };

  const devTotal = Math.max(1, (statsDb.deviceBreakdown.desktop || 0) + (statsDb.deviceBreakdown.mobile || 0) + (statsDb.deviceBreakdown.tablet || 0));
  const brTotal = Math.max(1, (statsDb.browserBreakdown.chrome || 0) + (statsDb.browserBreakdown.firefox || 0) + (statsDb.browserBreakdown.edge || 0) + (statsDb.browserBreakdown.safari || 0) + (statsDb.browserBreakdown.opera || 0) + (statsDb.browserBreakdown.discord || 0) + (statsDb.browserBreakdown.other || 0));

  const countryEntries = Object.entries(statsDb.countryBreakdown || {}).sort((a, b) => b[1] - a[1]);
  const totalCountryVisits = Math.max(1, countryEntries.reduce((sum, item) => sum + item[1], 0));

  const langEntries = Object.entries(statsDb.languageBreakdown || {}).sort((a, b) => b[1] - a[1]);
  const totalLangVisits = Math.max(1, langEntries.reduce((sum, item) => sum + item[1], 0));

  const recordedMins = ((statsDb.clipsDurationSecondsTotal || 0) / 60).toFixed(1);
  const recordedHours = ((statsDb.clipsDurationSecondsTotal || 0) / 3600).toFixed(2);
  const watchMins = ((statsDb.playerWatchTimeSecondsTotal || 0) / 60).toFixed(1);
  const watchHours = ((statsDb.playerWatchTimeSecondsTotal || 0) / 3600).toFixed(2);
  const globalCtr = statsDb.bannerImpressionsTotal > 0 ? ((statsDb.bannerClicksTotal / statsDb.bannerImpressionsTotal) * 100).toFixed(2) : '0.00';
  const disk = getDiskUsage();
  const allBannersJson = JSON.stringify(bannersDb.map(b => ({
    id: b.id,
    name: b.name,
    slot: b.slot,
    targetUrl: b.targetUrl,
    mediaUrl: b.mediaUrl,
    mediaVariants: b.mediaVariants || {},
    languages: Array.isArray(b.languages) && b.languages.length > 0 ? b.languages : ['all'],
    weight: parseInt(b.weight, 10) || 10,
    active: b.active !== false
  })));
  const quotaConfigJson = JSON.stringify(quotaConfig);

  return res.send(`
    <!DOCTYPE html>
    <html lang="es">
    <head>
      <meta charset="UTF-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1.0" />
      <title>Consola de Administración y Métricas | Zylo</title>
      <link rel="icon" type="image/png" href="/favicon.png?v=5" />
      <link rel="apple-touch-icon" href="/favicon.png?v=5" />
      <style>
        * { box-sizing: border-box; margin: 0; padding: 0; }
        body {
          background: #0d0218;
          color: #f3e8ff;
          font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
          min-height: 100vh;
          display: flex;
          flex-direction: column;
        }
        header {
          height: 68px;
          background: rgba(18, 4, 32, 0.96);
          border-bottom: 1.5px solid #2e0e4f;
          padding: 0 28px;
          display: flex;
          align-items: center;
          justify-content: space-between;
          position: sticky;
          top: 0;
          z-index: 50;
        }
        .header-brand { display: flex; align-items: center; gap: 14px; }
        .header-brand img { height: 36px; }
        .header-badge {
          background: rgba(255, 109, 0, 0.15);
          border: 1px solid rgba(255, 109, 0, 0.4);
          color: #ffa726;
          font-size: 11px;
          font-weight: 800;
          padding: 4px 10px;
          border-radius: 20px;
        }
        .header-tabs {
          display: flex;
          align-items: center;
          background: #140324;
          border: 1px solid #360f5c;
          border-radius: 12px;
          padding: 4px;
          gap: 4px;
        }
        .tab-btn {
          background: transparent;
          border: none;
          color: #c4b5fd;
          padding: 7px 16px;
          border-radius: 8px;
          font-size: 12px;
          font-weight: 800;
          cursor: pointer;
          transition: all 0.15s;
          display: inline-flex;
          align-items: center;
          gap: 6px;
        }
        .tab-btn:hover { color: #fff; background: rgba(255, 255, 255, 0.05); }
        .tab-btn.active {
          background: linear-gradient(135deg, #ffa726, #ff6d00);
          color: #0c0118;
          box-shadow: 0 2px 10px rgba(255, 109, 0, 0.35);
        }
        .period-filter-btn {
          background: #1c0533;
          border: 1px solid #431275;
          color: #c4b5fd;
          padding: 6px 14px;
          border-radius: 10px;
          font-size: 11px;
          font-weight: 700;
          cursor: pointer;
          transition: all 0.15s;
        }
        .period-filter-btn:hover {
          background: #2a084d;
          color: #fff;
          border-color: #ff9100;
        }
        .period-filter-btn.active {
          background: linear-gradient(135deg, #ffa726, #ff6d00);
          border-color: #ffa726;
          color: #0c0118;
          font-weight: 800;
          box-shadow: 0 2px 8px rgba(255, 109, 0, 0.35);
        }
        .header-actions { display: flex; align-items: center; gap: 10px; }
        .btn-header {
          background: #20063b;
          border: 1px solid #431275;
          color: #e9d5ff;
          padding: 8px 14px;
          border-radius: 10px;
          font-size: 12px;
          font-weight: 700;
          cursor: pointer;
          text-decoration: none;
          transition: all 0.2s;
          display: inline-flex;
          align-items: center;
          gap: 6px;
        }
        .btn-header:hover { background: #320a59; border-color: #ff9100; color: #fff; }
        .btn-danger-header {
          background: rgba(239, 68, 68, 0.15);
          border-color: #ef4444;
          color: #fca5a5;
        }
        .btn-danger-header:hover { background: #ef4444; color: #fff; }
        
        main {
          flex: 1;
          padding: 28px;
          max-width: 1440px;
          margin: 0 auto;
          width: 100%;
        }

        /* Metrics Grid */
        .metrics-grid {
          display: grid;
          grid-template-columns: repeat(auto-fit, minmax(210px, 1fr));
          gap: 16px;
          margin-bottom: 24px;
        }
        .metric-card {
          background: #150426;
          border: 1.5px solid #2f0e52;
          border-radius: 18px;
          padding: 18px 20px;
        }
        .metric-label { font-size: 11px; font-weight: 800; color: #c4b5fd; margin-bottom: 6px; text-transform: uppercase; letter-spacing: 0.5px; }
        .metric-val { font-size: 1.85rem; font-weight: 900; color: #fff; }
        .metric-sub { font-size: 11px; color: #94a3b8; margin-top: 4px; }
        .metric-val.green { color: #4ade80; }
        .metric-val.orange { color: #ffa726; }
        .metric-val.purple { color: #c084fc; }
        .metric-val.cyan { color: #38bdf8; }

        /* Toolbar */
        .toolbar {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 16px;
          margin-bottom: 18px;
          flex-wrap: wrap;
        }
        .search-box {
          background: #140424;
          border: 1.5px solid #360f5c;
          border-radius: 12px;
          padding: 10px 16px;
          color: #fff;
          font-size: 13px;
          width: 320px;
          outline: none;
        }
        .search-box:focus { border-color: #ff851b; }

        /* Tables */
        .table-wrap {
          background: #140324;
          border: 1.5px solid #2e0e4f;
          border-radius: 18px;
          overflow-x: auto;
          box-shadow: 0 10px 30px rgba(0,0,0,0.5);
          margin-bottom: 24px;
        }
        table {
          width: 100%;
          border-collapse: collapse;
          font-size: 13px;
          text-align: left;
        }
        th {
          background: #1c0533;
          padding: 14px 18px;
          font-weight: 800;
          color: #d8b4fe;
          border-bottom: 1.5px solid #381163;
          white-space: nowrap;
        }
        td {
          padding: 14px 18px;
          border-bottom: 1px solid #240a3d;
          vertical-align: middle;
        }
        tr:hover td { background: rgba(37, 8, 66, 0.4); }
        .badge-status {
          display: inline-block;
          padding: 4px 10px;
          border-radius: 12px;
          font-size: 11px;
          font-weight: 800;
        }
        .status-active { background: rgba(34, 197, 94, 0.15); color: #4ade80; border: 1px solid #22c55e; }
        .status-revoked { background: rgba(239, 68, 68, 0.15); color: #f87171; border: 1px solid #ef4444; }
        
        .btn-table {
          padding: 6px 12px;
          border-radius: 8px;
          font-size: 11px;
          font-weight: 800;
          cursor: pointer;
          border: none;
          text-decoration: none;
          display: inline-flex;
          align-items: center;
          gap: 6px;
          transition: all 0.15s;
        }
        .btn-revoke { background: rgba(245, 158, 11, 0.18); border: 1px solid #f59e0b; color: #fbbf24; }
        .btn-revoke:hover { background: #f59e0b; color: #000; }
        .btn-restore { background: rgba(34, 197, 94, 0.18); border: 1px solid #22c55e; color: #4ade80; }
        .btn-restore:hover { background: #22c55e; color: #000; }
        .btn-delete { background: rgba(239, 68, 68, 0.18); border: 1px solid #ef4444; color: #f87171; }
        .btn-delete:hover { background: #ef4444; color: #fff; }
        .btn-view { background: rgba(168, 85, 247, 0.18); border: 1px solid #a855f7; color: #d8b4fe; }
        .btn-view:hover { background: #a855f7; color: #fff; }
        .btn-details { background: rgba(56, 189, 248, 0.18); border: 1px solid #38bdf8; color: #7dd3fc; }
        .btn-details:hover { background: #38bdf8; color: #000; }
        .actions-cell { display: flex; gap: 8px; align-items: center; }

        /* Banners Tab Grid */
        .slot-section {
          background: #140324;
          border: 1.5px solid #2e0e4f;
          border-radius: 20px;
          padding: 22px;
          margin-bottom: 24px;
        }
        .slot-title {
          font-size: 15px;
          font-weight: 800;
          color: #ffa726;
          display: flex;
          align-items: center;
          justify-content: space-between;
          margin-bottom: 16px;
        }
        .banners-grid {
          display: grid;
          grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
          gap: 16px;
        }
        .banner-card {
          background: #18042b;
          border: 1px solid #3b0e63;
          border-radius: 16px;
          padding: 16px;
          display: flex;
          flex-direction: column;
          gap: 12px;
          position: relative;
        }
        .banner-preview-box {
          width: 100%;
          height: 220px;
          background: #090112;
          border-radius: 12px;
          overflow: hidden;
          display: flex;
          align-items: center;
          justify-content: center;
          border: 1px solid #290947;
        }
        .banner-preview-box img, .banner-preview-box video {
          max-width: 100%;
          max-height: 100%;
          object-fit: contain;
        }
        .prob-badge {
          background: rgba(255, 109, 0, 0.18);
          border: 1px solid #ff6d00;
          color: #ffa726;
          font-size: 11px;
          font-weight: 800;
          padding: 3px 8px;
          border-radius: 10px;
        }
        .bar-container {
          background: #090112;
          border-radius: 8px;
          height: 8px;
          overflow: hidden;
          margin-top: 6px;
        }
        .bar-fill {
          height: 100%;
          border-radius: 8px;
          transition: width 0.3s;
        }

        /* Tab Content Control */
        .tab-content { display: none; }
        .tab-content.active { display: block; }

        .ann-lang-btn {
          background: #1c0533;
          border: 1px solid #451375;
          color: #cbd5e1;
          font-size: 11px;
          font-weight: 700;
          padding: 6px 12px;
          border-radius: 8px;
          cursor: pointer;
          transition: all 0.2s;
        }
        .ann-lang-btn:hover {
          background: #2a084d;
          border-color: #a855f7;
          color: #fff;
        }
        .ann-lang-btn.active {
          background: #7e22ce;
          border-color: #c084fc;
          color: #fff;
          box-shadow: 0 2px 10px rgba(168, 85, 247, 0.4);
        }
      </style>
    </head>
    <body>
      <header>
        <div class="header-brand">
          <img src="/logo.png" alt="Zylo" />
          <span class="header-badge" data-admin-key="badge_panel">🛡️ Panel Maestro</span>
        </div>

        <nav class="header-tabs">
          <button class="tab-btn active" id="tabbtn-clips" onclick="switchTab('clips')"><span data-admin-key="tab_clips">📁 Clips</span> (${totalClips})</button>
          <button class="tab-btn" id="tabbtn-banners" onclick="switchTab('banners')"><span data-admin-key="tab_banners">📢 Banners</span> (${bannersDb.length})</button>
          <button class="tab-btn" id="tabbtn-announcement" onclick="switchTab('announcement')"><span data-admin-key="tab_announcement">📣 Anuncio del Sistema</span></button>
          <button class="tab-btn" id="tabbtn-stats" onclick="switchTab('stats')"><span data-admin-key="tab_stats">📊 Estadísticas y Métricas</span></button>
        </nav>

        <div class="header-actions">
          <div style="display:flex; align-items:center;">
            <select id="adminLangSelector" onchange="changeAdminLanguage(this.value)" style="background:#20073b; border:1px solid #451375; color:#cbd5e1; padding:7px 10px; border-radius:10px; font-size:12px; font-weight:700; cursor:pointer;">
              <option value="es">🇪🇸 Español</option>
              <option value="en">🇺🇸 English</option>
              <option value="pt">🇧🇷 Português</option>
              <option value="fr">🇫🇷 Français</option>
              <option value="de">🇩🇪 Deutsch</option>
              <option value="ja">🇯🇵 日本語</option>
            </select>
          </div>
          <button type="button" class="btn-header btn-danger-header" onclick="openResetModal()"><span data-admin-key="btn_purge">🗑️ Purgar Datos</span></button>
          <a href="${baseUrl}/" class="btn-header" target="_blank"><span data-admin-key="btn_studio">🚀 Estudio</span></a>
          <button type="button" class="btn-header" onclick="openPasswordModal()"><span data-admin-key="btn_pwd">🔑 Contraseña</span></button>
          <a href="/${ADMIN_SECRET_PATH}/logout" class="btn-header"><span data-admin-key="btn_logout">Cerrar Sesión</span></a>
        </div>
      </header>

      <main>
        <!-- ========================================== -->
        <!-- TAB 1: CLIPS Y MODERACIÓN -->
        <!-- ========================================== -->
        <div class="tab-content active" id="tab-clips">
          <div class="metrics-grid">
            <div class="metric-card">
              <div class="metric-label">Total de Clips</div>
              <div class="metric-val purple">${totalClips}</div>
              <div class="metric-sub">Histórico almacenado</div>
            </div>
            <div class="metric-card">
              <div class="metric-label">Enlaces Activos</div>
              <div class="metric-val green">${activeCount}</div>
              <div class="metric-sub">Accesibles públicamente</div>
            </div>
            <div class="metric-card">
              <div class="metric-label">Revocados / Expirados</div>
              <div class="metric-val orange">${expiredCount}</div>
              <div class="metric-sub">Acceso bloqueado</div>
            </div>
            <div class="metric-card">
              <div class="metric-label">Almacenamiento en Disco</div>
              <div class="metric-val">${totalMB} MB</div>
              <div class="metric-sub">Carpeta uploads</div>
            </div>
          </div>

          <div class="toolbar">
            <input type="text" class="search-box" id="searchBox" placeholder="🔍 Buscar por ID, nombre o formato..." oninput="filterTable(this.value)" />
            <div style="font-size: 12px; color: #94a3b8;">
              Mostrando <span id="itemCount" style="color:#fff; font-weight:bold;">${items.length}</span> archivo(s)
            </div>
          </div>

          <div class="table-wrap">
            <table id="mediaTable">
              <thead>
                <tr>
                  <th>ID</th>
                  <th>Archivo</th>
                  <th>Tamaño</th>
                  <th>Fecha Subida</th>
                  <th>Visitas / Límite</th>
                  <th>Privacidad</th>
                  <th>Estado</th>
                  <th>Acciones de Moderación</th>
                </tr>
              </thead>
              <tbody>
                ${items.map(it => {
                  const isVideo = it.mimetype && it.mimetype.startsWith('video/');
                  const isExp = it.publicExpired || (Date.now() >= it.expiresAt);
                  const sizeMB = ((it.size || 0) / (1024 * 1024)).toFixed(2);
                  const dateStr = new Date(it.createdAt).toLocaleString();
                  const priv = it.privacy || {};
                  const privBadges = [];
                  if (priv.active) privBadges.push('🛡️ Privado');
                  
                  if (priv.uniqueDevicesOnly) privBadges.push('👥 Disp. Únicos');
                  if (priv.watermarkEnabled !== false) privBadges.push('💧 Marca');

                  return `
                    <tr id="row-${it.id}" data-search="${it.id} ${it.originalName} ${it.filename}">
                      <td style="font-family: monospace; font-weight: bold; color: #ffa726;">${it.id}</td>
                      <td>
                        <div style="font-weight: 700; color: #fff;">${isVideo ? '🎥' : '📷'} ${it.originalName}</div>
                        <div style="font-size: 11px; color: #94a3b8; font-family: monospace;">${it.filename}</div>
                      </td>
                      <td>${sizeMB} MB</td>
                      <td style="font-size: 11px; color: #cbd5e1;">${dateStr}</td>
                      <td style="font-weight: 700;">${it.views || 0} / ${priv.maxViews > 0 ? priv.maxViews : '∞'}</td>
                      <td>
                        <span style="font-size: 11px; color: #d8b4fe;">${privBadges.length > 0 ? privBadges.join(' • ') : 'Normal'}</span>
                      </td>
                      <td>
                        <span class="badge-status ${isExp ? 'status-revoked' : 'status-active'}" id="status-${it.id}">
                          ${isExp ? '🔴 Revocado' : '🟢 Activo'}
                        </span>
                      </td>
                      <td>
                        <div class="actions-cell">
                          <button class="btn-table btn-view" onclick="previewClipModal('${it.id}', '${encodeURIComponent(it.originalName)}', '${isVideo ? 'video' : 'image'}', '${r2.getPublicClipUrl(it) || ''}')">▶ Ver</button>
                          <button class="btn-table btn-details" onclick="openAuditModal('${it.id}')" title="Ver IP, dispositivo de subida e historial de visitas">📊 Auditoría</button>
                          ${it.privacy?.active ? 
                            '<a href="' + baseUrl + '/v/' + it.id + '" target="_blank" class="btn-table btn-view" title="Ver como Público">🌐 Ver como Público</a>' +
                            '<a href="' + baseUrl + '/v/' + it.id + '?key=' + it.adminSecret + '" target="_blank" class="btn-table btn-view" title="Ver como Creador">👑 Ver como Creador</a>'
                          :
                            '<a href="' + baseUrl + '/v/' + it.id + '?key=' + it.adminSecret + '" target="_blank" class="btn-table btn-view" title="Ver Clip">🌐 Ver Clip</a>'
                          }
                          <button class="btn-table btn-revoke" onclick="toggleRevoke('${it.id}')" id="btn-rev-${it.id}">
                            ${isExp ? '♻️ Reactivar' : '🛑 Revocar'}
                          </button>
                          <button class="btn-table btn-delete" onclick="deleteClip('${it.id}')" title="Borrar de disco">🗑️</button>
                        </div>
                      </td>
                    </tr>
                  `;
                }).join('')}
              </tbody>
            </table>
          </div>
        </div>

        <!-- ========================================== -->
        <!-- TAB 2: BANNERS Y ANUNCIOS -->
        <!-- ========================================== -->
        <div class="tab-content" id="tab-banners">
          <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:20px; flex-wrap:wrap; gap:14px;">
            <div>
              <h2 style="font-size:18px; font-weight:800; color:#fff;">📢 Anuncios y Patrocinadores (AdBlock-Proof)</h2>
              <p style="font-size:12px; color:#cbd5e1; margin-top:2px;">Banners servidos directamente desde Zylo en las ubicaciones laterales y WebApp móvil. Cuotas configurables y segmentadas por idioma.</p>
            </div>
            <div style="display:flex; gap:10px; flex-wrap:wrap;">
              <button class="btn-table" style="background:#20073b; border:1px solid #7e22ce; color:#d8b4fe; font-size:13px; padding:10px 16px; border-radius:12px;" onclick="toggleQuotaConfigBox()">⚙️ Ajustar Cuotas por Idioma</button>
              <button class="btn-table" style="background:linear-gradient(135deg, #ffa726, #ff6d00); color:#0c0118; font-size:13px; padding:10px 18px; border-radius:12px;" onclick="openNewBannerModal()">+ Subir Nuevo Anuncio</button>
            </div>
          </div>

          <!-- Language Quotas Configuration Panel -->
          <div id="quotaConfigBox" style="display:none; background:#120224; border:1px solid #4a157c; border-radius:16px; padding:16px 20px; margin-bottom:22px; box-shadow:0 8px 30px rgba(0,0,0,0.6);">
            <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:12px; flex-wrap:wrap; gap:8px;">
              <div>
                <div style="font-size:13px; font-weight:800; color:#ffa726;">⚙️ Base de Cuota de Visitas por Idioma</div>
                <div style="font-size:11px; color:#cbd5e1; margin-top:2px;">Ajusta la cuota base de impresiones por idioma (ej. 200 o 500 para inglés si hay más anuncios, 100 para español, etc.)</div>
              </div>
              <button onclick="saveLanguageQuotas()" class="btn-table" style="background:#22c55e; color:#000; font-weight:800; font-size:11px; padding:7px 16px; border-radius:8px;">💾 Guardar Cuotas</button>
            </div>
            <div style="display:grid; grid-template-columns:repeat(auto-fit, minmax(130px, 1fr)); gap:10px;">
              <div>
                <label style="font-size:11px; color:#c4b5fd; font-weight:700;">🌐 Global (all):</label>
                <input type="number" id="quota-base-all" value="${quotaConfig.all || 100}" min="10" max="10000" style="width:100%; box-sizing:border-box; margin-top:4px; background:#190432; border:1px solid #451375; color:#fff; padding:6px 10px; border-radius:8px; font-size:12px;" />
              </div>
              <div>
                <label style="font-size:11px; color:#c4b5fd; font-weight:700;">🇺🇸 English (en):</label>
                <input type="number" id="quota-base-en" value="${quotaConfig.en || 100}" min="10" max="10000" style="width:100%; box-sizing:border-box; margin-top:4px; background:#190432; border:1px solid #451375; color:#fff; padding:6px 10px; border-radius:8px; font-size:12px;" />
              </div>
              <div>
                <label style="font-size:11px; color:#c4b5fd; font-weight:700;">🇪🇸 Español (es):</label>
                <input type="number" id="quota-base-es" value="${quotaConfig.es || 100}" min="10" max="10000" style="width:100%; box-sizing:border-box; margin-top:4px; background:#190432; border:1px solid #451375; color:#fff; padding:6px 10px; border-radius:8px; font-size:12px;" />
              </div>
              <div>
                <label style="font-size:11px; color:#c4b5fd; font-weight:700;">🇧🇷 Português (pt):</label>
                <input type="number" id="quota-base-pt" value="${quotaConfig.pt || 100}" min="10" max="10000" style="width:100%; box-sizing:border-box; margin-top:4px; background:#190432; border:1px solid #451375; color:#fff; padding:6px 10px; border-radius:8px; font-size:12px;" />
              </div>
              <div>
                <label style="font-size:11px; color:#c4b5fd; font-weight:700;">🇫🇷 Français (fr):</label>
                <input type="number" id="quota-base-fr" value="${quotaConfig.fr || 100}" min="10" max="10000" style="width:100%; box-sizing:border-box; margin-top:4px; background:#190432; border:1px solid #451375; color:#fff; padding:6px 10px; border-radius:8px; font-size:12px;" />
              </div>
              <div>
                <label style="font-size:11px; color:#c4b5fd; font-weight:700;">🇩🇪 Deutsch (de):</label>
                <input type="number" id="quota-base-de" value="${quotaConfig.de || 100}" min="10" max="10000" style="width:100%; box-sizing:border-box; margin-top:4px; background:#190432; border:1px solid #451375; color:#fff; padding:6px 10px; border-radius:8px; font-size:12px;" />
              </div>
              <div>
                <label style="font-size:11px; color:#c4b5fd; font-weight:700;">🇯🇵 日本語 (ja):</label>
                <input type="number" id="quota-base-ja" value="${quotaConfig.ja || 100}" min="10" max="10000" style="width:100%; box-sizing:border-box; margin-top:4px; background:#190432; border:1px solid #451375; color:#fff; padding:6px 10px; border-radius:8px; font-size:12px;" />
              </div>
            </div>
          </div>

          ${['studio_left', 'studio_right', 'viewer_left', 'viewer_right', 'mobile_webapp'].map(slotKey => {
            const slotBanners = bannersDb.filter(b => b.slot === slotKey);
            const totalSlotW = slotWeights[slotKey] || 0;

            return `
              <div class="slot-section">
                <div class="slot-title">
                  <span>${slotLabels[slotKey]}</span>
                  <span style="font-size:12px; color:#c4b5fd; font-weight:700;">${slotBanners.length} anuncio(s) configurado(s)</span>
                </div>

                ${slotBanners.length === 0 ? `
                  <div style="color:#94a3b8; font-size:12px; font-style:italic; padding:12px 0;">No hay banners asignados a esta posición. Haz clic en "Subir Nuevo Anuncio" arriba para añadir uno.</div>
                ` : `
                  <div class="banners-grid">
                    ${slotBanners.map(b => {
                      const isActive = b.active !== false;
                      const weightNum = Math.max(1, parseInt(b.weight, 10) || 1);
                      const bLangs = Array.isArray(b.languages) && b.languages.length > 0 ? b.languages : ['all'];
                      const primaryLang = bLangs[0] || 'all';
                      const targetBase = quotaConfig[primaryLang] || quotaConfig.all || 100;
                      const pct = Math.min(100, Math.round((weightNum / targetBase) * 100));
                      const isVid = b.mediaType === 'video' || (b.mediaUrl && b.mediaUrl.match(/\.(mp4|webm)($|\?)/i));
                      const ctrVal = b.impressions > 0 ? ((b.clicks / b.impressions) * 100).toFixed(2) : '0.00';

                      const langBadges = bLangs.map(l => {
                        const meta = LANG_NAMES[l] || { name: l.toUpperCase(), flag: '🌐' };
                        return `<span style="background:rgba(192, 132, 252, 0.15); border:1px solid #7e22ce; color:#d8b4fe; font-size:10px; font-weight:800; padding:2px 7px; border-radius:8px;">${meta.flag} ${l.toUpperCase()}</span>`;
                      }).join(' ');

                      const bGeo = b.geoStats || { countries: {}, languages: {} };
                      const sortedCountries = Object.entries(bGeo.countries || {}).sort((a, b) => (b[1].impressions || 0) - (a[1].impressions || 0));
                      const countryRowsHtml = sortedCountries.length === 0
                        ? '<div style="color:#64748b; font-size:11px; font-style:italic; padding:4px 0;">Sin visitas registradas con IP geográfica aún</div>'
                        : sortedCountries.slice(0, 8).map(([cCode, cData]) => {
                            const cName = COUNTRY_NAMES[cCode] || cCode;
                            const flag = getCountryFlag(cCode);
                            const cCtr = cData.impressions > 0 ? ((cData.clicks / cData.impressions) * 100).toFixed(1) : '0.0';
                            return `
                              <div style="display:flex; justify-content:space-between; align-items:center; padding:4px 0; border-bottom:1px dashed #20073b; font-size:11px;">
                                <span>${flag} <strong style="color:#fff;">${cName}</strong> <span style="color:#64748b; font-size:10px;">(${cCode})</span></span>
                                <span style="color:#cbd5e1;">${cData.impressions} imp • <strong style="color:#ffa726;">${cData.clicks} clics</strong> <span style="color:#4ade80; font-size:10px;">(${cCtr}%)</span></span>
                              </div>
                            `;
                          }).join('');

                      const sortedLangs = Object.entries(bGeo.languages || {}).sort((a, b) => (b[1].impressions || 0) - (a[1].impressions || 0));
                      const langRowsHtml = sortedLangs.length === 0
                        ? '<div style="color:#64748b; font-size:11px; font-style:italic; padding:4px 0;">Sin visitas registradas por idioma aún</div>'
                        : sortedLangs.slice(0, 8).map(([lCode, lData]) => {
                            const lMeta = LANG_NAMES[lCode] || { name: lCode.toUpperCase(), flag: '🌐' };
                            const lCtr = lData.impressions > 0 ? ((lData.clicks / lData.impressions) * 100).toFixed(1) : '0.0';
                            return `
                              <div style="display:flex; justify-content:space-between; align-items:center; padding:4px 0; border-bottom:1px dashed #20073b; font-size:11px;">
                                <span>${lMeta.flag} <strong style="color:#fff;">${lMeta.name}</strong> <span style="color:#64748b; font-size:10px;">(${lCode})</span></span>
                                <span style="color:#cbd5e1;">${lData.impressions} imp • <strong style="color:#38bdf8;">${lData.clicks} clics</strong> <span style="color:#4ade80; font-size:10px;">(${lCtr}%)</span></span>
                              </div>
                            `;
                          }).join('');

                      return `
                        <div class="banner-card" id="bcard-${b.id}">
                          <div class="banner-preview-box">
                            ${isVid 
                              ? `<video src="${b.mediaUrl}" autoplay loop muted playsinline></video>`
                              : `<img src="${b.mediaUrl}" alt="${b.name}" />`
                            }
                          </div>
                          <div>
                            <div style="font-weight:800; color:#fff; font-size:13px;">${b.name}</div>
                            <div style="font-size:11px; color:#ffa726; word-break:break-all; margin-top:2px;">
                              <a href="${b.targetUrl}" target="_blank" style="color:#ffa726; text-decoration:none;">🔗 ${b.targetUrl}</a>
                            </div>
                            <div style="display:flex; flex-wrap:wrap; gap:4px; margin-top:6px; align-items:center;">
                              <span style="font-size:10px; color:#c4b5fd; font-weight:700;">Idiomas:</span>
                              ${langBadges}
                            </div>
                          </div>

                          <div style="background:#110220; padding:10px; border-radius:10px; border:1px solid #2e094f; font-size:11px; display:flex; flex-direction:column; gap:4px;">
                            <div style="display:flex; justify-content:space-between; align-items:center;">
                              <span style="color:#c4b5fd;">Cuota (${bLangs.map(l => l.toUpperCase()).join('/')}):</span>
                              <span class="prob-badge">🎯 ${weightNum} de ${targetBase} (${pct}%)</span>
                            </div>
                            <div class="bar-container">
                              <div class="bar-fill" style="width:${pct}%; background:linear-gradient(90deg, #ff6d00, #ffa726);"></div>
                            </div>
                            <div style="display:flex; justify-content:space-between; color:#cbd5e1; margin-top:4px;">
                              <span>👁️ ${b.impressions || 0} imp.</span>
                              <span>🖱️ ${b.clicks || 0} clics</span>
                              <span style="color:#4ade80; font-weight:bold;">📈 ${ctrVal}% CTR</span>
                            </div>
                          </div>

                          <!-- Collapsible Geo & Language breakdown -->
                          <div style="margin-top:2px;">
                            <button type="button" class="btn-table" style="background:#20073b; border:1px solid #451375; color:#c4b5fd; font-size:11px; width:100%; justify-content:center; padding:7px; border-radius:10px; cursor:pointer;" onclick="toggleGeoStats('${b.id}')">
                              📊 Desplegar Desglose por País e Idioma ▾
                            </button>
                            <div id="geostats-${b.id}" style="display:none; background:#0c0117; border:1px solid #2e094f; border-radius:10px; padding:12px; margin-top:8px;">
                              <div style="font-weight:800; color:#ffa726; margin-bottom:6px; font-size:11px; display:flex; justify-content:space-between;">
                                <span>🌍 Países con más visitas:</span>
                                <span style="color:#94a3b8; font-size:10px;">(Orden de más a menos)</span>
                              </div>
                              ${countryRowsHtml}

                              <div style="height:1px; background:#290947; margin:10px 0;"></div>

                              <div style="font-weight:800; color:#38bdf8; margin-bottom:6px; font-size:11px; display:flex; justify-content:space-between;">
                                <span>🗣️ Idiomas del público:</span>
                                <span style="color:#94a3b8; font-size:10px;">(Orden de más a menos)</span>
                              </div>
                              ${langRowsHtml}
                            </div>
                          </div>

                          <div style="display:flex; justify-content:space-between; align-items:center; margin-top:4px; gap:6px;">
                            <button class="btn-table ${isActive ? 'btn-restore' : 'btn-revoke'}" onclick="toggleBannerActive('${b.id}')" id="btn-btoggle-${b.id}">
                              ${isActive ? '🟢 Activo' : '⚪ En Pausa'}
                            </button>
                            <button class="btn-table" style="background:#2563eb; border:1px solid #3b82f6; color:#fff;" onclick="openEditBannerModal('${b.id}')" title="Editar este anuncio">✏️ Editar</button>
                            <button class="btn-table btn-delete" onclick="deleteBanner('${b.id}')" title="Eliminar este banner">🗑️ Eliminar</button>
                          </div>
                        </div>
                      `;
                    }).join('')}
                  </div>
                `}
              </div>
            `;
          }).join('')}
        </div>

        <!-- ========================================== -->
        <!-- TAB 3: ESTADÍSTICAS Y MÉTRICAS -->
        <!-- ========================================== -->
        <div class="tab-content" id="tab-stats">
          <!-- Backup & Safeguard Metrics Toolbar -->
          <div style="display:flex; flex-wrap:wrap; align-items:center; justify-content:space-between; gap:12px; margin-bottom:14px; background:#10021f; border:1px solid #3b82f6; padding:12px 18px; border-radius:16px;">
            <div style="display:flex; align-items:center; gap:8px;">
              <span style="font-size:18px;">💾</span>
              <div>
                <div style="font-size:12px; font-weight:800; color:#38bdf8;">Resguardo y Respaldo de Métricas</div>
                <div style="font-size:10px; color:#cbd5e1;">Descarga o restaura el historial de visitas, clics y rendimiento de anuncios</div>
              </div>
            </div>
            <div style="display:flex; gap:8px; flex-wrap:wrap;">
              <a href="/api/admin/export-stats" class="btn-table" style="background:#0284c7; color:#fff; text-decoration:none; padding:8px 14px; border-radius:10px; font-size:12px; font-weight:700; display:flex; align-items:center; gap:6px;" download>
                📥 Descargar Respaldo (JSON)
              </a>
              <a href="/api/admin/export-stats-csv" class="btn-table" style="background:#16a34a; color:#fff; text-decoration:none; padding:8px 14px; border-radius:10px; font-size:12px; font-weight:700; display:flex; align-items:center; gap:6px;" download>
                📊 Exportar a Excel (CSV)
              </a>
              <button type="button" class="btn-table" style="background:#7c3aed; color:#fff; padding:8px 14px; border-radius:10px; font-size:12px; font-weight:700; display:flex; align-items:center; gap:6px; cursor:pointer;" onclick="document.getElementById('importStatsInput').click()">
                📤 Restaurar Respaldo
              </button>
              <input type="file" id="importStatsInput" accept=".json" style="display:none;" onchange="importStatsBackupFile(this.files)" />
            </div>
          </div>

          <!-- Period Filter Toolbar -->
          <div style="display:flex; flex-wrap:wrap; align-items:center; justify-content:space-between; gap:12px; margin-bottom:20px; background:#140324; border:1px solid #360f5c; padding:12px 18px; border-radius:16px;">
            <div style="display:flex; align-items:center; gap:8px;">
              <span style="font-size:16px;">⏱️</span>
              <span style="font-size:12px; font-weight:800; color:#c084fc; text-transform:uppercase; letter-spacing:0.04em;">Filtrar Estadísticas por Período:</span>
            </div>
            <div style="display:flex; gap:6px; flex-wrap:wrap;">
              <button type="button" class="period-filter-btn" data-period="today" onclick="switchPeriod('today')">📅 Hoy</button>
              <button type="button" class="period-filter-btn" data-period="24h" onclick="switchPeriod('24h')">⏱️ Últimas 24h</button>
              <button type="button" class="period-filter-btn" data-period="7d" onclick="switchPeriod('7d')">🗓️ Últimos 7 días</button>
              <button type="button" class="period-filter-btn" data-period="30d" onclick="switchPeriod('30d')">📆 Últimos 30 días</button>
              <button type="button" class="period-filter-btn active" data-period="all" onclick="switchPeriod('all')">🌐 Todo el tiempo</button>
            </div>
          </div>

          <div class="metrics-grid">
            <div class="metric-card">
              <div class="metric-label">Visitas Estudio (PC)</div>
              <div class="metric-val purple" id="metric-studio-visits">${statsDb.studioVisits || 0}</div>
              <div class="metric-sub">Página principal</div>
            </div>
            <div class="metric-card">
              <div class="metric-label">Visitas Reproductor</div>
              <div class="metric-val green" id="metric-viewer-visits">${statsDb.viewerVisits || 0}</div>
              <div class="metric-sub">Vistas a clips /v/:id</div>
            </div>
            <div class="metric-card">
              <div class="metric-label">Visitas WebApp (Móvil)</div>
              <div class="metric-val cyan" id="metric-webapp-visits">${statsDb.webappVisits || 0}</div>
              <div class="metric-sub">Acceso desde celulares</div>
            </div>
            <div class="metric-card">
              <div class="metric-label">👥 Usuarios Nuevos</div>
              <div class="metric-val orange" id="metric-new-users">${statsDb.newUsersTotal || 0}</div>
              <div class="metric-sub">Visitantes por primera vez</div>
            </div>
            <div class="metric-card">
              <div class="metric-label">Clips Creados Totales</div>
              <div class="metric-val orange" id="metric-clips-total">${statsDb.clipsCreatedTotal || 0}</div>
              <div class="metric-sub">Histórico registrado</div>
            </div>
            <div class="metric-card">
              <div class="metric-label">💾 Espacio en Disco</div>
              <div class="metric-val green" id="metric-disk-used">${disk.mb} MB</div>
              <div class="metric-sub" id="metric-disk-sub">${disk.files} archivos en uploads</div>
            </div>
            <div class="metric-card">
              <div class="metric-label">Tiempo Grabado Total</div>
              <div class="metric-val" id="metric-rec-mins">${recordedMins} m</div>
              <div class="metric-sub" id="metric-rec-hours">${recordedHours} horas en total</div>
            </div>
            <div class="metric-card">
              <div class="metric-label">Tiempo Visto en Player</div>
              <div class="metric-val green" id="metric-watch-mins">${watchMins} m</div>
              <div class="metric-sub" id="metric-watch-hours">${watchHours} horas reproducidas</div>
            </div>
            <div class="metric-card">
              <div class="metric-label">Clics Totales Banners</div>
              <div class="metric-val cyan" id="metric-banner-clicks">${statsDb.bannerClicksTotal || 0}</div>
              <div class="metric-sub" id="metric-banner-ctr">CTR Global: ${globalCtr}%</div>
            </div>
            <div class="metric-card">
              <div class="metric-label">Clips Privacidad Extra</div>
              <div class="metric-val purple" id="metric-privacy-clips">${statsDb.privacyClipsTotal || 0}</div>
              <div class="metric-sub">Con sesión/visitas limitadas</div>
            </div>
          </div>

          <!-- Breakdowns Grid -->
          <div style="display:grid; grid-template-columns:repeat(auto-fit, minmax(360px, 1fr)); gap:20px; margin-bottom:24px;">
            <!-- Devices Breakdown -->
            <div style="background:#140324; border:1.5px solid #2e0e4f; border-radius:20px; padding:20px;">
              <h3 style="font-size:14px; font-weight:800; color:#ffa726; margin-bottom:14px;">📱 Distribución por Tipo de Dispositivo</h3>
              ${[
                { id: 'desktop', label: 'Escritorio (PC / Mac / Linux)', count: statsDb.deviceBreakdown.desktop || 0, color: '#a855f7' },
                { id: 'mobile', label: 'Teléfono Móvil (Android / iOS)', count: statsDb.deviceBreakdown.mobile || 0, color: '#38bdf8' },
                { id: 'tablet', label: 'Tablet (iPad / Android Tablet)', count: statsDb.deviceBreakdown.tablet || 0, color: '#4ade80' }
              ].map(d => {
                const pct = Math.round((d.count / devTotal) * 100);
                return `
                  <div style="margin-bottom:12px;">
                    <div style="display:flex; justify-content:space-between; font-size:12px; color:#cbd5e1; font-weight:700;">
                      <span>${d.label}</span>
                      <span id="dev-${d.id}-text">${d.count} (${pct}%)</span>
                    </div>
                    <div class="bar-container">
                      <div class="bar-fill" id="dev-${d.id}-bar" style="width:${pct}%; background:${d.color};"></div>
                    </div>
                  </div>
                `;
              }).join('')}
            </div>

            <!-- Browsers Breakdown -->
            <div style="background:#140324; border:1.5px solid #2e0e4f; border-radius:20px; padding:20px;">
              <h3 style="font-size:14px; font-weight:800; color:#38bdf8; margin-bottom:14px;">🌐 Navegadores de los Usuarios</h3>
              ${[
                { id: 'chrome', label: 'Google Chrome', count: statsDb.browserBreakdown.chrome || 0, color: '#ffa726' },
                { id: 'edge', label: 'Microsoft Edge', count: statsDb.browserBreakdown.edge || 0, color: '#38bdf8' },
                { id: 'firefox', label: 'Mozilla Firefox', count: statsDb.browserBreakdown.firefox || 0, color: '#f97316' },
                { id: 'safari', label: 'Apple Safari', count: statsDb.browserBreakdown.safari || 0, color: '#a855f7' },
                { id: 'opera', label: 'Opera', count: statsDb.browserBreakdown.opera || 0, color: '#ef4444' },
                { id: 'discord', label: 'Discord In-App / Bot', count: statsDb.browserBreakdown.discord || 0, color: '#5865F2' },
                { id: 'other', label: 'Otros Navegadores', count: statsDb.browserBreakdown.other || 0, color: '#64748b' }
              ].map(b => {
                const pct = Math.round((b.count / brTotal) * 100);
                return `
                  <div style="margin-bottom:8px;">
                    <div style="display:flex; justify-content:space-between; font-size:11px; color:#cbd5e1; font-weight:700;">
                      <span>${b.label}</span>
                      <span id="br-${b.id}-text">${b.count} (${pct}%)</span>
                    </div>
                    <div class="bar-container" style="height:6px;">
                      <div class="bar-fill" id="br-${b.id}-bar" style="width:${pct}%; background:${b.color};"></div>
                    </div>
                  </div>
                `;
              }).join('')}
            </div>

            <!-- Country Breakdown -->
            <div style="background:#140324; border:1.5px solid #2e0e4f; border-radius:20px; padding:20px;">
              <h3 style="font-size:14px; font-weight:800; color:#4ade80; margin-bottom:14px;">🌍 Top Países Visitantes (GeoIP)</h3>
              ${countryEntries.length === 0 ? '<div style="color:#64748b; font-size:12px; font-style:italic;">Aún no hay visitas registradas con IP geográfica.</div>' :
                countryEntries.slice(0, 7).map(([cCode, count], idx) => {
                  const pct = Math.round((count / totalCountryVisits) * 100);
                  const cName = COUNTRY_NAMES[cCode] || cCode;
                  const flag = getCountryFlag(cCode);
                  const colors = ['#4ade80', '#22c55e', '#10b981', '#14b8a6', '#06b6d4', '#0ea5e9', '#3b82f6'];
                  return `
                    <div style="margin-bottom:8px;">
                      <div style="display:flex; justify-content:space-between; font-size:11px; color:#cbd5e1; font-weight:700;">
                        <span>${flag} ${cName} <span style="color:#64748b; font-size:10px;">(${cCode})</span></span>
                        <span>${count} (${pct}%)</span>
                      </div>
                      <div class="bar-container" style="height:6px;">
                        <div class="bar-fill" style="width:${pct}%; background:${colors[idx % colors.length]};"></div>
                      </div>
                    </div>
                  `;
                }).join('')
              }
            </div>

            <!-- Language Breakdown -->
            <div style="background:#140324; border:1.5px solid #2e0e4f; border-radius:20px; padding:20px;">
              <h3 style="font-size:14px; font-weight:800; color:#c084fc; margin-bottom:14px;">🗣️ Top Idiomas Detectados</h3>
              ${langEntries.length === 0 ? '<div style="color:#64748b; font-size:12px; font-style:italic;">Aún no hay visitas registradas por idioma.</div>' :
                langEntries.slice(0, 7).map(([lCode, count], idx) => {
                  const pct = Math.round((count / totalLangVisits) * 100);
                  const meta = LANG_NAMES[lCode] || { name: lCode.toUpperCase(), flag: '🌐' };
                  const colors = ['#c084fc', '#a855f7', '#9333ea', '#7e22ce', '#6b21a8', '#581c87', '#ec4899'];
                  return `
                    <div style="margin-bottom:8px;">
                      <div style="display:flex; justify-content:space-between; font-size:11px; color:#cbd5e1; font-weight:700;">
                        <span>${meta.flag} ${meta.name} <span style="color:#64748b; font-size:10px;">(${lCode})</span></span>
                        <span>${count} (${pct}%)</span>
                      </div>
                      <div class="bar-container" style="height:6px;">
                        <div class="bar-fill" style="width:${pct}%; background:${colors[idx % colors.length]};"></div>
                      </div>
                    </div>
                  `;
                }).join('')
              }
            </div>
          </div>

          <!-- Banners Individual Performance Table -->
          <div class="table-wrap">
            <div style="padding:16px 20px; border-bottom:1px solid #360f5c; display:flex; justify-content:space-between; align-items:center;">
              <h3 style="font-size:14px; font-weight:800; color:#fff;">📊 Rendimiento Detallado por Anuncio</h3>
              <span style="font-size:12px; color:#94a3b8;">${bannersDb.length} anuncio(s) monitoreado(s)</span>
            </div>
            <table>
              <thead>
                <tr>
                  <th>Nombre del Anuncio</th>
                  <th>Ubicación / Slot</th>
                  <th>Idiomas</th>
                  <th>Impresiones</th>
                  <th>Clics Recibidos</th>
                  <th>CTR (%)</th>
                  <th>Estado</th>
                  <th>Acción</th>
                </tr>
              </thead>
              <tbody>
                ${bannersDb.map(b => {
                  const ctrVal = b.impressions > 0 ? ((b.clicks / b.impressions) * 100).toFixed(2) : '0.00';
                  const isActive = b.active !== false;
                  const langs = (b.languages || ['all']).map(l => (LANG_NAMES[l]?.flag || '🌐') + ' ' + l.toUpperCase()).join(', ');
                  return `
                    <tr>
                      <td style="font-weight:700; color:#fff;">${b.name}</td>
                      <td style="font-size:11px; color:#c4b5fd;">${slotLabels[b.slot] || b.slot}</td>
                      <td style="font-size:11px; color:#cbd5e1;">${langs}</td>
                      <td>${b.impressions || 0}</td>
                      <td style="font-weight:700; color:#ffa726;">${b.clicks || 0}</td>
                      <td style="font-weight:800; color:#4ade80;">${ctrVal}%</td>
                      <td>
                        <span class="badge-status ${isActive ? 'status-active' : 'status-revoked'}">
                          ${isActive ? 'Activo' : 'En Pausa'}
                        </span>
                      </td>
                      <td>
                        <button class="btn-table" style="background:#2563eb; color:#fff; font-size:11px; padding:4px 8px; border-radius:6px; cursor:pointer;" onclick="openEditBannerModal('${b.id}')" title="Editar este anuncio">✏️ Editar</button>
                      </td>
                    </tr>
                  `;
                }).join('')}
              </tbody>
            </table>
          </div>

          ${statsDb.lastResetAt ? `
            <div style="text-align:right; font-size:11px; color:#94a3b8; font-style:italic;">
              ℹ️ Último reseteo de pruebas: ${new Date(statsDb.lastResetAt).toLocaleString()}
            </div>
          ` : ''}
        </div>

        <!-- ========================================== -->
        <!-- TAB 4: ANUNCIO GLOBAL DEL SISTEMA -->
        <!-- ========================================== -->
        <div class="tab-content" id="tab-announcement">
          <div style="background:#140324; border:1.5px solid #2e0e4f; border-radius:20px; padding:24px; margin-bottom:24px;">
            <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:18px;">
              <div>
                <h3 style="font-size:16px; font-weight:800; color:#ffa726;">📣 Anuncio Global del Sistema</h3>
                <p style="font-size:12px; color:#cbd5e1; margin-top:2px;">
                  Este anuncio se mostrará como ventana emergente a todos los usuarios que abran Zylo Estudio o la WebApp.
                </p>
              </div>
              <div style="display:flex; align-items:center; gap:10px;">
                <span id="announcementLiveBadge" class="badge-status ${announcementData.active ? 'status-active' : 'status-revoked'}">
                  ${announcementData.active ? 'Activo y Visible' : 'Inactivo / Oculto'}
                </span>
              </div>
            </div>

            <!-- Explanatory Guide Box -->
            <div style="background:#0c0117; border:1px solid #360f5c; border-radius:14px; padding:14px 18px; margin-bottom:20px; font-size:12px; line-height:1.6; color:#cbd5e1;">
              <div style="font-weight:800; color:#ffa726; margin-bottom:4px; font-size:13px;">💡 Guía de Funcionamiento y Controles:</div>
              <div>• <strong>Switch Activo / Inactivo:</strong> Si está apagado, el anuncio queda guardado pero invisible para los usuarios. Si está encendido, se mostrará al cargar la app.</div>
              <div>• <strong>Pestañas de Idioma y Traducción IA ✨:</strong> Redacta en Español y presiona <em>Traducir automáticamente con IA</em> para generar las versiones en Inglés, Portugués, Francés, Alemán y Japonés. Puedes editar cada una por separado.</div>
              <div>• <strong>Guardar y Publicar 🚀:</strong> Guarda los textos, idiomas y archivos adjuntos en el servidor y genera una versión nueva para que todos los usuarios lo reciban (incluso si ya cerraron anuncios anteriores).</div>
            </div>

            <div style="display:grid; grid-template-columns:repeat(auto-fit, minmax(360px, 1fr)); gap:24px;">
              <!-- Form -->
              <form id="announcementForm" onsubmit="submitAnnouncement(event)">
                <!-- Language Selector Bar with Auto-Translate Button -->
                <div style="background:#0c0117; padding:12px 14px; border-radius:14px; border:1px solid #360f5c; margin-bottom:16px;">
                  <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:10px; flex-wrap:wrap; gap:8px;">
                    <div style="font-size:11px; font-weight:800; color:#c084fc; text-transform:uppercase;">🌐 Idioma de Edición:</div>
                    <button type="button" id="btnAutoTranslate" onclick="autoTranslateAnnouncement()" style="background:linear-gradient(135deg, #a855f7, #6366f1); border:none; color:#fff; font-size:11px; font-weight:800; padding:6px 12px; border-radius:8px; cursor:pointer; display:flex; align-items:center; gap:5px; box-shadow:0 3px 12px rgba(168, 85, 247, 0.4);">
                      ✨ Traducir automáticamente con IA
                    </button>
                  </div>
                  <div style="display:flex; gap:6px; flex-wrap:wrap;" id="annLangTabsContainer">
                    <button type="button" class="ann-lang-btn active" data-lang="es" onclick="switchAnnouncementLang('es')">🇪🇸 Español (Original)</button>
                    <button type="button" class="ann-lang-btn" data-lang="en" onclick="switchAnnouncementLang('en')">🇺🇸 English</button>
                    <button type="button" class="ann-lang-btn" data-lang="pt" onclick="switchAnnouncementLang('pt')">🇧🇷 Português</button>
                    <button type="button" class="ann-lang-btn" data-lang="fr" onclick="switchAnnouncementLang('fr')">🇫🇷 Français</button>
                    <button type="button" class="ann-lang-btn" data-lang="de" onclick="switchAnnouncementLang('de')">🇩🇪 Deutsch</button>
                    <button type="button" class="ann-lang-btn" data-lang="ja" onclick="switchAnnouncementLang('ja')">🇯🇵 日本語</button>
                  </div>
                </div>

                <div style="margin-bottom:14px;">
                  <label style="display:block; font-size:11px; font-weight:700; color:#cbd5e1; margin-bottom:5px;">Título del Anuncio (<span id="lblCurrentAnnLang" style="color:#ffa726;">Español</span>):</label>
                  <input type="text" id="annInputTitle" value="${(announcementData.title || '').replace(/"/g, '&quot;')}" required placeholder="Ej: ¡Gran Actualización: Modo Pérdida Cero y Filtros!" style="width:100%; box-sizing:border-box; background:#10021f; border:1px solid #451375; color:#fff; padding:10px 14px; border-radius:10px; font-size:13px;" oninput="onAnnouncementFieldChange('title', this.value)" />
                </div>

                <div style="margin-bottom:14px;">
                  <label style="display:block; font-size:11px; font-weight:700; color:#cbd5e1; margin-bottom:5px;">Mensaje / Descripción de la Actualización (<span id="lblCurrentAnnLangMsg" style="color:#ffa726;">Español</span>):</label>
                  <textarea id="annInputMessage" rows="4" placeholder="Escribe los detalles o novedades que quieres comunicar..." style="width:100%; box-sizing:border-box; background:#10021f; border:1px solid #451375; color:#fff; padding:10px 14px; border-radius:10px; font-size:13px; font-family:inherit; resize:vertical;" oninput="onAnnouncementFieldChange('message', this.value)">${announcementData.message || ''}</textarea>
                </div>

                <div style="margin-bottom:14px;">
                  <label style="display:block; font-size:11px; font-weight:700; color:#cbd5e1; margin-bottom:5px;">Adjuntar Video (MP4/WebM) o Imagen (PNG/JPG/GIF):</label>
                  <input type="file" id="annInputFile" accept="video/*,image/*" style="width:100%; box-sizing:border-box; background:#10021f; border:1px solid #451375; color:#fff; padding:8px 12px; border-radius:10px; font-size:12px;" onchange="handleAnnouncementFileSelected(this)" />
                  <div style="margin-top:6px; font-size:11px; color:#94a3b8;">O ingresar URL de medio existente:</div>
                  <input type="text" id="annInputMediaUrl" value="${(announcementData.mediaUrl || '').replace(/"/g, '&quot;')}" placeholder="https://... o /uploads/..." style="width:100%; box-sizing:border-box; margin-top:4px; background:#10021f; border:1px solid #451375; color:#fff; padding:8px 12px; border-radius:10px; font-size:12px;" oninput="updateAnnouncementPreview()" />
                  ${announcementData.mediaUrl ? `
                    <div style="margin-top:8px;">
                      <button type="button" onclick="removeAnnouncementMedia()" style="background:rgba(239, 68, 68, 0.15); border:1px solid #ef4444; color:#f87171; font-size:11px; font-weight:700; padding:4px 10px; border-radius:8px; cursor:pointer;">🗑️ Quitar Medio Adjunto</button>
                    </div>
                  ` : ''}
                </div>

                <div style="display:grid; grid-template-columns:1fr 1fr; gap:12px; margin-bottom:16px;">
                  <div>
                    <label style="display:block; font-size:11px; font-weight:700; color:#cbd5e1; margin-bottom:5px;">Texto del Botón (Opcional):</label>
                    <input type="text" id="annInputActionText" value="${(announcementData.actionText || '').replace(/"/g, '&quot;')}" placeholder="Ej: Probar Ahora 🚀" style="width:100%; box-sizing:border-box; background:#10021f; border:1px solid #451375; color:#fff; padding:10px 14px; border-radius:10px; font-size:13px;" oninput="onAnnouncementFieldChange('actionText', this.value)" />
                  </div>
                  <div>
                    <label style="display:block; font-size:11px; font-weight:700; color:#cbd5e1; margin-bottom:5px;">Enlace del Botón (URL):</label>
                    <input type="text" id="annInputActionUrl" value="${(announcementData.actionUrl || '').replace(/"/g, '&quot;')}" placeholder="https://..." style="width:100%; box-sizing:border-box; background:#10021f; border:1px solid #451375; color:#fff; padding:10px 14px; border-radius:10px; font-size:13px;" oninput="updateAnnouncementPreview()" />
                  </div>
                </div>

                <div style="margin-bottom:20px; background:#0c0117; padding:14px 16px; border-radius:12px; border:1px solid #360f5c; display:flex; align-items:center; justify-content:space-between;">
                  <div>
                    <div style="font-size:13px; font-weight:800; color:#fff;">Activar y Mostrar este Anuncio a los Usuarios</div>
                    <div style="font-size:11px; color:#cbd5e1; margin-top:2px;">Se abrirá automáticamente al cargar Zylo Estudio o la WebApp.</div>
                  </div>
                  <label style="position:relative; display:inline-block; width:50px; height:28px; cursor:pointer;">
                    <input type="checkbox" id="annInputActive" ${announcementData.active ? 'checked' : ''} style="display:none;" onchange="updateAnnouncementPreview()" />
                    <span id="annToggleTrack" style="position:absolute; inset:0; background:${announcementData.active ? '#22c55e' : '#374151'}; border-radius:28px; transition:0.25s;">
                      <span id="annToggleKnob" style="position:absolute; top:3px; left:${announcementData.active ? '25px' : '3px'}; width:22px; height:22px; background:#fff; border-radius:50%; transition:0.25s;"></span>
                    </span>
                  </label>
                </div>

                <div style="display:flex; justify-content:flex-end; gap:10px;">
                  <button type="button" onclick="deactivateAnnouncement()" style="background:#20073b; border:1px solid #451375; color:#cbd5e1; padding:10px 16px; border-radius:10px; font-size:12px; font-weight:700; cursor:pointer;">Desactivar Anuncio</button>
                  <button type="submit" id="btnSaveAnnouncement" style="background:linear-gradient(135deg, #ffa726, #ff6d00); border:none; color:#0c0118; padding:10px 22px; border-radius:10px; font-size:12px; font-weight:800; cursor:pointer;">Guardar y Publicar 🚀</button>
                </div>
              </form>

              <!-- Live Preview -->
              <div>
                <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:10px;">
                  <div style="font-size:11px; font-weight:800; color:#c084fc; text-transform:uppercase; letter-spacing:0.05em;">👀 Vista Previa en Vivo:</div>
                  <span id="prevCurrentLangBadge" style="font-size:10px; font-weight:800; background:#3b0e63; color:#e9d5ff; padding:2px 8px; border-radius:6px;">🇪🇸 Español</span>
                </div>
                <div style="background:#17042c; border:2px solid #5b199e; border-radius:20px; padding:22px; box-shadow:0 15px 40px rgba(0,0,0,0.8); max-width:440px;" id="annPreviewCard">
                  <div style="display:flex; align-items:center; gap:8px; margin-bottom:12px;">
                    <span style="font-size:20px;">📢</span>
                    <span style="font-size:11px; font-weight:800; background:rgba(255, 109, 0, 0.2); border:1px solid #ff6d00; color:#ffa726; padding:2px 8px; border-radius:10px;">Anuncio del Sistema</span>
                  </div>
                  <h4 id="prevAnnTitle" style="font-size:16px; font-weight:900; color:#fff; margin-bottom:8px;">${announcementData.title || 'Título del anuncio'}</h4>
                  <div id="prevAnnMediaContainer" style="margin-bottom:12px;">
                    ${announcementData.mediaUrl ? (announcementData.mediaType === 'video' ? `<video src="${announcementData.mediaUrl}" controls playsinline muted loop style="width:100%; max-height:200px; border-radius:12px; background:#000; object-fit:contain;"></video>` : `<img src="${announcementData.mediaUrl}" style="width:100%; max-height:200px; border-radius:12px; object-fit:contain;" />`) : ''}
                  </div>
                  <p id="prevAnnMessage" style="font-size:12px; color:#cbd5e1; line-height:1.5; margin-bottom:16px; white-space:pre-wrap;">${announcementData.message || 'Texto descriptivo de las novedades...'}</p>
                  <div style="display:flex; justify-content:space-between; align-items:center; gap:8px;">
                    <button type="button" style="background:#20073b; border:1px solid #451375; color:#cbd5e1; padding:8px 16px; border-radius:10px; font-size:12px; font-weight:700; cursor:default;">Entendido / Cerrar</button>
                    <a id="prevAnnActionBtn" href="${announcementData.actionUrl || '#'}" target="_blank" style="display:${(announcementData.actionUrl && announcementData.actionText) ? 'inline-block' : 'none'}; background:linear-gradient(135deg, #ffa726, #ff6d00); color:#0c0118; font-weight:800; font-size:12px; padding:8px 16px; border-radius:10px; text-decoration:none;">${announcementData.actionText || 'Ver Más'}</a>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>

        <!-- ========================================== -->
        <!-- MODALS -->
        <!-- ========================================== -->

        <!-- Reset Test Data Modal -->
        <div id="resetModal" style="display:none; position:fixed; inset:0; background:rgba(7, 1, 15, 0.92); backdrop-filter:blur(8px); z-index:99999; align-items:center; justify-content:center; padding:20px;">
          <div style="background:#1a0328; border:2px solid #ef4444; border-radius:24px; max-width:480px; width:100%; padding:28px; box-shadow:0 20px 60px rgba(239, 68, 68, 0.4); text-align:center;">
            <div style="font-size:42px; margin-bottom:12px;">🗑️</div>
            <h3 style="font-size:1.3rem; font-weight:900; color:#fff; margin-bottom:8px;">¿Purgar Todos los Datos de Prueba?</h3>
            <p style="font-size:13px; color:#fca5a5; line-height:1.5; margin-bottom:16px;">
              Esta acción eliminará <strong>permanentemente del disco</strong> todos los videos y clips grabados, vaciará la base de datos de clips y reiniciará todos los contadores de visitas y métricas a cero (conservando tus banners configurados).
            </p>
            <div style="margin-bottom:20px; text-align:left;">
              <label style="display:block; font-size:11px; font-weight:800; color:#fca5a5; margin-bottom:6px; text-transform:uppercase; letter-spacing:0.05em;">Introduce tu Contraseña de Administrador:</label>
              <input type="password" id="resetAdminPasswordInput" placeholder="Contraseña Maestra de Admin" style="width:100%; box-sizing:border-box; background:#10021f; border:1.5px solid #ef4444; color:#fff; padding:10px 14px; border-radius:10px; font-size:13px; outline:none;" required />
            </div>
            <div style="display:flex; justify-content:center; gap:12px;">
              <button type="button" onclick="closeResetModal()" style="background:#20073b; border:1px solid #451375; color:#cbd5e1; padding:10px 20px; border-radius:12px; font-size:13px; font-weight:700; cursor:pointer;">Cancelar</button>
              <button type="button" onclick="submitResetTestData()" style="background:#ef4444; border:none; color:#fff; padding:10px 22px; border-radius:12px; font-size:13px; font-weight:900; cursor:pointer;">Sí, Purgar Todo Ahora 💥</button>
            </div>
          </div>
        </div>

        <!-- Create New Banner Modal -->
        <div id="newBannerModal" style="display:none; position:fixed; inset:0; background:rgba(7, 1, 15, 0.92); backdrop-filter:blur(8px); z-index:9999; align-items:center; justify-content:center; padding:20px;">
          <div style="background:#17042c; border:1.5px solid #431275; border-radius:24px; max-width:540px; width:100%; max-height:92vh; overflow-y:auto; padding:28px; box-shadow:0 25px 70px rgba(0,0,0,0.9);">
            <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:18px;">
              <h3 style="font-size:16px; font-weight:800; color:#ffa726;">📢 Subir Nuevo Anuncio / Banner</h3>
              <button onclick="closeNewBannerModal()" style="background:none; border:none; color:#cbd5e1; font-size:22px; cursor:pointer;">✕</button>
            </div>

            <form id="newBannerForm" onsubmit="submitNewBanner(event)">
              <div style="margin-bottom:14px;">
                <label style="display:block; font-size:11px; font-weight:700; color:#cbd5e1; margin-bottom:5px;">Nombre de Campaña / Título:</label>
                <input type="text" id="bannerInputName" required placeholder="Ej: Discord Nitro Promo, Patreon Walter..." style="width:100%; background:#10021f; border:1px solid #451375; color:#fff; padding:10px 14px; border-radius:10px; font-size:13px;" />
              </div>

              <div style="margin-bottom:14px;">
                <label style="display:block; font-size:11px; font-weight:700; color:#cbd5e1; margin-bottom:5px;">Ubicación / Posición (Slot):</label>
                <select id="bannerInputSlot" style="width:100%; background:#10021f; border:1px solid #451375; color:#fff; padding:10px 14px; border-radius:10px; font-size:13px;" onchange="updateBannerQuotaPie()">
                  <option value="studio_left">Estudio • Lateral Izquierdo (160×600)</option>
                  <option value="studio_right">Estudio • Lateral Derecho (160×600)</option>
                  <option value="viewer_left">Reproductor • Lateral Izquierdo (160×600)</option>
                  <option value="viewer_right">Reproductor • Lateral Derecho (160×600)</option>
                  <option value="mobile_webapp">📱 WebApp Móvil — Banner Uniforme (320×80 / 300×75)</option>
                </select>
              </div>

              <div style="margin-bottom:14px;">
                <label style="display:block; font-size:11px; font-weight:700; color:#cbd5e1; margin-bottom:5px;">Archivo de Medio Principal (PNG, WebP, GIF, APNG, AVIF, MP4, WebM):</label>
                <input type="file" id="bannerInputFile" accept="image/*,video/*" style="width:100%; background:#10021f; border:1px solid #451375; color:#fff; padding:8px 12px; border-radius:10px; font-size:12px;" />
                <div style="margin-top:6px; font-size:11px; color:#94a3b8;">O ingresar URL de imagen / GIF principal:</div>
                <input type="text" id="bannerInputUrl" placeholder="https://... o /banners/banner_features.svg" style="width:100%; margin-top:4px; background:#10021f; border:1px solid #451375; color:#fff; padding:8px 12px; border-radius:10px; font-size:12px;" />
              </div>

              <details style="margin-bottom:14px; background:#10021f; border:1px dashed #6366f1; border-radius:10px; padding:10px 14px;">
                <summary style="font-size:12px; font-weight:700; color:#a5b4fc; cursor:pointer; user-select:none;">🌐 Creatividades Específicas por Idioma (Opcional)</summary>
                <div style="font-size:11px; color:#94a3b8; margin-top:6px; margin-bottom:10px;">
                  Si los visitantes usan Zylo en un idioma determinado, se mostrará esta variante en vez de la principal.
                </div>
                <div style="display:grid; grid-template-columns:repeat(auto-fit, minmax(200px, 1fr)); gap:10px;">
                  <div style="background:#17042c; border:1px solid #360f5c; border-radius:8px; padding:8px;">
                    <div style="font-size:11px; font-weight:700; color:#cbd5e1; margin-bottom:4px;">🇪🇸 Español (es)</div>
                    <input type="file" id="new_variant_file_es" accept="image/*,video/*" style="width:100%; font-size:10px; color:#cbd5e1;" />
                    <input type="text" id="new_variant_url_es" placeholder="O URL es..." style="width:100%; margin-top:4px; background:#0c0118; border:1px solid #451375; color:#fff; padding:6px 8px; border-radius:6px; font-size:11px;" />
                  </div>
                  <div style="background:#17042c; border:1px solid #360f5c; border-radius:8px; padding:8px;">
                    <div style="font-size:11px; font-weight:700; color:#cbd5e1; margin-bottom:4px;">🇺🇸 English (en)</div>
                    <input type="file" id="new_variant_file_en" accept="image/*,video/*" style="width:100%; font-size:10px; color:#cbd5e1;" />
                    <input type="text" id="new_variant_url_en" placeholder="O URL en..." style="width:100%; margin-top:4px; background:#0c0118; border:1px solid #451375; color:#fff; padding:6px 8px; border-radius:6px; font-size:11px;" />
                  </div>
                  <div style="background:#17042c; border:1px solid #360f5c; border-radius:8px; padding:8px;">
                    <div style="font-size:11px; font-weight:700; color:#cbd5e1; margin-bottom:4px;">🇧🇷 Português (pt)</div>
                    <input type="file" id="new_variant_file_pt" accept="image/*,video/*" style="width:100%; font-size:10px; color:#cbd5e1;" />
                    <input type="text" id="new_variant_url_pt" placeholder="O URL pt..." style="width:100%; margin-top:4px; background:#0c0118; border:1px solid #451375; color:#fff; padding:6px 8px; border-radius:6px; font-size:11px;" />
                  </div>
                  <div style="background:#17042c; border:1px solid #360f5c; border-radius:8px; padding:8px;">
                    <div style="font-size:11px; font-weight:700; color:#cbd5e1; margin-bottom:4px;">🇫🇷 Français (fr)</div>
                    <input type="file" id="new_variant_file_fr" accept="image/*,video/*" style="width:100%; font-size:10px; color:#cbd5e1;" />
                    <input type="text" id="new_variant_url_fr" placeholder="O URL fr..." style="width:100%; margin-top:4px; background:#0c0118; border:1px solid #451375; color:#fff; padding:6px 8px; border-radius:6px; font-size:11px;" />
                  </div>
                  <div style="background:#17042c; border:1px solid #360f5c; border-radius:8px; padding:8px;">
                    <div style="font-size:11px; font-weight:700; color:#cbd5e1; margin-bottom:4px;">🇩🇪 Deutsch (de)</div>
                    <input type="file" id="new_variant_file_de" accept="image/*,video/*" style="width:100%; font-size:10px; color:#cbd5e1;" />
                    <input type="text" id="new_variant_url_de" placeholder="O URL de..." style="width:100%; margin-top:4px; background:#0c0118; border:1px solid #451375; color:#fff; padding:6px 8px; border-radius:6px; font-size:11px;" />
                  </div>
                  <div style="background:#17042c; border:1px solid #360f5c; border-radius:8px; padding:8px;">
                    <div style="font-size:11px; font-weight:700; color:#cbd5e1; margin-bottom:4px;">🇯🇵 日本語 (ja)</div>
                    <input type="file" id="new_variant_file_ja" accept="image/*,video/*" style="width:100%; font-size:10px; color:#cbd5e1;" />
                    <input type="text" id="new_variant_url_ja" placeholder="O URL ja..." style="width:100%; margin-top:4px; background:#0c0118; border:1px solid #451375; color:#fff; padding:6px 8px; border-radius:6px; font-size:11px;" />
                  </div>
                </div>
              </details>

              <div style="margin-bottom:14px;">
                <label style="display:block; font-size:11px; font-weight:700; color:#cbd5e1; margin-bottom:5px;">Enlace de Destino (Clic):</label>
                <input type="text" id="bannerInputTarget" required placeholder="https://discord.gg/... o https://tu-sitio.com" style="width:100%; background:#10021f; border:1px solid #451375; color:#fff; padding:10px 14px; border-radius:10px; font-size:13px;" />
              </div>

              <div style="margin-bottom:14px;">
                <label style="display:block; font-size:11px; font-weight:700; color:#cbd5e1; margin-bottom:5px;">Idiomas Donde Aparecerá el Anuncio:</label>
                <div style="display:grid; grid-template-columns:repeat(auto-fit, minmax(130px, 1fr)); gap:8px; background:#10021f; border:1px solid #451375; border-radius:10px; padding:10px;">
                  <label style="display:flex; align-items:center; gap:6px; font-size:12px; color:#fff; cursor:pointer;">
                    <input type="checkbox" name="bannerLang" value="all" id="lang-cb-all" checked onchange="handleLangAllToggle(this)" />
                    <span>🌐 Todos (Global)</span>
                  </label>
                  <label style="display:flex; align-items:center; gap:6px; font-size:12px; color:#cbd5e1; cursor:pointer;">
                    <input type="checkbox" name="bannerLang" value="es" class="lang-cb-specific" onchange="handleSpecificLangToggle()" />
                    <span>🇪🇸 Español (es)</span>
                  </label>
                  <label style="display:flex; align-items:center; gap:6px; font-size:12px; color:#cbd5e1; cursor:pointer;">
                    <input type="checkbox" name="bannerLang" value="en" class="lang-cb-specific" onchange="handleSpecificLangToggle()" />
                    <span>🇺🇸 English (en)</span>
                  </label>
                  <label style="display:flex; align-items:center; gap:6px; font-size:12px; color:#cbd5e1; cursor:pointer;">
                    <input type="checkbox" name="bannerLang" value="pt" class="lang-cb-specific" onchange="handleSpecificLangToggle()" />
                    <span>🇧🇷 Português (pt)</span>
                  </label>
                  <label style="display:flex; align-items:center; gap:6px; font-size:12px; color:#cbd5e1; cursor:pointer;">
                    <input type="checkbox" name="bannerLang" value="fr" class="lang-cb-specific" onchange="handleSpecificLangToggle()" />
                    <span>🇫🇷 Français (fr)</span>
                  </label>
                  <label style="display:flex; align-items:center; gap:6px; font-size:12px; color:#cbd5e1; cursor:pointer;">
                    <input type="checkbox" name="bannerLang" value="de" class="lang-cb-specific" onchange="handleSpecificLangToggle()" />
                    <span>🇩🇪 Deutsch (de)</span>
                  </label>
                  <label style="display:flex; align-items:center; gap:6px; font-size:12px; color:#cbd5e1; cursor:pointer;">
                    <input type="checkbox" name="bannerLang" value="ja" class="lang-cb-specific" onchange="handleSpecificLangToggle()" />
                    <span>🇯🇵 日本語 (ja)</span>
                  </label>
                </div>
                <div style="font-size:10px; color:#94a3b8; margin-top:4px;">Si desmarcas "Todos", el anuncio SOLO se mostrará cuando el visitante use Zylo en los idiomas seleccionados.</div>
              </div>

              <div style="margin-bottom:20px; background:#110221; border:1px solid #360f5c; border-radius:14px; padding:16px;">
                <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:12px;">
                  <div style="font-size:12px; font-weight:800; color:#c084fc;">📊 CUOTA DE IMPRESIONES PARA ESTE SLOT (TOTAL: 100%)</div>
                  <span id="quotaAvailableBadge" style="font-size:11px; font-weight:800; padding:2px 8px; border-radius:10px; background:rgba(34, 197, 94, 0.2); border:1px solid #22c55e; color:#4ade80;"></span>
                </div>

                <div style="display:flex; align-items:center; gap:20px;">
                  <!-- SVG Pie / Donut Chart -->
                  <div style="position:relative; width:110px; height:110px; flex-shrink:0;">
                    <svg id="quotaPieSvg" width="110" height="110" viewBox="0 0 42 42" style="transform:rotate(-90deg); border-radius:50%; background:#1a042e;"></svg>
                    <div id="quotaCenterText" style="position:absolute; inset:0; display:flex; flex-direction:column; align-items:center; justify-content:center; text-align:center;">
                      <span id="quotaCenterPct" style="font-size:15px; font-weight:900; color:#fff;">100%</span>
                      <span style="font-size:9px; color:#94a3b8; font-weight:700;">Libre</span>
                    </div>
                  </div>

                  <!-- Legend & Breakdown -->
                  <div id="quotaBreakdownLegend" style="flex:1; font-size:11px; display:flex; flex-direction:column; gap:5px;"></div>
                </div>

                <div style="margin-top:14px;">
                  <label style="display:block; font-size:11px; font-weight:700; color:#cbd5e1; margin-bottom:5px;">
                    Cuota Objetivo para este Anuncio (% de 1 a <span id="quotaMaxAllowedText">100</span>):
                  </label>
                  <input type="number" id="bannerInputWeight" value="10" min="1" max="100" style="width:100%; box-sizing:border-box; background:#10021f; border:1px solid #451375; color:#fff; padding:10px 14px; border-radius:10px; font-size:13px;" oninput="onBannerWeightChanged(this.value)" />
                  <div id="quotaWarningMsg" style="display:none; font-size:11px; color:#ef4444; font-weight:700; margin-top:5px;"></div>
                </div>
              </div>

              <div style="display:flex; justify-content:flex-end; gap:10px;">
                <button type="button" onclick="closeNewBannerModal()" style="background:#20073b; border:1px solid #451375; color:#cbd5e1; padding:10px 16px; border-radius:10px; font-size:12px; font-weight:700; cursor:pointer;">Cancelar</button>
                <button type="submit" id="btnSubmitNewBanner" style="background:linear-gradient(135deg, #ffa726, #ff6d00); border:none; color:#0c0118; padding:10px 20px; border-radius:10px; font-size:12px; font-weight:800; cursor:pointer;">Crear Anuncio 🚀</button>
              </div>
            </form>
          </div>
        </div>

        <!-- Edit Existing Banner Modal -->
        <div id="editBannerModal" style="display:none; position:fixed; inset:0; background:rgba(7, 1, 15, 0.92); backdrop-filter:blur(8px); z-index:9999; align-items:center; justify-content:center; padding:20px;">
          <div style="background:#17042c; border:1.5px solid #3b82f6; border-radius:24px; max-width:540px; width:100%; max-height:92vh; overflow-y:auto; padding:28px; box-shadow:0 25px 70px rgba(0,0,0,0.9);">
            <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:18px;">
              <h3 style="font-size:16px; font-weight:800; color:#38bdf8;">✏️ Editar Anuncio / Banner</h3>
              <button onclick="closeEditBannerModal()" style="background:none; border:none; color:#cbd5e1; font-size:22px; cursor:pointer;">✕</button>
            </div>

            <form id="editBannerForm" onsubmit="submitEditBanner(event)">
              <input type="hidden" id="editBannerId" />

              <div style="margin-bottom:14px;">
                <label style="display:block; font-size:11px; font-weight:700; color:#cbd5e1; margin-bottom:5px;">Nombre de Campaña / Título:</label>
                <input type="text" id="editBannerInputName" required placeholder="Ej: Discord Nitro Promo..." style="width:100%; background:#10021f; border:1px solid #451375; color:#fff; padding:10px 14px; border-radius:10px; font-size:13px;" />
              </div>

              <div style="margin-bottom:14px;">
                <label style="display:block; font-size:11px; font-weight:700; color:#cbd5e1; margin-bottom:5px;">Ubicación / Posición (Slot):</label>
                <select id="editBannerInputSlot" style="width:100%; background:#10021f; border:1px solid #451375; color:#fff; padding:10px 14px; border-radius:10px; font-size:13px;" onchange="updateEditBannerQuotaPie()">
                  <option value="studio_left">Estudio • Lateral Izquierdo (160×600)</option>
                  <option value="studio_right">Estudio • Lateral Derecho (160×600)</option>
                  <option value="viewer_left">Reproductor • Lateral Izquierdo (160×600)</option>
                  <option value="viewer_right">Reproductor • Lateral Derecho (160×600)</option>
                  <option value="mobile_webapp">📱 WebApp Móvil — Banner Uniforme (320×80 / 300×75)</option>
                </select>
              </div>

              <div style="margin-bottom:14px;">
                <label style="display:block; font-size:11px; font-weight:700; color:#cbd5e1; margin-bottom:5px;">Archivo de Medio Principal (Opcional - Reemplazar actual):</label>
                <div id="editBannerCurrentMedia" style="margin-bottom:8px; font-size:11px; color:#c4b5fd;"></div>
                <input type="file" id="editBannerInputFile" accept="image/*,video/*" style="width:100%; background:#10021f; border:1px solid #451375; color:#fff; padding:8px 12px; border-radius:10px; font-size:12px;" />
                <div style="margin-top:6px; font-size:11px; color:#94a3b8;">O ingresar nueva URL de imagen / GIF principal:</div>
                <input type="text" id="editBannerInputUrl" placeholder="https://... o /banners/banner_features.svg" style="width:100%; margin-top:4px; background:#10021f; border:1px solid #451375; color:#fff; padding:8px 12px; border-radius:10px; font-size:12px;" />
              </div>

              <details style="margin-bottom:14px; background:#10021f; border:1px dashed #38bdf8; border-radius:10px; padding:10px 14px;">
                <summary style="font-size:12px; font-weight:700; color:#38bdf8; cursor:pointer; user-select:none;">🌐 Variantes de Creatividad por Idioma (Opcional)</summary>
                <div style="font-size:11px; color:#94a3b8; margin-top:6px; margin-bottom:10px;">
                  Actualiza o define archivos/URLs específicos para cada idioma:
                </div>
                <div style="display:grid; grid-template-columns:repeat(auto-fit, minmax(200px, 1fr)); gap:10px;">
                  <div style="background:#17042c; border:1px solid #360f5c; border-radius:8px; padding:8px;">
                    <div style="font-size:11px; font-weight:700; color:#cbd5e1; margin-bottom:4px;">🇪🇸 Español (es)</div>
                    <div id="edit_variant_status_es" style="font-size:10px; color:#a78bfa; margin-bottom:2px;"></div>
                    <input type="file" id="edit_variant_file_es" accept="image/*,video/*" style="width:100%; font-size:10px; color:#cbd5e1;" />
                    <input type="text" id="edit_variant_url_es" placeholder="O URL es..." style="width:100%; margin-top:4px; background:#0c0118; border:1px solid #451375; color:#fff; padding:6px 8px; border-radius:6px; font-size:11px;" />
                  </div>
                  <div style="background:#17042c; border:1px solid #360f5c; border-radius:8px; padding:8px;">
                    <div style="font-size:11px; font-weight:700; color:#cbd5e1; margin-bottom:4px;">🇺🇸 English (en)</div>
                    <div id="edit_variant_status_en" style="font-size:10px; color:#a78bfa; margin-bottom:2px;"></div>
                    <input type="file" id="edit_variant_file_en" accept="image/*,video/*" style="width:100%; font-size:10px; color:#cbd5e1;" />
                    <input type="text" id="edit_variant_url_en" placeholder="O URL en..." style="width:100%; margin-top:4px; background:#0c0118; border:1px solid #451375; color:#fff; padding:6px 8px; border-radius:6px; font-size:11px;" />
                  </div>
                  <div style="background:#17042c; border:1px solid #360f5c; border-radius:8px; padding:8px;">
                    <div style="font-size:11px; font-weight:700; color:#cbd5e1; margin-bottom:4px;">🇧🇷 Português (pt)</div>
                    <div id="edit_variant_status_pt" style="font-size:10px; color:#a78bfa; margin-bottom:2px;"></div>
                    <input type="file" id="edit_variant_file_pt" accept="image/*,video/*" style="width:100%; font-size:10px; color:#cbd5e1;" />
                    <input type="text" id="edit_variant_url_pt" placeholder="O URL pt..." style="width:100%; margin-top:4px; background:#0c0118; border:1px solid #451375; color:#fff; padding:6px 8px; border-radius:6px; font-size:11px;" />
                  </div>
                  <div style="background:#17042c; border:1px solid #360f5c; border-radius:8px; padding:8px;">
                    <div style="font-size:11px; font-weight:700; color:#cbd5e1; margin-bottom:4px;">🇫🇷 Français (fr)</div>
                    <div id="edit_variant_status_fr" style="font-size:10px; color:#a78bfa; margin-bottom:2px;"></div>
                    <input type="file" id="edit_variant_file_fr" accept="image/*,video/*" style="width:100%; font-size:10px; color:#cbd5e1;" />
                    <input type="text" id="edit_variant_url_fr" placeholder="O URL fr..." style="width:100%; margin-top:4px; background:#0c0118; border:1px solid #451375; color:#fff; padding:6px 8px; border-radius:6px; font-size:11px;" />
                  </div>
                  <div style="background:#17042c; border:1px solid #360f5c; border-radius:8px; padding:8px;">
                    <div style="font-size:11px; font-weight:700; color:#cbd5e1; margin-bottom:4px;">🇩🇪 Deutsch (de)</div>
                    <div id="edit_variant_status_de" style="font-size:10px; color:#a78bfa; margin-bottom:2px;"></div>
                    <input type="file" id="edit_variant_file_de" accept="image/*,video/*" style="width:100%; font-size:10px; color:#cbd5e1;" />
                    <input type="text" id="edit_variant_url_de" placeholder="O URL de..." style="width:100%; margin-top:4px; background:#0c0118; border:1px solid #451375; color:#fff; padding:6px 8px; border-radius:6px; font-size:11px;" />
                  </div>
                  <div style="background:#17042c; border:1px solid #360f5c; border-radius:8px; padding:8px;">
                    <div style="font-size:11px; font-weight:700; color:#cbd5e1; margin-bottom:4px;">🇯🇵 日本語 (ja)</div>
                    <div id="edit_variant_status_ja" style="font-size:10px; color:#a78bfa; margin-bottom:2px;"></div>
                    <input type="file" id="edit_variant_file_ja" accept="image/*,video/*" style="width:100%; font-size:10px; color:#cbd5e1;" />
                    <input type="text" id="edit_variant_url_ja" placeholder="O URL ja..." style="width:100%; margin-top:4px; background:#0c0118; border:1px solid #451375; color:#fff; padding:6px 8px; border-radius:6px; font-size:11px;" />
                  </div>
                </div>
              </details>

              <div style="margin-bottom:14px;">
                <label style="display:block; font-size:11px; font-weight:700; color:#cbd5e1; margin-bottom:5px;">Enlace de Destino (Clic):</label>
                <input type="text" id="editBannerInputTarget" required placeholder="https://discord.gg/... o https://tu-sitio.com" style="width:100%; background:#10021f; border:1px solid #451375; color:#fff; padding:10px 14px; border-radius:10px; font-size:13px;" />
              </div>

              <div style="margin-bottom:14px;">
                <label style="display:block; font-size:11px; font-weight:700; color:#cbd5e1; margin-bottom:5px;">Idiomas Donde Aparecerá el Anuncio:</label>
                <div style="display:grid; grid-template-columns:repeat(auto-fit, minmax(130px, 1fr)); gap:8px; background:#10021f; border:1px solid #451375; border-radius:10px; padding:10px;">
                  <label style="display:flex; align-items:center; gap:6px; font-size:12px; color:#fff; cursor:pointer;">
                    <input type="checkbox" name="editBannerLang" value="all" id="edit-lang-cb-all" onchange="handleEditLangAllToggle(this)" />
                    <span>🌐 Todos (Global)</span>
                  </label>
                  <label style="display:flex; align-items:center; gap:6px; font-size:12px; color:#cbd5e1; cursor:pointer;">
                    <input type="checkbox" name="editBannerLang" value="es" class="edit-lang-cb-specific" onchange="handleEditSpecificLangToggle()" />
                    <span>🇪🇸 Español (es)</span>
                  </label>
                  <label style="display:flex; align-items:center; gap:6px; font-size:12px; color:#cbd5e1; cursor:pointer;">
                    <input type="checkbox" name="editBannerLang" value="en" class="edit-lang-cb-specific" onchange="handleEditSpecificLangToggle()" />
                    <span>🇺🇸 English (en)</span>
                  </label>
                  <label style="display:flex; align-items:center; gap:6px; font-size:12px; color:#cbd5e1; cursor:pointer;">
                    <input type="checkbox" name="editBannerLang" value="pt" class="edit-lang-cb-specific" onchange="handleEditSpecificLangToggle()" />
                    <span>🇧🇷 Português (pt)</span>
                  </label>
                  <label style="display:flex; align-items:center; gap:6px; font-size:12px; color:#cbd5e1; cursor:pointer;">
                    <input type="checkbox" name="editBannerLang" value="fr" class="edit-lang-cb-specific" onchange="handleEditSpecificLangToggle()" />
                    <span>🇫🇷 Français (fr)</span>
                  </label>
                  <label style="display:flex; align-items:center; gap:6px; font-size:12px; color:#cbd5e1; cursor:pointer;">
                    <input type="checkbox" name="editBannerLang" value="de" class="edit-lang-cb-specific" onchange="handleEditSpecificLangToggle()" />
                    <span>🇩🇪 Deutsch (de)</span>
                  </label>
                  <label style="display:flex; align-items:center; gap:6px; font-size:12px; color:#cbd5e1; cursor:pointer;">
                    <input type="checkbox" name="editBannerLang" value="ja" class="edit-lang-cb-specific" onchange="handleEditSpecificLangToggle()" />
                    <span>🇯🇵 日本語 (ja)</span>
                  </label>
                </div>
              </div>

              <div style="margin-bottom:20px; background:#110221; border:1px solid #360f5c; border-radius:14px; padding:16px;">
                <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:12px;">
                  <div style="font-size:12px; font-weight:800; color:#38bdf8;">📊 CUOTA DE IMPRESIONES SEGÚN IDIOMA</div>
                  <span id="editQuotaAvailableBadge" style="font-size:11px; font-weight:800; padding:2px 8px; border-radius:10px; background:rgba(56, 189, 248, 0.2); border:1px solid #38bdf8; color:#38bdf8;"></span>
                </div>

                <div style="display:flex; align-items:center; gap:20px;">
                  <!-- SVG Pie / Donut Chart -->
                  <div style="position:relative; width:110px; height:110px; flex-shrink:0;">
                    <svg id="editQuotaPieSvg" width="110" height="110" viewBox="0 0 42 42" style="transform:rotate(-90deg); border-radius:50%; background:#1a042e;"></svg>
                    <div id="editQuotaCenterText" style="position:absolute; inset:0; display:flex; flex-direction:column; align-items:center; justify-content:center; text-align:center;">
                      <span id="editQuotaCenterPct" style="font-size:15px; font-weight:900; color:#fff;">100%</span>
                      <span style="font-size:9px; color:#94a3b8; font-weight:700;">Libre</span>
                    </div>
                  </div>

                  <!-- Legend & Breakdown -->
                  <div id="editQuotaBreakdownLegend" style="flex:1; font-size:11px; display:flex; flex-direction:column; gap:5px;"></div>
                </div>

                <div style="margin-top:14px;">
                  <label style="display:block; font-size:11px; font-weight:700; color:#cbd5e1; margin-bottom:5px;">
                    Cuota Asignada para este Anuncio (de 1 a <span id="editQuotaMaxAllowedText">100</span>):
                  </label>
                  <input type="number" id="editBannerInputWeight" value="10" min="1" max="10000" style="width:100%; box-sizing:border-box; background:#10021f; border:1px solid #451375; color:#fff; padding:10px 14px; border-radius:10px; font-size:13px;" oninput="onEditBannerWeightChanged(this.value)" />
                  <div id="editQuotaWarningMsg" style="display:none; font-size:11px; color:#ef4444; font-weight:700; margin-top:5px;"></div>
                </div>
              </div>

              <div style="display:flex; justify-content:flex-end; gap:10px;">
                <button type="button" onclick="closeEditBannerModal()" style="background:#20073b; border:1px solid #451375; color:#cbd5e1; padding:10px 16px; border-radius:10px; font-size:12px; font-weight:700; cursor:pointer;">Cancelar</button>
                <button type="submit" id="btnSubmitEditBanner" style="background:linear-gradient(135deg, #38bdf8, #2563eb); border:none; color:#fff; padding:10px 20px; border-radius:10px; font-size:12px; font-weight:800; cursor:pointer;">Guardar Cambios 💾</button>
              </div>
            </form>
          </div>
        </div>

        <!-- Admin Inline Preview Modal -->
        <div id="previewModal" style="display:none; position:fixed; inset:0; background:rgba(7, 1, 15, 0.88); backdrop-filter:blur(6px); z-index:999; align-items:center; justify-content:center; padding:20px;">
          <div style="background:#17042c; border:1.5px solid #431275; border-radius:20px; max-width:850px; width:100%; max-height:90vh; overflow:hidden; display:flex; flex-direction:column; box-shadow:0 20px 60px rgba(0,0,0,0.85);">
            <div style="padding:16px 22px; border-bottom:1px solid #310c57; display:flex; justify-content:space-between; align-items:center;">
              <h3 id="modalTitle" style="font-size:15px; font-weight:800; color:#fff; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; max-width:700px;">Previsualización de Clip</h3>
              <button onclick="closePreviewModal()" style="background:none; border:none; color:#cbd5e1; font-size:22px; cursor:pointer; line-height:1;">✕</button>
            </div>
            <div id="modalMediaContainer" style="background:#090112; flex:1; min-height:360px; max-height:65vh; display:flex; align-items:center; justify-content:center;"></div>
            <div style="padding:14px 22px; border-top:1px solid #310c57; display:flex; justify-content:space-between; align-items:center; background:#120323;">
              <div id="modalLinks" style="display:flex; gap:10px;"></div>
              <button onclick="closePreviewModal()" style="background:linear-gradient(135deg, #ffa726, #ff6d00); border:none; color:#0c0118; font-weight:800; padding:8px 18px; border-radius:10px; cursor:pointer;">Cerrar</button>
            </div>
          </div>
        </div>

        <!-- Forensic Audit Details Modal -->
        <div id="auditModal" style="display:none; position:fixed; inset:0; background:rgba(7, 1, 15, 0.92); backdrop-filter:blur(8px); z-index:1000; align-items:center; justify-content:center; padding:20px;">
          <div style="background:#17042c; border:1.5px solid #431275; border-radius:24px; max-width:920px; width:100%; max-height:92vh; overflow:hidden; display:flex; flex-direction:column; box-shadow:0 25px 70px rgba(0,0,0,0.9);">
            <div style="padding:18px 24px; border-bottom:1px solid #310c57; display:flex; justify-content:space-between; align-items:center; background:#120324;">
              <div style="display:flex; align-items:center; gap:12px;">
                <span style="font-size:22px;">📊</span>
                <div>
                  <h3 id="auditModalTitle" style="font-size:16px; font-weight:800; color:#fff;">Auditoría Forense del Clip</h3>
                  <p id="auditModalSubtitle" style="font-size:12px; color:#c084fc; margin-top:2px; font-family:monospace;"></p>
                </div>
              </div>
              <button onclick="closeAuditModal()" style="background:none; border:none; color:#cbd5e1; font-size:24px; cursor:pointer; line-height:1;">✕</button>
            </div>

            <div style="flex:1; overflow-y:auto; padding:24px; display:flex; flex-direction:column; gap:20px;">
              <div style="background:#120221; border:1px solid #360d5e; border-radius:16px; padding:18px;">
                <div style="font-size:13px; font-weight:800; color:#ffa726; margin-bottom:14px;">👤 INFORMACIÓN DE QUIEN SUBIÓ EL CLIP (ORIGEN)</div>
                <div style="display:grid; grid-template-columns:repeat(auto-fit, minmax(200px, 1fr)); gap:14px; font-size:12px;" id="uploaderInfoGrid"></div>
              </div>

              <div style="background:#120221; border:1px solid #360d5e; border-radius:16px; padding:18px;">
                <div style="font-size:13px; font-weight:800; color:#4ade80; margin-bottom:14px; display:flex; justify-content:space-between; align-items:center;">
                  <span>👁️ HISTORIAL DE VISITAS (QUIÉNES LO VIERON)</span>
                  <span id="auditViewsCountBadge" style="background:rgba(74, 222, 128, 0.15); border:1px solid #22c55e; color:#4ade80; font-size:11px; padding:3px 10px; border-radius:12px;"></span>
                </div>
                <div id="viewsLogContainer" style="overflow-x:auto;"></div>
              </div>
            </div>

            <div style="padding:14px 24px; border-top:1px solid #310c57; display:flex; justify-content:flex-end; background:#120324;">
              <button onclick="closeAuditModal()" style="background:linear-gradient(135deg, #ffa726, #ff6d00); border:none; color:#0c0118; font-weight:800; padding:10px 22px; border-radius:12px; cursor:pointer;">Cerrar Auditoría</button>
            </div>
          </div>
        </div>

        <!-- Change Master Password Modal -->
        <div id="passwordModal" style="display:none; position:fixed; inset:0; background:rgba(0,0,0,0.85); backdrop-filter:blur(6px); z-index:9999; align-items:center; justify-content:center; padding:20px;">
          <div style="background:#18042b; border:1.5px solid #451375; border-radius:20px; padding:30px; width:100%; max-width:400px; box-shadow:0 20px 60px rgba(0,0,0,0.9);">
            <h3 style="font-size:1.2rem; font-weight:800; color:#fff; margin-bottom:6px;">🔑 Cambiar Contraseña Maestra</h3>
            <p style="font-size:12px; color:#cbd5e1; margin-bottom:18px;">Ingresa la nueva contraseña para acceder a la consola de administración.</p>
            
            <div style="margin-bottom:14px;">
              <label style="display:block; font-size:11px; font-weight:700; color:#cbd5e1; margin-bottom:4px;">Nueva Contraseña:</label>
              <input type="password" id="inputNewAdminPassword" placeholder="Mínimo 4 caracteres" style="width:100%; background:#10021f; border:1px solid #451375; color:#fff; padding:10px 14px; border-radius:10px; font-size:13px;" />
            </div>
            <div style="margin-bottom:20px;">
              <label style="display:block; font-size:11px; font-weight:700; color:#cbd5e1; margin-bottom:4px;">Confirmar Contraseña:</label>
              <input type="password" id="inputConfirmAdminPassword" placeholder="Repite la contraseña" style="width:100%; background:#10021f; border:1px solid #451375; color:#fff; padding:10px 14px; border-radius:10px; font-size:13px;" />
            </div>

            <div style="display:flex; justify-content:flex-end; gap:10px;">
              <button type="button" onclick="closePasswordModal()" style="background:#20073b; border:1px solid #451375; color:#cbd5e1; padding:8px 16px; border-radius:10px; font-size:12px; font-weight:700; cursor:pointer;">Cancelar</button>
              <button type="button" onclick="submitNewPassword()" style="background:linear-gradient(135deg, #ffa726, #ff6d00); border:none; color:#0c0118; padding:8px 18px; border-radius:10px; font-size:12px; font-weight:800; cursor:pointer;">Guardar Contraseña</button>
            </div>
          </div>
        </div>
      </main>

      <script>
        const BASE_URL = "${baseUrl}";
        const ADMIN_SECRET_PATH = "${ADMIN_SECRET_PATH}";

        function switchTab(tab) {
          ['clips', 'banners', 'announcement', 'stats'].forEach(t => {
            const btn = document.getElementById('tabbtn-' + t);
            const content = document.getElementById('tab-' + t);
            if (btn) btn.classList.toggle('active', t === tab);
            if (content) content.classList.toggle('active', t === tab);
          });
        }

        const allBannersData = ${allBannersJson};
        const quotaConfigData = ${quotaConfigJson};

        function calculateAvailableQuota(slot, languages, ignoreBannerId = null) {
          const langs = (languages && languages.length > 0) ? languages : ['all'];
          let minAvailable = Infinity;
          let dominantLang = 'all';

          for (const l of langs) {
            const qBase = (quotaConfigData && quotaConfigData[l]) || (quotaConfigData && quotaConfigData.all) || 100;
            const competing = allBannersData.filter(b => {
              if (b.slot !== slot || b.active === false) return false;
              if (ignoreBannerId && b.id === ignoreBannerId) return false;
              const bLangs = Array.isArray(b.languages) && b.languages.length > 0 ? b.languages : ['all'];
              if (l === 'all') return true;
              return bLangs.includes('all') || bLangs.includes(l);
            });
            const allocated = competing.reduce((sum, b) => sum + (parseInt(b.weight, 10) || 0), 0);
            const available = Math.max(0, qBase - allocated);
            if (available < minAvailable) {
              minAvailable = available;
              dominantLang = l;
            }
          }

          const base = (quotaConfigData && quotaConfigData[dominantLang]) || 100;
          return { available: minAvailable === Infinity ? base : minAvailable, base, dominantLang };
        }

        // Banners Management Functions
        function openNewBannerModal() {
          document.getElementById('newBannerModal').style.display = 'flex';
          updateBannerQuotaPie();
        }
        function closeNewBannerModal() {
          document.getElementById('newBannerModal').style.display = 'none';
        }

        function updateBannerQuotaPie() {
          const slot = document.getElementById('bannerInputSlot').value;
          const inputWeightEl = document.getElementById('bannerInputWeight');
          const warningEl = document.getElementById('quotaWarningMsg');
          const availableBadge = document.getElementById('quotaAvailableBadge');
          const maxAllowedText = document.getElementById('quotaMaxAllowedText');
          const centerPct = document.getElementById('quotaCenterPct');
          const legendEl = document.getElementById('quotaBreakdownLegend');
          const svgEl = document.getElementById('quotaPieSvg');
          const submitBtn = document.getElementById('btnSubmitNewBanner');

          const checkedLangs = Array.from(document.querySelectorAll('input[name="bannerLang"]:checked')).map(cb => cb.value);
          const finalLangs = checkedLangs.length > 0 ? checkedLangs : ['all'];

          const qInfo = calculateAvailableQuota(slot, finalLangs);
          const available = qInfo.available;
          const qBase = qInfo.base;

          maxAllowedText.innerText = available + ' (base ' + qBase + ')';
          inputWeightEl.max = available;

          let currentVal = parseInt(inputWeightEl.value, 10) || 0;
          if (available <= 0) {
            inputWeightEl.value = 0;
            inputWeightEl.disabled = true;
            warningEl.style.display = 'block';
            warningEl.innerText = '⚠️ La capacidad para este slot en ' + qInfo.dominantLang.toUpperCase() + ' está al 100% (0/' + qBase + '). Reduce o desactiva otro anuncio.';
            if (submitBtn) { submitBtn.disabled = true; submitBtn.style.opacity = '0.4'; submitBtn.style.cursor = 'not-allowed'; }
          } else {
            inputWeightEl.disabled = false;
            if (currentVal > available) {
              currentVal = available;
              inputWeightEl.value = available;
            }
            if (currentVal <= 0) {
              currentVal = Math.min(10, available);
              inputWeightEl.value = currentVal;
            }
            warningEl.style.display = 'none';
            if (submitBtn) { submitBtn.disabled = false; submitBtn.style.opacity = '1'; submitBtn.style.cursor = 'pointer'; }
          }

          const freePct = Math.round((available / qBase) * 100);
          availableBadge.innerText = available + ' de ' + qBase + ' (' + freePct + '% Libres)';
          centerPct.innerText = freePct + '%';

          const competing = allBannersData.filter(b => {
            if (b.slot !== slot || b.active === false) return false;
            const bLangs = Array.isArray(b.languages) && b.languages.length > 0 ? b.languages : ['all'];
            if (finalLangs.includes('all')) return true;
            return bLangs.includes('all') || bLangs.some(l => finalLangs.includes(l));
          });

          const colors = ['#a855f7', '#38bdf8', '#eab308', '#ec4899', '#06b6d4', '#8b5cf6'];
          let offsetPct = 0;
          let circlesHtml = '';
          let legendHtml = '';

          competing.forEach((b, i) => {
            const w = parseInt(b.weight, 10) || 0;
            const wPct = Math.min(100, Math.round((w / qBase) * 100));
            const col = colors[i % colors.length];
            circlesHtml += '<circle cx="21" cy="21" r="15.91549430918954" fill="transparent" stroke="' + col + '" stroke-width="5" stroke-dasharray="' + wPct + ' ' + (100 - wPct) + '" stroke-dashoffset="-' + offsetPct + '" />';
            legendHtml += '<div style="display:flex; align-items:center; justify-content:space-between; gap:8px;">' +
              '<div style="display:flex; align-items:center; gap:5px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; max-width:180px;">' +
              '<span style="display:inline-block; width:8px; height:8px; border-radius:50%; background:' + col + ';"></span>' +
              '<span style="color:#cbd5e1;">' + b.name + '</span>' +
              '</div>' +
              '<span style="font-weight:700; color:#fff;">' + w + ' / ' + qBase + ' (' + wPct + '%)</span>' +
              '</div>';
            offsetPct += wPct;
          });

          const newW = parseInt(inputWeightEl.value, 10) || 0;
          if (newW > 0 && available > 0) {
            const newPct = Math.min(100 - offsetPct, Math.round((newW / qBase) * 100));
            circlesHtml += '<circle cx="21" cy="21" r="15.91549430918954" fill="transparent" stroke="#ffa726" stroke-width="5" stroke-dasharray="' + newPct + ' ' + (100 - newPct) + '" stroke-dashoffset="-' + offsetPct + '" />';
            legendHtml += '<div style="display:flex; align-items:center; justify-content:space-between; gap:8px;">' +
              '<div style="display:flex; align-items:center; gap:5px;">' +
              '<span style="display:inline-block; width:8px; height:8px; border-radius:50%; background:#ffa726;"></span>' +
              '<span style="color:#ffa726; font-weight:700;">Nuevo Anuncio</span>' +
              '</div>' +
              '<span style="font-weight:800; color:#ffa726;">' + newW + ' / ' + qBase + ' (' + newPct + '%)</span>' +
              '</div>';
            offsetPct += newPct;
          }

          const remainingPct = Math.max(0, 100 - offsetPct);
          if (remainingPct > 0) {
            circlesHtml += '<circle cx="21" cy="21" r="15.91549430918954" fill="transparent" stroke="#22c55e" stroke-width="2" stroke-dasharray="' + remainingPct + ' ' + (100 - remainingPct) + '" stroke-dashoffset="-' + offsetPct + '" opacity="0.4" />';
            legendHtml += '<div style="display:flex; align-items:center; justify-content:space-between; gap:8px; margin-top:2px; padding-top:4px; border-top:1px dashed #360f5c;">' +
              '<div style="display:flex; align-items:center; gap:5px;">' +
              '<span style="display:inline-block; width:8px; height:8px; border-radius:50%; background:#22c55e;"></span>' +
              '<span style="color:#4ade80;">Libre en ' + qInfo.dominantLang.toUpperCase() + '</span>' +
              '</div>' +
              '<span style="font-weight:800; color:#4ade80;">' + available + ' / ' + qBase + ' (' + remainingPct + '%)</span>' +
              '</div>';
          }

          svgEl.innerHTML = circlesHtml;
          legendEl.innerHTML = legendHtml;
        }

        function onBannerWeightChanged(val) {
          const slot = document.getElementById('bannerInputSlot').value;
          const checkedLangs = Array.from(document.querySelectorAll('input[name="bannerLang"]:checked')).map(cb => cb.value);
          const finalLangs = checkedLangs.length > 0 ? checkedLangs : ['all'];
          const qInfo = calculateAvailableQuota(slot, finalLangs);
          const warningEl = document.getElementById('quotaWarningMsg');
          const submitBtn = document.getElementById('btnSubmitNewBanner');

          const v = parseInt(val, 10) || 0;
          if (v > qInfo.available) {
            warningEl.style.display = 'block';
            warningEl.innerText = '❌ Cuota máxima disponible en ' + qInfo.dominantLang.toUpperCase() + ': ' + qInfo.available + ' de ' + qInfo.base + '.';
            if (submitBtn) { submitBtn.disabled = true; submitBtn.style.opacity = '0.4'; submitBtn.style.cursor = 'not-allowed'; }
          } else if (v <= 0) {
            warningEl.style.display = 'block';
            warningEl.innerText = '❌ La cuota debe ser de al menos 1.';
            if (submitBtn) { submitBtn.disabled = true; submitBtn.style.opacity = '0.4'; submitBtn.style.cursor = 'not-allowed'; }
          } else {
            warningEl.style.display = 'none';
            if (submitBtn) { submitBtn.disabled = false; submitBtn.style.opacity = '1'; submitBtn.style.cursor = 'pointer'; }
          }

          updateBannerQuotaPie();
        }

        // Edit Banner Functions
        let currentEditBannerId = null;

        function openEditBannerModal(id) {
          const banner = allBannersData.find(b => b.id === id);
          if (!banner) {
            alert('Banner not found');
            return;
          }
          currentEditBannerId = id;
          document.getElementById('editBannerId').value = banner.id;
          document.getElementById('editBannerInputName').value = banner.name || '';
          document.getElementById('editBannerInputSlot').value = banner.slot || 'studio_left';
          document.getElementById('editBannerInputTarget').value = banner.targetUrl || '';
          document.getElementById('editBannerInputWeight').value = banner.weight || 10;
          document.getElementById('editBannerInputFile').value = '';
          document.getElementById('editBannerInputUrl').value = '';

          // Show current media
          const mediaBox = document.getElementById('editBannerCurrentMedia');
          if (mediaBox && banner.mediaUrl) {
            mediaBox.innerHTML = '<span style="color:#a855f7;">Medio principal:</span> <a href="' + banner.mediaUrl + '" target="_blank" style="color:#ffa726; word-break:break-all;">' + banner.mediaUrl + '</a>';
          }

          // Populate variant fields
          const supported = ['es', 'en', 'pt', 'fr', 'de', 'ja'];
          supported.forEach(l => {
            const fInput = document.getElementById('edit_variant_file_' + l);
            const uInput = document.getElementById('edit_variant_url_' + l);
            const sBox = document.getElementById('edit_variant_status_' + l);
            if (fInput) fInput.value = '';
            if (uInput) uInput.value = (banner.mediaVariants && banner.mediaVariants[l]) || '';
            if (sBox) {
              if (banner.mediaVariants && banner.mediaVariants[l]) {
                sBox.innerHTML = '<span style="color:#38bdf8;">Variante actual:</span> <a href="' + banner.mediaVariants[l] + '" target="_blank" style="color:#7dd3fc; word-break:break-all;">' + banner.mediaVariants[l] + '</a>';
              } else {
                sBox.innerHTML = '';
              }
            }
          });

          // Check language checkboxes
          const bLangs = Array.isArray(banner.languages) && banner.languages.length > 0 ? banner.languages : ['all'];
          const isAll = bLangs.includes('all');
          const allCb = document.getElementById('edit-lang-cb-all');
          if (allCb) allCb.checked = isAll;

          document.querySelectorAll('.edit-lang-cb-specific').forEach(cb => {
            cb.checked = !isAll && bLangs.includes(cb.value);
          });

          document.getElementById('editBannerModal').style.display = 'flex';
          updateEditBannerQuotaPie();
        }

        function closeEditBannerModal() {
          document.getElementById('editBannerModal').style.display = 'none';
          currentEditBannerId = null;
        }

        function handleEditLangAllToggle(allCb) {
          if (allCb.checked) {
            document.querySelectorAll('.edit-lang-cb-specific').forEach(cb => cb.checked = false);
          }
          updateEditBannerQuotaPie();
        }

        function handleEditSpecificLangToggle() {
          const specificChecked = document.querySelectorAll('.edit-lang-cb-specific:checked').length > 0;
          const allCb = document.getElementById('edit-lang-cb-all');
          if (specificChecked && allCb) {
            allCb.checked = false;
          } else if (!specificChecked && allCb) {
            allCb.checked = true;
          }
          updateEditBannerQuotaPie();
        }

        function updateEditBannerQuotaPie() {
          const slot = document.getElementById('editBannerInputSlot').value;
          const inputWeightEl = document.getElementById('editBannerInputWeight');
          const warningEl = document.getElementById('editQuotaWarningMsg');
          const availableBadge = document.getElementById('editQuotaAvailableBadge');
          const maxAllowedText = document.getElementById('editQuotaMaxAllowedText');
          const centerPct = document.getElementById('editQuotaCenterPct');
          const legendEl = document.getElementById('editQuotaBreakdownLegend');
          const svgEl = document.getElementById('editQuotaPieSvg');
          const submitBtn = document.getElementById('btnSubmitEditBanner');

          const checkedLangs = Array.from(document.querySelectorAll('input[name="editBannerLang"]:checked')).map(cb => cb.value);
          const finalLangs = checkedLangs.length > 0 ? checkedLangs : ['all'];

          const qInfo = calculateAvailableQuota(slot, finalLangs, currentEditBannerId);
          const available = qInfo.available;
          const qBase = qInfo.base;

          maxAllowedText.innerText = available + ' (base ' + qBase + ')';
          inputWeightEl.max = available;

          let currentVal = parseInt(inputWeightEl.value, 10) || 0;
          if (available <= 0) {
            inputWeightEl.value = 0;
            inputWeightEl.disabled = true;
            warningEl.style.display = 'block';
            warningEl.innerText = '⚠️ La capacidad para este slot en ' + qInfo.dominantLang.toUpperCase() + ' está al 100% (0/' + qBase + ').';
            if (submitBtn) { submitBtn.disabled = true; submitBtn.style.opacity = '0.4'; submitBtn.style.cursor = 'not-allowed'; }
          } else {
            inputWeightEl.disabled = false;
            if (currentVal > available) {
              currentVal = available;
              inputWeightEl.value = available;
            }
            if (currentVal <= 0) {
              currentVal = Math.min(10, available);
              inputWeightEl.value = currentVal;
            }
            warningEl.style.display = 'none';
            if (submitBtn) { submitBtn.disabled = false; submitBtn.style.opacity = '1'; submitBtn.style.cursor = 'pointer'; }
          }

          const freePct = Math.round((available / qBase) * 100);
          availableBadge.innerText = available + ' de ' + qBase + ' (' + freePct + '% Libres)';
          centerPct.innerText = freePct + '%';

          const competing = allBannersData.filter(b => {
            if (b.slot !== slot || b.active === false || b.id === currentEditBannerId) return false;
            const bLangs = Array.isArray(b.languages) && b.languages.length > 0 ? b.languages : ['all'];
            if (finalLangs.includes('all')) return true;
            return bLangs.includes('all') || bLangs.some(l => finalLangs.includes(l));
          });

          const colors = ['#a855f7', '#38bdf8', '#eab308', '#ec4899', '#06b6d4', '#8b5cf6'];
          let offsetPct = 0;
          let circlesHtml = '';
          let legendHtml = '';

          competing.forEach((b, i) => {
            const w = parseInt(b.weight, 10) || 0;
            const wPct = Math.min(100, Math.round((w / qBase) * 100));
            const col = colors[i % colors.length];
            circlesHtml += '<circle cx="21" cy="21" r="15.91549430918954" fill="transparent" stroke="' + col + '" stroke-width="5" stroke-dasharray="' + wPct + ' ' + (100 - wPct) + '" stroke-dashoffset="-' + offsetPct + '" />';
            legendHtml += '<div style="display:flex; align-items:center; justify-content:space-between; gap:8px;">' +
              '<div style="display:flex; align-items:center; gap:5px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; max-width:180px;">' +
              '<span style="display:inline-block; width:8px; height:8px; border-radius:50%; background:' + col + ';"></span>' +
              '<span style="color:#cbd5e1;">' + b.name + '</span>' +
              '</div>' +
              '<span style="font-weight:700; color:#fff;">' + w + ' / ' + qBase + ' (' + wPct + '%)</span>' +
              '</div>';
            offsetPct += wPct;
          });

          const newW = parseInt(inputWeightEl.value, 10) || 0;
          if (newW > 0 && available > 0) {
            const newPct = Math.min(100 - offsetPct, Math.round((newW / qBase) * 100));
            circlesHtml += '<circle cx="21" cy="21" r="15.91549430918954" fill="transparent" stroke="#38bdf8" stroke-width="5" stroke-dasharray="' + newPct + ' ' + (100 - newPct) + '" stroke-dashoffset="-' + offsetPct + '" />';
            legendHtml += '<div style="display:flex; align-items:center; justify-content:space-between; gap:8px;">' +
              '<div style="display:flex; align-items:center; gap:5px;">' +
              '<span style="display:inline-block; width:8px; height:8px; border-radius:50%; background:#38bdf8;"></span>' +
              '<span style="color:#38bdf8; font-weight:700;">Este Anuncio</span>' +
              '</div>' +
              '<span style="font-weight:800; color:#38bdf8;">' + newW + ' / ' + qBase + ' (' + newPct + '%)</span>' +
              '</div>';
            offsetPct += newPct;
          }

          const remainingPct = Math.max(0, 100 - offsetPct);
          if (remainingPct > 0) {
            circlesHtml += '<circle cx="21" cy="21" r="15.91549430918954" fill="transparent" stroke="#22c55e" stroke-width="2" stroke-dasharray="' + remainingPct + ' ' + (100 - remainingPct) + '" stroke-dashoffset="-' + offsetPct + '" opacity="0.4" />';
            legendHtml += '<div style="display:flex; align-items:center; justify-content:space-between; gap:8px; margin-top:2px; padding-top:4px; border-top:1px dashed #360f5c;">' +
              '<div style="display:flex; align-items:center; gap:5px;">' +
              '<span style="display:inline-block; width:8px; height:8px; border-radius:50%; background:#22c55e;"></span>' +
              '<span style="color:#4ade80;">Libre en ' + qInfo.dominantLang.toUpperCase() + '</span>' +
              '</div>' +
              '<span style="font-weight:800; color:#4ade80;">' + available + ' / ' + qBase + ' (' + remainingPct + '%)</span>' +
              '</div>';
          }

          svgEl.innerHTML = circlesHtml;
          legendEl.innerHTML = legendHtml;
        }

        function onEditBannerWeightChanged(val) {
          const slot = document.getElementById('editBannerInputSlot').value;
          const checkedLangs = Array.from(document.querySelectorAll('input[name="editBannerLang"]:checked')).map(cb => cb.value);
          const finalLangs = checkedLangs.length > 0 ? checkedLangs : ['all'];
          const qInfo = calculateAvailableQuota(slot, finalLangs, currentEditBannerId);
          const warningEl = document.getElementById('editQuotaWarningMsg');
          const submitBtn = document.getElementById('btnSubmitEditBanner');

          const v = parseInt(val, 10) || 0;
          if (v > qInfo.available) {
            warningEl.style.display = 'block';
            warningEl.innerText = '❌ Cuota máxima disponible en ' + qInfo.dominantLang.toUpperCase() + ': ' + qInfo.available + ' de ' + qInfo.base + '.';
            if (submitBtn) { submitBtn.disabled = true; submitBtn.style.opacity = '0.4'; submitBtn.style.cursor = 'not-allowed'; }
          } else if (v <= 0) {
            warningEl.style.display = 'block';
            warningEl.innerText = '❌ La cuota debe ser de al menos 1.';
            if (submitBtn) { submitBtn.disabled = true; submitBtn.style.opacity = '0.4'; submitBtn.style.cursor = 'not-allowed'; }
          } else {
            warningEl.style.display = 'none';
            if (submitBtn) { submitBtn.disabled = false; submitBtn.style.opacity = '1'; submitBtn.style.cursor = 'pointer'; }
          }

          updateEditBannerQuotaPie();
        }

        async function submitEditBanner(e) {
          e.preventDefault();
          if (!currentEditBannerId) return;

          const name = document.getElementById('editBannerInputName').value.trim();
          const slot = document.getElementById('editBannerInputSlot').value;
          const targetUrl = document.getElementById('editBannerInputTarget').value.trim();
          const weight = parseInt(document.getElementById('editBannerInputWeight').value, 10) || 10;
          const fileInput = document.getElementById('editBannerInputFile');
          const urlInput = document.getElementById('editBannerInputUrl').value.trim();

          const checkedLangs = Array.from(document.querySelectorAll('input[name="editBannerLang"]:checked')).map(cb => cb.value);
          const finalLangs = checkedLangs.length > 0 ? checkedLangs : ['all'];

          const qInfo = calculateAvailableQuota(slot, finalLangs, currentEditBannerId);
          if (weight > qInfo.available) {
            alert('?? The requested quota (' + weight + ') exceeds available quota (' + qInfo.available + ' %)');
            return;
          }

          const formData = new FormData();
          formData.append('name', name);
          formData.append('slot', slot);
          formData.append('targetUrl', targetUrl);
          formData.append('weight', weight);
          formData.append('languages', JSON.stringify(finalLangs));

          if (fileInput.files.length > 0) {
            formData.append('bannerFile', fileInput.files[0]);
          } else if (urlInput) {
            formData.append('mediaUrl', urlInput);
          }

          // Append creative variants
          const supported = ['es', 'en', 'pt', 'fr', 'de', 'ja'];
          supported.forEach(l => {
            const f = document.getElementById('edit_variant_file_' + l);
            const u = document.getElementById('edit_variant_url_' + l);
            if (f && f.files.length > 0) {
              formData.append('variant_file_' + l, f.files[0]);
            } else if (u) {
              formData.append('variant_url_' + l, u.value.trim());
            }
          });

          try {
            const res = await fetch('/api/admin/banners/' + currentEditBannerId + '/edit', {
              method: 'POST',
              body: formData
            });
            const data = await res.json();
            if (res.ok && data.success) {
              alert('? Announcement updated successfully.');
              window.location.reload();
            } else {
              alert('Error: ' + (data.error || 'Could not update banner'));
            }
          } catch(err) {
            alert('Connection error while updating announcement.');
          }
        }

        // Quota Config Panel Functions
        function toggleQuotaConfigBox() {
          const box = document.getElementById('quotaConfigBox');
          if (box) {
            box.style.display = (box.style.display === 'none' || !box.style.display) ? 'block' : 'none';
          }
        }

        async function saveLanguageQuotas() {
          const payload = {};
          ['all', 'en', 'es', 'pt', 'fr', 'de', 'ja'].forEach(k => {
            const el = document.getElementById('quota-base-' + k);
            if (el) payload[k] = parseInt(el.value, 10) || 100;
          });
          try {
            const res = await fetch('/api/admin/quota-config', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(payload)
            });
            const data = await res.json();
            if (res.ok && data.success) {
              alert('? Language quotas saved successfully.');
              window.location.reload();
            } else {
              alert('Error saving quotas');
            }
          } catch(e) {
            alert('Connection error');
          }
        }

        // Stats Backup Restore Function
        async function importStatsBackupFile(files) {
          if (!files || files.length === 0) return;
          const file = files[0];
          if (!confirm('¿Deseas restaurar las estadísticas desde "' + file.name + '"? Los contadores actuales se actualizarán con los del respaldo.')) {
            return;
          }
          const reader = new FileReader();
          reader.onload = async (e) => {
            try {
              const json = JSON.parse(e.target.result);
              const res = await fetch('/api/admin/import-stats', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(json)
              });
              const data = await res.json();
              if (res.ok && data.success) {
                alert('? Backup restored successfully.');
                window.location.reload();
              } else {
                alert('❌ Error al restaurar: ' + (data.error || 'Respaldo inválido'));
              }
            } catch(err) {
              alert('❌ Error al procesar el archivo JSON: ' + err.message);
            }
          };
          reader.readAsText(file);
        }

        // Period Filtering Functions
        async function switchPeriod(period) {
          document.querySelectorAll('.period-filter-btn').forEach(btn => {
            btn.classList.toggle('active', btn.getAttribute('data-period') === period);
          });

          try {
            const res = await fetch('/api/admin/stats?period=' + period);
            if (!res.ok) return;
            const data = await res.json();
            if (!data || !data.success) return;

            const s = data.stats;
            const diskInfo = data.diskUsage || {};

            document.getElementById('metric-studio-visits').innerText = s.studioVisits || 0;
            document.getElementById('metric-viewer-visits').innerText = s.viewerVisits || 0;
            document.getElementById('metric-webapp-visits').innerText = s.webappVisits || 0;
            document.getElementById('metric-new-users').innerText = s.newUsersTotal || 0;
            document.getElementById('metric-clips-total').innerText = s.clipsCreatedTotal || 0;
            document.getElementById('metric-disk-used').innerText = (diskInfo.mb || '0.0') + ' MB';
            document.getElementById('metric-disk-sub').innerText = (diskInfo.files || 0) + ' archivos en uploads';
            
            const recM = ((s.clipsDurationSecondsTotal || 0) / 60).toFixed(1);
            const recH = ((s.clipsDurationSecondsTotal || 0) / 3600).toFixed(2);
            document.getElementById('metric-rec-mins').innerText = recM + ' m';
            document.getElementById('metric-rec-hours').innerText = recH + ' horas en total';

            const watchM = ((s.playerWatchTimeSecondsTotal || 0) / 60).toFixed(1);
            const watchH = ((s.playerWatchTimeSecondsTotal || 0) / 3600).toFixed(2);
            document.getElementById('metric-watch-mins').innerText = watchM + ' m';
            document.getElementById('metric-watch-hours').innerText = watchH + ' horas reproducidas';

            document.getElementById('metric-banner-clicks').innerText = s.bannerClicksTotal || 0;
            const ctr = s.bannerImpressionsTotal > 0 ? ((s.bannerClicksTotal / s.bannerImpressionsTotal) * 100).toFixed(2) : '0.00';
            document.getElementById('metric-banner-ctr').innerText = 'CTR Global: ' + ctr + '%';
            document.getElementById('metric-privacy-clips').innerText = s.privacyClipsTotal || 0;

            const devTotal = Math.max(1, (s.deviceBreakdown.desktop || 0) + (s.deviceBreakdown.mobile || 0) + (s.deviceBreakdown.tablet || 0));
            updateBreakdownBar('dev-desktop', s.deviceBreakdown.desktop || 0, devTotal);
            updateBreakdownBar('dev-mobile', s.deviceBreakdown.mobile || 0, devTotal);
            updateBreakdownBar('dev-tablet', s.deviceBreakdown.tablet || 0, devTotal);

            const brTotal = Math.max(1, Object.values(s.browserBreakdown).reduce((a, b) => a + b, 0));
            ['chrome', 'edge', 'firefox', 'safari', 'opera', 'discord', 'other'].forEach(br => {
              updateBreakdownBar('br-' + br, s.browserBreakdown[br] || 0, brTotal);
            });
          } catch(e) {
            console.error('Error switching period:', e);
          }
        }

        function updateBreakdownBar(idPrefix, count, total) {
          const pct = Math.round((count / Math.max(1, total)) * 100);
          const textEl = document.getElementById(idPrefix + '-text');
          const barEl = document.getElementById(idPrefix + '-bar');
          if (textEl) textEl.innerText = count + ' (' + pct + '%)';
          if (barEl) barEl.style.width = pct + '%';
        }

        // System Announcement Functions & Multi-Language Translation
        let currentAnnEditLang = 'es';
        let annBaseData = {
          title: ${(JSON.stringify(announcementData.title || ''))},
          message: ${(JSON.stringify(announcementData.message || ''))},
          actionText: ${(JSON.stringify(announcementData.actionText || ''))}
        };
        let annTranslations = ${(JSON.stringify(announcementData.translations || {}))};

        function getLangLabel(l) {
          const names = { es: 'Español', en: 'English', pt: 'Português', fr: 'Français', de: 'Deutsch', ja: '日本語' };
          return names[l] || l;
        }

        function getLangFlag(l) {
          const flags = { es: '🇪🇸 Español', en: '🇺🇸 English', pt: '🇧🇷 Português', fr: '🇫🇷 Français', de: '🇩🇪 Deutsch', ja: '🇯🇵 日本語' };
          return flags[l] || l;
        }

        function switchAnnouncementLang(targetLang) {
          // Commit current inputs to currentAnnEditLang
          const curTitle = document.getElementById('annInputTitle').value;
          const curMsg = document.getElementById('annInputMessage').value;
          const curBtn = document.getElementById('annInputActionText').value;

          if (currentAnnEditLang === 'es') {
            annBaseData.title = curTitle;
            annBaseData.message = curMsg;
            annBaseData.actionText = curBtn;
          } else {
            if (!annTranslations[currentAnnEditLang]) annTranslations[currentAnnEditLang] = {};
            annTranslations[currentAnnEditLang].title = curTitle;
            annTranslations[currentAnnEditLang].message = curMsg;
            annTranslations[currentAnnEditLang].actionText = curBtn;
          }

          currentAnnEditLang = targetLang;

          document.querySelectorAll('.ann-lang-btn').forEach(btn => {
            btn.classList.toggle('active', btn.getAttribute('data-lang') === targetLang);
          });

          const lblTitle = document.getElementById('lblCurrentAnnLang');
          if (lblTitle) lblTitle.innerText = getLangLabel(targetLang);
          const lblMsg = document.getElementById('lblCurrentAnnLangMsg');
          if (lblMsg) lblMsg.innerText = getLangLabel(targetLang);

          const badge = document.getElementById('prevCurrentLangBadge');
          if (badge) badge.innerText = getLangFlag(targetLang);

          if (targetLang === 'es') {
            document.getElementById('annInputTitle').value = annBaseData.title || '';
            document.getElementById('annInputMessage').value = annBaseData.message || '';
            document.getElementById('annInputActionText').value = annBaseData.actionText || '';
          } else {
            const tr = annTranslations[targetLang] || {};
            document.getElementById('annInputTitle').value = tr.title || annBaseData.title || '';
            document.getElementById('annInputMessage').value = tr.message || annBaseData.message || '';
            document.getElementById('annInputActionText').value = tr.actionText || annBaseData.actionText || '';
          }

          updateAnnouncementPreview();
        }

        function onAnnouncementFieldChange(field, val) {
          if (currentAnnEditLang === 'es') {
            annBaseData[field] = val;
          } else {
            if (!annTranslations[currentAnnEditLang]) annTranslations[currentAnnEditLang] = {};
            annTranslations[currentAnnEditLang][field] = val;
          }
          updateAnnouncementPreview();
        }

        async function autoTranslateAnnouncement() {
          const btn = document.getElementById('btnAutoTranslate');
          const origText = btn.innerHTML;
          btn.disabled = true;
          btn.innerHTML = '⏳ Traduciendo con IA...';

          if (currentAnnEditLang === 'es') {
            annBaseData.title = document.getElementById('annInputTitle').value;
            annBaseData.message = document.getElementById('annInputMessage').value;
            annBaseData.actionText = document.getElementById('annInputActionText').value;
          }

          try {
            const res = await fetch('/api/admin/translate', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                title: annBaseData.title,
                message: annBaseData.message,
                actionText: annBaseData.actionText,
                sourceLang: 'es'
              })
            });
            const data = await res.json();
            if (data.success && data.translations) {
              annTranslations = Object.assign({}, annTranslations, data.translations);
              alert('? Translation completed successfully!');
              switchAnnouncementLang(currentAnnEditLang);
            } else {
              alert('Translation error: ' + (data.error || 'Could not connect'));
            }
          } catch(e) {
            alert('Connection error with translation engine: ' + e.message);
          } finally {
            btn.disabled = false;
            btn.innerHTML = origText;
          }
        }

        function handleAnnouncementFileSelected(input) {
          if (input.files && input.files[0]) {
            const file = input.files[0];
            const previewContainer = document.getElementById('prevAnnMediaContainer');
            const url = URL.createObjectURL(file);
            if (file.type.startsWith('video/')) {
              previewContainer.innerHTML = '<video src="' + url + '" controls playsinline muted loop style="width:100%; max-height:200px; border-radius:12px; background:#000; object-fit:contain;"></video>';
            } else {
              previewContainer.innerHTML = '<img src="' + url + '" style="width:100%; max-height:200px; border-radius:12px; object-fit:contain;" />';
            }
          }
        }

        function updateAnnouncementPreview() {
          const title = document.getElementById('annInputTitle').value;
          const msg = document.getElementById('annInputMessage').value;
          const mediaUrl = document.getElementById('annInputMediaUrl').value;
          const actionText = document.getElementById('annInputActionText').value;
          const actionUrl = document.getElementById('annInputActionUrl').value;
          const active = document.getElementById('annInputActive').checked;

          document.getElementById('prevAnnTitle').innerText = title || 'Título del anuncio';
          document.getElementById('prevAnnMessage').innerText = msg || 'Texto descriptivo de las novedades...';
          
          const actionBtn = document.getElementById('prevAnnActionBtn');
          if (actionUrl && actionText) {
            actionBtn.style.display = 'inline-block';
            actionBtn.innerText = actionText;
            actionBtn.href = actionUrl;
          } else {
            actionBtn.style.display = 'none';
          }

          const liveBadge = document.getElementById('announcementLiveBadge');
          if (liveBadge) {
            liveBadge.className = 'badge-status ' + (active ? 'status-active' : 'status-revoked');
            liveBadge.innerText = active ? 'Activo y Visible' : 'Inactivo / Oculto';
          }

          const fileInput = document.getElementById('annInputFile');
          if (!fileInput.files || fileInput.files.length === 0) {
            const previewContainer = document.getElementById('prevAnnMediaContainer');
            if (mediaUrl) {
              if (mediaUrl.match(/\\.(mp4|webm)($|\\?)/i)) {
                previewContainer.innerHTML = '<video src="' + mediaUrl + '" controls playsinline muted loop style="width:100%; max-height:200px; border-radius:12px; background:#000; object-fit:contain;"></video>';
              } else {
                previewContainer.innerHTML = '<img src="' + mediaUrl + '" style="width:100%; max-height:200px; border-radius:12px; object-fit:contain;" />';
              }
            } else {
              previewContainer.innerHTML = '';
            }
          }
        }

        async function removeAnnouncementMedia() {
          if (!confirm('¿Deseas remover el archivo de medio adjunto de este anuncio?')) return;
          const formData = new FormData();
          formData.append('title', annBaseData.title);
          formData.append('message', annBaseData.message);
          formData.append('actionText', annBaseData.actionText);
          formData.append('actionUrl', document.getElementById('annInputActionUrl').value);
          formData.append('active', document.getElementById('annInputActive').checked);
          formData.append('translations', JSON.stringify(annTranslations));
          formData.append('removeMedia', 'true');

          try {
            const res = await fetch('/api/admin/announcement', { method: 'POST', body: formData });
            if (res.ok) {
              alert('Media deleted successfully.');
              window.location.reload();
            }
          } catch(e) {
            alert('Error deleting media.');
          }
        }

        async function deactivateAnnouncement() {
          document.getElementById('annInputActive').checked = false;
          submitAnnouncement(new Event('submit'));
        }

        async function submitAnnouncement(e) {
          if (e && e.preventDefault) e.preventDefault();
          const btn = document.getElementById('btnSaveAnnouncement');
          if (btn) btn.innerText = 'Guardando...';

          // Commit currently active tab
          const curTitle = document.getElementById('annInputTitle').value;
          const curMsg = document.getElementById('annInputMessage').value;
          const curBtn = document.getElementById('annInputActionText').value;
          if (currentAnnEditLang === 'es') {
            annBaseData.title = curTitle;
            annBaseData.message = curMsg;
            annBaseData.actionText = curBtn;
          } else {
            if (!annTranslations[currentAnnEditLang]) annTranslations[currentAnnEditLang] = {};
            annTranslations[currentAnnEditLang].title = curTitle;
            annTranslations[currentAnnEditLang].message = curMsg;
            annTranslations[currentAnnEditLang].actionText = curBtn;
          }

          const formData = new FormData();
          formData.append('title', annBaseData.title);
          formData.append('message', annBaseData.message);
          formData.append('actionText', annBaseData.actionText);
          formData.append('actionUrl', document.getElementById('annInputActionUrl').value);
          formData.append('active', document.getElementById('annInputActive').checked);
          formData.append('translations', JSON.stringify(annTranslations));

          const fileInput = document.getElementById('annInputFile');
          if (fileInput.files.length > 0) {
            formData.append('mediaFile', fileInput.files[0]);
          } else {
            formData.append('mediaUrl', document.getElementById('annInputMediaUrl').value);
          }

          try {
            const res = await fetch('/api/admin/announcement', { method: 'POST', body: formData });
            const data = await res.json();
            if (res.ok && data.success) {
              alert('? System announcement saved and published in all languages.');
              window.location.reload();
            } else {
              alert('Error: ' + (data.error || 'Could not save announcement'));
            }
          } catch(err) {
            alert('Connection error while saving announcement');
          } finally {
            if (btn) btn.innerText = 'Guardar y Publicar 🚀';
          }
        }

        function toggleGeoStats(id) {
          const el = document.getElementById('geostats-' + id);
          if (!el) return;
          el.style.display = (el.style.display === 'none' || el.style.display === '') ? 'block' : 'none';
        }

        function handleLangAllToggle(allCb) {
          if (allCb.checked) {
            document.querySelectorAll('.lang-cb-specific').forEach(cb => cb.checked = false);
          }
          updateBannerQuotaPie();
        }

        function handleSpecificLangToggle() {
          const specificChecked = document.querySelectorAll('.lang-cb-specific:checked').length > 0;
          const allCb = document.getElementById('lang-cb-all');
          if (specificChecked && allCb) {
            allCb.checked = false;
          } else if (!specificChecked && allCb) {
            allCb.checked = true;
          }
          updateBannerQuotaPie();
        }

        async function submitNewBanner(e) {
          e.preventDefault();
          const name = document.getElementById('bannerInputName').value.trim();
          const slot = document.getElementById('bannerInputSlot').value;
          const targetUrl = document.getElementById('bannerInputTarget').value.trim();
          const weight = parseInt(document.getElementById('bannerInputWeight').value, 10) || 10;
          const fileInput = document.getElementById('bannerInputFile');
          const urlInput = document.getElementById('bannerInputUrl').value.trim();

          const checkedLangs = Array.from(document.querySelectorAll('input[name="bannerLang"]:checked')).map(cb => cb.value);
          const finalLangs = checkedLangs.length > 0 ? checkedLangs : ['all'];

          // Client-side Strict Quota Preflight with language segment awareness:
          const qInfo = calculateAvailableQuota(slot, finalLangs);
          if (weight > qInfo.available) {
            alert('?? The requested quota (' + weight + ') exceeds available quota (' + qInfo.available + ' %)');
            return;
          }

          const formData = new FormData();
          formData.append('name', name);
          formData.append('slot', slot);
          formData.append('targetUrl', targetUrl);
          formData.append('weight', weight);
          formData.append('languages', JSON.stringify(finalLangs));

          if (fileInput.files.length > 0) {
            formData.append('bannerFile', fileInput.files[0]);
          } else if (urlInput) {
            formData.append('mediaUrl', urlInput);
          } else {
            alert('Please select a file or enter a URL for the announcement media.');
            return;
          }

          // Append creative variants
          const supported = ['es', 'en', 'pt', 'fr', 'de', 'ja'];
          supported.forEach(l => {
            const f = document.getElementById('new_variant_file_' + l);
            const u = document.getElementById('new_variant_url_' + l);
            if (f && f.files.length > 0) {
              formData.append('variant_file_' + l, f.files[0]);
            } else if (u && u.value.trim()) {
              formData.append('variant_url_' + l, u.value.trim());
            }
          });

          try {
            const res = await fetch('/api/admin/banners', { method: 'POST', body: formData });
            const data = await res.json();
            if (res.ok && data.success) {
              alert('? Announcement created and activated successfully.');
              window.location.reload();
            } else {
              alert('Error: ' + (data.error || 'Could not create banner'));
            }
          } catch(err) {
            alert('Connection error while creating announcement.');
          }
        }

        async function toggleBannerActive(id) {
          try {
            const res = await fetch('/api/admin/banners/' + id + '/toggle', { method: 'POST' });
            if (res.ok) {
              window.location.reload();
            } else {
              alert('Error changing banner status');
            }
          } catch(e) {
            alert('Connection error');
          }
        }

        async function deleteBanner(id) {
          if (!confirm('¿Estás seguro de que deseas eliminar este anuncio?')) return;
          try {
            const res = await fetch('/api/admin/banners/' + id, { method: 'DELETE' });
            if (res.ok) {
              window.location.reload();
            } else {
              alert('Error deleting banner');
            }
          } catch(e) {
            alert('Connection error');
          }
        }

        // Reset Test Data Functions
        function openResetModal() {
          const pass = document.getElementById('resetAdminPasswordInput');
          if (pass) pass.value = '';
          document.getElementById('resetModal').style.display = 'flex';
          setTimeout(() => pass && pass.focus(), 100);
        }
        function closeResetModal() {
          const pass = document.getElementById('resetAdminPasswordInput');
          if (pass) pass.value = '';
          document.getElementById('resetModal').style.display = 'none';
        }

        async function submitResetTestData() {
          const passInput = document.getElementById('resetAdminPasswordInput');
          const password = passInput ? passInput.value.trim() : '';
          if (!password) {
            alert('You must enter your administrator password to authorize the purge.');
            return;
          }
          try {
            const res = await fetch('/api/admin/reset-test-data', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ password })
            });
            const data = await res.json();
            if (res.ok && data.success) {
              alert('?? Database and test files purged successfully. ' + data.deletedFiles + ' files deleted.');
              window.location.reload();
            } else {
              alert('Error: ' + (data.error || 'Could not purge data'));
            }
          } catch(e) {
            alert('Connection error while purging data');
          }
        }

        // Clips & Moderation Functions
        function previewClipModal(id, titleEncoded, type, directUrl) {
          const modal = document.getElementById('previewModal');
          const mediaContainer = document.getElementById('modalMediaContainer');
          const modalTitle = document.getElementById('modalTitle');
          const modalLinks = document.getElementById('modalLinks');
          const title = decodeURIComponent(titleEncoded);
          const mediaSrc = directUrl || ('/' + ADMIN_SECRET_PATH + '/raw/' + id);
          
          modalTitle.innerText = title + ' (ID: ' + id + ')';
          
          if (type === 'video') {
            mediaContainer.innerHTML = '<video id="adminPreviewVideo" controls autoplay playsinline src="' + mediaSrc + '" style="max-width:100%; max-height:65vh; border-radius:8px;"></video>';
            const v = document.getElementById('adminPreviewVideo');
            if (v) { v.muted = false; v.volume = 1.0; }
          } else {
            mediaContainer.innerHTML = '<img src="' + mediaSrc + '" style="max-width:100%; max-height:65vh; object-fit:contain;" />';
          }
          
          modalLinks.innerHTML = '<a href="' + BASE_URL + '/v/' + id + '" target="_blank" class="btn-table btn-view">🌐 Abrir Público</a>' +
                                 '<a href="' + mediaSrc + '" target="_blank" download class="btn-table btn-restore">⬇️ Descargar Directo</a>';
          modal.style.display = 'flex';
        }

        function closePreviewModal() {
          const modal = document.getElementById('previewModal');
          const mediaContainer = document.getElementById('modalMediaContainer');
          if (mediaContainer) mediaContainer.innerHTML = '';
          if (modal) modal.style.display = 'none';
        }

        async function openAuditModal(id) {
          const modal = document.getElementById('auditModal');
          const title = document.getElementById('auditModalTitle');
          const sub = document.getElementById('auditModalSubtitle');
          const uploaderGrid = document.getElementById('uploaderInfoGrid');
          const viewsContainer = document.getElementById('viewsLogContainer');
          const countBadge = document.getElementById('auditViewsCountBadge');

          title.innerText = 'Cargando datos de auditoría...';
          sub.innerText = 'ID: ' + id;
          uploaderGrid.innerHTML = '<div style="color:#cbd5e1;">Consultando base de datos...</div>';
          viewsContainer.innerHTML = '';
          modal.style.display = 'flex';

          try {
            const res = await fetch('/api/admin/details/' + id);
            if (!res.ok) throw new Error('Error al cargar');
            const data = await res.json();
            
            title.innerText = 'Auditoría: ' + data.originalName;
            sub.innerText = 'ID: ' + data.id + ' • Archivo en disco: ' + data.filename;

            const u = data.uploader || {};

            uploaderGrid.innerHTML = '<div>' +
              '<span style="color:#a855f7; font-weight:bold;">📍 IP del Creador:</span>' +
              '<div style="color:#ffa726; font-family:monospace; font-weight:bold; margin-top:3px;">' + (u.ip || 'No registrada') + '</div>' +
              '</div>' +
              '<div>' +
              '<span style="color:#a855f7; font-weight:bold;">💻 Dispositivo y SO:</span>' +
              '<div style="color:#fff; margin-top:3px;">' + (u.os || 'Desconocido') + ' (' + (u.deviceType || 'PC') + ')</div>' +
              '</div>' +
              '<div>' +
              '<span style="color:#a855f7; font-weight:bold;">🌐 Navegador:</span>' +
              '<div style="color:#fff; margin-top:3px;">' + (u.browser || 'Web') + '</div>' +
              '</div>' +
              '<div>' +
              '<span style="color:#a855f7; font-weight:bold;">⏱️ Fecha de Subida:</span>' +
              '<div style="color:#fff; margin-top:3px;">' + (u.uploadDate || new Date(data.createdAt).toLocaleString()) + '</div>' +
              '</div>' +
              '<div>' +
              '<span style="color:#a855f7; font-weight:bold;">📦 Tamaño / Formato:</span>' +
              '<div style="color:#fff; margin-top:3px;">' + ((data.size || 0)/(1024*1024)).toFixed(2) + ' MB • ' + data.mimetype + '</div>' +
              '</div>' +
              '<div>' +
              '<span style="color:#a855f7; font-weight:bold;">⏱️ Caducidad Efímera:</span>' +
              '<div style="color:#fff; margin-top:3px;">6 horas (Estricto)</div>' +
              '</div>';

            const logs = data.viewsLog || [];
            countBadge.innerText = logs.length + ' evento(s) de acceso';

            if (logs.length === 0) {
              viewsContainer.innerHTML = '<div style="color:#94a3b8; font-style:italic; padding:16px; text-align:center;">Ningún espectador ha abierto este enlace todavía.</div>';
            } else {
              let tableHtml = '<table style="width:100%; border-collapse:collapse; font-size:12px;">' +
                '<thead><tr style="border-bottom:1px solid #360d5e; color:#c084fc; text-align:left;">' +
                '<th style="padding:8px 10px;">#</th><th style="padding:8px 10px;">Fecha y Hora</th>' +
                '<th style="padding:8px 10px;">Dirección IP</th><th style="padding:8px 10px;">Dispositivo / SO</th>' +
                '<th style="padding:8px 10px;">Navegador</th><th style="padding:8px 10px;">Acceso</th>' +
                '<th style="padding:8px 10px;">Estado</th></tr></thead><tbody>';

              logs.forEach((log, idx) => {
                const isAllowed = log.allowed;
                const badgeStyle = 'padding:2px 8px; border-radius:10px; font-size:11px; font-weight:bold; background:' + (isAllowed ? 'rgba(34,197,94,0.15)' : 'rgba(239,68,68,0.15)') + '; color:' + (isAllowed ? '#4ade80' : '#f87171') + '; border:1px solid ' + (isAllowed ? '#22c55e' : '#ef4444') + ';';
                const accessBadge = log.isCreatorKey ? '<span style="color:#eab308; font-weight:bold;">👑 Maestro</span>' : '<span style="color:#38bdf8;">🌐 Público</span>';

                tableHtml += '<tr style="border-bottom:1px solid #240a3d;">' +
                  '<td style="padding:8px 10px; color:#94a3b8;">' + (idx + 1) + '</td>' +
                  '<td style="padding:8px 10px; color:#cbd5e1;">' + (log.date || new Date(log.timestamp).toLocaleString()) + '</td>' +
                  '<td style="padding:8px 10px; font-family:monospace; color:#ffa726; font-weight:bold;">' + (log.ip || '127.0.0.1') + '</td>' +
                  '<td style="padding:8px 10px; color:#fff;">' + (log.os || 'Desconocido') + ' (' + (log.deviceType || 'PC') + ')</td>' +
                  '<td style="padding:8px 10px; color:#cbd5e1;">' + (log.browser || 'Web') + '</td>' +
                  '<td style="padding:8px 10px;">' + accessBadge + '</td>' +
                  '<td style="padding:8px 10px;"><span style="' + badgeStyle + '">' + (log.status || (isAllowed ? 'Permitido' : 'Bloqueado')) + '</span></td>' +
                  '</tr>';
              });
              tableHtml += '</tbody></table>';
              viewsContainer.innerHTML = tableHtml;
            }
          } catch (e) {
            title.innerText = 'Error al cargar';
            uploaderGrid.innerHTML = '<div style="color:#ef4444;">No se pudieron obtener los detalles del clip.</div>';
          }
        }

        function closeAuditModal() {
          const modal = document.getElementById('auditModal');
          if (modal) modal.style.display = 'none';
        }

        function filterTable(query) {
          const q = query.toLowerCase().trim();
          const rows = document.querySelectorAll('#mediaTable tbody tr');
          let count = 0;
          rows.forEach(r => {
            const txt = (r.getAttribute('data-search') || '').toLowerCase();
            const show = txt.includes(q);
            r.style.display = show ? '' : 'none';
            if (show) count++;
          });
          document.getElementById('itemCount').innerText = count;
        }

        async function toggleRevoke(id) {
          const btn = document.getElementById('btn-rev-' + id);
          const badge = document.getElementById('status-' + id);
          const isCurrentlyRevoked = badge.classList.contains('status-revoked');
          const endpoint = isCurrentlyRevoked ? ('/api/admin/restore/' + id) : ('/api/admin/revoke/' + id);

          try {
            const res = await fetch(endpoint, { method: 'POST' });
            if (res.ok) {
              if (isCurrentlyRevoked) {
                badge.className = 'badge-status status-active';
                badge.innerText = '🟢 Activo';
                btn.innerText = '🛑 Revocar';
              } else {
                badge.className = 'badge-status status-revoked';
                badge.innerText = '🔴 Revocado';
                btn.innerText = '♻️ Reactivar';
              }
            } else {
              alert('Error modifying status');
            }
          } catch (e) {
            alert('Connection error');
          }
        }

        async function deleteClip(id) {
          if (!confirm('¿Estás seguro de que deseas eliminar permanentemente este archivo del disco y base de datos?')) return;
          try {
            const res = await fetch('/api/admin/delete/' + id, { method: 'POST' });
            if (res.ok) {
              const row = document.getElementById('row-' + id);
              if (row) row.remove();
            } else {
              alert('Error deleting');
            }
          } catch(e) {
            alert('Connection error');
          }
        }

        function openPasswordModal() {
          document.getElementById('passwordModal').style.display = 'flex';
          document.getElementById('inputNewAdminPassword').value = '';
          document.getElementById('inputConfirmAdminPassword').value = '';
          document.getElementById('inputNewAdminPassword').focus();
        }

        function closePasswordModal() {
          document.getElementById('passwordModal').style.display = 'none';
        }

        async function submitNewPassword() {
          const p1 = document.getElementById('inputNewAdminPassword').value.trim();
          const p2 = document.getElementById('inputConfirmAdminPassword').value.trim();
          if (!p1) {
            alert('Please enter a new password.');
            return;
          }
          if (p1.length < 4) {
            alert('The password must be at least 4 characters long.');
            return;
          }
          if (p1 !== p2) {
            alert('The passwords do not match. Please verify.');
            return;
          }

          try {
            const res = await fetch('/api/admin/change-password', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ password: p1 })
            });
            const data = await res.json();
            if (res.ok && data.success) {
              alert('? Master password updated successfully.');
              closePasswordModal();
            } else {
              alert('Error: ' + (data.error || 'Could not update password'));
            }
          } catch(e) {
            alert('Connection error while saving password.');
          }
        }

        // Multi-Language Switcher for Master Admin Panel
        const adminI18n = {
          es: {
            badge_panel: '🛡️ Panel Maestro',
            tab_clips: '📁 Clips',
            tab_banners: '📢 Banners',
            tab_announcement: '📣 Anuncio del Sistema',
            tab_stats: '📊 Estadísticas y Métricas',
            btn_purge: '🗑️ Purgar Datos',
            btn_studio: '🚀 Estudio',
            btn_pwd: '🔑 Contraseña',
            btn_logout: 'Cerrar Sesión'
          },
          en: {
            badge_panel: '🛡️ Master Panel',
            tab_clips: '📁 Clips',
            tab_banners: '📢 Ad Banners',
            tab_announcement: '📣 System Announcement',
            tab_stats: '📊 Stats & Metrics',
            btn_purge: '🗑️ Purge Data',
            btn_studio: '🚀 Studio',
            btn_pwd: '🔑 Password',
            btn_logout: 'Log Out'
          },
          pt: {
            badge_panel: '🛡️ Painel Mestre',
            tab_clips: '📁 Clipes',
            tab_banners: '📢 Banners',
            tab_announcement: '📣 Anúncio do Sistema',
            tab_stats: '📊 Estatísticas e Métricas',
            btn_purge: '🗑️ Purgar Dados',
            btn_studio: '🚀 Estúdio',
            btn_pwd: '🔑 Senha',
            btn_logout: 'Encerrar Sessão'
          },
          fr: {
            badge_panel: '🛡️ Panneau Maître',
            tab_clips: '📁 Clips',
            tab_banners: '📢 Bannières',
            tab_announcement: '📣 Annonce Système',
            tab_stats: '📊 Statistiques & Métriques',
            btn_purge: '🗑️ Purger Données',
            btn_studio: '🚀 Studio',
            btn_pwd: '🔑 Mot de passe',
            btn_logout: 'Déconnexion'
          },
          de: {
            badge_panel: '🛡️ Master-Panel',
            tab_clips: '📁 Clips',
            tab_banners: '📢 Werbebanner',
            tab_announcement: '📣 System-Ankündigung',
            tab_stats: '📊 Statistiken & Metriken',
            btn_purge: '🗑️ Daten löschen',
            btn_studio: '🚀 Studio',
            btn_pwd: '🔑 Passwort',
            btn_logout: 'Abmelden'
          },
          ja: {
            badge_panel: '🛡️ マスターパネル',
            tab_clips: '📁 クリップ',
            tab_banners: '📢 広告バナー',
            tab_announcement: '📣 システム通知',
            tab_stats: '📊 統計とメトリクス',
            btn_purge: '🗑️ データを消去',
            btn_studio: '🚀 スタジオ',
            btn_pwd: '🔑 パスワード',
            btn_logout: 'ログアウト'
          }
        };

        function changeAdminLanguage(lang) {
          try {
            localStorage.setItem('zylo_admin_lang', lang);
          } catch(e){}
          const dict = adminI18n[lang] || adminI18n.es;
          document.querySelectorAll('[data-admin-key]').forEach(el => {
            const key = el.getAttribute('data-admin-key');
            if (dict[key]) {
              el.innerText = dict[key];
            }
          });
          const sel = document.getElementById('adminLangSelector');
          if (sel) sel.value = lang;
        }

        try {
          const savedAdminLang = localStorage.getItem('zylo_admin_lang') || 'es';
          changeAdminLanguage(savedAdminLang);
        } catch(e){}

      </script>
    </body>
    </html>
  `);
});

export default router;
