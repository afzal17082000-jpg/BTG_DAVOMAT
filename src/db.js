// ============================================================
// src/db.js
// Single shared PostgreSQL connection pool for the whole app.
// Both server.js (API) and bot.js (Telegram bot) import this
// same module so they share one pool per process.
// ============================================================
const { Pool } = require('pg');
const config = require('./config');

const pool = new Pool({
  connectionString: config.databaseUrl,
  ssl: config.pgSslMode === 'require' ? { rejectUnauthorized: false } : false,
  max: 10, // reasonable default for a small/medium factory-sized app
  idleTimeoutMillis: 30000,
});

pool.on('error', (err) => {
  // Catches errors on idle clients so the process doesn't crash silently.
  console.error('[db] Unexpected error on idle PostgreSQL client', err);
});

/**
 * Run a query with automatic logging of slow queries in development.
 * @param {string} text - SQL text with $1, $2... placeholders
 * @param {Array} params
 */
async function query(text, params) {
  const start = Date.now();
  const result = await pool.query(text, params);
  const duration = Date.now() - start;
  if (config.nodeEnv !== 'production' && duration > 200) {
    console.warn(`[db] slow query (${duration}ms): ${text}`);
  }
  return result;
}

/**
 * Get a dedicated client for multi-statement transactions.
 * Caller MUST call client.release() when done (use try/finally).
 */
async function getClient() {
  const client = await pool.connect();
  return client;
}

module.exports = { pool, query, getClient };
