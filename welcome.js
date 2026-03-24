// welcome.js

import { DEFAULTS } from "./config.js";
import {
  getGroupKV,
  safeJSON,
  safeKVGet,
  safeKVPut,
  safeKVDelete
} from "./kv.js";
import { escapeBasicMarkdown } from "./utils.js";
import { tg } from "./telegram.js";

function welcomeRecentKey(chatId, userId) {
  return `welcome:recent:${Number(chatId)}:${Number(userId)}`;
}

function isRecentWelcome(raw, windowMs = 90 * 1000) {
  const recent = safeJSON(raw, null);
  if (!recent?.sent_at) return false;

  const lastMs = new Date(recent.sent_at).getTime();
  if (!Number.isFinite(lastMs) || lastMs <= 0) return false;

  const diff = Date.now() - lastMs;
  return diff >= 0 && diff <= windowMs;
}

export async function welcome(API, KV, chatId, user) {
  try {
    const targetChatId = Number(chatId);
    const targetUserId = Number(user?.id || 0);

    if (!targetChatId || !targetUserId || user?.is_bot) return;

    const recentKey = welcomeRecentKey(targetChatId, targetUserId);
    const recentRaw = await safeKVGet(KV, recentKey);

    if (isRecentWelcome(recentRaw)) {
      return;
    }

    const username = user.username
      ? `@${user.username}`
      : escapeBasicMarkdown(user.first_name || "User");

    const nama = user.first_name || "TeMan";

    const textTpl = await getGroupKV(KV, targetChatId, "welcome_text");
    const links = safeJSON(await getGroupKV(KV, targetChatId, "welcome_links"), []);

    const text = String(textTpl || DEFAULTS.welcome_text)
      .replace(/{username}/gi, username)
      .replace(/{nama}/gi, nama);

    const media = safeJSON(await getGroupKV(KV, targetChatId, "welcome_media"), null);
    if (!media?.file_id || !media?.type) return;

    let method = "sendPhoto";
    let key = "photo";

    if (media.type === "video") {
      method = "sendVideo";
      key = "video";
    } else if (media.type === "animation") {
      method = "sendAnimation";
      key = "animation";
    }

    const buttons = buildWelcomeButtons(links);

    await safeKVPut(
      KV,
      recentKey,
      JSON.stringify({
        sent_at: new Date().toISOString()
      })
    );

    try {
      await tg(API, method, {
        chat_id: targetChatId,
        [key]: media.file_id,
        caption: text,
        parse_mode: "Markdown",
        reply_markup: buttons.length
          ? { inline_keyboard: buttons }
          : undefined
      });
    } catch (err) {
      await safeKVDelete(KV, recentKey);
      throw err;
    }
  } catch (err) {
    console.log("WELCOME FAILED:", err?.message || err);
  }
}

function buildWelcomeButtons(links) {
  const buttons = [];
  let row = [];

  for (const l of Array.isArray(links) ? links : []) {
    if (!l?.text || !l?.url) continue;

    const btn = {
      text: String(l.text).slice(0, 64),
      url: l.url
    };

    if (btn.text.length > 10) {
      if (row.length) {
        buttons.push(row);
        row = [];
      }
      buttons.push([btn]);
      continue;
    }

    row.push(btn);
    if (row.length === 2) {
      buttons.push(row);
      row = [];
    }
  }

  if (row.length) buttons.push(row);
  return buttons;
}
