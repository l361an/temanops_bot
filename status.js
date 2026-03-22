// status.js

import { GROUP_ID } from "./config.js";
import { getSafeNumber, escapeBasicMarkdown } from "./utils.js";
import {
  safeKVGet,
  safeKVPut,
  send,
  getGroupKV,
  createCaseRecord
} from "./kv.js";
import { mute } from "./moderation.js";

function detectContentType(msg) {
  if (typeof msg?.text === "string" && msg.text.trim()) return "text";
  if (typeof msg?.caption === "string" && msg.caption.trim()) {
    if (msg.photo?.length) return "photo_caption";
    if (msg.video?.file_id) return "video_caption";
    if (msg.animation?.file_id) return "animation_caption";
    if (msg.document?.file_id) return "document_caption";
    return "caption";
  }
  if (msg.photo?.length) return "photo";
  if (msg.video?.file_id) return "video";
  if (msg.animation?.file_id) return "animation";
  if (msg.document?.file_id) return "document";
  if (msg.sticker?.file_id) return "sticker";
  if (msg.voice?.file_id) return "voice";
  if (msg.video_note?.file_id) return "video_note";
  return "unknown";
}

function truncateCaseText(value, max = 2000) {
  const text = String(value || "").trim();
  if (!text) return "";
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1)}…`;
}

function getEvidenceText(msg) {
  if (typeof msg?.text === "string" && msg.text.trim()) {
    return msg.text.trim();
  }

  if (typeof msg?.caption === "string" && msg.caption.trim()) {
    return msg.caption.trim();
  }

  return "";
}

function collectEntityTypes(msg) {
  const entities = [
    ...(Array.isArray(msg?.entities) ? msg.entities : []),
    ...(Array.isArray(msg?.caption_entities) ? msg.caption_entities : [])
  ];

  return [...new Set(entities.map((x) => String(x?.type || "").trim()).filter(Boolean))];
}

function buildCasePayload(msg, title, reason, muteMinutes, muteOk) {
  const offenderId = Number(msg?.from?.id || 0);
  const threadId = msg?.message_thread_id ? Number(msg.message_thread_id) : null;
  const messageDate = Number(msg?.date || 0);
  const evidenceText = truncateCaseText(getEvidenceText(msg), 2000);

  return {
    chat_id: Number(msg?.chat?.id || 0),
    chat_title: String(title || msg?.chat?.title || msg?.chat?.id || "-"),
    message_id: Number(msg?.message_id || 0),
    message_thread_id: threadId,
    message_date: messageDate ? new Date(messageDate * 1000).toISOString() : null,
    reason: String(reason || "-"),
    action: {
      type: "mute",
      minutes: Number(muteMinutes || 0),
      ok: !!muteOk
    },
    offender: {
      id: offenderId,
      first_name: String(msg?.from?.first_name || ""),
      username: String(msg?.from?.username || ""),
      language_code: String(msg?.from?.language_code || "")
    },
    evidence: {
      content_type: detectContentType(msg),
      text: evidenceText,
      entity_types: collectEntityTypes(msg),
      has_media: !!(
        msg?.photo?.length ||
        msg?.video?.file_id ||
        msg?.animation?.file_id ||
        msg?.document?.file_id ||
        msg?.sticker?.file_id ||
        msg?.voice?.file_id ||
        msg?.video_note?.file_id
      )
    }
  };
}

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
  const chatId = Number(msg?.chat?.id || 0);
  const offenderId = Number(msg?.from?.id || 0);
  if (!chatId || !offenderId) {
    console.log("PUNISH FAILED: missing chatId or offenderId");
    return { case_id: null, mute_ok: false };
  }

  const min = getSafeNumber(await getGroupKV(KV, chatId, "mute_minutes"), 60);
  const muteOk = await mute(API, chatId, offenderId, min);

  const title = await getTemanOpsTitle(KV, chatId);
  const logTarget = await getGroupLogTarget(KV, chatId);
  const offenderUsername = msg?.from?.username ? `@${msg.from.username}` : "-";

  const caseRecord = await createCaseRecord(
    KV,
    buildCasePayload(msg, title, reason, min, muteOk)
  );

  if (!caseRecord) {
    console.log(
      "CASE SAVE FAILED:",
      JSON.stringify({
        chat_id: chatId,
        message_id: Number(msg?.message_id || 0),
        offender_id: offenderId,
        reason: String(reason || "")
      })
    );
  }

  const punishmentText = muteOk ? `Mute ${min} menit` : "Mute gagal - cek izin bot";
  const caseSection = caseRecord?.case_id
    ? `\n\n🗂️ *Case ID*\n\`${caseRecord.case_id}\``
    : "\n\n⚠️ *Case detail gagal disimpan*";

  const logText =
`📋 *LOG PELANGGARAN*

🏠 ${escapeBasicMarkdown(title || String(chatId))}
👤 ${escapeBasicMarkdown(msg?.from?.first_name || "-")}
🔗 ${escapeBasicMarkdown(offenderUsername)}
🆔 ${offenderId}

🚫 *Alasan*
${escapeBasicMarkdown(reason)}

⏱️ *Hukuman*
${escapeBasicMarkdown(punishmentText)}

🕊️ *Remisi*
Hubungi admin group${caseSection}`;

  await send(
    API,
    Number(logTarget.chat_id || chatId),
    logText,
    logTarget.thread_id
  );

  return {
    case_id: caseRecord?.case_id || null,
    mute_ok: muteOk
  };
}
