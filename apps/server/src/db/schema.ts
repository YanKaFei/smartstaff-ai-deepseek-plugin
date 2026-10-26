/**
 * SQLite schema. All timestamps are epoch milliseconds.
 * The SQL avoids SQLite-only syntax where practical (TEXT/INTEGER/REAL,
 * explicit indexes) so a PostgreSQL migration only needs type + autoincrement
 * adjustments in one place.
 */
export const SCHEMA_VERSION = 11;

export const DDL = `
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  role TEXT NOT NULL CHECK (role IN ('manager','staff','admin')),
  name TEXT NOT NULL,
  phone TEXT,
  password_hash TEXT,
  store_id TEXT,
  openid TEXT,
  phone_verified INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_users_phone ON users(phone) WHERE phone IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS ux_users_openid ON users(openid) WHERE openid IS NOT NULL;

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  role TEXT NOT NULL,
  store_id TEXT,
  expires_at INTEGER NOT NULL,
  refresh_token_hash TEXT,
  access_expires_at INTEGER,
  refresh_expires_at INTEGER,
  last_auth_at INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_sessions_user ON sessions(user_id);
CREATE UNIQUE INDEX IF NOT EXISTS ux_sessions_refresh ON sessions(refresh_token_hash) WHERE refresh_token_hash IS NOT NULL;

CREATE TABLE IF NOT EXISTS stores (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  manager_code TEXT NOT NULL UNIQUE,
  address TEXT NOT NULL,
  lat REAL NOT NULL DEFAULT 22.54,
  lng REAL NOT NULL DEFAULT 113.95,
  hours_start TEXT NOT NULL DEFAULT '16:00',
  hours_end TEXT NOT NULL DEFAULT '02:00',
  job_type TEXT NOT NULL DEFAULT '烤肉辅助',
  hourly_rate REAL NOT NULL DEFAULT 32,
  config_json TEXT NOT NULL,
  onboarding_step INTEGER NOT NULL DEFAULT 0,
  onboarded_at INTEGER,
  owner_user_id TEXT,
  manager_claim_hash TEXT,
  manager_claim_expires_at INTEGER,
  webhook_secret TEXT,
  webhook_secret_enc TEXT,
  webhook_secret_rotated_at INTEGER,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS store_clocks (
  store_id TEXT PRIMARY KEY REFERENCES stores(id),
  offset_ms INTEGER NOT NULL DEFAULT 0,
  running INTEGER NOT NULL DEFAULT 0,
  speed INTEGER NOT NULL DEFAULT 60,
  last_sim_at INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS store_tables (
  id TEXT PRIMARY KEY,
  store_id TEXT NOT NULL REFERENCES stores(id),
  table_type TEXT NOT NULL CHECK (table_type IN ('small','medium','large')),
  label TEXT NOT NULL,
  seats INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('available','dining','checkout','cleaning')),
  current_session_id TEXT,
  status_updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_tables_store ON store_tables(store_id);
CREATE INDEX IF NOT EXISTS ix_tables_status ON store_tables(store_id, status);

CREATE TABLE IF NOT EXISTS dining_sessions (
  id TEXT PRIMARY KEY,
  store_id TEXT NOT NULL REFERENCES stores(id),
  table_id TEXT NOT NULL,
  table_type TEXT NOT NULL,
  party_size INTEGER NOT NULL,
  seated_at INTEGER NOT NULL,
  checkout_at INTEGER,
  left_at INTEGER,
  cleaned_at INTEGER,
  source TEXT NOT NULL DEFAULT 'manual',
  business_date TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_sessions_store_time ON dining_sessions(store_id, seated_at);
CREATE INDEX IF NOT EXISTS ix_sessions_table ON dining_sessions(table_id, seated_at);

CREATE TABLE IF NOT EXISTS queue_entries (
  id TEXT PRIMARY KEY,
  store_id TEXT NOT NULL REFERENCES stores(id),
  call_no INTEGER,
  party_size INTEGER NOT NULL,
  desired_type TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('queued','called','seated','abandoned')),
  joined_at INTEGER NOT NULL,
  called_at INTEGER,
  seated_at INTEGER,
  abandoned_at INTEGER,
  table_id TEXT,
  source TEXT NOT NULL DEFAULT 'manual',
  business_date TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_queue_store_status ON queue_entries(store_id, status, joined_at);

CREATE TABLE IF NOT EXISTS ops_events (
  id TEXT PRIMARY KEY,
  store_id TEXT NOT NULL REFERENCES stores(id),
  type TEXT NOT NULL,
  table_id TEXT,
  queue_id TEXT,
  payload_json TEXT NOT NULL DEFAULT '{}',
  occurred_at INTEGER NOT NULL,
  source TEXT NOT NULL DEFAULT 'manual'
);
CREATE INDEX IF NOT EXISTS ix_events_store_time ON ops_events(store_id, occurred_at);

CREATE TABLE IF NOT EXISTS business_days (
  id TEXT PRIMARY KEY,
  store_id TEXT NOT NULL REFERENCES stores(id),
  business_date TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('draft','confirmed','closed')),
  on_duty_staff INTEGER NOT NULL DEFAULT 0,
  queue_groups INTEGER NOT NULL DEFAULT 0,
  queue_customers INTEGER NOT NULL DEFAULT 0,
  latest_call_no INTEGER NOT NULL DEFAULT 0,
  confirmed_at INTEGER,
  closed_at INTEGER,
  created_at INTEGER NOT NULL,
  UNIQUE (store_id, business_date)
);

CREATE TABLE IF NOT EXISTS staff_profiles (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL UNIQUE REFERENCES users(id),
  store_id TEXT NOT NULL REFERENCES stores(id),
  nickname TEXT NOT NULL,
  phone TEXT,
  area TEXT NOT NULL DEFAULT '',
  distance_km REAL NOT NULL DEFAULT 0,
  expected_rate REAL NOT NULL DEFAULT 32,
  experience_years REAL NOT NULL DEFAULT 0,
  skills_json TEXT NOT NULL DEFAULT '["烤肉辅助"]',
  qualified INTEGER NOT NULL DEFAULT 0,
  training_status TEXT NOT NULL DEFAULT 'pending',
  status TEXT NOT NULL CHECK (status IN ('pending','approved','rejected','suspended')),
  on_time_rate REAL NOT NULL DEFAULT 0.9,
  shifts_completed INTEGER NOT NULL DEFAULT 0,
  no_show_count INTEGER NOT NULL DEFAULT 0,
  bio TEXT NOT NULL DEFAULT '',
  source TEXT NOT NULL DEFAULT 'manual',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_staff_store_status ON staff_profiles(store_id, status);

CREATE TABLE IF NOT EXISTS staff_availability (
  id TEXT PRIMARY KEY,
  staff_id TEXT NOT NULL REFERENCES staff_profiles(id) ON DELETE CASCADE,
  weekday INTEGER NOT NULL CHECK (weekday BETWEEN 0 AND 6),
  start_min INTEGER NOT NULL,
  end_min INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_avail_staff ON staff_availability(staff_id);

CREATE TABLE IF NOT EXISTS forecasts (
  id TEXT PRIMARY KEY,
  store_id TEXT NOT NULL REFERENCES stores(id),
  generated_at INTEGER NOT NULL,
  horizon_start INTEGER NOT NULL,
  slots_json TEXT NOT NULL,
  summary_json TEXT NOT NULL,
  ai_json TEXT,
  ai_status TEXT NOT NULL DEFAULT 'fallback',
  reliability TEXT NOT NULL,
  bottleneck TEXT NOT NULL,
  required_staff INTEGER NOT NULL,
  on_duty_staff INTEGER NOT NULL,
  gap INTEGER NOT NULL,
  source TEXT NOT NULL DEFAULT 'manual'
);
CREATE INDEX IF NOT EXISTS ix_forecasts_store ON forecasts(store_id, generated_at);

CREATE TABLE IF NOT EXISTS assignment_plans (
  id TEXT PRIMARY KEY,
  store_id TEXT NOT NULL REFERENCES stores(id),
  forecast_id TEXT NOT NULL REFERENCES forecasts(id),
  plan_type TEXT NOT NULL CHECK (plan_type IN ('economic','guarantee')),
  status TEXT NOT NULL CHECK (status IN ('proposed','confirmed','superseded')),
  items_json TEXT NOT NULL,
  total_cost REAL NOT NULL DEFAULT 0,
  headcount INTEGER NOT NULL DEFAULT 0,
  shortage_json TEXT NOT NULL DEFAULT '[]',
  shadow INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  confirmed_at INTEGER
);
CREATE INDEX IF NOT EXISTS ix_plans_store_status ON assignment_plans(store_id, status, created_at);

CREATE TABLE IF NOT EXISTS staffing_demands (
  id TEXT PRIMARY KEY,
  store_id TEXT NOT NULL REFERENCES stores(id),
  plan_id TEXT,
  role TEXT NOT NULL DEFAULT '烤肉辅助',
  start_at INTEGER NOT NULL,
  end_at INTEGER NOT NULL,
  headcount INTEGER NOT NULL,
  hourly_rate REAL NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('open','filled','cancelled')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_demands_store_time ON staffing_demands(store_id, start_at);
CREATE UNIQUE INDEX IF NOT EXISTS ux_demands_plan_slot ON staffing_demands(plan_id, start_at, end_at, role) WHERE plan_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS backfill_tasks (
  id TEXT PRIMARY KEY,
  store_id TEXT NOT NULL REFERENCES stores(id),
  demand_id TEXT NOT NULL REFERENCES staffing_demands(id),
  source_shift_id TEXT NOT NULL UNIQUE,
  shift_id TEXT,
  role TEXT NOT NULL,
  start_at INTEGER NOT NULL,
  end_at INTEGER NOT NULL,
  hourly_rate REAL NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending','offered','filled','no_candidate','cancelled','needs_approval')),
  reason TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_backfill_demand ON backfill_tasks(demand_id, status);

CREATE TABLE IF NOT EXISTS shifts (
  id TEXT PRIMARY KEY,
  store_id TEXT NOT NULL REFERENCES stores(id),
  staff_id TEXT NOT NULL REFERENCES staff_profiles(id),
  plan_id TEXT,
  demand_id TEXT,
  is_backfill INTEGER NOT NULL DEFAULT 0,
  role TEXT NOT NULL DEFAULT '烤肉辅助',
  start_at INTEGER NOT NULL,
  end_at INTEGER NOT NULL,
  hourly_rate REAL NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('invited','confirmed','checked_in','completed','cancelled','no_show')),
  offer_id TEXT,
  checked_in_at INTEGER,
  checked_out_at INTEGER,
  actual_minutes INTEGER,
  pay_amount REAL,
  late_minutes INTEGER NOT NULL DEFAULT 0,
  manager_confirmed INTEGER NOT NULL DEFAULT 0,
  note TEXT NOT NULL DEFAULT '',
  cancelled_at INTEGER,
  cancelled_by TEXT,
  cancel_reason TEXT,
  cancel_kind TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_shifts_store_time ON shifts(store_id, start_at);
CREATE INDEX IF NOT EXISTS ix_shifts_staff_time ON shifts(staff_id, start_at);
CREATE INDEX IF NOT EXISTS ix_shifts_status ON shifts(store_id, status);

CREATE TABLE IF NOT EXISTS job_offers (
  id TEXT PRIMARY KEY,
  store_id TEXT NOT NULL REFERENCES stores(id),
  shift_id TEXT NOT NULL REFERENCES shifts(id),
  staff_id TEXT NOT NULL REFERENCES staff_profiles(id),
  status TEXT NOT NULL CHECK (status IN ('pending','accepted','rejected','expired','cancelled')),
  expires_at INTEGER NOT NULL,
  attempt INTEGER NOT NULL DEFAULT 1,
  candidates_json TEXT NOT NULL DEFAULT '[]',
  responded_at INTEGER,
  reason TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_offers_staff ON job_offers(staff_id, status);
CREATE INDEX IF NOT EXISTS ix_offers_pending ON job_offers(store_id, status, expires_at);

CREATE TABLE IF NOT EXISTS notifications (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  store_id TEXT,
  type TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  read INTEGER NOT NULL DEFAULT 0,
  related_json TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_notifications_user ON notifications(user_id, read, created_at);

CREATE TABLE IF NOT EXISTS exceptions (
  id TEXT PRIMARY KEY,
  store_id TEXT NOT NULL REFERENCES stores(id),
  type TEXT NOT NULL,
  severity TEXT NOT NULL DEFAULT 'warning',
  status TEXT NOT NULL CHECK (status IN ('open','resolved')),
  shift_id TEXT,
  offer_id TEXT,
  message TEXT NOT NULL,
  payload_json TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL,
  resolved_at INTEGER,
  resolved_by TEXT
);
CREATE INDEX IF NOT EXISTS ix_exceptions_store ON exceptions(store_id, status, created_at);

CREATE TABLE IF NOT EXISTS shadow_runs (
  id TEXT PRIMARY KEY,
  store_id TEXT NOT NULL REFERENCES stores(id),
  plan_id TEXT NOT NULL REFERENCES assignment_plans(id),
  forecast_id TEXT NOT NULL,
  recommendations_json TEXT NOT NULL,
  total_cost REAL NOT NULL DEFAULT 0,
  note TEXT NOT NULL DEFAULT '',
  created_by TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_shadow_store_time ON shadow_runs(store_id, created_at);

CREATE TABLE IF NOT EXISTS pilot_controls (
  store_id TEXT PRIMARY KEY REFERENCES stores(id),
  dispatch_paused INTEGER NOT NULL DEFAULT 0,
  reason TEXT,
  updated_by TEXT,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS pilot_feedback (
  id TEXT PRIMARY KEY,
  store_id TEXT NOT NULL REFERENCES stores(id),
  shadow_run_id TEXT,
  recommended INTEGER NOT NULL,
  manager_actual INTEGER NOT NULL,
  on_duty INTEGER NOT NULL,
  overloaded INTEGER NOT NULL DEFAULT 0,
  no_show INTEGER NOT NULL DEFAULT 0,
  decision TEXT,
  reasons_json TEXT,
  correction TEXT,
  notes TEXT,
  created_by TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS data_imports (
  id TEXT PRIMARY KEY,
  store_id TEXT NOT NULL REFERENCES stores(id),
  filename TEXT NOT NULL,
  format TEXT NOT NULL CHECK (format IN ('csv','xlsx')),
  data_origin TEXT NOT NULL CHECK (data_origin IN ('REAL','SIMULATED')),
  row_count INTEGER NOT NULL,
  valid_count INTEGER NOT NULL,
  invalid_count INTEGER NOT NULL,
  duplicate_count INTEGER NOT NULL,
  quality_json TEXT NOT NULL,
  created_by TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_imports_store_time ON data_imports(store_id, created_at);

CREATE TABLE IF NOT EXISTS import_observations (
  id TEXT PRIMARY KEY,
  import_id TEXT NOT NULL REFERENCES data_imports(id),
  store_id TEXT NOT NULL REFERENCES stores(id),
  source_row INTEGER NOT NULL,
  store_code TEXT,
  business_date TEXT,
  table_type TEXT,
  party_size INTEGER,
  queue_at INTEGER,
  seat_at INTEGER,
  checkout_at INTEGER,
  leave_at INTEGER,
  clean_at INTEGER,
  on_duty_staff INTEGER,
  service_mode TEXT,
  actual_work_minutes REAL,
  manager_sufficiency TEXT,
  data_origin TEXT NOT NULL CHECK (data_origin IN ('REAL','SIMULATED')),
  quality_status TEXT NOT NULL CHECK (quality_status IN ('valid','invalid','duplicate')),
  issues_json TEXT NOT NULL DEFAULT '[]',
  dedupe_key TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_observations_import ON import_observations(import_id, quality_status);
CREATE INDEX IF NOT EXISTS ix_observations_time ON import_observations(store_id, seat_at);

CREATE TABLE IF NOT EXISTS replay_runs (
  id TEXT PRIMARY KEY,
  import_id TEXT NOT NULL REFERENCES data_imports(id),
  store_id TEXT NOT NULL REFERENCES stores(id),
  model TEXT NOT NULL,
  service_mode TEXT NOT NULL,
  status TEXT NOT NULL,
  prediction_count INTEGER NOT NULL DEFAULT 0,
  metrics_json TEXT NOT NULL DEFAULT '{}',
  data_quality_json TEXT NOT NULL DEFAULT '{}',
  created_by TEXT,
  created_at INTEGER NOT NULL,
  completed_at INTEGER
);
CREATE INDEX IF NOT EXISTS ix_replay_import ON replay_runs(import_id, created_at);

CREATE TABLE IF NOT EXISTS replay_predictions (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES replay_runs(id),
  prediction_time INTEGER NOT NULL,
  horizon_start INTEGER NOT NULL,
  horizon_end INTEGER NOT NULL,
  input_snapshot_json TEXT NOT NULL,
  model TEXT NOT NULL,
  service_mode TEXT NOT NULL,
  recommended INTEGER NOT NULL,
  reason TEXT NOT NULL,
  quality_json TEXT NOT NULL,
  actual_json TEXT,
  evaluated INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_replay_predictions_run ON replay_predictions(run_id, prediction_time);

CREATE TABLE IF NOT EXISTS pilot_ux_metrics (
  id TEXT PRIMARY KEY,
  store_id TEXT NOT NULL REFERENCES stores(id),
  flow TEXT NOT NULL,
  action_count INTEGER NOT NULL,
  elapsed_ms INTEGER NOT NULL,
  plan_id TEXT,
  shadow INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS rate_limit_buckets (
  key TEXT PRIMARY KEY,
  window_start INTEGER NOT NULL,
  hits INTEGER NOT NULL,
  blocked_until INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS service_calibrations (
  id TEXT PRIMARY KEY,
  store_id TEXT NOT NULL REFERENCES stores(id),
  sample_size INTEGER NOT NULL,
  source TEXT NOT NULL,
  evidence_note TEXT NOT NULL,
  parameters_json TEXT NOT NULL,
  created_by TEXT,
  created_at INTEGER NOT NULL,
  active INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS ix_calibration_store ON service_calibrations(store_id, active, created_at);

CREATE TABLE IF NOT EXISTS ai_usage (
  id TEXT PRIMARY KEY,
  store_id TEXT NOT NULL REFERENCES stores(id),
  forecast_id TEXT,
  model TEXT NOT NULL,
  prompt_tokens INTEGER NOT NULL DEFAULT 0,
  completion_tokens INTEGER NOT NULL DEFAULT 0,
  total_tokens INTEGER NOT NULL DEFAULT 0,
  latency_ms INTEGER NOT NULL DEFAULT 0,
  cost_usd REAL NOT NULL DEFAULT 0,
  cost_basis TEXT NOT NULL DEFAULT 'unconfigured',
  status TEXT NOT NULL,
  error_code TEXT,
  cache_hit INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_ai_usage_store_time ON ai_usage(store_id, created_at);

CREATE TABLE IF NOT EXISTS ai_cache (
  cache_key TEXT PRIMARY KEY,
  model TEXT NOT NULL,
  analysis_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS event_ingest (
  id TEXT PRIMARY KEY,
  store_id TEXT NOT NULL REFERENCES stores(id),
  source TEXT NOT NULL CHECK (source IN ('manual','simulator','webhook','correction')),
  external_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  occurred_at INTEGER NOT NULL,
  received_at INTEGER NOT NULL,
  payload_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('received','applied','duplicate','stale','error','replayed','corrected')),
  error TEXT,
  signature_valid INTEGER NOT NULL DEFAULT 0,
  correction_of TEXT,
  applied_event_id TEXT,
  created_at INTEGER NOT NULL,
  UNIQUE (store_id, source, external_id)
);
CREATE INDEX IF NOT EXISTS ix_ingest_store_time ON event_ingest(store_id, occurred_at);
CREATE INDEX IF NOT EXISTS ix_ingest_status ON event_ingest(store_id, status);

CREATE TABLE IF NOT EXISTS event_ingest_state (
  store_id TEXT PRIMARY KEY REFERENCES stores(id),
  last_received_at INTEGER,
  last_applied_at INTEGER,
  last_event_at INTEGER,
  last_source TEXT,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS phone_verifications (
  id TEXT PRIMARY KEY,
  phone TEXT NOT NULL,
  code_hash TEXT NOT NULL,
  store_id TEXT,
  expires_at INTEGER NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  used_at INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_phone_verifications ON phone_verifications(phone, created_at);

CREATE TABLE IF NOT EXISTS audit_logs (
  id TEXT PRIMARY KEY,
  store_id TEXT,
  actor_id TEXT,
  actor_role TEXT,
  action TEXT NOT NULL,
  entity TEXT,
  entity_id TEXT,
  detail_json TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_audit_store ON audit_logs(store_id, created_at);
`;
