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

export async function auditUsernameSurveillance(API, KV, chatId, user) {
  try {
    const groupId = Number(chatId);
    const userId = Number(user?.id);

    if (!groupId || !userId || user?.is_bot) return false;

    const target = await getUsernameWatchTarget(KV, groupId);
    if (!target?.chat_id) return false;

    const hasUsername = !!String(user?.username || "").trim();

    if (hasUsername) {
      await clearUserWatchCard(API, KV, groupId, userId);
      return true;
    }

    const existing = safeJSON(await safeKVGet(KV, watchCardKey(groupId, userId)), null);
    const sameTarget =
      existing?.message_id &&
      Number(existing.chat_id) === Number(target.chat_id) &&
      Number(existing.thread_id || 0) === Number(target.thread_id || 0);

    if (sameTarget) {
      return true;
    }

    if (existing?.message_id) {
      await deleteWatchMessage(API, existing.chat_id, existing.message_id);
      await safeKVDelete(KV, watchCardKey(groupId, userId));
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

    await safeKVPut(
      KV,
      watchCardKey(groupId, userId),
      JSON.stringify({
        chat_id: Number(target.chat_id),
        thread_id: target.thread_id ? Number(target.thread_id) : null,
        message_id: Number(messageId)
      })
    );

    return true;
  } catch (err) {
    console.log("AUDIT USERNAME SURVEILLANCE FAILED:", err?.message || err);
    return false;
  }
}

export async function clearUserWatchCard(API, KV, chatId, userId) {
  try {
    const raw = await safeKVGet(KV, watchCardKey(chatId, userId));
    const data = safeJSON(raw, null);

    if (data?.chat_id && data?.message_id) {
      await deleteWatchMessage(API, data.chat_id, data.message_id);
    }

    await safeKVDelete(KV, watchCardKey(chatId, userId));
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
