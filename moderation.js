// moderation.js

import { LINK_REGEX, floodMap } from "./config.js";
import { isAdmin } from "./permissions.js";
import { getGroupKV, del, safeJSON } from "./kv.js";
import { punish } from "./status.js";

export async function handleModeration(API, msg, KV) {
  try {
    const admin = await isAdmin(API, msg.chat.id, msg.from.id);
    if (admin) return;

    if (await isFlood(API, msg, KV)) return;

    const content = getMessageContent(msg);
    if (!content) return;

    const text = content.toLowerCase();
    const groupId = Number(msg.chat.id);

    if (LINK_REGEX.test(text)) {
      LINK_REGEX.lastIndex = 0;
      const allowed = await linkAllowed(text, KV, groupId);

      if (!allowed) {
        await del(API, msg.chat.id, msg.message_id);
        await punish(API, msg, KV, "Mengirim link terlarang");
        return;
      }
    }
    LINK_REGEX.lastIndex = 0;

    const banned = String(await getGroupKV(KV, groupId, "banned_words"))
      .split(",")
      .map(x => x.trim().toLowerCase())
      .filter(Boolean);

    for (const w of banned) {
      if (w && text.includes(w)) {
        await del(API, msg.chat.id, msg.message_id);
        await punish(API, msg, KV, "Menggunakan kata terlarang");
        return;
      }
    }
  } catch (err) {
    console.log("MODERATION ERROR:", err?.message || err);
  }
}

export function getMessageContent(msg) {
  if (typeof msg.text === "string" && msg.text.trim()) return msg.text;
  if (typeof msg.caption === "string" && msg.caption.trim()) return msg.caption;
  return "";
}

export async function isFlood(API, msg, KV) {
  const userId = msg.from?.id;
  const groupId = Number(msg.chat.id);
  if (!userId || !groupId) return false;

  const key = `${groupId}:${userId}`;
  const now = Date.now();
  const limit = Number(await getGroupKV(KV, groupId, "flood_limit")) || 5;
  const win = (Number(await getGroupKV(KV, groupId, "flood_window")) || 10) * 1000;

  floodMap[key] = (floodMap[key] || []).filter(t => now - t < win);
  floodMap[key].push(now);

  if (floodMap[key].length >= limit) {
    floodMap[key] = [];
    await del(API, msg.chat.id, msg.message_id);
    await punish(API, msg, KV, "Flood / Spam");
    return true;
  }

  return false;
}

export async function mute(API, chatId, userId, min) {
  const until = Math.floor(Date.now() / 1000) + (min * 60);

  const res = await fetchMute(API, chatId, userId, until, false);
  return !!res?.ok;
}

export async function unmute(API, chatId, userId) {
  const res = await fetchMute(API, chatId, userId, undefined, true);
  return !!res?.ok;
}

async function fetchMute(API, chatId, userId, until, enableAll) {
  const { tg } = await import("./telegram.js");
  return tg(API, "restrictChatMember", {
    chat_id: chatId,
    user_id: userId,
    until_date: until,
    use_independent_chat_permissions: true,
    permissions: enableAll
      ? {
          can_send_messages: true,
          can_send_audios: true,
          can_send_documents: true,
          can_send_photos: true,
          can_send_videos: true,
          can_send_video_notes: true,
          can_send_voice_notes: true,
          can_send_polls: true,
          can_send_other_messages: true,
          can_add_web_page_previews: true,
          can_change_info: false,
          can_invite_users: true,
          can_pin_messages: false,
          can_manage_topics: false
        }
      : {
          can_send_messages: false,
          can_send_audios: false,
          can_send_documents: false,
          can_send_photos: false,
          can_send_videos: false,
          can_send_video_notes: false,
          can_send_voice_notes: false,
          can_send_polls: false,
          can_send_other_messages: false,
          can_add_web_page_previews: false,
          can_change_info: false,
          can_invite_users: false,
          can_pin_messages: false,
          can_manage_topics: false
        }
  });
}

export async function linkAllowed(text, KV, chatId) {
  const mode = normalizeLinkMode(await getGroupKV(KV, chatId, "link_mode"));
  const wl = safeJSON(await getGroupKV(KV, chatId, "link_whitelist"), []);
  const bl = safeJSON(await getGroupKV(KV, chatId, "link_blacklist"), []);

  const urls = text.match(LINK_REGEX);
  if (!urls) return true;

  for (let url of urls) {
    if (!/^https?:\/\//i.test(url)) {
      url = "https://" + url;
    }

    const whitelisted = isWhitelistedUrl(url, wl);
    if (whitelisted) {
      continue;
    }

    if (mode === "whitelistonly") {
      return false;
    }

    const domain = extractDomain(url);
    if (!domain) continue;

    if (isBlacklistedDomain(domain, bl)) {
      return false;
    }
  }

  return true;
}

function normalizeLinkMode(mode) {
  return String(mode || "hybrid").trim().toLowerCase() === "whitelistonly"
    ? "whitelistonly"
    : "hybrid";
}

function isWhitelistedUrl(url, whitelist) {
  if (!Array.isArray(whitelist)) return false;

  const host = extractDomain(url);

  return whitelist.some(entry => {
    const rule = String(entry || "").trim().toLowerCase();
    if (!rule) return false;

    if (rule.includes("/")) {
      return url.includes(rule);
    }

    if (!host) return false;
    return host === rule || host.endsWith(`.${rule}`);
  });
}

function isBlacklistedDomain(domain, blacklist) {
  if (!Array.isArray(blacklist)) return false;

  return blacklist.some(entry => {
    const rule = String(entry || "").trim().toLowerCase();
    if (!rule) return false;
    return domain === rule || domain.endsWith(`.${rule}`);
  });
}

function extractDomain(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return null;
  }
}
