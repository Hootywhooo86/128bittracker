// Schema + migrations. Pure SQL so both node:sqlite (server) and sql.js
// (the Android app) run the exact same database.

export const MIGRATIONS = [
  // 1 — core schema
  `
  CREATE TABLE trackers (
    id          INTEGER PRIMARY KEY,
    name        TEXT NOT NULL,
    icon        TEXT NOT NULL DEFAULT '⭐',
    color       TEXT NOT NULL DEFAULT '#2dd4bf',
    kind        TEXT NOT NULL CHECK (kind IN ('check','count','duration','scale')),
    target      REAL NOT NULL DEFAULT 1,
    unit        TEXT,
    preset      TEXT,
    listens     TEXT,
    archived    INTEGER NOT NULL DEFAULT 0,
    created_at  TEXT NOT NULL
  );

  CREATE TABLE logs (
    id          INTEGER PRIMARY KEY,
    tracker_id  INTEGER NOT NULL REFERENCES trackers(id) ON DELETE CASCADE,
    value       REAL NOT NULL DEFAULT 1,
    note        TEXT,
    day         TEXT NOT NULL,
    logged_at   TEXT NOT NULL,
    source      TEXT NOT NULL DEFAULT 'tracker'
  );
  CREATE INDEX logs_tracker_day ON logs(tracker_id, day);

  CREATE TABLE freezes (
    tracker_id  INTEGER NOT NULL REFERENCES trackers(id) ON DELETE CASCADE,
    day         TEXT NOT NULL,
    PRIMARY KEY (tracker_id, day)
  );

  CREATE TABLE items (
    id             INTEGER PRIMARY KEY,
    type           TEXT NOT NULL,
    title          TEXT NOT NULL,
    creator        TEXT,
    year           INTEGER,
    cover_url      TEXT,
    status         TEXT NOT NULL DEFAULT 'planned'
                   CHECK (status IN ('planned','active','on_hold','done','dropped')),
    progress       REAL NOT NULL DEFAULT 0,
    progress_total REAL,
    rating         INTEGER CHECK (rating IS NULL OR rating BETWEEN 1 AND 10),
    review         TEXT,
    source         TEXT NOT NULL DEFAULT 'manual',
    external_id    TEXT,
    meta           TEXT NOT NULL DEFAULT '{}',
    started_at     TEXT,
    finished_at    TEXT,
    created_at     TEXT NOT NULL,
    updated_at     TEXT NOT NULL
  );
  CREATE UNIQUE INDEX items_external ON items(source, external_id) WHERE external_id IS NOT NULL;

  CREATE TABLE sessions (
    id        INTEGER PRIMARY KEY,
    item_id   INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
    minutes   REAL NOT NULL DEFAULT 0,
    progress  REAL,
    note      TEXT,
    at        TEXT NOT NULL,
    source    TEXT NOT NULL DEFAULT 'manual'
  );

  CREATE TABLE collections (
    id          INTEGER PRIMARY KEY,
    name        TEXT NOT NULL UNIQUE,
    description TEXT,
    created_at  TEXT NOT NULL
  );
  CREATE TABLE collection_items (
    collection_id INTEGER NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
    item_id       INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
    PRIMARY KEY (collection_id, item_id)
  );

  CREATE TABLE events (
    id           TEXT PRIMARY KEY,
    type         TEXT NOT NULL,
    source       TEXT NOT NULL,
    occurred_at  TEXT NOT NULL,
    received_at  TEXT NOT NULL,
    title        TEXT,
    payload      TEXT NOT NULL DEFAULT '{}'
  );
  CREATE INDEX events_time ON events(occurred_at DESC);

  CREATE TABLE api_keys (
    id           INTEGER PRIMARY KEY,
    name         TEXT NOT NULL,
    prefix       TEXT NOT NULL,
    hash         TEXT NOT NULL UNIQUE,
    scopes       TEXT NOT NULL,
    created_at   TEXT NOT NULL,
    last_used_at TEXT,
    revoked_at   TEXT
  );

  CREATE TABLE webhooks (
    id          INTEGER PRIMARY KEY,
    url         TEXT NOT NULL,
    secret      TEXT NOT NULL,
    event_types TEXT NOT NULL DEFAULT '*',
    active      INTEGER NOT NULL DEFAULT 1,
    created_at  TEXT NOT NULL,
    last_status INTEGER,
    last_error  TEXT
  );
  `,
  // 2 — key/value settings (device sync config + cursors)
  `
  CREATE TABLE kv (
    key   TEXT PRIMARY KEY,
    value TEXT
  );
  `,
];

export function migrate(db) {
  const { user_version: current } = db.prepare('PRAGMA user_version').get();
  for (let v = current; v < MIGRATIONS.length; v++) {
    db.exec('BEGIN');
    try {
      db.exec(MIGRATIONS[v]);
      db.exec(`PRAGMA user_version = ${v + 1}`);
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }
}
