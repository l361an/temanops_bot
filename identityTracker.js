// identityTracker.js
import { safeJSON, safeKVGet, safeKVPut, safeKVDelete } from "./kv.js";
import { tg } from "./telegram.js";
import { getTemanOpsTitle } from "./status.js";
import { escapeBasicMarkdown } from "./utils.js";

function hasD1(DB) {
  return !!DB && typeof DB.prepare === "function";
}

function trackerTargetKey(chatId) {
  return `temanops_identity_target:${chatId}`;
}

function identitySnapshotKey(chatId, userId) {
  return `identity:snapshot:${Number(chatId)}:${Number(userId)}`;
}

function legacyIdentitySnapshotKey(userId) {
  return `identity:snapshot:${Number(userId)}`;
}

function identityHistoryKey(chatId, userId) {
  return `identity:history:${Number(chatId)}:${Number(userId)}`;
}

function legacyIdentityHistoryKey(userId) {
  return `identity:history:${Number(userId)}`;
}

function identityRecentSignalKey(chatId, userId) {
  return `identity:recent:${Number(chatId)}:${Number(userId)}`;
}

function normalizeUsername(value) {
  return String(value || "")
    .trim()
    .replace(/^@+/, "")
    .toLowerCase();
}

function normalizeName(value) {
  return String(value || "").trim();
}

function buildSnapshot(user) {
  return {
    id: Number(user?.id || 0),
    username: normalizeUsername(user?.username),
    first_name: normalizeName(user?.first_name),
    last_name: normalizeName(user?.last_name),
    updated_at: new Date().toISOString()
  };
}

function compareField(field, prev, next) {
  const oldValue = String(prev?.[field] || "").trim();
  const newValue = String(next?.[field] || "").trim();

  if (oldValue === newValue) return null;

  return {
    field,
    old_value: oldValue,
    new_value: newValue
  };
}

function compareIdentitySnapshot(prev, next) {
  const out = [];

  const usernameChange = compareField("username", prev, next);
  const firstNameChange = compareField("first_name", prev, next);
  const lastNameChange = compareField("last_name", prev, next);

  if (usernameChange) out.push(usernameChange);
  if (firstNameChange) out.push(firstNameChange);
  if (lastNameChange) out.push(lastNameChange);

  return out;
}

function formatUsernameValue(value) {
  const text = String(value || "").trim().replace(/^@+/, "");
  return text ? `@${escapeBasicMarkdown(text)}` : "-";
}

function buildFullName(firstName, lastName) {
  const first = String(firstName || "").trim();
  const last = String(lastName || "").trim();
  return [first, last].filter(Boolean).join(" ").trim();
}

function formatFullName(firstName, lastName) {
  const fullName = buildFullName(firstName, lastName);
  return fullName ? escapeBasicMarkdown(fullName) : "-";
}

function getChangeMap(changes) {
  const map = {};
  for (const change of changes || []) {
    if (change?.field) {
      map[change.field] = change;
    }
  }
  return map;
}

function formatDateDDMMYY(dateLike) {
  const d = new Date(dateLike || Date.now());
  const dd = String(d.getDate()).padStart(2, "0");
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const yy = String(d.getFullYear()).slice(-2);
  return `${dd}/${mm}/${yy}`;
}

function buildChangeSignature(nextSnapshot, changes) {
  const fields = (changes || [])
    .map((item) => String(item?.field || "").trim())
    .filter(Boolean)
    .sort();

  return JSON.stringify({
    fields,
    username: String(nextSnapshot?.username || ""),
    first_name: String(nextSnapshot?.first_name || ""),
    last_name: String(nextSnapshot?.last_name || "")
  });
}

function isRecentDuplicateSignal(recent, signature, windowMs = 90 * 1000) {
  if (!recent?.signature || recent.signature !== signature) return false;

  const lastMs = new Date(recent.detected_at || 0).getTime();
  if (!Number.isFinite(lastMs) || lastMs <= 0) return false;

  const diff = Date.now() - lastMs;
  return diff >= 0 && diff <= windowMs;
}

function buildIdentityMessage(groupTitle, userId, prevSnapshot, nextSnapshot, changes) {
  const safeGroupTitle = escapeBasicMarkdown(groupTitle || "Unknown Group");
  const profileLink = `[🔗 Klik Buka Profil](tg://user?id=${userId})`;
  const footerDate = formatDateDDMMYY(nextSnapshot?.updated_at || Date.now());
  const changeMap = getChangeMap(changes);

  const namaBlock = changeMap.first_name || changeMap.last_name
    ? `${formatFullName(prevSnapshot?.first_name, prevSnapshot?.last_name)} -> ${formatFullName(nextSnapshot?.first_name, nextSnapshot?.last_name)}`
    : formatFullName(nextSnapshot?.first_name, nextSnapshot?.last_name);

  const usernameBlock = changeMap.username
    ? `${formatUsernameValue(changeMap.username.old_value)} -> ${formatUsernameValue(changeMap.username.new_value)}`
    : formatUsernameValue(nextSnapshot?.username);

  return `*🔔 UPDATE IDENTITAS*

👤 Nama :
${namaBlock}

🏷️ Username :
${usernameBlock}

${profileLink}
📍 ${safeGroupTitle} @${footerDate}`;
}

function mapHistoryRow(row) {
  return {
    detected_at: String(row?.detected_at || ""),
    detected_in_chat_id: Number(row?.chat_id || 0),
    source: String(row?.source || ""),
    changes: Array.isArray(safeJSON(row?.changes_json, []))
      ? safeJSON(row?.changes_json, [])
      : [],
    notified: !!Number(row?.notified || 0),
    target_chat_id: row?.target_chat_id != null ? Number(row.target_chat_id) : null,
    target_thread_id: row?.target_thread_id != null ? Number(row.target_thread_id) : null,
    target_message_id: row?.target_message_id != null ? Number(row.target_message_id) : null
  };
}

async function readSnapshotKV(KV, chatId, userId) {
  const scoped = safeJSON(
    await safeKVGet(KV, identitySnapshotKey(chatId, userId)),
    null
  );

  if (scoped?.id) return scoped;

  return safeJSON(await safeKVGet(KV, legacyIdentitySnapshotKey(userId)), null);
}

async function writeSnapshotKV(KV, chatId, snapshot) {
  return safeKVPut(
    KV,
    identitySnapshotKey(chatId, snapshot.id),
    JSON.stringify(snapshot)
  );
}

async function readRecentSignalKV(KV, chatId, userId) {
  return safeJSON(
    await safeKVGet(KV, identityRecentSignalKey(chatId, userId)),
    null
  );
}

async function writeRecentSignalKV(KV, chatId, userId, signature) {
  return safeKVPut(
    KV,
    identityRecentSignalKey(chatId, userId),
    JSON.stringify({
      signature,
      detected_at: new Date().toISOString()
    })
  );
}

async function appendHistoryKV(KV, chatId, userId, entry, maxItems = 30) {
  const scopedKey = identityHistoryKey(chatId, userId);
  const legacyKey = legacyIdentityHistoryKey(userId);

  const scopedCurrent = safeJSON(await safeKVGet(KV, scopedKey), []);
  const scopedList = Array.isArray(scopedCurrent) ? scopedCurrent : [];
  scopedList.unshift(entry);

  const legacyCurrent = safeJSON(await safeKVGet(KV, legacyKey), []);
  const legacyList = Array.isArray(legacyCurrent) ? legacyCurrent : [];
  legacyList.unshift(entry);

  await Promise.all([
    safeKVPut(KV, scopedKey, JSON.stringify(scopedList.slice(0, maxItems))),
    safeKVPut(KV, legacyKey, JSON.stringify(legacyList.slice(0, maxItems)))
  ]);
}

async function readSnapshotD1(DB, chatId, userId) {
  const row = await DB
    .prepare(`
      SELECT chat_id, user_id, username, first_name, last_name, updated_at
      FROM identity_tracker_snapshots
      WHERE chat_id = ? AND user_id = ?
      LIMIT 1
    `)
    .bind(Number(chatId), Number(userId))
    .first();

  if (!row?.user_id) return null;

  return {
    id: Number(row.user_id),
    username: normalizeUsername(row.username),
    first_name: normalizeName(row.first_name),
    last_name: normalizeName(row.last_name),
    updated_at: String(row.updated_at || "")
  };
}

async function writeSnapshotD1(DB, chatId, snapshot) {
  await DB
    .prepare(`
      INSERT INTO identity_tracker_snapshots (
        chat_id, user_id, username, first_name, last_name, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(chat_id, user_id) DO UPDATE SET
        username = excluded.username,
        first_name = excluded.first_name,
        last_name = excluded.last_name,
        updated_at = excluded.updated_at
    `)
    .bind(
      Number(chatId),
      Number(snapshot.id),
      normalizeUsername(snapshot.username),
      normalizeName(snapshot.first_name),
      normalizeName(snapshot.last_name),
      String(snapshot.updated_at || new Date().toISOString())
    )
    .run();

  return true;
}

async function readRecentSignalD1(DB, chatId, userId) {
  const row = await DB
    .prepare(`
      SELECT signature, detected_at
      FROM identity_tracker_recent_signals
      WHERE chat_id = ? AND user_id = ?
      LIMIT 1
    `)
    .bind(Number(chatId), Number(userId))
    .first();

  if (!row?.signature) return null;

  return {
    signature: String(row.signature || ""),
    detected_at: String(row.detected_at || "")
  };
}

async function writeRecentSignalD1(DB, chatId, userId, signature) {
  await DB
    .prepare(`
      INSERT INTO identity_tracker_recent_signals (
        chat_id, user_id, signature, detected_at
      ) VALUES (?, ?, ?, ?)
      ON CONFLICT(chat_id, user_id) DO UPDATE SET
        signature = excluded.signature,
        detected_at = excluded.detected_at
    `)
    .bind(
      Number(chatId),
      Number(userId),
      String(signature || ""),
      new Date().toISOString()
    )
    .run();

  return true;
}

async function appendHistoryD1(DB, chatId, userId, entry, maxItems = 30) {
  await DB
    .prepare(`
      INSERT INTO identity_tracker_history (
        chat_id,
        user_id,
        detected_at,
        source,
        changes_json,
        notified,
        target_chat_id,
        target_thread_id,
        target_message_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    .bind(
      Number(chatId),
      Number(userId),
      String(entry?.detected_at || new Date().toISOString()),
      String(entry?.source || ""),
      JSON.stringify(Array.isArray(entry?.changes) ? entry.changes : []),
      entry?.notified ? 1 : 0,
      entry?.target_chat_id != null ? Number(entry.target_chat_id) : null,
      entry?.target_thread_id != null ? Number(entry.target_thread_id) : null,
      entry?.target_message_id != null ? Number(entry.target_message_id) : null
    )
    .run();

  await DB
    .prepare(`
      DELETE FROM identity_tracker_history
      WHERE chat_id = ? AND user_id = ?
        AND id NOT IN (
          SELECT id
          FROM identity_tracker_history
          WHERE chat_id = ? AND user_id = ?
          ORDER BY detected_at DESC, id DESC
          LIMIT ?
        )
    `)
    .bind(
      Number(chatId),
      Number(userId),
      Number(chatId),
      Number(userId),
      Number(maxItems)
    )
    .run();

  return true;
}

async function getHistoryD1(DB, userId, chatId = null, limit = 30) {
  if (chatId != null) {
    const rows = await DB
      .prepare(`
        SELECT
          id,
          chat_id,
          user_id,
          detected_at,
          source,
          changes_json,
          notified,
          target_chat_id,
          target_thread_id,
          target_message_id
        FROM identity_tracker_history
        WHERE chat_id = ? AND user_id = ?
        ORDER BY detected_at DESC, id DESC
        LIMIT ?
      `)
      .bind(Number(chatId), Number(userId), Number(limit))
      .all();

    return Array.isArray(rows?.results)
      ? rows.results.map(mapHistoryRow)
      : [];
  }

  const rows = await DB
    .prepare(`
      SELECT
        id,
        chat_id,
        user_id,
        detected_at,
        source,
        changes_json,
        notified,
        target_chat_id,
        target_thread_id,
        target_message_id
      FROM identity_tracker_history
      WHERE user_id = ?
      ORDER BY detected_at DESC, id DESC
      LIMIT ?
    `)
    .bind(Number(userId), Number(limit))
    .all();

  return Array.isArray(rows?.results)
    ? rows.results.map(mapHistoryRow)
    : [];
}

async function readSnapshot(DB, KV, chatId, userId) {
  if (hasD1(DB)) {
    const d1 = await readSnapshotD1(DB, chatId, userId);
    if (d1?.id) return d1;
  }

  return readSnapshotKV(KV, chatId, userId);
}

async function writeSnapshot(DB, KV, chatId, snapshot) {
  if (hasD1(DB)) {
    return writeSnapshotD1(DB, chatId, snapshot);
  }

  return writeSnapshotKV(KV, chatId, snapshot);
}

async function readRecentSignal(DB, KV, chatId, userId) {
  if (hasD1(DB)) {
    const d1 = await readRecentSignalD1(DB, chatId, userId);
    if (d1?.signature) return d1;
  }

  return readRecentSignalKV(KV, chatId, userId);
}

async function writeRecentSignal(DB, KV, chatId, userId, signature) {
  if (hasD1(DB)) {
    return writeRecentSignalD1(DB, chatId, userId, signature);
  }

  return writeRecentSignalKV(KV, chatId, userId, signature);
}

async function appendHistory(DB, KV, chatId, userId, entry, maxItems = 30) {
  if (hasD1(DB)) {
    return appendHistoryD1(DB, chatId, userId, entry, maxItems);
  }

  return appendHistoryKV(KV, chatId, userId, entry, maxItems);
}

function resolveAuditArgs(a, b, c, d) {
  if (hasD1(a)) {
    return {
      DB: a,
      chatId: Number(b),
      user: c,
      source: d || "message"
    };
  }

  return {
    DB: null,
    chatId: Number(a),
    user: b,
    source: c || "message"
  };
}

function resolveHistoryArgs(a, b, c) {
  if (hasD1(a)) {
    return {
      DB: a,
      userId: Number(b),
      chatId: c != null ? Number(c) : null
    };
  }

  return {
    DB: null,
    userId: Number(a),
    chatId: b != null ? Number(b) : null
  };
}

export async function setIdentityTrackerTarget(KV, sourceChatId, targetChatId, threadId) {
  return safeKVPut(
    KV,
    trackerTargetKey(sourceChatId),
    JSON.stringify({
      chat_id: Number(targetChatId),
      thread_id: threadId ? Number(threadId) : null
    })
  );
}

export async function getIdentityTrackerTarget(KV, sourceChatId) {
  const raw = await safeKVGet(KV, trackerTargetKey(sourceChatId));
  const data = safeJSON(raw, null);

  if (!data?.chat_id) return null;

  return {
    chat_id: Number(data.chat_id),
    thread_id: data.thread_id ? Number(data.thread_id) : undefined
  };
}

export async function clearIdentityTrackerTarget(KV, sourceChatId) {
  return safeKVDelete(KV, trackerTargetKey(sourceChatId));
}

export async function getIdentityHistory(KV, a, b = null, c = null) {
  const { DB, userId, chatId } = resolveHistoryArgs(a, b, c);

  if (hasD1(DB)) {
    const list = await getHistoryD1(DB, userId, chatId, 30);
    if (list.length) return list;
  }

  const key = chatId != null
    ? identityHistoryKey(chatId, userId)
    : legacyIdentityHistoryKey(userId);

  const data = safeJSON(await safeKVGet(KV, key), []);
  return Array.isArray(data) ? data : [];
}

export async function auditIdentityTracker(API, KV, a, b, c, d) {
  try {
    const { DB, chatId, user, source } = resolveAuditArgs(a, b, c, d);

    const groupId = Number(chatId);
    const userId = Number(user?.id);

    if (!groupId || !userId || user?.is_bot) return false;

    const target = await getIdentityTrackerTarget(KV, groupId);
    if (!target?.chat_id) return false;

    const nextSnapshot = buildSnapshot(user);
    const prevSnapshot = await readSnapshot(DB, KV, groupId, userId);
    const currentD1Snapshot = hasD1(DB)
      ? await readSnapshotD1(DB, groupId, userId)
      : null;

    if (!prevSnapshot?.id) {
      await writeSnapshot(DB, KV, groupId, nextSnapshot);
      return true;
    }

    if (hasD1(DB) && !currentD1Snapshot?.id) {
      await writeSnapshotD1(DB, groupId, prevSnapshot);
    }

    const changes = compareIdentitySnapshot(prevSnapshot, nextSnapshot);

    if (!changes.length) {
      return true;
    }

    const signature = buildChangeSignature(nextSnapshot, changes);
    const recent = await readRecentSignal(DB, KV, groupId, userId);

    if (isRecentDuplicateSignal(recent, signature)) {
      await writeSnapshot(DB, KV, groupId, nextSnapshot);
      return true;
    }

    const title = await getTemanOpsTitle(KV, groupId);
    const text = buildIdentityMessage(title, userId, prevSnapshot, nextSnapshot, changes);

    const res = await tg(API, "sendMessage", {
      chat_id: Number(target.chat_id),
      text,
      parse_mode: "Markdown",
      disable_web_page_preview: true,
      message_thread_id: target.thread_id ? Number(target.thread_id) : undefined,
      is_topic_message: target.thread_id ? true : undefined
    });

    const entry = {
      detected_at: new Date().toISOString(),
      detected_in_chat_id: groupId,
      source,
      changes,
      notified: !!res?.result?.message_id,
      target_chat_id: Number(target.chat_id),
      target_thread_id: target.thread_id ? Number(target.thread_id) : null,
      target_message_id: res?.result?.message_id ? Number(res.result.message_id) : null
    };

    await Promise.all([
      appendHistory(DB, KV, groupId, userId, entry),
      writeSnapshot(DB, KV, groupId, nextSnapshot),
      writeRecentSignal(DB, KV, groupId, userId, signature)
    ]);

    return true;
  } catch (err) {
    console.log("AUDIT IDENTITY TRACKER FAILED:", err?.message || err);
    return false;
  }
}
