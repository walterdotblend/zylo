import express from 'express';
import path from 'path';
import fs from 'fs';
import { UPLOAD_DIR, getBaseUrl } from '../config/constants.js';
import { mediaDb, saveDb, recordVisit } from '../db/store.js';
import { getDeviceSignature, parseClientDetails } from '../middleware/security.js';
import * as r2 from '../services/r2.js';

const router = express.Router();

// --- TOS and Privacy Policy ---
router.get('/tos', (req, res) => {
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8"><title>Terms of Service | Zylo</title>
  <link rel="icon" type="image/png" href="/favicon.png?v=5" />
  <style>body { font-family: sans-serif; background: #0d0218; color: #cbd5e1; padding: 40px; line-height: 1.6; max-width: 800px; margin: auto; } h1, h2 { color: #ff851b; }</style>
</head>
<body>
  <h1>Terms of Service</h1>
  <p>Welcome to Zylo (zylo.stream). By using our service, you agree to the following terms:</p>
  <h2>1. Service Usage</h2>
  <p>Zylo is provided "as is". You agree not to use the service for illegal, abusive, or harmful purposes.</p>
  <h2>2. Content Responsibility</h2>
  <p>You are solely responsible for the media you upload and share through Zylo. We do not actively monitor content but reserve the right to remove links that violate our terms or applicable laws.</p>
  <h2>3. Service Availability</h2>
  <p>We do not guarantee 100% uptime and are not responsible for any data loss. Clips are ephemeral and will be automatically deleted after their expiration.</p>
  <p><br/><a href="/" style="color:#ff851b;">Return Home</a></p>
</body>
</html>`);
});

router.get('/privacy', (req, res) => {
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8"><title>Privacy Policy | Zylo</title>
  <link rel="icon" type="image/png" href="/favicon.png?v=5" />
  <style>body { font-family: sans-serif; background: #0d0218; color: #cbd5e1; padding: 40px; line-height: 1.6; max-width: 800px; margin: auto; } h1, h2 { color: #ff851b; }</style>
</head>
<body>
  <h1>Privacy Policy</h1>
  <p>Your privacy is important to us. This policy explains how we handle your data:</p>
  <h2>1. Data Collection</h2>
  <p>We temporarily store the video clips you upload to provide the sharing functionality. We also collect basic telemetry such as your IP address and device type strictly for rate-limiting, security, and applying creator-defined privacy restrictions.</p>
  <h2>2. Data Sharing & Law Enforcement</h2>
  <p>We do not sell your personal data or uploaded media to third parties. However, we will cooperate fully with law enforcement agencies and comply with valid legal requests or court orders if required to do so.</p>
  <h2>3. Data Retention</h2>
  <p>All media uploaded to Zylo is ephemeral. Clips and their associated metadata are automatically and permanently deleted from our servers once they expire.</p>
  <p><br/><a href="/" style="color:#ff851b;">Return Home</a></p>
</body>
</html>`);
});

// RAW streaming Endpoint with 100% R2 Direct CDN Redirection (Zero Render Bandwidth)
router.get('/raw/:id', (req, res) => {
  const cleanId = req.params.id.replace(/\.(mp4|webm|png|jpg|jpeg|mkv)$/i, '');
  const item = mediaDb[cleanId] || mediaDb[req.params.id];
  if (!item) {
    return res.status(404).send('File not found.');
  }

  const isCreatorKey = req.query.key && req.query.key === item.adminSecret;
  if (item.publicExpired && !isCreatorKey) {
    return res.status(403).send('Public access to this file has expired.');
  }

  const filePath = path.join(UPLOAD_DIR, item.filename);
  const localExists = fs.existsSync(filePath);
  if (!localExists && !(item.r2 && r2.enabled)) {
    return res.status(404).send('File not found on storage.');
  }

  if (item.privacy && item.privacy.active) {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    res.setHeader('Surrogate-Control', 'no-store');
  } else {
    res.setHeader('Cache-Control', 'public, max-age=86400');
  }

  let contentType = item.mimetype || 'video/webm';
  const fname = (item.filename || '').toLowerCase();
  const oname = (item.originalName || '').toLowerCase();
  if (fname.endsWith('.webm') || oname.endsWith('.webm')) contentType = 'video/webm';
  else if (fname.endsWith('.mp4') || oname.endsWith('.mp4')) contentType = 'video/mp4';
  else if (fname.endsWith('.png') || oname.endsWith('.png')) contentType = 'image/png';
  else if (fname.endsWith('.jpg') || fname.endsWith('.jpeg') || oname.endsWith('.jpg') || oname.endsWith('.jpeg')) contentType = 'image/jpeg';

  // 100% Zero Render Bandwidth: Redirect directly to Cloudflare R2 public CDN
  const directR2Url = r2.getPublicClipUrl(item);
  if (directR2Url && item.r2) {
    return res.redirect(302, directR2Url);
  }

  if (!localExists) {
    return r2.streamClip(item, req, res, contentType).then(ok => {
      if (!ok && !res.headersSent) res.status(404).send('File not found.');
    });
  }

  const stat = fs.statSync(filePath);
  const fileSize = stat.size;
  const range = req.headers.range;

  if (range && contentType.startsWith('video/')) {
    const parts = range.replace(/bytes=/, "").split("-");
    const start = parseInt(parts[0], 10);
    let end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
    if (isNaN(start) || start >= fileSize) {
      res.writeHead(416, { 'Content-Range': `bytes */${fileSize}` });
      return res.end();
    }
    if (end >= fileSize) end = fileSize - 1;
    const chunksize = (end - start) + 1;
    const stream = fs.createReadStream(filePath, { start, end });
    res.writeHead(206, {
      'Content-Range': `bytes ${start}-${end}/${fileSize}`,
      'Accept-Ranges': 'bytes',
      'Content-Length': chunksize,
      'Content-Type': contentType
    });
    stream.pipe(res);
  } else {
    res.writeHead(200, {
      'Content-Length': fileSize,
      'Content-Type': contentType,
      'Accept-Ranges': 'bytes'
    });
    fs.createReadStream(filePath).pipe(res);
  }
});

const clientI18nScript = `
<script src="/i18n.js"></script>
<script>
  (function() {
    var lang = localStorage.getItem('zylo_lang') || localStorage.getItem('mogi_lang');
    if (lang !== 'es') return;
    var t = {
      creator: "👑 Creador", privacy: "👁️ Privacidad Extra", expires: "Expira:",
      shieldTitle: "Contenido Protegido", shieldDesc: "Captura de pantalla o cambio de ventana detectado. El video se pausa automáticamente para proteger la confidencialidad. Haz clic aquí para reanudar.",
      playbackCompleted: "Reproducción Finalizada", playbackCompletedDesc: "Este video fue configurado para una única reproducción por visita y ha concluido.",
      btnDownload: "⬇️ Descargar", btnCopy: "📋 Copiar enlace", alertCopied: "¡Link copiado!",
      fileNotFoundTitle: "Archivo No Encontrado | Zylo", fileNotFoundHeading: "⏳ Archivo no encontrado", fileNotFoundDesc: "Este archivo no existe o fue retirado.",
      expiredTitle: "Acceso Público Expirado | Zylo", expiredHeading: "🔒 Acceso Público Desactivado", expiredDesc: "Este enlace público ha alcanzado su límite de visitas o el tiempo configurado ha expirado.",
      mobileTitle: "Acceso Restringido | Zylo", mobileHeading: "📱 Solo visible desde Dispositivos Móviles", mobileDesc: "Por configuración del creador, este enlace solo se puede abrir desde un teléfono celular.",
      lockTitle: "Dispositivo no autorizado | Zylo", lockHeading: "🚫 Acceso Denegado (Dispositivo Bloqueado)", lockDesc: "Este enlace fue configurado para ser visto únicamente por el primer dispositivo que lo abrió.",
      visitsTitle: "Acceso Finalizado | Zylo", visitsHeading: "🔒 Límite de Visitas Alcanzado",
      sessionTitle: "Sesión Bloqueada | Zylo", sessionHeading: "⚠️ Enlace Abierto en Otra Sesión", sessionDesc: "Por configuración de privacidad del creador, este enlace solo permite una única sesión activa y ya fue abierto en otro navegador o dispositivo."
    };
    var badge = document.querySelector('header .badge');
    if (badge) {
      if (badge.innerHTML.includes('👑')) badge.innerHTML = t.creator;
      else if (badge.innerHTML.includes('👁️')) badge.innerHTML = t.privacy;
      else if (badge.innerHTML.includes('Expires')) {
        var dateText = badge.innerHTML.split('<\\/span>')[1] || badge.innerHTML.split(':')[1] || '';
        badge.innerHTML = '<span>' + t.expires + '</span>' + dateText;
      }
    }
    var shield = document.getElementById('privacyShield');
    if (shield) { var divs = shield.querySelectorAll('div'); if (divs.length >= 3) { divs[1].innerText = t.shieldTitle; divs[2].innerText = t.shieldDesc; } }
    var spOverlay = document.getElementById('singlePlayFinishedOverlay');
    if (spOverlay) { var spDivs = spOverlay.querySelectorAll('div'); if (spDivs.length >= 3) { spDivs[1].innerText = t.playbackCompleted; spDivs[2].innerText = t.playbackCompletedDesc; } }
    var btnDownload = document.querySelector('.btn-primary');
    if (btnDownload) btnDownload.innerText = t.btnDownload;
    var btns = document.querySelectorAll('.btn');
    btns.forEach(function(btn) { if (btn.innerText.includes('Copy')) { btn.innerText = t.btnCopy; btn.setAttribute('onclick', "navigator.clipboard.writeText(window.location.href); alert('" + t.alertCopied + "');"); } });
    var errHeading = document.querySelector('body > h2');
    var errDesc = document.querySelector('body > p');
    if (errHeading && errDesc) {
      if (errHeading.innerText.includes('File not found')) { document.title = t.fileNotFoundTitle; errHeading.innerText = t.fileNotFoundHeading; errDesc.innerText = t.fileNotFoundDesc; }
      else if (errHeading.innerText.includes('Public Access')) { document.title = t.expiredTitle; errHeading.innerText = t.expiredHeading; errDesc.innerText = t.expiredDesc; }
      else if (errHeading.innerText.includes('Mobile Devices')) { document.title = t.mobileTitle; errHeading.innerText = t.mobileHeading; errDesc.innerText = t.mobileDesc; }
      else if (errHeading.innerText.includes('Denied')) { document.title = t.lockTitle; errHeading.innerText = t.lockHeading; errDesc.innerText = t.lockDesc; }
      else if (errHeading.innerText.includes('Visit Limit')) {
        document.title = t.visitsTitle; errHeading.innerText = t.visitsHeading;
        var match = errDesc.innerText.match(/\\d+/);
        if (match) errDesc.innerText = "El acceso público para este enlace ha concluido tras alcanzar " + match[0] + " visita(s).";
      }
      else if (errHeading.innerText.includes('Session')) { document.title = t.sessionTitle; errHeading.innerText = t.sessionHeading; errDesc.innerText = t.sessionDesc; }
    }
  })();
</script>
`;

// Heartbeat to keep active session alive
router.get('/api/heartbeat/:id', (req, res) => {
  const item = mediaDb[req.params.id];
  const tab = req.query.tab;
  if (item && item.privacy && item.privacy.singleSession && tab) {
    if (item.privacy.activeSessionId === tab) {
      item.privacy.activeSessionTime = Date.now();
    }
  }
  res.json({ ok: true });
});

router.get('/v/:id', (req, res) => {
  recordVisit('viewer', req);
  const item = mediaDb[req.params.id];
  const userAgent = req.headers['user-agent'] || '';
  const acceptLang = req.headers['accept-language'] || '';
  const cookies = (req.headers.cookie || '').split(';').reduce((acc, c) => {
    const [k, v] = c.trim().split('=');
    if (k) acc[k] = v;
    return acc;
  }, {});
  const langCookie = cookies['zylo_lang'] || cookies['mbp_lang'] || cookies['mogi_lang'];
  const isEn = langCookie ? (langCookie === 'en') : !/es/i.test(acceptLang.split(',')[0]);

  const t = {
    notFoundTitle: isEn ? "File Not Found | Zylo" : "Archivo No Encontrado | Zylo",
    notFoundHeading: isEn ? "⏳ File not found" : "⏳ Archivo no encontrado",
    notFoundDesc: isEn ? "This file does not exist or has been removed." : "Este archivo no existe o fue retirado.",
    expiredTitle: isEn ? "Public Access Expired | Zylo" : "Acceso Público Expirado | Zylo",
    expiredHeading: isEn ? "🔒 Public Access Disabled" : "🔒 Acceso Público Desactivado",
    expiredDesc: isEn ? "This public link has reached its visit limit or its expiration time has passed." : "Este enlace público ha alcanzado su límite de visitas o el tiempo configurado ha expirado.",
    mobileTitle: isEn ? "Restricted Access | Zylo" : "Acceso Restringido | Zylo",
    mobileHeading: isEn ? "📱 Mobile Devices Only" : "📱 Solo visible desde Dispositivos Móviles",
    mobileDesc: isEn ? "Per creator settings, this link can only be viewed from a mobile phone." : "Por configuración del creador, este enlace solo se puede abrir desde un teléfono celular.",
    lockTitle: isEn ? "Unauthorized Device | Zylo" : "Dispositivo no autorizado | Zylo",
    lockHeading: isEn ? "🚫 Access Denied (Device Locked)" : "🚫 Acceso Denegado (Dispositivo Bloqueado)",
    lockDesc: isEn ? "This link was configured to be viewed exclusively by the first device that opened it." : "Este enlace fue configurado para ser visto únicamente por el primer dispositivo que lo abrió.",
    visitsTitle: isEn ? "Access Completed | Zylo" : "Acceso Finalizado | Zylo",
    visitsHeading: isEn ? "🔒 Visit Limit Reached" : "🔒 Límite de Visitas Alcanzado",
    visitsDesc: (max) => isEn ? `Public access for this link has ended after reaching ${max} visit(s).` : `El acceso público para este enlace ha concluido tras alcanzar ${max} visita(s).`,
    sessionTitle: isEn ? "Session Blocked | Zylo" : "Sesión Bloqueada | Zylo",
    sessionHeading: isEn ? "⚠️ Link Opened in Another Session" : "⚠️ Enlace Abierto en Otra Sesión",
    sessionDesc: isEn ? "Per creator settings, this link can only be viewed in a single active session and was already opened elsewhere." : "Por configuración de privacidad del creador, este enlace solo permite una única sesión activa y ya fue abierto en otro navegador o dispositivo.",
    badgeCreator: isEn ? "👑 Creator" : "👑 Creador",
    badgePrivacy: isEn ? "👁️ Extra Privacy" : "👁️ Privacidad Extra",
    badgeExpires: isEn ? "Expires:" : "Expira:",
    deviceLabel: isEn ? "Device:" : "Dispositivo:",
    btnDownload: isEn ? "⬇️ Download" : "⬇️ Descargar",
    btnCopy: isEn ? "📋 Copy link" : "📋 Copiar enlace",
    alertCopied: isEn ? "Link copied!" : "¡Link copiado!"
  };

  if (!item) {
    return res.status(404).send(`
      <!DOCTYPE html>
      <html lang="${isEn ? 'en' : 'es'}">
        <head><meta charset="utf-8"><title>${t.notFoundTitle}</title></head>
        <body style="font-family: sans-serif; text-align: center; padding: 50px; background: #150327; color: #fff;">
          <h2 style="color: #ff9100;">${t.notFoundHeading}</h2>
          <p style="color: #d8b4fe; margin-top: 10px;">${t.notFoundDesc}</p>
          ${clientI18nScript}
        </body>
      </html>
    `);
  }

  const isBot = /bot|crawler|spider|facebookexternalhit/i.test(userAgent);
  const isMobile = /android|iphone|ipad|ipod|mobile/i.test(userAgent);
  const rawClientIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress || '127.0.0.1';
  const clientDetails = parseClientDetails(userAgent, rawClientIp);
  const clientIp = clientDetails.ip;
  const isCreatorKey = req.query.key && req.query.key === item.adminSecret;
  const deviceName = clientDetails.deviceName;

  function recordViewLog(statusMsg, isAllowed) {
    if (isBot) return;
    if (!Array.isArray(item.viewsLog)) item.viewsLog = [];
    item.viewsLog.unshift({
      timestamp: Date.now(),
      date: new Date().toLocaleString(),
      ip: clientDetails.ip,
      os: clientDetails.os,
      browser: clientDetails.browser,
      deviceType: clientDetails.deviceType,
      deviceName: clientDetails.deviceName,
      isCreatorKey: Boolean(isCreatorKey),
      status: statusMsg,
      allowed: isAllowed
    });
    if (item.viewsLog.length > 80) item.viewsLog.pop();
    saveDb();
  }

  const fname = (item.filename || '').toLowerCase();
  const oname = (item.originalName || '').toLowerCase();
  const isVideo = (item.mimetype && item.mimetype.startsWith('video/')) ||
                  fname.endsWith('.webm') || fname.endsWith('.mp4') || fname.endsWith('.mkv') ||
                  oname.endsWith('.webm') || oname.endsWith('.mp4') || oname.endsWith('.mkv');
  const isImage = (item.mimetype && item.mimetype.startsWith('image/')) ||
                  fname.endsWith('.png') || fname.endsWith('.jpg') || fname.endsWith('.jpeg') ||
                  oname.endsWith('.png') || oname.endsWith('.jpg') || oname.endsWith('.jpeg');
  const mediaMime = isVideo ? (fname.endsWith('.mp4') ? 'video/mp4' : 'video/webm') : (fname.endsWith('.png') ? 'image/png' : 'image/jpeg');

  const baseUrl = getBaseUrl(req);
  const fileExt = fname.endsWith('.mp4') ? 'mp4' : (fname.endsWith('.png') ? 'png' : (fname.endsWith('.jpg') || fname.endsWith('.jpeg') ? 'jpg' : 'webm'));

  // 100% Direct Cloudflare R2 CDN URL (0% Render egress bandwidth)
  const directR2Url = (item.r2 && r2.getPublicClipUrl(item)) ? r2.getPublicClipUrl(item) : null;
  const rawMediaUrl = directR2Url || (isCreatorKey
    ? `${baseUrl}/raw/${item.id}.${fileExt}?key=${item.adminSecret}`
    : `${baseUrl}/raw/${item.id}.${fileExt}`);

  const videoMetaWidth = item.width || 1280;
  const videoMetaHeight = item.height || 720;
  const videoMetaDuration = (item.duration && item.duration > 0) ? Math.round(item.duration) : null;
  const expireDate = new Date(item.expiresAt).toLocaleString(isEn ? 'en-US' : 'es-ES');

  if (item.privacy && item.privacy.active && !isCreatorKey) {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    res.setHeader('Surrogate-Control', 'no-store');
  } else if (isBot) {
    res.setHeader('Cache-Control', 'public, max-age=3600');
  }

  if (!isCreatorKey && item.publicExpired) {
    recordViewLog('Bloqueado: Enlace público expirado', false);
    return res.status(403).send(`
      <!DOCTYPE html>
      <html lang="${isEn ? 'en' : 'es'}">
        <head><meta charset="utf-8"><title>${t.expiredTitle}</title></head>
        <body style="font-family: sans-serif; text-align: center; padding: 50px; background: #150327; color: #fff;">
          <h2 style="color: #ff9100;">${t.expiredHeading}</h2>
          <p style="color: #d8b4fe; margin-top: 10px; max-width: 500px; margin-left: auto; margin-right: auto; line-height: 1.5;">
            ${t.expiredDesc}
          </p>
          ${clientI18nScript}
        </body>
      </html>
    `);
  }

  if (isBot && item.privacy && item.privacy.blockEmbed && !isCreatorKey) {
    return res.send(`
      <!DOCTYPE html>
      <html><head>
        <meta property="og:type" content="website" />
        <meta property="og:title" content="👁️ Private Media | Zylo" />
        <meta property="og:description" content="To watch this video, open the link directly." />
        <meta property="og:image" content="${baseUrl}/privacy_banner.png" />
        <meta name="twitter:card" content="summary_large_image" />
        <meta name="twitter:title" content="👁️ Private Media | Zylo" />
        <meta name="twitter:description" content="To watch this video, open the link directly." />
        <meta name="twitter:image" content="${baseUrl}/privacy_banner.png" />
      </head><body style="background:#150327;"></body></html>
    `);
  }

  if (!isCreatorKey && item.privacy && item.privacy.active) {
    const deviceId = getDeviceSignature(req, clientDetails);
    const seenCookie = Boolean(req.headers.cookie && (req.headers.cookie.includes('zylo_seen_' + item.id + '=1') || req.headers.cookie.includes('mogi_seen_' + item.id + '=1')));

    if (!item.privacy.devicesSeen) {
      item.privacy.devicesSeen = {};
    }

    if (item.privacy.mobileOnly && !isMobile) {
      recordViewLog('Bloqueado: Requiere dispositivo móvil', false);
      return res.status(403).send(`
        <!DOCTYPE html>
        <html lang="${isEn ? 'en' : 'es'}"><head><meta charset="utf-8"><title>${t.mobileTitle}</title></head>
        <body style="font-family:sans-serif; text-align:center; padding:50px; background:#150327; color:#fff;">
          <h2 style="color:#ff9100;">${t.mobileHeading}</h2>
          <p style="color:#d8b4fe; margin-top: 8px;">${t.mobileDesc}</p>
          ${clientI18nScript}</body></html>
      `);
    }

    if (item.privacy.singlePlayPerVisit) {
      if (!item.privacy.singlePlayCompleted) item.privacy.singlePlayCompleted = {};
      if (item.privacy.singlePlayCompleted[deviceId] || seenCookie) {
        recordViewLog('Bloqueado: Reproducción única por dispositivo ya completada', false);
        return res.status(403).send(`
          <!DOCTYPE html>
          <html lang="${isEn ? 'en' : 'es'}"><head><meta charset="utf-8"><title>${t.visitsTitle}</title></head>
          <body style="font-family:sans-serif; text-align:center; padding:50px; background:#150327; color:#fff;">
            <h2 style="color:#ff9100;">${isEn ? '🔒 Single Play Completed' : '🔒 Reproducción Única Completada'}</h2>
            <p style="color:#d8b4fe; margin-top: 8px;">
              ${isEn ? 'This video was configured for 1 single play per device and has already concluded.' : 'Este video fue configurado para una única reproducción por dispositivo y ya ha concluido.'}
            </p>
          ${clientI18nScript}</body></html>
        `);
      }
    }

    const maxLimit = item.privacy.maxViews || 0;

    if (item.privacy.lockDevice === true) {
      if (!item.privacy.boundDeviceId) {
        item.privacy.boundDeviceId = deviceId;
        item.privacy.devicesSeen[deviceId] = 1;
        item.views = 1;
        saveDb();
        res.cookie('zylo_seen_' + item.id, '1', { maxAge: 31536000000, httpOnly: true, sameSite: 'Lax', path: '/' });
      } else if (item.privacy.boundDeviceId !== deviceId) {
        recordViewLog('Bloqueado: Restringido al primer dispositivo', false);
        return res.status(403).send(`
          <!DOCTYPE html>
          <html lang="${isEn ? 'en' : 'es'}"><head><meta charset="utf-8"><title>${t.lockTitle}</title></head>
          <body style="font-family:sans-serif; text-align:center; padding:50px; background:#150327; color:#fff;">
            <h2 style="color:#ff9100;">${t.lockHeading}</h2>
            <p style="color:#d8b4fe; margin-top: 8px;">${t.lockDesc}</p>
          ${clientI18nScript}</body></html>
        `);
      } else {
        if (maxLimit > 0 && (item.privacy.devicesSeen[deviceId] || 0) >= maxLimit) {
          item.publicExpired = true;
          saveDb();
          recordViewLog(`Bloqueado: Límite de ${maxLimit} visitas alcanzado por el primer dispositivo`, false);
          return res.status(403).send(`
            <!DOCTYPE html>
            <html lang="${isEn ? 'en' : 'es'}"><head><meta charset="utf-8"><title>${t.visitsTitle}</title></head>
            <body style="font-family:sans-serif; text-align:center; padding:50px; background:#150327; color:#fff;">
              <h2 style="color:#ff9100;">${t.visitsHeading}</h2>
              <p style="color:#d8b4fe; margin-top: 8px;">${t.visitsDesc(maxLimit)}</p>
            ${clientI18nScript}</body></html>
          `);
        }
        item.privacy.devicesSeen[deviceId] = (item.privacy.devicesSeen[deviceId] || 0) + 1;
        item.views = item.privacy.devicesSeen[deviceId];
        saveDb();
      }
    } else if (item.privacy.uniqueDevicesOnly === true) {
      if (!item.privacy.devicesSeen[deviceId]) {
        const uniqueCount = Object.keys(item.privacy.devicesSeen).length;
        if (maxLimit > 0 && uniqueCount >= maxLimit) {
          recordViewLog(`Bloqueado: Límite de ${maxLimit} dispositivos únicos alcanzado`, false);
          return res.status(403).send(`
            <!DOCTYPE html>
            <html lang="${isEn ? 'en' : 'es'}"><head><meta charset="utf-8"><title>${t.visitsTitle}</title></head>
            <body style="font-family:sans-serif; text-align:center; padding:50px; background:#150327; color:#fff;">
              <h2 style="color:#ff9100;">${t.visitsHeading}</h2>
              <p style="color:#d8b4fe; margin-top: 8px;">${t.visitsDesc(maxLimit)}</p>
            ${clientI18nScript}</body></html>
          `);
        }
        item.privacy.devicesSeen[deviceId] = 1;
        item.views = Object.keys(item.privacy.devicesSeen).length;
        saveDb();
        res.cookie('zylo_seen_' + item.id, '1', { maxAge: 31536000000, httpOnly: true, sameSite: 'Lax', path: '/' });
      }
    } else if (item.privacy.singleViewPerDevice === true) {
      const alreadySeen = seenCookie || (item.privacy.devicesSeen[deviceId] && item.privacy.devicesSeen[deviceId] >= 1);
      if (alreadySeen) {
        recordViewLog('Bloqueado: Dispositivo o navegador ya utilizó su única visita permitida', false);
        return res.status(403).send(`
          <!DOCTYPE html>
          <html lang="${isEn ? 'en' : 'es'}"><head><meta charset="utf-8"><title>${isEn ? 'Access Blocked | Zylo' : 'Acceso Bloqueado | Zylo'}</title></head>
          <body style="font-family:sans-serif; text-align:center; padding:50px; background:#150327; color:#fff;">
            <h2 style="color:#ff9100;">${isEn ? '🚫 Access Limit (1 View per Device)' : '🚫 Límite Alcanzado (1 Visita por Dispositivo)'}</h2>
            <p style="color:#d8b4fe; margin-top: 8px;">
              ${isEn ? 'This link was configured to allow only 1 single view per device. This device has already accessed this clip.' : 'Este enlace fue configurado para permitir solo 1 visita por dispositivo. Este equipo o navegador ya accedió al clip anteriormente.'}
            </p>
          ${clientI18nScript}</body></html>
        `);
      }
      const uniqueCount = Object.keys(item.privacy.devicesSeen).length;
      if (maxLimit > 0 && uniqueCount >= maxLimit) {
        recordViewLog(`Bloqueado: Límite de ${maxLimit} dispositivos alcanzado`, false);
        return res.status(403).send(`
          <!DOCTYPE html>
          <html lang="${isEn ? 'en' : 'es'}"><head><meta charset="utf-8"><title>${t.visitsTitle}</title></head>
          <body style="font-family:sans-serif; text-align:center; padding:50px; background:#150327; color:#fff;">
            <h2 style="color:#ff9100;">${t.visitsHeading}</h2>
            <p style="color:#d8b4fe; margin-top: 8px;">${t.visitsDesc(maxLimit)}</p>
          ${clientI18nScript}</body></html>
        `);
      }
      item.privacy.devicesSeen[deviceId] = 1;
      item.views = Object.keys(item.privacy.devicesSeen).length;
      saveDb();
      res.cookie('zylo_seen_' + item.id, '1', { maxAge: 31536000000, httpOnly: true, sameSite: 'Lax', path: '/' });
    } else {
      if (maxLimit > 0 && (item.views || 0) >= maxLimit) {
        item.publicExpired = true;
        saveDb();
        recordViewLog(`Bloqueado: Límite de ${maxLimit} visitas alcanzado`, false);
        return res.status(403).send(`
          <!DOCTYPE html>
          <html lang="${isEn ? 'en' : 'es'}"><head><meta charset="utf-8"><title>${t.visitsTitle}</title></head>
          <body style="font-family:sans-serif; text-align:center; padding:50px; background:#150327; color:#fff;">
            <h2 style="color:#ff9100;">${t.visitsHeading}</h2>
            <p style="color:#d8b4fe; margin-top: 8px;">${t.visitsDesc(maxLimit)}</p>
          ${clientI18nScript}</body></html>
        `);
      }
      item.views = (item.views || 0) + 1;
      saveDb();
    }
  }

  recordViewLog(isCreatorKey ? 'Permitido (Clave Maestra Creador)' : `Permitido (Vista pública ${item.views || 1}/${(item.privacy && item.privacy.maxViews > 0) ? item.privacy.maxViews : '∞'})`, true);

  const isPrivacyProtected = !isCreatorKey && item.privacy && item.privacy.active;
  const isSinglePlay = Boolean(isPrivacyProtected && item.privacy && item.privacy.singlePlayPerVisit);
  const customTxt = (item.privacy && item.privacy.customWatermarkText) ? item.privacy.customWatermarkText : '';

  let watermarkHtml = '';
  if (isPrivacyProtected && item.privacy && item.privacy.watermarkEnabled === true) {
    const parts = [];
    if (item.privacy.watermarkIncludeIp !== false && clientIp) {
      parts.push(`<span>${clientIp}</span>`);
    }
    if (item.privacy.watermarkIncludeDevice !== false && deviceName) {
      parts.push(`<span>${deviceName}</span>`);
    }
    if (item.privacy.watermarkIncludeCustom !== false && customTxt) {
      parts.push(`<span>${customTxt}</span>`);
    }
    if (parts.length > 0) {
      const movingClass = item.privacy.watermarkMoving ? 'floating-moving-watermark' : '';
      watermarkHtml = `
        <div class="custom-watermark-overlay" id="watermarkOverlay">
          <div class="watermark-badge ${movingClass}">
            ${parts.join(' <span style="opacity:0.4;">•</span> ')}
          </div>
        </div>
      `;
    }
  }

  const metaHeadersOnly = `<!DOCTYPE html>
    <html lang="${isEn ? 'en' : 'es'}">
    <head>
      <meta charset="UTF-8" />
      <meta name="theme-color" content="#ff7b00" />
      ${isPrivacyProtected ? `
        <meta property="og:type" content="website" />
        <meta property="og:title" content="👁️ Private Media | Zylo" />
        <meta property="og:description" content="To watch this video, open the link directly." />
        <meta property="og:image" content="${baseUrl}/privacy_banner.png" />
        <meta name="twitter:card" content="summary_large_image" />
        <meta name="twitter:title" content="👁️ Private Media | Zylo" />
        <meta name="twitter:description" content="To watch this video, open the link directly." />
        <meta name="twitter:image" content="${baseUrl}/privacy_banner.png" />
      ` : `
        ${isVideo ? `
          <meta property="og:type" content="video.other" />
          <meta property="og:video" content="${rawMediaUrl}" />
          <meta property="og:video:url" content="${rawMediaUrl}" />
          <meta property="og:video:secure_url" content="${rawMediaUrl}" />
          <meta property="og:video:type" content="${mediaMime}" />
          <meta property="og:video:width" content="${videoMetaWidth}" />
          <meta property="og:video:height" content="${videoMetaHeight}" />
          ${videoMetaDuration ? `
            <meta property="og:video:duration" content="${videoMetaDuration}" />
            <meta property="video:duration" content="${videoMetaDuration}" />
          ` : ''}
          <meta name="twitter:card" content="player" />
          <meta name="twitter:player" content="${rawMediaUrl}" />
          <meta name="twitter:player:width" content="${videoMetaWidth}" />
          <meta name="twitter:player:height" content="${videoMetaHeight}" />
          <meta name="twitter:player:stream" content="${rawMediaUrl}" />
          <meta name="twitter:player:stream:content_type" content="${mediaMime}" />
        ` : ''}
        ${isImage ? `
          <meta property="og:site_name" content="Zylo" />
          <meta property="og:title" content="${item.originalName || 'Zylo Image'}" />
          <meta property="og:type" content="image" />
          <meta property="og:image" content="${rawMediaUrl}" />
          <meta property="og:image:secure_url" content="${rawMediaUrl}" />
          <meta name="twitter:card" content="summary_large_image" />
          <meta name="twitter:title" content="${item.originalName || 'Zylo Image'}" />
          <meta name="twitter:image" content="${rawMediaUrl}" />
        ` : ''}
      `}
    </head>
    <body style="background:#0d0218;"></body>
    </html>`;

  if (isBot) {
    return res.send(metaHeadersOnly);
  }

  return res.send(`
    <!DOCTYPE html>
    <html lang="${isEn ? 'en' : 'es'}">
    <head>
      <meta charset="UTF-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no" />
      <title>Zylo | Clip</title>
      <link rel="icon" type="image/png" href="/favicon.png?v=5" />
      <link rel="apple-touch-icon" href="/favicon.png?v=5" />
      <meta name="theme-color" content="#ff7b00" />

      ${isPrivacyProtected ? `
        <meta property="og:type" content="website" />
        <meta property="og:title" content="👁️ Private Media | Zylo" />
        <meta property="og:description" content="To watch this video, open the link directly." />
        <meta property="og:image" content="${baseUrl}/privacy_banner.png" />
        <meta name="twitter:card" content="summary_large_image" />
        <meta name="twitter:title" content="👁️ Private Media | Zylo" />
        <meta name="twitter:description" content="To watch this video, open the link directly." />
        <meta name="twitter:image" content="${baseUrl}/privacy_banner.png" />
      ` : `
        ${isVideo ? `
          <meta property="og:type" content="video.other" />
          <meta property="og:video" content="${rawMediaUrl}" />
          <meta property="og:video:url" content="${rawMediaUrl}" />
          <meta property="og:video:secure_url" content="${rawMediaUrl}" />
          <meta property="og:video:type" content="${mediaMime}" />
          <meta property="og:video:width" content="${videoMetaWidth}" />
          <meta property="og:video:height" content="${videoMetaHeight}" />
          ${videoMetaDuration ? `
            <meta property="og:video:duration" content="${videoMetaDuration}" />
            <meta property="video:duration" content="${videoMetaDuration}" />
          ` : ''}
          <meta name="twitter:card" content="player" />
          <meta name="twitter:player" content="${rawMediaUrl}" />
          <meta name="twitter:player:width" content="${videoMetaWidth}" />
          <meta name="twitter:player:height" content="${videoMetaHeight}" />
          <meta name="twitter:player:stream" content="${rawMediaUrl}" />
          <meta name="twitter:player:stream:content_type" content="${mediaMime}" />
        ` : ''}
        ${isImage ? `
          <meta property="og:site_name" content="Zylo" />
          <meta property="og:title" content="${item.originalName || 'Zylo Image'}" />
          <meta property="og:type" content="image" />
          <meta property="og:image" content="${rawMediaUrl}" />
          <meta property="og:image:secure_url" content="${rawMediaUrl}" />
          <meta name="twitter:card" content="summary_large_image" />
          <meta name="twitter:title" content="${item.originalName || 'Zylo Image'}" />
          <meta name="twitter:image" content="${rawMediaUrl}" />
        ` : ''}
      `}

      <style>
        * { box-sizing: border-box; margin: 0; padding: 0; }
        html, body {
          width: 100vw;
          height: 100vh;
          overflow: hidden;
          background: #0d0218;
          background: radial-gradient(circle at 50% 30%, #22063d 0%, #0d0218 100%);
          color: #f5f3ff;
          font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
          display: flex;
          flex-direction: column;
          position: relative;
        }
        .ambient-watermark {
          position: fixed;
          pointer-events: none;
          z-index: 0;
          background-image: url('/logo-outline.png');
          background-repeat: no-repeat;
          background-size: contain;
          opacity: 0.035;
          filter: invert(0.85) sepia(1) saturate(5) hue-rotate(345deg);
        }
        .ambient-top-right {
          top: -80px;
          right: -100px;
          width: 580px;
          height: 380px;
          transform: rotate(-16deg);
        }
        .ambient-bottom-left {
          bottom: -90px;
          left: -120px;
          width: 650px;
          height: 420px;
          transform: rotate(14deg);
        }
        header {
          height: 60px;
          padding: 0 24px;
          display: flex;
          align-items: center;
          justify-content: space-between;
          background: rgba(18, 4, 34, 0.92);
          backdrop-filter: blur(14px);
          border-bottom: 1px solid #2e0e4f;
          flex-shrink: 0;
          z-index: 20;
        }
        .brand {
          display: flex;
          align-items: center;
          gap: 10px;
        }
        .brand img {
          height: 38px;
          border-radius: 8px;
        }
        .badge {
          background: rgba(255, 109, 0, 0.15);
          border: 1px solid #ff6d00;
          color: #ffa726;
          font-size: 11px;
          font-weight: 800;
          padding: 4px 10px;
          border-radius: 12px;
          letter-spacing: 0.3px;
        }
        .badge-privacy {
          background: rgba(168, 85, 247, 0.2);
          border-color: #a855f7;
          color: #d8b4fe;
        }
        main {
          flex: 1;
          display: flex;
          align-items: center;
          justify-content: center;
          position: relative;
          overflow: hidden;
          padding: 12px;
          gap: 16px;
          z-index: 10;
        }
        .ad-banner-vertical {
          width: 160px;
          height: 600px;
          flex-shrink: 0;
          display: none;
          align-items: center;
          justify-content: center;
          z-index: 15;
          position: relative;
          background: rgba(22, 6, 42, 0.65);
          border: 1px solid rgba(255, 109, 0, 0.25);
          border-radius: 14px;
          box-shadow: 0 8px 32px rgba(0,0,0,0.6);
          backdrop-filter: blur(10px);
          overflow: hidden;
          transition: transform 0.2s ease, border-color 0.2s ease;
        }
        .ad-banner-vertical:hover {
          border-color: rgba(255, 109, 0, 0.55);
          transform: translateY(-2px);
        }
        .ad-banner-inner {
          width: 100%;
          height: 100%;
          display: flex;
          align-items: center;
          justify-content: center;
        }
        .viewport {
          flex: 1;
          max-width: 100%;
          height: 100%;
          display: flex;
          align-items: center;
          justify-content: center;
          position: relative;
          border-radius: 16px;
          overflow: hidden;
          background: #000;
          box-shadow: 0 10px 40px rgba(0, 0, 0, 0.7);
          border: 1px solid #2e0e4f;
        }
        .custom-watermark-overlay {
          position: absolute;
          inset: 0;
          pointer-events: none;
          z-index: 40;
          display: flex;
          align-items: center;
          justify-content: center;
          overflow: hidden;
        }
        .watermark-badge {
          background: transparent;
          border: none;
          box-shadow: none;
          color: rgba(255, 255, 255, 0.26);
          font-size: 14px;
          font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, monospace;
          font-weight: 700;
          letter-spacing: 0.8px;
          text-shadow: 0 1px 3px rgba(0,0,0,0.85), 0 0 10px rgba(0,0,0,0.7);
          display: inline-flex;
          gap: 12px;
          pointer-events: none;
          user-select: none;
          white-space: nowrap;
          will-change: transform;
        }
        .watermark-badge.floating-moving-watermark {
          animation: gentleCenterWatermark 22s ease-in-out infinite alternate;
        }
        @keyframes gentleCenterWatermark {
          0%   { transform: translate(-45px, -30px); }
          25%  { transform: translate(50px, -15px); }
          50%  { transform: translate(35px, 35px); }
          75%  { transform: translate(-40px, 20px); }
          100% { transform: translate(-45px, -30px); }
        }
        footer {
          height: 64px;
          padding: 0 24px;
          display: flex;
          align-items: center;
          justify-content: space-between;
          background: rgba(18, 4, 34, 0.92);
          backdrop-filter: blur(14px);
          border-top: 1px solid #2e0e4f;
          flex-shrink: 0;
          z-index: 20;
        }
        .filename {
          font-size: 13px;
          color: #cbd5e1;
          font-weight: 600;
          max-width: 40%;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }
        .actions {
          display: flex;
          align-items: center;
          gap: 12px;
        }
        .btn {
          background: #20073b;
          color: #fff;
          border: 1px solid #431275;
          padding: 10px 20px;
          border-radius: 12px;
          cursor: pointer;
          font-weight: 800;
          font-size: 13px;
          text-decoration: none;
          display: inline-flex;
          align-items: center;
          gap: 8px;
          transition: all 0.2s;
        }
        .btn:hover { background: #320a59; border-color: #ff9100; transform: translateY(-1px); }
        .btn-primary {
          background: linear-gradient(135deg, #ffa726, #ff6d00);
          border: none;
          color: #0f021c;
          box-shadow: 0 4px 18px rgba(255, 109, 0, 0.4);
        }
        .btn-primary:hover {
          background: linear-gradient(135deg, #ffb74d, #ff7a00);
          box-shadow: 0 6px 24px rgba(255, 109, 0, 0.6);
          color: #000;
        }
        .zylo-big-play:hover {
          transform: scale(1.12);
          box-shadow: 0 14px 48px rgba(255, 109, 0, 0.85);
        }
      </style>
    </head>
    <body>
      <div class="ambient-watermark ambient-top-right"></div>
      <div class="ambient-watermark ambient-bottom-left"></div>

      <header>
        <a href="/" class="brand" style="text-decoration: none; cursor: pointer;" title="Zylo">
          <img src="/logo.png" alt="Zylo" />
        </a>
        <div class="badge ${isPrivacyProtected ? 'badge-privacy' : ''}">
          ${isCreatorKey ? t.badgeCreator : (isPrivacyProtected ? t.badgePrivacy : `${t.badgeExpires} ${expireDate}`)}
        </div>
        <div style="margin-left:auto; display:flex; align-items:center;">
          <select id="viewerLangSelector" style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif; background:#20073b; border:1px solid #451375; color:#cbd5e1; padding:5px 8px; border-radius:8px; font-size:12px; font-weight:bold; cursor:pointer; outline:none;" onchange="changeViewerLanguage(this.value)">
            <option value="en" ${langCookie==='en'||(!langCookie&&!/es|pt|fr|de|ja/i.test(acceptLang)) ? 'selected' : ''}>English (EN)</option>
            <option value="es" ${langCookie==='es'||(!langCookie&&/es/i.test(acceptLang)) ? 'selected' : ''}>Español (ES)</option>
            <option value="pt" ${langCookie==='pt'||(!langCookie&&/pt/i.test(acceptLang)) ? 'selected' : ''}>Português (PT)</option>
            <option value="fr" ${langCookie==='fr'||(!langCookie&&/fr/i.test(acceptLang)) ? 'selected' : ''}>Français (FR)</option>
            <option value="de" ${langCookie==='de'||(!langCookie&&/de/i.test(acceptLang)) ? 'selected' : ''}>Deutsch (DE)</option>
            <option value="ja" ${langCookie==='ja'||(!langCookie&&/ja/i.test(acceptLang)) ? 'selected' : ''}>日本語 (JA)</option>
          </select>
        </div>
      </header>

      <main>
        <aside class="ad-banner-vertical ad-banner-left" id="asideViewerLeft" style="display:none; cursor:pointer;">
          <div class="ad-banner-inner" id="bannerContainerViewerLeft" style="padding:0; overflow:hidden;"></div>
        </aside>

        <div class="viewport">
          ${watermarkHtml}

          ${isPrivacyProtected ? `
            <div id="privacyShield" style="display:none; position:absolute; inset:0; background:#070110; z-index:99999; flex-direction:column; align-items:center; justify-content:center; text-align:center; padding:24px; color:#ffa726; font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
              <div style="font-size:46px; margin-bottom:12px; filter:drop-shadow(0 4px 12px rgba(255,109,0,0.5));">🔒</div>
              <div style="font-size:18px; font-weight:800; color:#fff; margin-bottom:6px;">Protected Content</div>
              <div style="font-size:13px; color:#cbd5e1; max-width:320px; line-height:1.5;">Screen capture or window focus change detected. Video is automatically paused for privacy. Click here to resume.</div>
            </div>
          ` : ''}

          ${isSinglePlay ? `
            <div id="singlePlayFinishedOverlay" style="display:none; position:absolute; inset:0; background:#070110; z-index:99999; flex-direction:column; align-items:center; justify-content:center; text-align:center; padding:24px; color:#ffa726; font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
              <div style="font-size:48px; margin-bottom:12px; filter:drop-shadow(0 4px 14px rgba(255,109,0,0.6));">🔒</div>
              <div style="font-size:18px; font-weight:800; color:#fff; margin-bottom:6px;">${isEn ? 'Playback Completed' : 'Reproducción Finalizada'}</div>
              <div style="font-size:13px; color:#cbd5e1; max-width:320px; line-height:1.5;">${isEn ? 'This video was set to a single unpausable play per visit and has ended.' : 'Este video fue configurado para una única reproducción por visita y ha concluido.'}</div>
            </div>
          ` : ''}

          ${isVideo ? `
            <video id="mainVideoPlayer" src="${rawMediaUrl}" controls playsinline ${isSinglePlay ? '' : 'loop'} preload="auto"
                   ${isPrivacyProtected ? 'controlsList="nodownload noplaybackrate nofullscreen noremoteplayback" disablePictureInPicture oncontextmenu="return false;"' : ''}
                   style="width:100%; height:100%; object-fit:contain;">
              <source src="${rawMediaUrl}" type="${mediaMime}">
              <source src="${rawMediaUrl}" type="video/mp4">
              <source src="${rawMediaUrl}" type="video/webm">
              Your browser does not support the video tag.
            </video>

            ${isPrivacyProtected ? `
              <div id="videoProtectionShield" style="position:absolute; inset:0; z-index:30; cursor:pointer;" onclick="togglePlayPauseVideo(event)" ondblclick="preventShieldDbl(event)"></div>
              <div id="privacyVolumeBar" style="position:absolute; bottom:14px; right:14px; display:flex; align-items:center; gap:8px; background:rgba(12,1,24,0.92); padding:6px 14px; border-radius:24px; border:1px solid rgba(255,109,0,0.6); z-index:90; backdrop-filter:blur(10px); box-shadow:0 4px 18px rgba(0,0,0,0.7); pointer-events:auto;" onclick="event.stopPropagation();" onmousedown="event.stopPropagation();" ontouchstart="event.stopPropagation();">
                <span id="privacyMuteBtn" onclick="togglePrivacyMute(event)" onmousedown="event.stopPropagation();" ontouchstart="event.stopPropagation();" style="cursor:pointer; font-size:16px; user-select:none; line-height:1; display:inline-flex; align-items:center; justify-content:center;" title="Mute / Unmute">🔊</span>
                <input type="range" id="privacyVolSlider" min="0" max="1" step="0.02" value="1" oninput="setPrivacyVolume(this.value)" onchange="setPrivacyVolume(this.value)" onmousedown="event.stopPropagation();" ontouchstart="event.stopPropagation();" style="width:80px; accent-color:#ffa726; cursor:pointer;" title="Volume" />
              </div>
            ` : ''}

            <div id="bigPlayBtn" onclick="startPlaybackWithSound(event)" style="position:absolute; inset:0; display:flex; align-items:center; justify-content:center; background:rgba(12, 1, 24, 0.4); backdrop-filter:blur(2px); cursor:pointer; z-index:80; transition:opacity 0.25s ease;">
              <div class="zylo-big-play" style="width:88px; height:88px; border-radius:50%; background:linear-gradient(135deg, #ffa726, #ff6d00); display:flex; align-items:center; justify-content:center; box-shadow:0 10px 40px rgba(255, 109, 0, 0.7); transition:all 0.2s cubic-bezier(0.34, 1.56, 0.64, 1);">
                <svg width="42" height="42" viewBox="0 0 24 24" fill="#0c0118" style="margin-left:5px;"><path d="M8 5v14l11-7z"/></svg>
              </div>
            </div>
          ` : ''}

          ${isImage ? `<img src="${rawMediaUrl}" alt="${item.originalName}" style="width:100%; height:100%; object-fit:contain;" />` : ''}
        </div>

        <aside class="ad-banner-vertical ad-banner-right" id="asideViewerRight" style="display:none; cursor:pointer;">
          <div class="ad-banner-inner" id="bannerContainerViewerRight" style="padding:0; overflow:hidden;"></div>
        </aside>
      </main>

      <footer>
        <div class="filename">${item.originalName}</div>
        <div class="actions">
          ${(!isPrivacyProtected || isCreatorKey) ? `<a class="btn btn-primary" href="${rawMediaUrl}" download="${item.originalName}">${t.btnDownload}</a>` : ''}
          <button class="btn" onclick="navigator.clipboard.writeText(window.location.href); alert('${t.alertCopied}');">${t.btnCopy}</button>
        </div>
      </footer>

      <script>
        const vp = document.getElementById('mainVideoPlayer');
        const bigPlayBtn = document.getElementById('bigPlayBtn');
        let justStartedPlaybackTime = 0;

        function togglePrivacyMute(e) {
          if (e) { e.preventDefault(); e.stopPropagation(); }
          if (!vp) return;
          if (vp.muted || vp.volume === 0) {
            vp.muted = false;
            if (vp.volume === 0) vp.volume = 1.0;
          } else {
            vp.muted = true;
          }
          updatePrivacyVolumeUI();
        }

        function setPrivacyVolume(val) {
          if (!vp) return;
          const v = Math.max(0, Math.min(1, parseFloat(val) || 0));
          vp.volume = v;
          vp.muted = (v === 0);
          updatePrivacyVolumeUI();
        }

        function updatePrivacyVolumeUI() {
          if (!vp) return;
          const btn = document.getElementById('privacyMuteBtn');
          const slider = document.getElementById('privacyVolSlider');
          const isMuted = vp.muted || vp.volume === 0;
          if (btn) {
            if (isMuted) btn.innerText = '🔇';
            else if (vp.volume < 0.5) btn.innerText = '🔉';
            else btn.innerText = '🔊';
          }
          if (slider) {
            slider.value = isMuted ? 0 : vp.volume;
          }
        }

        if (vp) {
          vp.addEventListener('volumechange', updatePrivacyVolumeUI);
        }

        function preventShieldDbl(e) {
          if (e) {
            e.preventDefault();
            e.stopPropagation();
            e.stopImmediatePropagation();
          }
          return false;
        }

        function togglePlayPauseVideo(e) {
          if (e) { e.preventDefault(); e.stopPropagation(); }
          if (!vp) return;
          if (isSinglePlayMode) {
            if (vp.paused) vp.play().catch(()=>{});
            return;
          }
          if (vp.paused) vp.play().catch(()=>{});
          else vp.pause();
        }

        function startPlaybackWithSound(e) {
          if (e) { e.preventDefault(); e.stopPropagation(); }
          justStartedPlaybackTime = Date.now();
          if (bigPlayBtn) {
            bigPlayBtn.style.opacity = '0';
            bigPlayBtn.style.pointerEvents = 'none';
            setTimeout(() => { bigPlayBtn.style.display = 'none'; }, 350);
          }
          if (vp) {
            vp.muted = false;
            vp.volume = 1.0;
            const playPromise = vp.play();
            if (playPromise !== undefined) {
              playPromise.catch(err => console.warn('Playback gesture required:', err));
            }
          }
        }

        if (vp) {
          vp.muted = false;
          vp.volume = 1.0;
          vp.play().then(() => {
            if (bigPlayBtn) bigPlayBtn.style.display = 'none';
          }).catch(() => {
            if (bigPlayBtn) {
              bigPlayBtn.style.opacity = '1';
              bigPlayBtn.style.pointerEvents = 'auto';
              bigPlayBtn.style.display = 'flex';
            }
          });

          vp.addEventListener('play', () => {
            vp.muted = false;
            vp.volume = 1.0;
            if (bigPlayBtn) bigPlayBtn.style.display = 'none';
          });

          vp.addEventListener('pause', () => {
            if (Date.now() - justStartedPlaybackTime < 650 && !vp.ended && !singlePlayEnded) {
              vp.play().catch(()=>{});
            }
          });

          const knownDur = ${parseFloat(item.duration || item.clipDuration || 0)};
          vp.addEventListener('loadedmetadata', () => {
            if (!isSinglePlayMode && (!isFinite(vp.duration) || isNaN(vp.duration) || vp.duration === 0) && knownDur > 0) {
              try {
                vp.currentTime = 1e101;
                vp.ontimeupdate = function() {
                  this.ontimeupdate = null;
                  this.currentTime = 0;
                };
              } catch(e) {}
            }
          });
        }

        const isPrivacyProtectedMode = ${isPrivacyProtected ? 'true' : 'false'};
        if (isPrivacyProtectedMode) {
          try {
            HTMLVideoElement.prototype.requestFullscreen = function() { return Promise.reject(new Error("Disabled")); };
            HTMLVideoElement.prototype.webkitRequestFullscreen = function() { return false; };
            HTMLVideoElement.prototype.webkitEnterFullscreen = function() { return false; };
            HTMLVideoElement.prototype.webkitEnterFullScreen = function() { return false; };
            HTMLVideoElement.prototype.msRequestFullscreen = function() { return false; };
            HTMLVideoElement.prototype.mozRequestFullScreen = function() { return false; };
            Element.prototype.requestFullscreen = function() { return Promise.reject(new Error("Disabled")); };
            Element.prototype.webkitRequestFullscreen = function() { return false; };
            Element.prototype.webkitRequestFullScreen = function() { return false; };
            Element.prototype.mozRequestFullScreen = function() { return false; };
          } catch(e){}

          window.addEventListener('dblclick', preventShieldDbl, { capture: true, passive: false });
          document.addEventListener('dblclick', preventShieldDbl, { capture: true, passive: false });
          if (vp) {
            vp.addEventListener('dblclick', preventShieldDbl, { capture: true, passive: false });
            vp.ondblclick = preventShieldDbl;
          }

          const killFullscreen = () => {
            if (document.fullscreenElement || document.webkitFullscreenElement || document.mozFullScreenElement || document.msFullscreenElement) {
              try {
                if (document.exitFullscreen) document.exitFullscreen().catch(()=>{});
                else if (document.webkitExitFullscreen) document.webkitExitFullscreen();
                else if (document.mozCancelFullScreen) document.mozCancelFullScreen();
                else if (document.msExitFullscreen) document.msExitFullscreen();
              } catch(e){}
            }
          };
          document.addEventListener('fullscreenchange', killFullscreen);
          document.addEventListener('webkitfullscreenchange', killFullscreen);
          document.addEventListener('mozfullscreenchange', killFullscreen);
          document.addEventListener('msfullscreenchange', killFullscreen);
          setInterval(killFullscreen, 250);
        }

        const isSinglePlayMode = ${isSinglePlay ? 'true' : 'false'};
        const sessionLockKey = 'zylo_sp_' + ${JSON.stringify(item.id)};
        let singlePlayEnded = false;

        if (isSinglePlayMode) {
          if (sessionStorage.getItem(sessionLockKey) === '1') {
            singlePlayEnded = true;
            const sOverlay = document.getElementById('singlePlayFinishedOverlay');
            if (sOverlay) sOverlay.style.display = 'flex';
            if (vp) {
              vp.pause();
              vp.src = '';
              try { vp.remove(); } catch(e){}
            }
            if (bigPlayBtn) bigPlayBtn.style.display = 'none';
          }

          window.addEventListener('keydown', (e) => {
            if ([' ', 'k', 'K', 'MediaPlayPause'].includes(e.key)) {
              e.preventDefault();
            }
          });

          if (vp) {
            vp.addEventListener('pause', () => {
              if (!singlePlayEnded && !vp.ended) {
                vp.play().catch(()=>{});
              }
            });

            vp.addEventListener('ended', () => {
              singlePlayEnded = true;
              try {
                sessionStorage.setItem(sessionLockKey, '1');
                localStorage.setItem(sessionLockKey, '1');
                document.cookie = sessionLockKey + '=1; path=/; max-age=86400; SameSite=Lax';
              } catch(e){}
              const sOverlay = document.getElementById('singlePlayFinishedOverlay');
              if (sOverlay) sOverlay.style.display = 'flex';
              vp.pause();
              vp.src = '';
              try { vp.remove(); } catch(e){}
            });
          }
        }

        const viewerI18n = {
          en: {
            badgeCreator: "👑 Creator",
            badgePrivacy: "👁️ Extra Privacy",
            badgeExpires: "Expires:",
            btnDownload: "⬇️ Download",
            btnCopy: "📋 Copy link",
            alertCopied: "Link copied!",
            shieldTitle: "Protected Content",
            shieldDesc: "Screen capture or window focus change detected. Video is automatically paused for privacy. Click here to resume.",
            spTitle: "Playback Completed",
            spDesc: "This video was set to a single unpausable play per visit and has ended."
          },
          es: {
            badgeCreator: "👑 Creador",
            badgePrivacy: "👁️ Privacidad Extra",
            badgeExpires: "Expira:",
            btnDownload: "⬇️ Descargar",
            btnCopy: "📋 Copiar enlace",
            alertCopied: "¡Link copiado!",
            shieldTitle: "Contenido Protegido",
            shieldDesc: "Captura de pantalla o cambio de ventana detectado. El video se pausa automáticamente para proteger la confidencialidad. Haz clic aquí para reanudar.",
            spTitle: "Reproducción Finalizada",
            spDesc: "Este video fue configurado para una única reproducción por visita y ha concluido."
          },
          pt: {
            badgeCreator: "👑 Criador",
            badgePrivacy: "👁️ Privacidade Extra",
            badgeExpires: "Expira:",
            btnDownload: "⬇️ Baixar",
            btnCopy: "📋 Copiar link",
            alertCopied: "Link copiado!",
            shieldTitle: "Conteúdo Protegido",
            shieldDesc: "Captura de tela ou troca de janela detectada.",
            spTitle: "Reprodução Concluída",
            spDesc: "Este vídeo foi configurado para reprodução única e terminou."
          },
          fr: {
            badgeCreator: "👑 Créateur",
            badgePrivacy: "👁️ Confidentialité Extra",
            badgeExpires: "Expire:",
            btnDownload: "⬇️ Télécharger",
            btnCopy: "📋 Copier le lien",
            alertCopied: "Lien copié !",
            shieldTitle: "Contenu Protégé",
            shieldDesc: "Capture d'écran ou changement de fenêtre détecté.",
            spTitle: "Lecture Terminée",
            spDesc: "Cette vidéo était configurée pour une seule lecture et s'est terminée."
          },
          de: {
            badgeCreator: "👑 Ersteller",
            badgePrivacy: "👁️ Extra Privatsphäre",
            badgeExpires: "Läuft ab:",
            btnDownload: "⬇️ Herunterladen",
            btnCopy: "📋 Link kopieren",
            alertCopied: "Link kopiert!",
            shieldTitle: "Geschützter Inhalt",
            shieldDesc: "Screenshot oder Fensterwechsel erkannt.",
            spTitle: "Wiedergabe Beendet",
            spDesc: "Dieses Video wurde für eine einmalige Wiedergabe konfiguriert."
          },
          ja: {
            badgeCreator: "👑 作成者",
            badgePrivacy: "👁️ 追加プライバシー",
            badgeExpires: "有効期限:",
            btnDownload: "⬇️ ダウンロード",
            btnCopy: "📋 リンクをコピー",
            alertCopied: "リンクをコピーしました！",
            shieldTitle: "保護されたコンテンツ",
            shieldDesc: "画面キャプチャまたはフォーカス変更が検出されました。",
            spTitle: "再生終了",
            spDesc: "この動画は1回のみ再生可能に設定されており、終了しました。"
          }
        };

        let currentViewerLang = (() => {
          try {
            const saved = localStorage.getItem('zylo_lang') || localStorage.getItem('mogi_lang') || localStorage.getItem('mogi_app_lang');
            if (saved) return saved;
          } catch(e){}
          const m = document.cookie.match(/(?:zylo_lang|mogi_lang|mbp_lang)=([a-z]{2})/i);
          if (m) return m[1].toLowerCase();
          return '${langCookie || (isEn ? "en" : "es")}';
        })();

        function changeViewerLanguage(lang) {
          currentViewerLang = lang;
          try {
            localStorage.setItem('zylo_lang', lang);
            localStorage.setItem('mogi_lang', lang);
            localStorage.setItem('mogi_app_lang', lang);
          } catch(e){}
          document.cookie = 'zylo_lang=' + lang + '; path=/; max-age=31536000; SameSite=Lax';
          document.cookie = 'mbp_lang=' + lang + '; path=/; max-age=31536000; SameSite=Lax';
          document.cookie = 'mogi_lang=' + lang + '; path=/; max-age=31536000; SameSite=Lax';

          const sel = document.getElementById('viewerLangSelector');
          if (sel) sel.value = lang;

          const dict = viewerI18n[lang] || viewerI18n.en;

          const badgeEl = document.querySelector('header .badge');
          if (badgeEl) {
            ${isCreatorKey ? 'badgeEl.innerText = dict.badgeCreator;' : (isPrivacyProtected ? 'badgeEl.innerText = dict.badgePrivacy;' : `badgeEl.innerText = dict.badgeExpires + ' ${expireDate}';`)}
          }

          const btnDl = document.querySelector('footer a.btn-primary');
          if (btnDl) btnDl.innerText = dict.btnDownload;
          const btnCp = document.querySelector('footer button.btn');
          if (btnCp) {
            btnCp.innerText = dict.btnCopy;
            btnCp.setAttribute('onclick', "navigator.clipboard.writeText(window.location.href); alert('" + dict.alertCopied + "');");
          }

          const pShieldTitle = document.querySelector('#privacyShield div:nth-child(2)');
          const pShieldDesc = document.querySelector('#privacyShield div:nth-child(3)');
          if (pShieldTitle) pShieldTitle.innerText = dict.shieldTitle;
          if (pShieldDesc) pShieldDesc.innerText = dict.shieldDesc;

          const spTitle = document.querySelector('#singlePlayFinishedOverlay div:nth-child(2)');
          const spDesc = document.querySelector('#singlePlayFinishedOverlay div:nth-child(3)');
          if (spTitle) spTitle.innerText = dict.spTitle;
          if (spDesc) spDesc.innerText = dict.spDesc;

          loadViewerBanner('viewer_left', 'asideViewerLeft', 'bannerContainerViewerLeft', lang);
          loadViewerBanner('viewer_right', 'asideViewerRight', 'bannerContainerViewerRight', lang);
        }

        async function loadViewerBanner(slot, asideId, containerId, lang) {
          const activeLang = lang || currentViewerLang || 'en';
          try {
            const res = await fetch('/api/banners/' + slot + '?lang=' + encodeURIComponent(activeLang));
            const data = await res.json();
            if (data && data.found) {
              const aside = document.getElementById(asideId);
              const container = document.getElementById(containerId);
              if (!aside || !container) return;
              let mediaHtml = '';
              if (data.mediaType === 'video') {
                mediaHtml = '<video src="' + data.mediaUrl + '" autoplay loop muted playsinline style="width:100%; height:100%; object-fit:contain; border-radius:12px; pointer-events:none;"></video>';
              } else {
                mediaHtml = '<img src="' + data.mediaUrl + '" alt="' + (data.name || 'Ad') + '" style="width:100%; height:100%; object-fit:contain; border-radius:12px; pointer-events:none;" />';
              }
              container.innerHTML = '<a href="' + data.clickUrl + '" target="_blank" rel="noopener noreferrer" style="position:relative; display:block; width:100%; height:100%; text-decoration:none;"><span style="position:absolute; top:6px; right:6px; background:rgba(0,0,0,0.78); color:#ffa726; font-size:9px; font-weight:800; padding:2px 6px; border-radius:4px; letter-spacing:0.5px; border:1px solid rgba(255,167,38,0.35); z-index:5;">AD</span>' + mediaHtml + '</a>';
              aside.style.display = 'flex';
            }
          } catch(e) {}
        }

        if (currentViewerLang && currentViewerLang !== '${isEn ? "en" : "es"}') {
          changeViewerLanguage(currentViewerLang);
        } else {
          loadViewerBanner('viewer_left', 'asideViewerLeft', 'bannerContainerViewerLeft', currentViewerLang);
          loadViewerBanner('viewer_right', 'asideViewerRight', 'bannerContainerViewerRight', currentViewerLang);
        }
      </script>

      ${isPrivacyProtected ? `
        <script>
          const shield = document.getElementById('privacyShield');
          const vpElem = document.getElementById('mainVideoPlayer');

          function triggerShield() {
            if (shield) shield.style.display = 'flex';
            if (vpElem && !vpElem.paused) vpElem.pause();
          }

          function dismissShield() {
            if (shield) shield.style.display = 'none';
          }

          window.addEventListener('blur', triggerShield);
          document.addEventListener('visibilitychange', () => {
            if (document.hidden) triggerShield();
          });

          window.addEventListener('focus', () => {
            dismissShield();
          });

          if (shield) {
            shield.addEventListener('click', dismissShield);
          }

          window.addEventListener('keyup', (e) => {
            if (e.key === 'PrintScreen' || e.code === 'PrintScreen') {
              triggerShield();
              try { navigator.clipboard.writeText(''); } catch(err){}
              setTimeout(dismissShield, 2200);
            }
          });

          document.addEventListener('keydown', e => {
            const keyLower = e.key.toLowerCase();
            if (
              e.key === 'PrintScreen' || e.code === 'PrintScreen' ||
              e.key === 'F12' ||
              (e.ctrlKey && ['s', 'p', 'u', 'c'].includes(keyLower)) ||
              (e.ctrlKey && e.shiftKey && ['i', 'j', 'c', 's'].includes(keyLower)) ||
              (e.metaKey && e.altKey && ['i', 'j', 'c'].includes(keyLower))
            ) {
              e.preventDefault();
              e.stopPropagation();
              triggerShield();
              try { navigator.clipboard.writeText(''); } catch(err){}
              setTimeout(dismissShield, 2200);
              return false;
            }
          });

          document.addEventListener('contextmenu', e => e.preventDefault());
          document.addEventListener('dragstart', e => e.preventDefault());
        </script>
      ` : ''}
      ${clientI18nScript}
    </body>
    </html>
  `);
});

export default router;
