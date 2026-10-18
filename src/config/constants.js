// ============================================================================
// Zylo (zylo.stream) — Centralized Configuration & Constants
// ============================================================================
import 'dotenv/config';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const ROOT_DIR = path.resolve(__dirname, '../..');
export const PUBLIC_DIR = path.join(ROOT_DIR, 'public');
export const UPLOAD_DIR = path.join(ROOT_DIR, 'uploads');
export const BANNERS_UPLOAD_DIR = path.join(UPLOAD_DIR, 'banners');
export const ANNOUNCEMENTS_UPLOAD_DIR = path.join(UPLOAD_DIR, 'announcements');

export const DB_FILE = path.join(ROOT_DIR, 'media_db.json');
export const BANNERS_DB_FILE = path.join(ROOT_DIR, 'banners_db.json');
export const STATS_DB_FILE = path.join(ROOT_DIR, 'stats_db.json');
export const ANNOUNCEMENTS_DB_FILE = path.join(ROOT_DIR, 'announcements_db.json');
export const QUOTA_CONFIG_FILE = path.join(ROOT_DIR, 'quota_config.json');
export const ADMIN_CONFIG_FILE = path.join(ROOT_DIR, 'admin_config.json');
export const VOTERS_DB_FILE = path.join(ROOT_DIR, 'voters_db.json');

export const PORT = process.env.PORT || 3000;
export const PUBLIC_URL = process.env.PUBLIC_URL || process.env.RENDER_EXTERNAL_URL || (process.env.BASE_URL && !process.env.BASE_URL.includes('localhost') && !process.env.BASE_URL.includes('127.0.0.1') ? process.env.BASE_URL : 'https://zylo.stream');
export const BASE_URL = (process.env.BASE_URL || PUBLIC_URL || `http://localhost:${PORT}`).replace(/\/+$/, '');
export const CDN_URL = (process.env.R2_PUBLIC_URL || 'https://pub-89cc7f23900d4c61beba3ac77dd1959a.r2.dev').replace(/\/+$/, '');

export function getBaseUrl(req) {
  if (process.env.BASE_URL && !process.env.BASE_URL.includes('localhost:') && !process.env.BASE_URL.includes('127.0.0.1:')) {
    return process.env.BASE_URL.replace(/\/+$/, '');
  }
  if (req) {
    const proto = req.get('x-forwarded-proto') || req.protocol || 'http';
    const host = req.get('x-forwarded-host') || req.get('host') || `localhost:${PORT}`;
    return `${proto}://${host}`;
  }
  return BASE_URL;
}

// Security & Admin
export const ADMIN_SECRET_PATH = process.env.ADMIN_SECRET_PATH || 'GX8zt2PX8v08lw2yR2r8I1rE8SRLgc';
export const ADMIN_TOKEN_SECRET = process.env.ADMIN_TOKEN_SECRET || 'zylo_hmac_secret_salt_2026_v1';
export const TOPGG_WEBHOOK_AUTH = process.env.TOPGG_WEBHOOK_AUTH || '';

// Hidden/Silent Tier Engine Limits (Enforced in backend, invisible in UI until enabled)
export const TIERS = {
  FREE: {
    id: 'free',
    name: 'Free',
    maxDurationSecs: 360,
    maxFileSizeBytes: 150 * 1024 * 1024, // 150 MB
    maxResolution: '720p',
    maxFps: 30,
    maxBitrateMbps: 4.0,
    retentionHours: 6
  },
  VOTER: {
    id: 'voter',
    name: 'Top.gg Voter',
    maxDurationSecs: 600,
    maxFileSizeBytes: 250 * 1024 * 1024, // 250 MB
    maxResolution: '1080p',
    maxFps: 60,
    maxBitrateMbps: 6.0,
    retentionHours: 12,
    clipsPerWindow: 3,
    windowHours: 12
  },
  PREMIUM: {
    id: 'premium',
    name: 'Zylo Pro',
    maxDurationSecs: 900,
    maxFileSizeBytes: 500 * 1024 * 1024, // 500 MB
    maxResolution: '1080p60 / Source',
    maxFps: 60,
    maxBitrateMbps: 10.0,
    retentionHours: 168 // 7 days
  }
};

export const COUNTRY_NAMES = {
  US: 'Estados Unidos', ES: 'España', MX: 'México', AR: 'Argentina', CO: 'Colombia',
  CL: 'Chile', PE: 'Perú', BR: 'Brasil', DE: 'Alemania', FR: 'Francia',
  GB: 'Reino Unido', CA: 'Canadá', IT: 'Italia', PT: 'Portugal', JP: 'Japón',
  KR: 'Corea del Sur', IN: 'India', AU: 'Australia', NL: 'Países Bajos',
  UY: 'Uruguay', VE: 'Venezuela', EC: 'Ecuador', GT: 'Guatemala', CR: 'Costa Rica',
  PA: 'Panamá', DO: 'República Dominicana', BO: 'Bolivia', PY: 'Paraguay',
  LOCAL: 'Red Local / Dev', UNKNOWN: 'Desconocido'
};

export function getCountryFlag(code) {
  if (!code || code === 'UNKNOWN' || code === 'LOCAL') return '🌐';
  const c = code.toUpperCase();
  if (c.length !== 2) return '🌐';
  const codePoints = [...c].map(char => 127397 + char.charCodeAt(0));
  return String.fromCodePoint(...codePoints);
}

export const LANG_NAMES = {
  all: { name: 'Todos los Idiomas', flag: '🌐' },
  es: { name: 'Español', flag: '🇪🇸' },
  en: { name: 'English', flag: '🇺🇸' },
  pt: { name: 'Português', flag: '🇧🇷' },
  fr: { name: 'Français', flag: '🇫🇷' },
  de: { name: 'Deutsch', flag: '🇩🇪' },
  ja: { name: '日本語', flag: '🇯🇵' }
};
