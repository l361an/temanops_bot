// welcome.js

import { DEFAULTS } from "./config.js";
import { getGroupKV, safeJSON } from "./kv.js";
import { escapeBasicMarkdown } from "./utils.js";
import { tg } from "./telegram.js";

export async function welcome(API, KV, chatId, user) {
  try {
    const targetChatId = Number(chatId);
    if (!targetChatId) return;

    const username = user.username
      ? `@${user.username}`
      : escapeBasicMarkdown(user.first_name || "User");

    const nama = escapeBasicMarkdown(user.first_name || "TeMan");

    const textTpl = await getGroupKV(KV, targetChatId, "welcome_text");
    const links = safeJSON(await getGroupKV(KV, targetChatId, "welcome_links"), []);
    const media = safeJSON(await getGroupKV(KV, targetChatId, "welcome_media"), null);

    const text = String(textTpl || DEFAULTS.welcome_text)
      .replace(/{username}/gi, username)
      .replace(/{nama}/gi, nama);

    const buttons = buildWelcomeButtons(links);

    let mediaSent = false;

    if (media?.file_id && media?.type) {
      let method = "sendPhoto";
      let key = "photo";

      if (media.type === "video") {
        method = "sendVideo";
        key = "video";
      } else if (media.type === "animation") {
        method = "sendAnimation";
        key = "animation";
      }

      const res = await tg(API, method, {
        chat_id: targetChatId,
        [key]: media.file_id,
        caption: text,
        parse_mode: "Markdown",
        reply_markup: buttons.length
          ? { inline_keyboard: buttons }
          : undefined
      });

      mediaSent = !!res?.ok;
    }

    // fallback: kalau media belum ada / gagal, tetap kirim welcome message
    if (!mediaSent) {
      await tg(API, "sendMessage", {
        chat_id: targetChatId,
        text,
        parse_mode: "Markdown",
        disable_web_page_preview: true,
        reply_markup: buttons.length
          ? { inline_keyboard: buttons }
          : undefined
      });
      return;
    }

    // tambahan welcome note terpisah
    await tg(API, "sendMessage", {
      chat_id: targetChatId,
      text,
      parse_mode: "Markdown",
      disable_web_page_preview: true
    });
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
