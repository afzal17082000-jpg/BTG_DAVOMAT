// ============================================================
// src/config.js
// Centralized, validated access to environment variables.
// Every other module reads settings from here instead of
// touching process.env directly, so config is defined once.
// ============================================================
require('dotenv').config();

function required(name, fallback) {
  const value = process.env[name] ?? fallback;
  if (value === undefined) {
    throw new Error(`[config] Missing required environment variable: ${name}`);
  }
  return value;
}

function parseTimeToMinutes(hhmm) {
  // "08:30" -> 510 (minutes since midnight). Used for late/overtime comparisons.
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
}

const config = {
  botToken: required('BOT_TOKEN'),
  webAppUrl: process.env.WEBAPP_URL || '',
  adminTelegramIds: (process.env.ADMIN_TELEGRAM_IDS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map(Number),

  databaseUrl: required('DATABASE_URL'),
  pgSslMode: process.env.PGSSLMODE || 'disable',

  port: Number(process.env.PORT || 3000),
  nodeEnv: process.env.NODE_ENV || 'development',

  geofence: {
    lat: Number(process.env.COMPANY_LAT || 41.311081),
    lng: Number(process.env.COMPANY_LNG || 69.240562),
    radiusM: Number(process.env.GEOFENCE_RADIUS_M || 100),
    maxAccuracyM: Number(process.env.MAX_GPS_ACCURACY_M || 100),
  },

  workSchedule: {
    startStr: process.env.WORK_START || '08:30',
    endStr: process.env.WORK_END || '18:00',
    get startMinutes() {
      return parseTimeToMinutes(this.startStr);
    },
    get endMinutes() {
      return parseTimeToMinutes(this.endStr);
    },
  },

  defaultOvertimeMultiplier: Number(process.env.DEFAULT_OVERTIME_MULTIPLIER || 1.5),
  timezone: process.env.TIMEZONE || 'Asia/Tashkent',

  // --- Bot delivery mode ---
  // 'polling'  -> bot.js runs a standalone long-polling process (simple, needs an
  //               always-on machine — good for a VPS or local development).
  // 'webhook'  -> Telegram pushes updates via HTTP POST straight into server.js,
  //               so there is only ONE process to run. This is the recommended
  //               mode for free-tier hosts (e.g. Render's free web service) that
  //               spin the app down when idle: Telegram's own retries "wake" it
  //               back up on the next incoming message, instead of relying on
  //               a separate always-polling worker that free tiers don't offer.
  botMode: (process.env.BOT_MODE || 'polling').toLowerCase(),
  webhook: {
    // The secret is embedded in the URL path itself (plus Telegram's own
    // secret-token header check) so the endpoint can't be guessed or spammed
    // by strangers who only know your domain.
    secret: process.env.TELEGRAM_WEBHOOK_SECRET || '',
    get path() {
      const s = this.secret || 'change-me-set-TELEGRAM_WEBHOOK_SECRET';
      return `/telegram-webhook/${s}`;
    },
  },
};

module.exports = config;
