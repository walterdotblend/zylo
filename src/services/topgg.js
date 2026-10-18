// ============================================================================
// Zylo — Top.gg Vote Webhook & Silent Voter Credits Service
//  - Grants 3 high-quality clips every 12 hours when a user votes on Top.gg.
//  - Mirrored to R2 for durability across restarts.
// ============================================================================
import fs from 'fs';
import { VOTERS_DB_FILE, TIERS, TOPGG_WEBHOOK_AUTH } from '../config/constants.js';
import * as r2 from './r2.js';

let votersDb = {};

export function loadVotersDb() {
  if (fs.existsSync(VOTERS_DB_FILE)) {
    try { votersDb = JSON.parse(fs.readFileSync(VOTERS_DB_FILE, 'utf8')); } catch (e) {}
  }
}
loadVotersDb();

function saveVoters() {
  try {
    fs.writeFileSync(VOTERS_DB_FILE, JSON.stringify(votersDb, null, 2));
    r2.schedulePersist('voters_db.json');
  } catch (e) {}
}

export function handleTopggWebhook(req, res) {
  if (TOPGG_WEBHOOK_AUTH && req.headers.authorization !== TOPGG_WEBHOOK_AUTH) {
    return res.status(401).json({ error: 'Unauthorized webhook' });
  }

  const { user } = req.body || {};
  if (!user) return res.status(400).json({ error: 'Missing user id' });

  const now = Date.now();
  const windowMs = TIERS.VOTER.windowHours * 60 * 60 * 1000;

  votersDb[user] = {
    votedAt: now,
    expiresAt: now + windowMs,
    clipsRemaining: TIERS.VOTER.clipsPerWindow
  };

  saveVoters();
  console.log(`[Top.gg] User ${user} voted! Granted ${TIERS.VOTER.clipsPerWindow} HD clips for ${TIERS.VOTER.windowHours}h.`);
  return res.json({ success: true, message: 'Vote recorded' });
}

export function getVoterTierStatus(userId) {
  if (!userId || !votersDb[userId]) return null;
  const voter = votersDb[userId];
  if (Date.now() > voter.expiresAt || voter.clipsRemaining <= 0) {
    return null;
  }
  return voter;
}

export function consumeVoterCredit(userId) {
  if (!userId || !votersDb[userId]) return false;
  if (Date.now() > votersDb[userId].expiresAt) return false;
  if (votersDb[userId].clipsRemaining > 0) {
    votersDb[userId].clipsRemaining--;
    saveVoters();
    return true;
  }
  return false;
}
