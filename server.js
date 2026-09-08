// ============================================================
// server.js
// Entry point for the HTTP server: serves the Mini App static
// files (public/) and the REST API (/api/*) used by it.
// Run separately from bot.js: `npm run start:server`
// ============================================================
const path = require('path');
const express = require('express');
const cors = require('cors');
const config = require('./src/config');
const apiRoutes = require('./src/routes/api');

const app = express();

// --- Global middleware ---
app.use(cors()); // Telegram WebView loads the page cross-origin from telegram.org in some clients
app.use(express.json({ limit: '1mb' }));

// Serve the Mini App's static frontend (index.html, css, js) from /public
app.use(express.static(path.join(__dirname, 'public'), { maxAge: '1h' }));

// --- API routes ---
app.use('/api', apiRoutes);

// --------------------------------------------------------------
// Telegram bot — WEBHOOK MODE
// When BOT_MODE=webhook, the bot is mounted as just another route on
// this same Express app instead of running as a separate long-polling
// process. Telegram POSTs each update straight to our public URL.
// This is the recommended setup for free-tier hosts (Render, etc.)
// that spin the service down when idle: instead of needing a second,
// always-on "worker" process to keep polling (which free tiers
// generally don't offer), Telegram's own delivery retries simply
// wake this single web service back up on the next incoming message.
// See README.md -> "Deploying on free hosting".
// --------------------------------------------------------------
async function mountTelegramWebhook() {
  if (config.botMode !== 'webhook') return;

  if (!config.webAppUrl) {
    console.error('[server] BOT_MODE=webhook requires WEBAPP_URL to be set (your public HTTPS domain). Skipping webhook setup.');
    return;
  }
  if (!config.webhook.secret) {
    console.warn('[server] TELEGRAM_WEBHOOK_SECRET is not set — using an insecure default path. Set it before going to production.');
  }

  const { createBot } = require('./src/bot/telegramBot');
  const bot = createBot();

  // bot.createWebhook() both registers the URL with Telegram's servers
  // (via setWebhook) AND returns the Express middleware that handles
  // incoming updates — so this one call does both jobs.
  const webhookMiddleware = await bot.createWebhook({
    domain: config.webAppUrl,
    path: config.webhook.path,
    secret_token: config.webhook.secret || undefined,
  });

  app.use(webhookMiddleware);
  console.log(`[server] Telegram webhook mounted at ${config.webAppUrl}${config.webhook.path}`);
}

// --------------------------------------------------------------
// Startup.
//
// IMPORTANT ORDERING NOTE: Express matches middleware strictly in the
// order app.use() was CALLED, not just the order it appears in the file.
// mountTelegramWebhook() registers its route asynchronously (it awaits
// a network call to Telegram before calling app.use(webhookMiddleware)).
// If the catch-all 404 handler below were registered synchronously at
// module load time — as it was in an earlier version of this file — it
// would end up registered BEFORE the webhook route finishes mounting,
// so every incoming Telegram update would hit the 404 handler first and
// never reach the bot. To prevent that, the 404 and error handlers are
// registered here, inside the same async sequence, strictly AFTER
// `await mountTelegramWebhook()` resolves — guaranteeing the webhook
// route (when enabled) is always earlier in the middleware stack.
// --------------------------------------------------------------
(async () => {
  try {
    await mountTelegramWebhook();
  } catch (err) {
    console.error('[server] Failed to set up Telegram webhook:', err);
    // Don't crash the whole API just because the webhook registration failed —
    // the Mini App and REST API still work; only bot messaging is affected.
  }

  // --- 404 handler (must come after all real routes, including the webhook) ---
  app.use((req, res) => {
    res.status(404).json({ error: 'not_found' });
  });

  // --- Central error handler ---
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    console.error('[server] Unhandled error:', err);
    res.status(500).json({ error: 'server_error', message: 'Serverda xatolik yuz berdi.' });
  });

  app.listen(config.port, () => {
    console.log(`[server] BTG Davomat API listening on port ${config.port} (env: ${config.nodeEnv})`);
    console.log(`[server] Mini App static files served from /public`);
    console.log(`[server] Bot mode: ${config.botMode}`);
    if (!config.webAppUrl) {
      console.warn('[server] WEBAPP_URL is not set — the bot cannot open the Mini App button until it is.');
    }
  });
})();
