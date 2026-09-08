// ============================================================
// bot.js
// Standalone entry point for LONG-POLLING mode (BOT_MODE=polling,
// the default). Use this on a machine that stays on 24/7 — a VPS,
// or your own computer during development.
//
// If BOT_MODE=webhook, the bot does NOT run from here at all —
// server.js mounts it directly as part of the Express app instead,
// so Telegram pushes updates straight to your web service. That is
// the recommended setup for free-tier hosts (see README.md,
// "Deploying on free hosting"). Running this file in webhook mode
// would just start a second, redundant bot instance, so it exits
// early with a pointer to the right command instead.
// ============================================================
const config = require('./src/config');
const { createBot } = require('./src/bot/telegramBot');

if (config.botMode === 'webhook') {
  console.log(
    '[bot] BOT_MODE=webhook — the bot runs inside server.js in this mode, not bot.js.\n' +
      '[bot] Start it with: npm run start:server (or npm start)'
  );
  process.exit(0);
}

const bot = createBot();

bot.launch().then(() => {
  console.log('[bot] BTG Davomat bot started (long polling).');
});

// Graceful shutdown
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
