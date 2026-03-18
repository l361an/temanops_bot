// welcome.js

import { GROUP_ID, DEFAULTS } from "./config.js";
import { getKV, safeJSON } from "./kv.js";
import { escapeBasicMarkdown } from "./utils.js";
import { tg } from "./telegram.js";

export async function welcome(API, KV, user) {
  try {
    const username = user.username
      ? `@${user.username}`
      : escapeBasicMarkdown(user.first_name || "User");

    const nama = user.first_name || "TeMan";

    const textTpl = await getKV(KV, "welcome_text");
    const links = safeJSON(await getKV(KV, "welcome_links"), []);

    const text = String(textTpl || DEFAULTS.welcome_text)
      .replace(/{username}/gi, username)
      .replace(/{nama}/gi, nama);

    const media = safeJSON(await getKV(KV, "welcome_media"), null);
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

    await tg(API, method, {
      chat_id: GROUP_ID,
      [key]: media.file_id,
      caption: text,
      parse_mode: "Markdown",
      reply_markup: buttons.length
        ? { inline_keyboard: buttons }
        : undefined
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
