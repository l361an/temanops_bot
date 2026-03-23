// identityTracker.js

import { safeJSON, safeKVGet, safeKVPut, safeKVDelete } from "./kv.js";
import { tg } from "./telegram.js";
import { getTemanOpsTitle } from "./status.js";
import { escapeBasicMarkdown } from "./utils.js";

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

function formatPlainValue(value) {
  const text = String(value || "").trim();
  return text ? escapeBasicMarkdown(text) : "-";
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

async function readSnapshot(KV, chatId, userId) {
  const scoped = safeJSON(
    await safeKVGet(KV, identitySnapshotKey(chatId, userId)),
    null
  );

  if (scoped?.id) return scoped;

  return safeJSON(await safeKVGet(KV, legacyIdentitySnapshotKey(userId)), null);
}

async function writeSnapshot(KV, chatId, snapshot) {
  return safeKVPut(
    KV,
    identitySnapshotKey(chatId, snapshot.id),
    JSON.stringify(snapshot)
  );
}

async function readRecentSignal(KV, chatId, userId) {
  return safeJSON(
    await safeKVGet(KV, identityRecentSignalKey(chatId, userId)),
    null
  );
}

async function writeRecentSignal(KV, chatId, userId, signature) {
  return safeKVPut(
    KV,
    identityRecentSignalKey(chatId, userId),
    JSON.stringify({
      signature,
      detected_at: new Date().toISOString()
    })
  );
}

async function appendHistory(KV, chatId, userId, entry, maxItems = 30) {
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

export async function getIdentityHistory(KV, userId, chatId = null) {
  const key = chatId
    ? identityHistoryKey(chatId, userId)
    : legacyIdentityHistoryKey(userId);

  const data = safeJSON(await safeKVGet(KV, key), []);
  return Array.isArray(data) ? data : [];
}

export async function auditIdentityTracker(API, KV, chatId, user, source = "message") {
  try {
    const groupId = Number(chatId);
    const userId = Number(user?.id);

    if (!groupId || !userId || user?.is_bot) return false;

    const target = await getIdentityTrackerTarget(KV, groupId);
    if (!target?.chat_id) return false;

    const nextSnapshot = buildSnapshot(user);
    const prevSnapshot = await readSnapshot(KV, groupId, userId);

    if (!prevSnapshot?.id) {
      await writeSnapshot(KV, groupId, nextSnapshot);
      return true;
    }

    const changes = compareIdentitySnapshot(prevSnapshot, nextSnapshot);

    if (!changes.length) {
      return true;
    }

    const signature = buildChangeSignature(nextSnapshot, changes);
    const recent = await readRecentSignal(KV, groupId, userId);

    if (isRecentDuplicateSignal(recent, signature)) {
      await writeSnapshot(KV, groupId, nextSnapshot);
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
      appendHistory(KV, groupId, userId, entry),
      writeSnapshot(KV, groupId, nextSnapshot),
      writeRecentSignal(KV, groupId, userId, signature)
    ]);

    return true;
  } catch (err) {
    console.log("AUDIT IDENTITY TRACKER FAILED:", err?.message || err);
    return false;
  }
}
