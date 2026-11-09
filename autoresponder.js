// autoresponder.js

import { tg } from "./telegram.js";
import { isTemanOpsEnabled } from "./status.js";
import { getGroupKV, safeJSON } from "./kv.js";

const RATE_LIMIT_MS = 60 * 1000;
const MAX_RESPONSES = 100;
const recentReplies = new Map();

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function normalizeKeyword(keyword) {
  return String(keyword || "").trim().replace(/\s+/g, " ");
}

export function buildPattern(keyword) {
  const normalized = normalizeKeyword(keyword);
  if (!normalized) return null;

  const parts = normalized.split(" ").map(escapeRegex);
  if (!parts.length || parts.some((p) => !p)) return null;

  return new RegExp(`\\b${parts.join("\\s+")}\\b`, "i");
}

export function normalizeAutoResponses(raw) {
  const arr = safeJSON(raw, []);
  if (!Array.isArray(arr)) return [];

  return arr
    .filter((x) => x && typeof x.keyword === "string" && typeof x.reply === "string")
    .map((x) => ({
      keyword: normalizeKeyword(x.keyword),
      reply: String(x.reply).trim()
    }))
    .filter((x) => x.keyword && x.reply)
    .slice(0, MAX_RESPONSES);
}

export async function getAutoResponses(KV, chatId) {
  return normalizeAutoResponses(await getGroupKV(KV, chatId, "autoresponses"));
}

export async function isAutoReplyEnabled(KV, chatId) {
  return String(await getGroupKV(KV, chatId, "autoreply_enabled")) === "1";
}

export function matchAutoResponse(list, text) {
  const haystack = String(text || "");
  if (!haystack) return null;

  for (const item of list) {
    const pattern = buildPattern(item.keyword);
    if (pattern && pattern.test(haystack)) return item;
  }
  return null;
}

export async function maybeAutoRespond(API, KV, msg) {
  try {
    if (!msg?.from || msg.from.is_bot) return false;
    if (!["group", "supergroup"].includes(msg.chat.type)) return false;
    if (msg.edit_date) return false;

    const text = String(msg.text || msg.caption || "").trim();
    if (!text || text.startsWith("/")) return false;

    const chatId = Number(msg.chat.id);
    if (!chatId) return false;

    if (!(await isTemanOpsEnabled(KV, chatId))) return false;
    if (!(await isAutoReplyEnabled(KV, chatId))) return false;

    const list = await getAutoResponses(KV, chatId);
    if (!list.length) return false;

    const matched = matchAutoResponse(list, text);
    if (!matched) return false;

    const userId = Number(msg.from.id || 0);
    const rateKey = `${chatId}:${userId}:${matched.keyword.toLowerCase()}`;
    const now = Date.now();
    const last = recentReplies.get(rateKey) || 0;
    if (now - last < RATE_LIMIT_MS) return false;
    recentReplies.set(rateKey, now);

    if (recentReplies.size > 2000) {
      for (const [k, ts] of recentReplies) {
        if (now - ts > RATE_LIMIT_MS * 10) recentReplies.delete(k);
      }
    }

    const threadId = msg.message_thread_id ? Number(msg.message_thread_id) : null;

    await tg(API, "sendMessage", {
      chat_id: chatId,
      text: matched.reply,
      reply_to_message_id: msg.message_id,
      allow_sending_without_reply: true,
      message_thread_id: threadId || undefined,
      is_topic_message: threadId ? true : undefined
    });

    return true;
  } catch (err) {
    console.log("AUTO RESPONDER FAILED:", err?.message || err);
    return false;
  }
}
