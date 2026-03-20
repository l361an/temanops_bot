// status.js

import { GROUP_ID } from "./config.js";
import { getSafeNumber, escapeBasicMarkdown } from "./utils.js";
import { safeKVGet, safeKVPut, send, getGroupKV } from "./kv.js";
import { mute } from "./moderation.js";

export async function shouldRunModeration(KV, chatId) {
  const n = Number(chatId);
  if (!n) return false;
  if (n === Number(GROUP_ID)) return true;
  return await isTemanOpsEnabled(KV, n);
}

export async function setTemanOpsEnabled(KV, chatId, enabled) {
  await safeKVPut(KV, `temanops_enabled:${chatId}`, enabled ? "1" : "0");
  await safeKVPut(KV, `temanops_group_registry:${chatId}`, "1");
  return true;
}

export async function isTemanOpsEnabled(KV, chatId) {
  if (Number(chatId) === Number(GROUP_ID)) return true;
  const val = await safeKVGet(KV, `temanops_enabled:${chatId}`);
  return val === "1";
}

export async function getTemanOpsTitle(KV, chatId) {
  return (
    await safeKVGet(KV, `temanops_title:${chatId}`)
  ) || (Number(chatId) === Number(GROUP_ID) ? "Legacy Group" : String(chatId));
}

export async function setGroupLogTarget(KV, sourceChatId, targetChatId, threadId) {
  return safeKVPut(
    KV,
    `temanops_log_target:${sourceChatId}`,
    JSON.stringify({
      chat_id: Number(targetChatId),
      thread_id: threadId ? Number(threadId) : null
    })
  );
}

export async function getGroupLogTarget(KV, sourceChatId) {
  const raw = await safeKVGet(KV, `temanops_log_target:${sourceChatId}`);
  let data = null;

  try {
    data = raw ? JSON.parse(raw) : null;
  } catch {
    data = null;
  }

  if (data?.chat_id) {
    return {
      chat_id: Number(data.chat_id),
      thread_id: data.thread_id ? Number(data.thread_id) : undefined
    };
  }

  return {
    chat_id: Number(sourceChatId),
    thread_id: undefined
  };
}

export async function listTemanOpsGroups(KV) {
  const groups = [];
  let cursor = undefined;

  try {
    do {
      const page = await KV.list({
        prefix: "temanops_group_registry:",
        cursor
      });

      for (const key of page.keys || []) {
        const rawId = String(key.name || "").replace("temanops_group_registry:", "");
        const chatId = Number(rawId);
        if (!chatId) continue;

        const enabled = await isTemanOpsEnabled(KV, chatId);
        const title = await getTemanOpsTitle(KV, chatId);

        groups.push({
          chat_id: chatId,
          title,
          enabled
        });
      }

      cursor = page.list_complete ? undefined : page.cursor;
    } while (cursor);

    groups.sort((a, b) => {
      if (a.enabled !== b.enabled) return a.enabled ? -1 : 1;
      return String(a.title || "").localeCompare(String(b.title || ""));
    });

    return groups;
  } catch (err) {
    console.log("LIST TEMANOPS GROUPS FAILED:", err?.message || err);
    return [];
  }
}

export async function getTemanOpsGroupSummary(KV, chatId) {
  const title = await getTemanOpsTitle(KV, chatId);
  const enabled = await isTemanOpsEnabled(KV, chatId);
  const logTarget = await getGroupLogTarget(KV, chatId);

  return {
    chat_id: Number(chatId),
    title,
    enabled,
    log_label: logTarget?.thread_id ? `Topic ID ${logTarget.thread_id}` : "General"
  };
}

export async function punish(API, msg, KV, reason) {
  const chatId = Number(msg.chat.id);
  const min = getSafeNumber(await getGroupKV(KV, chatId, "mute_minutes"), 60);

  await mute(API, chatId, msg.from.id, min);

  const title = await getTemanOpsTitle(KV, chatId);
  const logTarget = await getGroupLogTarget(KV, chatId);
  const offenderUsername = msg.from.username ? `@${msg.from.username}` : "-";

  const logText =
`📋 *LOG PELANGGARAN*

🏠 ${escapeBasicMarkdown(title || String(chatId))}
👤 ${escapeBasicMarkdown(msg.from.first_name || "-")}
🔗 ${escapeBasicMarkdown(offenderUsername)}
🆔 ${msg.from.id}

🚫 *Alasan*
${escapeBasicMarkdown(reason)}

⏱️ *Hukuman*
Mute ${min} menit

🕊️ *Remisi*
Hubungi admin group`;

  await send(
    API,
    Number(logTarget.chat_id || chatId),
    logText,
    logTarget.thread_id
  );
}
