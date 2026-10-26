import path from 'node:path';
import { createHttpServer } from './lib/http.js';
import type { Db } from './db/index.js';
import type { AppConfig } from './config.js';
import { serverRoot } from './config.js';
import { registerAuthRoutes } from './routes/auth.js';
import { registerManagerRoutes } from './routes/manager.js';
import { registerStaffRoutes } from './routes/staff.js';
import { registerAdminRoutes } from './routes/admin.js';
import { registerIngestRoutes } from './routes/ingest.js';

let registered = false;

export function registerRoutes(): void {
  if (registered) return;
  registerAuthRoutes();
  registerManagerRoutes();
  registerStaffRoutes();
  registerAdminRoutes();
  registerIngestRoutes();
  registered = true;
}

export function buildApp(db: Db, cfg: AppConfig) {
  registerRoutes();
  return createHttpServer({
    db,
    config: cfg,
    adminDir: path.resolve(serverRoot, '..', 'admin'),
    h5Dir: path.join(cfg.miniappDist, 'h5'),
  });
}
