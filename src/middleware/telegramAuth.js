// ============================================================
// src/middleware/telegramAuth.js
// Validates the `initData` string that the Telegram Mini App SDK
// sends with every request, per Telegram's official algorithm:
//   https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app
//
// This is the ONLY trustworthy way to know "which Telegram user is
// making this request" — never trust a plain telegram_id sent in
// the request body, since that could be forged by any client.
// ============================================================
const crypto = require('crypto');
const config = require('../config');
const db = require('../db');

/**
 * Verifies the HMAC signature of a Telegram WebApp initData string.
 * Returns the parsed user object if valid, otherwise null.
 */
function verifyInitData(initData) {
  if (!initData || typeof initData !== 'string') return null;

  const params = new URLSearchParams(initData);
  const hash = params.get('hash');
  if (!hash) return null;
  params.delete('hash');

  // Build the "data-check-string": all fields sorted alphabetically, joined by \n
  const dataCheckArr = [];
  for (const [key, value] of [...params.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    dataCheckArr.push(`${key}=${value}`);
  }
  const dataCheckString = dataCheckArr.join('\n');

  // secret_key = HMAC_SHA256("WebAppData", bot_token)
  const secretKey = crypto.createHmac('sha256', 'WebAppData').update(config.botToken).digest();
  const computedHash = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex');

  if (computedHash !== hash) return null;

  // Optional freshness check: reject initData older than 24h to limit replay-attack window.
  const authDate = Number(params.get('auth_date') || 0);
  const ageSeconds = Date.now() / 1000 - authDate;
  if (!authDate || ageSeconds > 60 * 60 * 24) {
    return null;
  }

  const userJson = params.get('user');
  if (!userJson) return null;

  try {
    return JSON.parse(userJson); // { id, first_name, last_name, username, ... }
  } catch {
    return null;
  }
}

/**
 * Express middleware: requires a valid Telegram Mini App session AND
 * a matching, active employee record. Attaches `req.tgUser` and `req.employee`.
 */
async function requireTelegramAuth(req, res, next) {
  try {
    const initData = req.header('X-Telegram-Init-Data') || req.body?.initData || req.query?.initData;
    const tgUser = verifyInitData(initData);

    if (!tgUser) {
      return res.status(401).json({ error: 'unauthorized', message: 'Invalid or expired Telegram session.' });
    }

    const { rows } = await db.query(
      `SELECT * FROM employees WHERE telegram_id = $1 AND is_active = TRUE LIMIT 1`,
      [tgUser.id]
    );

    if (rows.length === 0) {
      return res.status(403).json({
        error: 'not_registered',
        message: "Siz tizimda ro'yxatdan o'tmagansiz. Administratorga murojaat qiling.",
      });
    }

    req.tgUser = tgUser;
    req.employee = rows[0];
    req.isAdmin = config.adminTelegramIds.includes(tgUser.id);
    next();
  } catch (err) {
    console.error('[telegramAuth] error', err);
    res.status(500).json({ error: 'server_error' });
  }
}

module.exports = { verifyInitData, requireTelegramAuth };
