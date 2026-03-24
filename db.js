// db.js
let initPromise = null;
let initDone = false;

const SCHEMA_STATEMENTS = [
  "CREATE TABLE IF NOT EXISTS user_identity_cache (user_id INTEGER PRIMARY KEY, username TEXT NOT NULL DEFAULT '', first_name TEXT NOT NULL DEFAULT '', last_name TEXT NOT NULL DEFAULT '', updated_at TEXT NOT NULL)",
  "CREATE INDEX IF NOT EXISTS idx_user_identity_cache_username ON user_identity_cache(username)",
  "CREATE TABLE IF NOT EXISTS username_cache (scope_type TEXT NOT NULL, chat_id INTEGER NOT NULL DEFAULT 0, username TEXT NOT NULL, user_id INTEGER NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY (scope_type, chat_id, username))",
  "CREATE INDEX IF NOT EXISTS idx_username_cache_lookup ON username_cache(scope_type, chat_id, username)",
  "CREATE INDEX IF NOT EXISTS idx_username_cache_user ON username_cache(user_id)",
  "CREATE TABLE IF NOT EXISTS identity_tracker_snapshots (chat_id INTEGER NOT NULL, user_id INTEGER NOT NULL, username TEXT NOT NULL DEFAULT '', first_name TEXT NOT NULL DEFAULT '', last_name TEXT NOT NULL DEFAULT '', updated_at TEXT NOT NULL, PRIMARY KEY (chat_id, user_id))",
  "CREATE TABLE IF NOT EXISTS identity_tracker_recent_signals (chat_id INTEGER NOT NULL, user_id INTEGER NOT NULL, signature TEXT NOT NULL, detected_at TEXT NOT NULL, PRIMARY KEY (chat_id, user_id))",
  "CREATE TABLE IF NOT EXISTS identity_tracker_history (id INTEGER PRIMARY KEY AUTOINCREMENT, chat_id INTEGER NOT NULL, user_id INTEGER NOT NULL, detected_at TEXT NOT NULL, source TEXT NOT NULL DEFAULT '', changes_json TEXT NOT NULL DEFAULT '[]', notified INTEGER NOT NULL DEFAULT 0, target_chat_id INTEGER, target_thread_id INTEGER, target_message_id INTEGER)",
  "CREATE INDEX IF NOT EXISTS idx_identity_tracker_history_lookup ON identity_tracker_history(chat_id, user_id, detected_at DESC, id DESC)",
  "CREATE INDEX IF NOT EXISTS idx_identity_tracker_history_user ON identity_tracker_history(user_id, detected_at DESC, id DESC)"
];

export async function ensureTemanOpsDb(DB) {
  if (!DB || typeof DB.prepare !== "function") return false;
  if (initDone) return true;
  if (initPromise) return initPromise;

  initPromise = (async () => {
    for (const sql of SCHEMA_STATEMENTS) {
      await DB.prepare(sql).run();
    }

    const row = await DB
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1")
      .bind("identity_tracker_snapshots")
      .first();

    if (!row?.name) {
      throw new Error("D1 schema verification failed");
    }

    initDone = true;
    return true;
  })().catch((err) => {
    initPromise = null;
    initDone = false;
    throw err;
  });

  return initPromise;
}
