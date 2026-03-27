let initPromise = null;
let initDone = false;

const BASE_SCHEMA_STATEMENTS = [
  "CREATE TABLE IF NOT EXISTS user_identity_cache (user_id INTEGER PRIMARY KEY, username TEXT NOT NULL DEFAULT '', first_name TEXT NOT NULL DEFAULT '', last_name TEXT NOT NULL DEFAULT '', updated_at TEXT NOT NULL)",
  "CREATE INDEX IF NOT EXISTS idx_user_identity_cache_username ON user_identity_cache(username)",
  "CREATE TABLE IF NOT EXISTS username_cache (scope_type TEXT NOT NULL, chat_id INTEGER NOT NULL DEFAULT 0, username TEXT NOT NULL, user_id INTEGER NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY (scope_type, chat_id, username))",
  "CREATE INDEX IF NOT EXISTS idx_username_cache_lookup ON username_cache(scope_type, chat_id, username)",
  "CREATE INDEX IF NOT EXISTS idx_username_cache_user ON username_cache(user_id)",
  "CREATE TABLE IF NOT EXISTS identity_tracker_snapshots (chat_id INTEGER NOT NULL, user_id INTEGER NOT NULL, username TEXT NOT NULL DEFAULT '', first_name TEXT NOT NULL DEFAULT '', last_name TEXT NOT NULL DEFAULT '', updated_at TEXT NOT NULL, PRIMARY KEY (chat_id, user_id))",
  "CREATE TABLE IF NOT EXISTS identity_tracker_recent_signals (chat_id INTEGER NOT NULL, user_id INTEGER NOT NULL, signature TEXT NOT NULL, detected_at TEXT NOT NULL, PRIMARY KEY (chat_id, user_id))",
  "CREATE TABLE IF NOT EXISTS identity_tracker_history (id INTEGER PRIMARY KEY AUTOINCREMENT, chat_id INTEGER NOT NULL, user_id INTEGER NOT NULL, detected_at TEXT NOT NULL, source TEXT NOT NULL DEFAULT '', changes_json TEXT NOT NULL DEFAULT '[]', notified INTEGER NOT NULL DEFAULT 0, target_chat_id INTEGER, target_thread_id INTEGER, target_message_id INTEGER)",
  "CREATE INDEX IF NOT EXISTS idx_identity_tracker_history_lookup ON identity_tracker_history(chat_id, user_id, detected_at DESC, id DESC)",
  "CREATE INDEX IF NOT EXISTS idx_identity_tracker_history_user ON identity_tracker_history(user_id, detected_at DESC, id DESC)",
  "CREATE TABLE IF NOT EXISTS username_surveillance_cards (source_chat_id INTEGER NOT NULL, user_id INTEGER NOT NULL, target_chat_id INTEGER NOT NULL, target_thread_id INTEGER, target_message_id INTEGER NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY (source_chat_id, user_id))",
  "CREATE INDEX IF NOT EXISTS idx_username_surveillance_cards_target ON username_surveillance_cards(target_chat_id, target_thread_id, updated_at DESC)",
  "CREATE TABLE IF NOT EXISTS username_surveillance_history (id INTEGER PRIMARY KEY AUTOINCREMENT, source_chat_id INTEGER NOT NULL, user_id INTEGER NOT NULL, event_type TEXT NOT NULL, reason TEXT NOT NULL DEFAULT '', target_chat_id INTEGER, target_thread_id INTEGER, target_message_id INTEGER, username TEXT NOT NULL DEFAULT '', first_name TEXT NOT NULL DEFAULT '', last_name TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL)",
  "CREATE INDEX IF NOT EXISTS idx_username_surveillance_history_lookup ON username_surveillance_history(source_chat_id, user_id, created_at DESC, id DESC)",
  "CREATE INDEX IF NOT EXISTS idx_username_surveillance_history_event ON username_surveillance_history(event_type, created_at DESC, id DESC)"
];

const CASE_RECORD_TABLE_NAME = "username_surveillance_case_records";

const CASE_RECORD_SCHEMA_STATEMENTS = [
  "CREATE TABLE IF NOT EXISTS username_surveillance_case_records (id INTEGER PRIMARY KEY AUTOINCREMENT, case_id TEXT NOT NULL UNIQUE, schema_version INTEGER NOT NULL DEFAULT 1, chat_id INTEGER NOT NULL, offender_user_id INTEGER NOT NULL, chat_title TEXT NOT NULL DEFAULT '', message_id INTEGER NOT NULL, message_thread_id INTEGER, message_date TEXT, reason TEXT NOT NULL DEFAULT '', action_json TEXT NOT NULL DEFAULT '{}', offender_json TEXT NOT NULL DEFAULT '{}', evidence_json TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL, updated_at TEXT NOT NULL)",
  "CREATE UNIQUE INDEX IF NOT EXISTS idx_username_surveillance_case_records_case_id ON username_surveillance_case_records(case_id)",
  "CREATE INDEX IF NOT EXISTS idx_username_surveillance_case_records_lookup ON username_surveillance_case_records(chat_id, offender_user_id, created_at DESC, id DESC)",
  "CREATE INDEX IF NOT EXISTS idx_username_surveillance_case_records_created_at ON username_surveillance_case_records(created_at DESC, id DESC)"
];

async function verifyTable(DB, tableName) {
  const row = await DB
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1")
    .bind(tableName)
    .first();

  return !!row?.name;
}

async function getTableColumns(DB, tableName) {
  const result = await DB.prepare(`PRAGMA table_info(${tableName})`).all();
  return (result?.results || [])
    .map((row) => String(row?.name || "").trim())
    .filter(Boolean);
}

async function runStatements(DB, statements) {
  for (const sql of statements) {
    await DB.prepare(sql).run();
  }
}

async function ensureCaseRecordSchema(DB) {
  const hasTable = await verifyTable(DB, CASE_RECORD_TABLE_NAME);

  if (!hasTable) {
    await runStatements(DB, CASE_RECORD_SCHEMA_STATEMENTS);
    return true;
  }

  const columns = await getTableColumns(DB, CASE_RECORD_TABLE_NAME);
  const hasRequiredShape =
    columns.includes("case_id") &&
    columns.includes("chat_id") &&
    columns.includes("offender_user_id") &&
    columns.includes("action_json") &&
    columns.includes("offender_json") &&
    columns.includes("evidence_json");

  if (hasRequiredShape) {
    await runStatements(DB, CASE_RECORD_SCHEMA_STATEMENTS.slice(1));
    return true;
  }

  const row = await DB
    .prepare(`SELECT COUNT(*) AS total FROM ${CASE_RECORD_TABLE_NAME}`)
    .first();

  const total = Number(row?.total || 0);

  if (total > 0) {
    throw new Error("D1 case record schema mismatch with existing rows");
  }

  await DB.prepare(`DROP TABLE IF EXISTS ${CASE_RECORD_TABLE_NAME}`).run();
  await runStatements(DB, CASE_RECORD_SCHEMA_STATEMENTS);
  return true;
}

export async function ensureTemanOpsDb(DB) {
  if (!DB || typeof DB.prepare !== "function") return false;
  if (initDone) return true;
  if (initPromise) return initPromise;

  initPromise = (async () => {
    await runStatements(DB, BASE_SCHEMA_STATEMENTS);
    await ensureCaseRecordSchema(DB);

    const hasIdentitySnapshots = await verifyTable(DB, "identity_tracker_snapshots");
    const hasUsernameSurveillanceCards = await verifyTable(DB, "username_surveillance_cards");
    const hasUsernameSurveillanceHistory = await verifyTable(DB, "username_surveillance_history");
    const hasUsernameSurveillanceCaseRecords = await verifyTable(DB, CASE_RECORD_TABLE_NAME);
    const caseRecordColumns = await getTableColumns(DB, CASE_RECORD_TABLE_NAME);

    if (
      !hasIdentitySnapshots ||
      !hasUsernameSurveillanceCards ||
      !hasUsernameSurveillanceHistory ||
      !hasUsernameSurveillanceCaseRecords ||
      !caseRecordColumns.includes("case_id")
    ) {
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

const MAX_CASE_ID_ATTEMPTS = 5;
const CASE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const CASE_ID_LENGTH = 8;

function randomCaseToken(length = CASE_ID_LENGTH) {
  const out = [];

  for (let i = 0; i < length; i += 1) {
    const idx = Math.floor(Math.random() * CASE_ALPHABET.length);
    out.push(CASE_ALPHABET[idx]);
  }

  return out.join("");
}

function createCaseId() {
  return randomCaseToken(CASE_ID_LENGTH);
}

export async function createCaseRecordD1(DB, payload) {
  if (!DB || typeof DB.prepare !== "function" || !payload || typeof payload !== "object") {
    return null;
  }

  const nowIso = new Date().toISOString();

  for (let i = 0; i < MAX_CASE_ID_ATTEMPTS; i += 1) {
    const caseId = createCaseId();

    try {
      const result = await DB
        .prepare(`
          INSERT INTO username_surveillance_case_records (
            case_id,
            schema_version,
            chat_id,
            offender_user_id,
            chat_title,
            message_id,
            message_thread_id,
            message_date,
            reason,
            action_json,
            offender_json,
            evidence_json,
            created_at,
            updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `)
        .bind(
          caseId,
          1,
          Number(payload.chat_id || 0),
          Number(payload.offender?.id || 0),
          String(payload.chat_title || ""),
          Number(payload.message_id || 0),
          payload.message_thread_id == null ? null : Number(payload.message_thread_id),
          payload.message_date || null,
          String(payload.reason || ""),
          JSON.stringify(payload.action || {}),
          JSON.stringify(payload.offender || {}),
          JSON.stringify(payload.evidence || {}),
          nowIso,
          nowIso
        )
        .run();

      if (!result?.success) {
        continue;
      }

      return {
        schema_version: 1,
        case_id: caseId,
        chat_id: Number(payload.chat_id || 0),
        offender_user_id: Number(payload.offender?.id || 0),
        chat_title: String(payload.chat_title || ""),
        message_id: Number(payload.message_id || 0),
        message_thread_id: payload.message_thread_id == null ? null : Number(payload.message_thread_id),
        message_date: payload.message_date || null,
        reason: String(payload.reason || ""),
        action: payload.action || {},
        offender: payload.offender || {},
        evidence: payload.evidence || {},
        created_at: nowIso,
        updated_at: nowIso
      };
    } catch (err) {
      const message = String(err?.message || err || "").toLowerCase();

      if (message.includes("unique") || message.includes("constraint")) {
        continue;
      }

      console.log("D1 CASE CREATE FAILED:", err?.stack || err?.message || String(err));
      return null;
    }
  }

  console.log("D1 CASE CREATE FAILED: unable to allocate unique case id");
  return null;
}
