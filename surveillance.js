// surveillance.js

import { safeJSON, safeKVGet, safeKVPut, safeKVDelete } from "./kv.js";
import { tg } from "./telegram.js";
import { getTemanOpsTitle } from "./status.js";
import { escapeBasicMarkdown } from "./utils.js";

function watchTargetKey(chatId) {
  return `temanops_watch_target:${chatId}`;
}

function watchCardKey(chatId, userId) {
  return `temanops_watch_card:${chatId}:${userId}`;
}

function canUseDb(DB) {
  return !!DB && typeof DB.prepare === "function";
}

function normalizeWatchCard(data) {
  if (!data?.chat_id || !data?.message_id) return null;

  return {
    chat_id: Number(data.chat_id),
    thread_id: data.thread_id ? Number(data.thread_id) : null,
    message_id: Number(data.message_id)
  };
}

function normalizeUserText(value) {
  return String(value || "").trim();
}

function normalizeHistoryUser(user) {
  return {
    username: normalizeUserText(user?.username),
    first_name: normalizeUserText(user?.first_name),
    last_name: normalizeUserText(user?.last_name)
  };
}

async function recordWatchHistory(DB, payload) {
  if (!canUseDb(DB)) return false;

  const user = normalizeHistoryUser(payload?.user);

  try {
    await DB
      .prepare(
        "INSERT INTO username_surveillance_history (source_chat_id, user_id, event_type, reason, target_chat_id, target_thread_id, target_message_id, username, first_name, last_name, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
      )
      .bind(
        Number(payload?.source_chat_id),
        Number(payload?.user_id),
        String(payload?.event_type || ""),
        String(payload?.reason || ""),
        payload?.target_chat_id != null ? Number(payload.target_chat_id) : null,
        payload?.target_thread_id != null ? Number(payload.target_thread_id) : null,
        payload?.target_message_id != null ? Number(payload.target_message_id) : null,
        user.username,
        user.first_name,
        user.last_name,
        new Date().toISOString()
      )
      .run();

    return true;
  } catch (err) {
    console.log("WATCH HISTORY WRITE D1 FAILED:", err?.message || err);
    return false;
  }
}

async function readWatchCardFromDb(DB, chatId, userId) {
  if (!canUseDb(DB)) return null;

  const row = await DB
    .prepare(
      "SELECT target_chat_id, target_thread_id, target_message_id FROM username_surveillance_cards WHERE source_chat_id = ? AND user_id = ? LIMIT 1"
    )
    .bind(Number(chatId), Number(userId))
    .first();

  return normalizeWatchCard({
    chat_id: row?.target_chat_id,
    thread_id: row?.target_thread_id,
    message_id: row?.target_message_id
  });
}

async function writeWatchCardToDb(DB, chatId, userId, card) {
  if (!canUseDb(DB)) return false;

  await DB
    .prepare(
      "INSERT INTO username_surveillance_cards (source_chat_id, user_id, target_chat_id, target_thread_id, target_message_id, updated_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(source_chat_id, user_id) DO UPDATE SET target_chat_id = excluded.target_chat_id, target_thread_id = excluded.target_thread_id, target_message_id = excluded.target_message_id, updated_at = excluded.updated_at"
    )
    .bind(
      Number(chatId),
      Number(userId),
      Number(card.chat_id),
      card.thread_id ? Number(card.thread_id) : null,
      Number(card.message_id),
      new Date().toISOString()
    )
    .run();

  return true;
}

async function deleteWatchCardFromDb(DB, chatId, userId) {
  if (!canUseDb(DB)) return false;

  await DB
    .prepare("DELETE FROM username_surveillance_cards WHERE source_chat_id = ? AND user_id = ?")
    .bind(Number(chatId), Number(userId))
    .run();

  return true;
}

async function getStoredWatchCard(KV, DB, chatId, userId) {
  if (canUseDb(DB)) {
    try {
      return await readWatchCardFromDb(DB, chatId, userId);
    } catch (err) {
      console.log("WATCH CARD READ D1 FAILED:", err?.message || err);
    }
  }

  return normalizeWatchCard(
    safeJSON(await safeKVGet(KV, watchCardKey(chatId, userId)), null)
  );
}

async function saveStoredWatchCard(KV, DB, chatId, userId, card) {
  if (canUseDb(DB)) {
    try {
      await writeWatchCardToDb(DB, chatId, userId, card);
      return true;
    } catch (err) {
      console.log("WATCH CARD WRITE D1 FAILED:", err?.message || err);
    }
  }

  await safeKVPut(KV, watchCardKey(chatId, userId), JSON.stringify(card));
  return true;
}

async function clearStoredWatchCard(KV, DB, chatId, userId) {
  if (canUseDb(DB)) {
    try {
      await deleteWatchCardFromDb(DB, chatId, userId);
      return true;
    } catch (err) {
      console.log("WATCH CARD DELETE D1 FAILED:", err?.message || err);
    }
  }

  await safeKVDelete(KV, watchCardKey(chatId, userId));
  return true;
}

export async function setUsernameWatchTarget(KV, sourceChatId, targetChatId, threadId) {
  return safeKVPut(
    KV,
    watchTargetKey(sourceChatId),
    JSON.stringify({
      chat_id: Number(targetChatId),
      thread_id: threadId ? Number(threadId) : null
    })
  );
}

export async function getUsernameWatchTarget(KV, sourceChatId) {
  const raw = await safeKVGet(KV, watchTargetKey(sourceChatId));
  const data = safeJSON(raw, null);

  if (!data?.chat_id) return null;

  return {
    chat_id: Number(data.chat_id),
    thread_id: data.thread_id ? Number(data.thread_id) : undefined
  };
}

export async function clearUsernameWatchTarget(KV, sourceChatId) {
  return safeKVDelete(KV, watchTargetKey(sourceChatId));
}

export async function auditUsernameSurveillance(API, KV, DB, chatId, user) {
  try {
    const groupId = Number(chatId);
    const userId = Number(user?.id);

    if (!groupId || !userId || user?.is_bot) return false;

    const target = await getUsernameWatchTarget(KV, groupId);
    if (!target?.chat_id) return false;

    const hasUsername = !!String(user?.username || "").trim();

    if (hasUsername) {
      await clearUserWatchCard(API, KV, DB, groupId, userId, {
        reason: "username_present",
        user
      });
      return true;
    }

    const existing = await getStoredWatchCard(KV, DB, groupId, userId);
    const sameTarget =
      existing?.message_id &&
      Number(existing.chat_id) === Number(target.chat_id) &&
      Number(existing.thread_id || 0) === Number(target.thread_id || 0);

    if (sameTarget) {
      return true;
    }

    if (existing?.message_id) {
      await clearUserWatchCard(API, KV, DB, groupId, userId, {
        reason: "retarget",
        user
      });
    }

    const title = await getTemanOpsTitle(KV, groupId);
    const displayName = [user?.first_name || "", user?.last_name || ""].join(" ").trim() || "User";
    const text =
`🚨 *DALAM PENGAWASAN TEMAN*

🏠 Group: ${escapeBasicMarkdown(title)}
🆔 User ID: \`${userId}\`
👤 Nama: ${escapeBasicMarkdown(displayName)}
🔗 Username: -
🙋 Profil: [klik buka profil](tg://user?id=${userId})

ℹ️ User ini belum memasang username.
ℹ️ Kartu ini akan dihapus otomatis kalau user sudah pasang username.`;

    const res = await tg(API, "sendMessage", {
      chat_id: Number(target.chat_id),
      text,
      parse_mode: "Markdown",
      disable_web_page_preview: true,
      message_thread_id: target.thread_id ? Number(target.thread_id) : undefined,
      is_topic_message: target.thread_id ? true : undefined
    });

    const messageId = res?.result?.message_id;
    if (!messageId) return false;

    const storedCard = {
      chat_id: Number(target.chat_id),
      thread_id: target.thread_id ? Number(target.thread_id) : null,
      message_id: Number(messageId)
    };

    await saveStoredWatchCard(KV, DB, groupId, userId, storedCard);

    await recordWatchHistory(DB, {
      source_chat_id: groupId,
      user_id: userId,
      event_type: "card_created",
      reason: "missing_username",
      target_chat_id: storedCard.chat_id,
      target_thread_id: storedCard.thread_id,
      target_message_id: storedCard.message_id,
      user
    });

    return true;
  } catch (err) {
    console.log("AUDIT USERNAME SURVEILLANCE FAILED:", err?.message || err);
    return false;
  }
}

export async function clearUserWatchCard(API, KV, DB, chatId, userId, context = {}) {
  try {
    const data = await getStoredWatchCard(KV, DB, chatId, userId);

    if (data?.chat_id && data?.message_id) {
      await deleteWatchMessage(API, data.chat_id, data.message_id);
    }

    await clearStoredWatchCard(KV, DB, chatId, userId);

    if (data?.chat_id && data?.message_id) {
      await recordWatchHistory(DB, {
        source_chat_id: Number(chatId),
        user_id: Number(userId),
        event_type: "card_deleted",
        reason: String(context?.reason || ""),
        target_chat_id: Number(data.chat_id),
        target_thread_id: data.thread_id ? Number(data.thread_id) : null,
        target_message_id: Number(data.message_id),
        user: context?.user
      });
    }

    return true;
  } catch (err) {
    console.log("CLEAR USER WATCH CARD FAILED:", err?.message || err);
    return false;
  }
}

async function deleteWatchMessage(API, chatId, messageId) {
  return tg(API, "deleteMessage", {
    chat_id: Number(chatId),
    message_id: Number(messageId)
  });
}
