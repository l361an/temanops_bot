// identityTracker.js

import { safeJSON, safeKVGet, safeKVPut, safeKVDelete } from "./kv.js";
import { tg } from "./telegram.js";
import { getTemanOpsTitle } from "./status.js";
import { escapeBasicMarkdown } from "./utils.js";

function trackerTargetKey(chatId) {
  return `temanops_identity_target:${chatId}`;
}

function identitySnapshotKey(userId) {
  return `identity:snapshot:${Number(userId)}`;
}

function identityHistoryKey(userId) {
  return `identity:history:${Number(userId)}`;
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

function describeChange(change) {
  if (!change) return null;

  if (change.field === "username") {
    return `• Username: ${formatUsernameValue(change.old_value)} → ${formatUsernameValue(change.new_value)}`;
  }

  if (change.field === "first_name") {
    return `• Nama depan: ${formatPlainValue(change.old_value)} → ${formatPlainValue(change.new_value)}`;
  }

  if (change.field === "last_name") {
    return `• Nama belakang: ${formatPlainValue(change.old_value)} → ${formatPlainValue(change.new_value)}`;
  }

  return null;
}

function buildIdentityMessage(groupTitle, userId, changes) {
  const lines = changes.map(describeChange).filter(Boolean).join("\n");

  return `🕵️ *IDENTITY UPDATE*

🏠 Group: ${escapeBasicMarkdown(groupTitle || "Unknown Group")}
🆔 User ID: \`${userId}\`
🙋 Profil: [klik buka profil](tg://user?id=${userId})

${lines}`;
}

async function readSnapshot(KV, userId) {
  return safeJSON(await safeKVGet(KV, identitySnapshotKey(userId)), null);
}

async function writeSnapshot(KV, snapshot) {
  return safeKVPut(
    KV,
    identitySnapshotKey(snapshot.id),
    JSON.stringify(snapshot)
  );
}

async function appendHistory(KV, userId, entry, maxItems = 30) {
  const key = identityHistoryKey(userId);
  const current = safeJSON(await safeKVGet(KV, key), []);
  const list = Array.isArray(current) ? current : [];

  list.unshift(entry);

  return safeKVPut(
    KV,
    key,
    JSON.stringify(list.slice(0, maxItems))
  );
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

export async function getIdentityHistory(KV, userId) {
  const data = safeJSON(await safeKVGet(KV, identityHistoryKey(userId)), []);
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
    const prevSnapshot = await readSnapshot(KV, userId);

    if (!prevSnapshot?.id) {
      await writeSnapshot(KV, nextSnapshot);
      return true;
    }

    const changes = compareIdentitySnapshot(prevSnapshot, nextSnapshot);

    if (!changes.length) {
      await writeSnapshot(KV, nextSnapshot);
      return true;
    }

    const title = await getTemanOpsTitle(KV, groupId);
    const text = buildIdentityMessage(title, userId, changes);

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

    await appendHistory(KV, userId, entry);
    await writeSnapshot(KV, nextSnapshot);

    return true;
  } catch (err) {
    console.log("AUDIT IDENTITY TRACKER FAILED:", err?.message || err);
    return false;
  }
}
