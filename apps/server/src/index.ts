import { assertProductionSafety, config } from './config.js';
import { getDatabase } from './db/index.js';
import { assertAdminPasswordSafety, ensureAdmin } from './lib/auth.js';
import { logger, errorFields } from './lib/logger.js';
import { buildApp } from './app.js';
import { seedDemo } from './seed.js';
import { migrateWebhookSecrets } from './domain/ingest.js';
import { all } from './lib/db.js';
import { tickRunningStores } from './domain/simulator.js';
import { expireDueOffers, processStaleShifts } from './domain/dispatch.js';

assertProductionSafety(config);
const handle = getDatabase();
if (config.adminPassword) ensureAdmin(handle.db, config.adminPassword);
assertAdminPasswordSafety(handle.db, config);
if (config.auth.demoLoginEnabled) {
  logger.warn('demo_login_enabled', { note: 'development-only; disabled by production validation' });
}

const stores = all<{ id: string }>(handle.db, 'SELECT id FROM stores');
if (stores.length === 0) {
  logger.info('demo_seed_start', { reason: 'empty database' });
  const result = seedDemo(handle.db, config);
  logger.info('demo_seed_done', { storeId: result.storeId, staff: result.staffCount, simNow: result.simNow });
}

const migratedSecrets = migrateWebhookSecrets(handle.db, config);
if (migratedSecrets > 0) logger.info('webhook_secrets_encrypted', { count: migratedSecrets });

const app = buildApp(handle.db, config);
const server = app.listen(config.port, config.host, () => {
  logger.info('server_started', {
    url: `http://127.0.0.1:${config.port}`,
    admin: `http://127.0.0.1:${config.port}/admin/`,
    h5: `http://127.0.0.1:${config.port}/app/`,
    model: config.deepseek.model,
    aiConfigured: Boolean(config.deepseek.apiKey),
    env: config.nodeEnv,
  });
});

const ticker = setInterval(() => {
  void (async () => {
    try {
      await tickRunningStores(handle.db, config);
      for (const store of all<{ id: string }>(handle.db, 'SELECT id FROM stores')) {
        expireDueOffers(handle.db, store.id);
        processStaleShifts(handle.db, store.id);
      }
    } catch (err) {
      logger.error('ticker_failed', errorFields(err));
    }
  })();
}, 3000);
ticker.unref?.();

function shutdown(signal: string) {
  logger.info('shutdown', { signal });
  clearInterval(ticker);
  server.close(() => {
    handle.close();
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 3000).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
