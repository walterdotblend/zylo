// ============================================================================
// Zylo — Hardened Security, Admin Auth, Magic-Byte Validator & Silent Tier Engine
// ============================================================================
import crypto from 'crypto';
import fs from 'fs';
import * as r2 from '../services/r2.js';
import { ADMIN_CONFIG_FILE, ADMIN_TOKEN_SECRET, TIERS } from '../config/constants.js';
import { getVoterTierStatus } from '../services/topgg.js';

// ------------------------------------------------------------------ Admin Auth
export function getMasterAdminPassword() {
  if (fs.existsSync(ADMIN_CONFIG_FILE)) {
    try {
      const data = JSON.parse(fs.readFileSync(ADMIN_CONFIG_FILE, 'utf8'));
      if (data && data.password) return data.password;
    } catch (e) {}
  }
  return process.env.MASTER_ADMIN_PASSWORD || 'mogi2026';
}

export function setMasterAdminPassword(newPwd) {
  try {
    fs.writeFileSync(ADMIN_CONFIG_FILE, JSON.stringify({ password: newPwd.trim() }, null, 2), 'utf8');
    r2.schedulePersist('admin_config.json');
    return true;
  } catch (e) {
    console.error('[Security] Error saving admin password:', e.message);
    return false;
  }
}

export function computeAdminSessionToken(pwd = getMasterAdminPassword()) {
  return crypto
    .createHmac('sha256', ADMIN_TOKEN_SECRET)
    .update(String(pwd))
    .digest('hex');
}

function safeCompare(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

export function isAdminAuthed(req) {
  const currentPassword = getMasterAdminPassword();
  const expectedToken = computeAdminSessionToken(currentPassword);

  const cookieHeader = req.headers.cookie || '';
  const match = cookieHeader.match(/(?:zylo_admin_auth|mogi_admin_auth)=([a-f0-9]{64})/i);
  if (match && match[1] && safeCompare(match[1], expectedToken)) {
    return true;
  }

  const headerKey = req.headers['x-admin-key'] || req.query?.key;
  if (headerKey && safeCompare(String(headerKey), String(currentPassword))) {
    return true;
  }
  return false;
}

export function requireAdminAuth(req, res, next) {
  if (!isAdminAuthed(req)) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

// Brute-force protection on Admin Login (max 6 attempts per 15 min per IP)
const loginAttempts = new Map();

export function checkLoginRateLimit(ip) {
  const now = Date.now();
  const rec = loginAttempts.get(ip);
  if (!rec) return { allowed: true };
  if (now > rec.resetAt) {
    loginAttempts.delete(ip);
    return { allowed: true };
  }
  if (rec.count >= 6) {
    const waitMin = Math.ceil((rec.resetAt - now) / 60000);
    return { allowed: false, waitMin };
  }
  return { allowed: true };
}

export function recordLoginFailure(ip) {
  const now = Date.now();
  const rec = loginAttempts.get(ip);
  if (!rec || now > rec.resetAt) {
    loginAttempts.set(ip, { count: 1, resetAt: now + 15 * 60 * 1000 });
  } else {
    rec.count++;
  }
}

export function clearLoginFailures(ip) {
  loginAttempts.delete(ip);
}

export const checkAdminLoginRateLimit = checkLoginRateLimit;
export const recordAdminLoginFailure = recordLoginFailure;
export const clearAdminLoginFailures = clearLoginFailures;

// ------------------------------------------------ Upload Security & Rate Limit
const uploadTracker = new Map();

export function checkUploadRateLimit(ip) {
  const now = Date.now();
  const windowMs = 10 * 60 * 1000; // 10 minutes
  const maxUploads = 25;
  let timestamps = uploadTracker.get(ip) || [];
  timestamps = timestamps.filter(t => now - t < windowMs);
  if (timestamps.length >= maxUploads) {
    return false;
  }
  timestamps.push(now);
  uploadTracker.set(ip, timestamps);
  return true;
}

/**
 * Inspects the first 12 bytes of a file (O(1), 0% CPU) to ensure it is a genuine
 * video (WebM/EBML/MKV or MP4/MOV) or image (PNG/JPEG).
 */
export function validateMediaMagicBytes(filePath) {
  let fd = null;
  try {
    fd = fs.openSync(filePath, 'r');
    const buf = Buffer.alloc(12);
    const bytesRead = fs.readSync(fd, buf, 0, 12, 0);
    if (bytesRead < 4) return { valid: false };

    // 1. WebM / MKV (EBML header: 0x1A 0x45 0xDF 0xA3)
    if (buf[0] === 0x1A && buf[1] === 0x45 && buf[2] === 0xDF && buf[3] === 0xA3) {
      return { valid: true, detectedMime: 'video/webm', ext: '.webm' };
    }
    // 2. MP4 / MOV / ISO Base Media (bytes 4..7 == 'ftyp' or 'moov' or 'wide' or 'mdat')
    const boxType = buf.slice(4, 8).toString('ascii');
    if (['ftyp', 'moov', 'mdat', 'wide', 'free', 'skip'].includes(boxType)) {
      return { valid: true, detectedMime: 'video/mp4', ext: '.mp4' };
    }
    // 3. PNG (0x89 0x50 0x4E 0x47)
    if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47) {
      return { valid: true, detectedMime: 'image/png', ext: '.png' };
    }
    // 4. JPEG (0xFF 0xD8 0xFF)
    if (buf[0] === 0xFF && buf[1] === 0xD8 && buf[2] === 0xFF) {
      return { valid: true, detectedMime: 'image/jpeg', ext: '.jpg' };
    }

    return { valid: false };
  } catch (e) {
    return { valid: false };
  } finally {
    if (fd !== null) {
      try { fs.closeSync(fd); } catch (_) {}
    }
  }
}

// --------------------------------------------------- Silent Backend Tier Engine
export function resolveSilentUserTier(req, discordUserId = null) {
  // 1. Check Premium Token (for future paid subscribers)
  const premiumHeader = req.headers['x-zylo-pro-token'] || req.body?.proToken;
  if (premiumHeader && process.env.ZYLO_PRO_MASTER_KEY && safeCompare(String(premiumHeader), String(process.env.ZYLO_PRO_MASTER_KEY))) {
    return TIERS.PREMIUM;
  }

  // 2. Check Top.gg Voter Tier (every 12 hours, 3 HD clips)
  const voterId = discordUserId || req.body?.voterUserId || req.headers['x-zylo-voter-id'];
  if (voterId && getVoterTierStatus(voterId)) {
    return TIERS.VOTER;
  }

  // 3. Default Free Tier
  return TIERS.FREE;
}

// ------------------------------------------- Device Fingerprinting & Telemetry
export function getDeviceSignature(req, clientDetails) {
  const rawIp = (req.headers['x-forwarded-for'] || req.socket?.remoteAddress || '127.0.0.1').split(',')[0].replace('::ffff:', '').trim();
  const os = clientDetails?.os || 'unknown_os';
  const devType = clientDetails?.deviceType || 'desk';
  const ipPrefix = rawIp.includes(':') ? rawIp.split(':').slice(0, 4).join(':') : rawIp;
  return 'dev_' + crypto.createHash('sha256').update(ipPrefix + '_' + os + '_' + devType).digest('hex').substring(0, 16);
}

export function parseClientDetails(userAgent = '', rawIp = '') {
  const ip = (rawIp || '').split(',')[0].replace('::ffff:', '').trim() || '127.0.0.1';
  let os = 'Desconocido';
  let deviceType = 'Escritorio';
  let browser = 'Navegador Web';

  if (/iphone/i.test(userAgent)) { os = 'iOS (iPhone)'; deviceType = 'Móvil'; }
  else if (/ipad/i.test(userAgent)) { os = 'iPadOS (iPad)'; deviceType = 'Tablet'; }
  else if (/android/i.test(userAgent)) { os = 'Android'; deviceType = 'Móvil'; }
  else if (/windows nt 10/i.test(userAgent)) { os = 'Windows 10/11'; deviceType = 'Escritorio'; }
  else if (/windows nt/i.test(userAgent)) { os = 'Windows PC'; deviceType = 'Escritorio'; }
  else if (/macintosh|mac os x/i.test(userAgent)) { os = 'macOS'; deviceType = 'Escritorio'; }
  else if (/cros/i.test(userAgent)) { os = 'ChromeOS'; deviceType = 'Escritorio'; }
  else if (/linux/i.test(userAgent)) { os = 'Linux'; deviceType = 'Escritorio'; }

  if (/edg\//i.test(userAgent)) browser = 'Microsoft Edge';
  else if (/opr\/|opera/i.test(userAgent)) browser = 'Opera';
  else if (/chrome|crios/i.test(userAgent)) browser = 'Google Chrome';
  else if (/firefox|fxios/i.test(userAgent)) browser = 'Mozilla Firefox';
  else if (/safari/i.test(userAgent)) browser = 'Apple Safari';
  else if (/discord/i.test(userAgent)) browser = 'Discord Client / Bot';

  const deviceName = `${os} • ${browser}`;
  return { ip, os, browser, deviceType, deviceName };
}
