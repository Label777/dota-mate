'use strict';
/*
 * База данных Dota Mate: SQLite через встроенный в Node.js модуль node:sqlite (Node 22.5+, внешних зависимостей нет).
 * Миграции применяются по порядку при запуске; применённые записываются в schema_migrations.
 * Все запросы подготовленные (параметры отдельно от текста запроса), поэтому SQL-инъекции исключены.
 */
let DatabaseSync = null;
try { ({ DatabaseSync } = require('node:sqlite')); } catch (e) { /* старый Node: функции сообщества отключаются */ }

const STATUSES = "'new','pending','needs_data','confirmed','not_confirmed','rejected','disputed','closed'";

const MIGRATIONS = [
  {
    id: 1, name: 'init',
    sql: `
CREATE TABLE players (
  acc TEXT PRIMARY KEY CHECK (length(acc) BETWEEN 1 AND 10 AND acc NOT GLOB '*[^0-9]*'),
  name TEXT, avatar TEXT, updated_at INTEGER NOT NULL
);
CREATE TABLE matches (
  id TEXT PRIMARY KEY CHECK (length(id) BETWEEN 6 AND 13 AND id NOT GLOB '*[^0-9]*'),
  started_at INTEGER, duration INTEGER, game_mode INTEGER, fetched_at INTEGER NOT NULL
);
CREATE TABLE match_players (
  match_id TEXT NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
  acc TEXT NOT NULL, hero_id INTEGER, is_radiant INTEGER, kills INTEGER, deaths INTEGER, assists INTEGER,
  PRIMARY KEY (match_id, acc)
);
CREATE TABLE reports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  reporter TEXT NOT NULL, target TEXT NOT NULL,
  match_id TEXT NOT NULL REFERENCES matches(id),
  category TEXT NOT NULL CHECK (category IN ('sabotage','feeding','afk','other')),
  description TEXT NOT NULL CHECK (length(description) BETWEEN 20 AND 1000),
  status TEXT NOT NULL DEFAULT 'new' CHECK (status IN (${STATUSES})),
  public_reason TEXT CHECK (public_reason IS NULL OR length(public_reason) <= 300),
  flags INTEGER NOT NULL DEFAULT 0,
  volume_flag INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, decided_at INTEGER,
  UNIQUE (reporter, target, match_id),
  CHECK (reporter <> target)
);
CREATE INDEX ix_reports_target_status ON reports(target, status);
CREATE INDEX ix_reports_status_created ON reports(status, created_at);
CREATE INDEX ix_reports_reporter_created ON reports(reporter, created_at);
CREATE TABLE appeals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  report_id INTEGER NOT NULL REFERENCES reports(id),
  author TEXT NOT NULL, by_target INTEGER NOT NULL CHECK (by_target IN (0,1)),
  text TEXT NOT NULL CHECK (length(text) BETWEEN 10 AND 1000),
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','needs_data','upheld','revoked','closed')),
  decision_reason TEXT, decided_by TEXT,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX ux_appeals_open ON appeals(report_id, author) WHERE status IN ('open','needs_data');
CREATE INDEX ix_appeals_status ON appeals(status, created_at);
CREATE TABLE report_evidence (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  report_id INTEGER REFERENCES reports(id) ON DELETE CASCADE,
  appeal_id INTEGER REFERENCES appeals(id) ON DELETE CASCADE,
  url TEXT NOT NULL CHECK (length(url) <= 300),
  created_at INTEGER NOT NULL,
  CHECK ((report_id IS NULL) <> (appeal_id IS NULL))
);
CREATE INDEX ix_evidence_report ON report_evidence(report_id);
CREATE INDEX ix_evidence_appeal ON report_evidence(appeal_id);
CREATE TABLE report_flags (
  report_id INTEGER NOT NULL REFERENCES reports(id) ON DELETE CASCADE,
  flagger TEXT NOT NULL, reason TEXT, created_at INTEGER NOT NULL,
  PRIMARY KEY (report_id, flagger)
);
CREATE TABLE moderation_actions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  report_id INTEGER REFERENCES reports(id), appeal_id INTEGER REFERENCES appeals(id),
  actor TEXT NOT NULL, action TEXT NOT NULL,
  from_status TEXT, to_status TEXT, reason TEXT, created_at INTEGER NOT NULL
);
CREATE INDEX ix_actions_report ON moderation_actions(report_id, id);
CREATE INDEX ix_actions_appeal ON moderation_actions(appeal_id, id);
CREATE TABLE watchlist_entries (
  user_acc TEXT NOT NULL, target_acc TEXT NOT NULL, note TEXT CHECK (note IS NULL OR length(note) <= 200),
  added_at INTEGER NOT NULL, last_checked_at INTEGER, last_state TEXT, last_anomalies INTEGER,
  PRIMARY KEY (user_acc, target_acc)
);
CREATE INDEX ix_watch_target ON watchlist_entries(target_acc);
CREATE TABLE notifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_acc TEXT NOT NULL, kind TEXT NOT NULL CHECK (kind IN ('message','anomaly','decision')),
  target_acc TEXT, text TEXT NOT NULL, ref TEXT,
  created_at INTEGER NOT NULL, read_at INTEGER
);
CREATE INDEX ix_notif_user ON notifications(user_acc, read_at, id);
CREATE TABLE reputation_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  target_acc TEXT NOT NULL, user_acc TEXT NOT NULL, computed_at INTEGER NOT NULL,
  state TEXT NOT NULL, score INTEGER, confidence TEXT, anomalies INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX ix_snap_target ON reputation_snapshots(target_acc, computed_at);
`
  }
];

function migrate(db, now) {
  db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (id INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at INTEGER NOT NULL)');
  const done = new Set(db.prepare('SELECT id FROM schema_migrations').all().map((r) => r.id));
  for (const m of MIGRATIONS) {
    if (done.has(m.id)) continue;
    db.exec('BEGIN');
    try {
      db.exec(m.sql);
      db.prepare('INSERT INTO schema_migrations (id, name, applied_at) VALUES (?, ?, ?)').run(m.id, m.name, now || Math.floor(Date.now() / 1000));
      db.exec('COMMIT');
    } catch (e) { db.exec('ROLLBACK'); throw e; }
  }
}

/** Открывает базу (file = ':memory:' для тестов). Бросает ошибку с code NO_SQLITE, если модуля нет. */
function open(file) {
  if (!DatabaseSync) throw Object.assign(new Error('Модуль node:sqlite недоступен: нужен Node.js 22.5 или новее.'), { code: 'NO_SQLITE' });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA foreign_keys = ON');
  if (file !== ':memory:') db.exec('PRAGMA journal_mode = WAL');
  migrate(db);
  return db;
}

module.exports = { open, migrate, MIGRATIONS, available: !!DatabaseSync };
