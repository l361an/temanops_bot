// workers.js

// ================== CONFIG ==================
const GROUP_ID = -1001901372111;
const LOG_THREAD_ID = 82107;

const LINK_REGEX = /(https?:\/\/[^\s]+|t\.me\/[^\s]+|telegram\.me\/[^\s]+|wa\.me\/[^\s]+|bit\.ly\/[^\s]+|tinyurl\.com\/[^\s]+)/gi;

let floodMap = {};

// ================== DEFAULTS ==================
const DEFAULTS = {
  flood_limit: "5",
  flood_window: "10",
  mute_minutes: "60",
  banned_words: "",
  link_whitelist: "[]",
  link_blacklist: "[]",
  welcome_text: "Selamat Bergabung di *TeMan* 🤍",
  welcome_media: "",
  welcome_links: "[]"
};

// ================== WORKER ==================
export default {
  async fetch(req, env) {
    if (req.method !== "POST") return new Response("OK");

    const BOT_TOKEN = env.BOT_TOKEN;
    const KV = env.TEMANOPS_KV;
    if (!BOT_TOKEN || !KV) return new Response("ENV ERROR", { status: 500 });

    const API = `https://api.telegram.org/bot${BOT_TOKEN}`;
    const update = await req.json().catch(() => ({}));
    console.log("UPDATE:", JSON.stringify(update));

    try {
      // ===== JOIN VIA chat_member =====
      if (update.chat_member?.chat?.id === GROUP_ID) {
        const { old_chat_member, new_chat_member } = update.chat_member;

        const oldStatus = old_chat_member?.status;
        const newStatus = new_chat_member?.status;

        const oldIsMember =
          old_chat_member?.is_member === true ||
          ["member", "administrator", "creator"].includes(oldStatus);

        const newIsMember =
          new_chat_member?.is_member === true ||
          ["member", "administrator", "creator"].includes(newStatus) ||
          (newStatus === "restricted" && new_chat_member?.is_member === true);

        const newUser = new_chat_member?.user;

        const justJoined = !oldIsMember && newIsMember;

        if (justJoined && !newUser?.is_bot) {
          await welcome(API, KV, newUser);
        }

        return new Response("OK");
      }

      // ===== NORMALISASI MESSAGE =====
      const msg =
        update.message ||
        update.edited_message ||
        update.channel_post ||
        update.edited_channel_post ||
        null;

      if (!msg || !msg.chat) {
        return new Response("OK");
      }

      // ===== FALLBACK JOIN VIA new_chat_members =====
      if (msg?.chat?.id === GROUP_ID && Array.isArray(msg.new_chat_members)) {
        for (const member of msg.new_chat_members) {
          if (!member?.is_bot) {
            await welcome(API, KV, member);
          }
        }
        return new Response("OK");
      }      

      // ===== PRIVATE COMMAND =====
      if (msg.chat.type === "private" && msg.text?.startsWith("/")) {
        const step = await getWelcomeStep(KV, msg.from?.id);
        if (step && msg.from?.id) await clearWelcomeStep(KV, msg.from.id);

        await handleCommand(API, msg, KV);
        return new Response("OK");
      }

      // ===== WELCOME SETUP (PRIVATE ONLY) =====
      if (msg.chat.type === "private") {
        const userId = msg.from?.id;
        if (!userId) return new Response("OK");

        const step = await getWelcomeStep(KV, userId);
        if (!step) return new Response("OK");

        // === MEDIA ===
        if (step === "media") {
          let fileId = null;
          let type = null;

          if (msg.photo?.length) {
            fileId = msg.photo.at(-1).file_id;
            type = "photo";
          } else if (msg.video?.file_id) {
            fileId = msg.video.file_id;
            type = "video";
          } else if (msg.animation?.file_id) {
            fileId = msg.animation.file_id;
            type = "animation";
          }

          if (!fileId) {
            await send(API, msg.chat.id, "❌ Kirim *foto / video / gif*, bukan teks");
            return new Response("OK");
          }

          await safeKVPut(KV, "welcome_media", JSON.stringify({ type, file_id: fileId }));
          await clearWelcomeStep(KV, userId);

          await send(API, msg.chat.id, "✅ Welcome media berhasil disimpan");
          return new Response("OK");
        }

        // === TEXT ===
        if (step === "text") {
          if (!msg.text) {
            await send(API, msg.chat.id, "❌ Kirim *teks*, bukan media");
            return new Response("OK");
          }

          await safeKVPut(KV, "welcome_text", msg.text);
          await clearWelcomeStep(KV, userId);

          await send(API, msg.chat.id, "✅ Welcome text berhasil disimpan");
          return new Response("OK");
        }

        // === LINK TITLE ===
        if (step === "link_title") {
          if (!msg.text) {
            await send(API, msg.chat.id, "❌ Kirim *judul button*");
            return new Response("OK");
          }

          await safeKVPut(
            KV,
            `welcome_link_tmp:${userId}`,
            JSON.stringify({ text: msg.text })
          );

          await setWelcomeStep(KV, userId, "link_url");
          await send(API, msg.chat.id, "🔗 Sekarang kirim *URL link*");
          return new Response("OK");
        }

        // === LINK URL ===
        if (step === "link_url") {
          if (!msg.text || !/^https?:\/\//i.test(msg.text)) {
            await send(API, msg.chat.id, "❌ URL tidak valid");
            return new Response("OK");
          }

          const tmp = safeJSON(await safeKVGet(KV, `welcome_link_tmp:${userId}`), {});
          let links = safeJSON(await getKV(KV, "welcome_links"), []);

          if (!tmp?.text) {
            await clearWelcomeStep(KV, userId);
            await safeKVDelete(KV, `welcome_link_tmp:${userId}`);
            await send(API, msg.chat.id, "❌ Sesi link tidak valid. Ulangi /addwelcomelink");
            return new Response("OK");
          }

          links.push({
            text: tmp.text,
            url: msg.text
          });

          await safeKVPut(KV, "welcome_links", JSON.stringify(links));
          await safeKVDelete(KV, `welcome_link_tmp:${userId}`);
          await clearWelcomeStep(KV, userId);

          await send(API, msg.chat.id, "✅ Welcome button berhasil ditambahkan");
          return new Response("OK");
        }

        return new Response("OK");
      }

      // ===== PING =====
      if (msg.text === "ping") {
        await send(API, msg.chat.id, "pong");
        return new Response("OK");
      }

      // ===== GROUP MODERATION =====
      if (msg.chat.id === GROUP_ID && msg.from && !msg.from.is_bot) {
        await handleModeration(API, msg, KV);
      }

      return new Response("OK");
    } catch (err) {
      console.log("FETCH ERROR:", err?.stack || err?.message || String(err));
      return new Response("OK");
    }
  }
};

// ================== WELCOME ==================
async function welcome(API, KV, user) {
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

// ================== MODERATION ==================
async function handleModeration(API, msg, KV) {
  try {
    const admin = await isAdmin(API, msg.chat.id, msg.from.id);
    if (admin) return;

    // Anti flood untuk hampir semua pesan user
    if (await isFlood(API, msg, KV)) return;

    const content = getMessageContent(msg);
    if (!content) return;

    const text = content.toLowerCase();

    // Link moderation
    if (LINK_REGEX.test(text)) {
      LINK_REGEX.lastIndex = 0;
      const allowed = await linkAllowed(text, KV);

      if (!allowed) {
        await del(API, msg.chat.id, msg.message_id);
        await punish(API, msg, KV, "Mengirim link terlarang");
        return;
      }
    }
    LINK_REGEX.lastIndex = 0;

    // Banword moderation
    const banned = String(await getKV(KV, "banned_words"))
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

function getMessageContent(msg) {
  if (typeof msg.text === "string" && msg.text.trim()) return msg.text;
  if (typeof msg.caption === "string" && msg.caption.trim()) return msg.caption;
  return "";
}

// ================== COMMAND ==================
async function handleCommand(API, msg, KV) {
  const parts = String(msg.text || "").trim().split(/\s+/);
  const raw = parts[0] || "";
  const a = parts[1];
  const b = parts[2];
  const cmd = raw.split("@")[0].toLowerCase();

  if (cmd.includes("_")) {
    return send(
      API,
      msg.chat.id,
      "❌ Command tidak memakai underscore.\nGunakan:\n/linkwhitelist atau /linkblacklist"
    );
  }

  if (msg.chat.type !== "private") {
    return send(API, msg.chat.id, "❌ Command hanya via private bot");
  }

  if (cmd === "/listcmd") {
    return send(
      API,
      msg.chat.id,
`🛠️ *Admin Commands*

*Moderation*
• /banword add [kata]
• /banword del [kata]
• /banword list

• /linkwhitelist add [domain]
• /linkwhitelist del [domain]
• /linkwhitelist list

• /linkblacklist add [domain]
• /linkblacklist del [domain]
• /linkblacklist list

*Anti Spam*
• /antiflood [limit] [detik]
• /setmutetime [menit]

*Welcome / Welcome Note*
• /updatewelcometext
• /updatewelcomemedia
• /addwelcomelink
• /delwelcomelink [judul]
• /listwelcomelink

*User Control*
• /unmute [user_id]

*Info*
• /listcmd

ℹ️ Semua command hanya via private bot
🔐 Khusus admin & creator`
    );
  }

  const is_user_admin = await isAdmin(API, GROUP_ID, msg.from.id);
  if (!is_user_admin) {
    return send(API, msg.chat.id, "❌ Bukan admin");
  }

  if (cmd === "/updatewelcomemedia") {
    await setWelcomeStep(KV, msg.from.id, "media");
    return send(API, msg.chat.id, "📸 Silakan kirim *foto / video / gif* untuk welcome media");
  }

  if (cmd === "/updatewelcometext") {
    await setWelcomeStep(KV, msg.from.id, "text");
    return send(
      API,
      msg.chat.id,
`✍️ *Update Welcome Text*

Silakan ketik welcome text.

ℹ️ Placeholder tersedia:
• {username} → username / mention klik
• {nama} → nama saja

Contoh:
Selamat datang {username} di TeMan 🤍`
    );
  }

  if (cmd === "/addwelcomelink") {
    await setWelcomeStep(KV, msg.from.id, "link_title");
    return send(API, msg.chat.id, "🧷 Silahkan kirim *judul button*");
  }

  if (cmd === "/delwelcomelink") {
    const title = String(msg.text || "")
      .replace(/^\/delwelcomelink(@\w+)?\s+/i, "")
      .trim();

    if (!title) {
      return send(API, msg.chat.id, "❌ /delwelcomelink <judul>");
    }

    let links = safeJSON(await getKV(KV, "welcome_links"), []);
    const before = links.length;

    links = links.filter(
      l => String(l.text || "").trim().toLowerCase() !== title.toLowerCase()
    );

    if (links.length === before) {
      return send(API, msg.chat.id, "⚠️ Judul tidak ditemukan");
    }

    await safeKVPut(KV, "welcome_links", JSON.stringify(links));
    return send(API, msg.chat.id, `🗑️ Welcome button dihapus:\n${title}`);
  }

  if (cmd === "/listwelcomelink") {
    const links = safeJSON(await getKV(KV, "welcome_links"), []);

    if (!links.length) {
      return tg(API, "sendMessage", {
        chat_id: msg.chat.id,
        text: "📭 Welcome button masih kosong",
        disable_web_page_preview: true
      });
    }

    return tg(API, "sendMessage", {
      chat_id: msg.chat.id,
      text:
        "Daftar Welcome Button\n\n" +
        links.map((l, i) => `${i + 1}. ${l.text}\n${l.url}`).join("\n\n"),
      disable_web_page_preview: true
    });
  }

  if (cmd === "/banword") {
    if (!a) {
      return send(
        API,
        msg.chat.id,
        "❌ Format:\n/banword add <kata>\n/banword del <kata>\n/banword list"
      );
    }

    let list = String(await getKV(KV, "banned_words"))
      .split(",")
      .map(x => x.trim().toLowerCase())
      .filter(Boolean);

    if (a === "list") {
      if (list.length === 0) {
        return send(API, msg.chat.id, "📭 Banword masih kosong");
      }

      return send(
        API,
        msg.chat.id,
        `🚫 *Daftar Banword*\n\n${list.map((w, i) => `${i + 1}. ${escapeBasicMarkdown(w)}`).join("\n")}`
      );
    }

    if (!b) {
      return send(
        API,
        msg.chat.id,
        "❌ Format:\n/banword add <kata>\n/banword del <kata>"
      );
    }

    const action = a.toLowerCase();
    const word = b.toLowerCase();

    if (action === "add") {
      if (list.includes(word)) {
        return send(API, msg.chat.id, `⚠️ Kata *${escapeBasicMarkdown(word)}* sudah ada`);
      }
      list.push(word);
      await safeKVPut(KV, "banned_words", list.join(","));
      return send(API, msg.chat.id, `✅ Kata *${escapeBasicMarkdown(word)}* ditambahkan`);
    }

    if (action === "del") {
      if (!list.includes(word)) {
        return send(API, msg.chat.id, `⚠️ Kata *${escapeBasicMarkdown(word)}* tidak ditemukan`);
      }
      list = list.filter(w => w !== word);
      await safeKVPut(KV, "banned_words", list.join(","));
      return send(API, msg.chat.id, `🗑️ Kata *${escapeBasicMarkdown(word)}* dihapus`);
    }

    return send(API, msg.chat.id, "❌ Gunakan add / del / list");
  }

  if (cmd === "/linkwhitelist") {
    if (!["add", "del", "list"].includes(a)) {
      return send(API, msg.chat.id, "❌ /linkwhitelist add|del|list [domain]");
    }

    let list = safeJSON(await getKV(KV, "link_whitelist"), []);

    if (a === "list") {
      return send(API, msg.chat.id, renderAdminList("✅ Link Whitelist", list));
    }

    if (!b) return send(API, msg.chat.id, "❌ Domain kosong");

    const domain = b.toLowerCase();

    if (a === "add") {
      if (list.includes(domain)) {
        return send(API, msg.chat.id, "⚠️ Domain sudah ada");
      }
      list.push(domain);
    }

    if (a === "del") {
      const before = list.length;
      list = list.filter(d => d !== domain);

      if (list.length === before) {
        return send(API, msg.chat.id, "⚠️ Domain tidak ditemukan");
      }
    }

    await safeKVPut(KV, "link_whitelist", JSON.stringify(list));
    return send(API, msg.chat.id, `✅ Whitelist diupdate:\n${domain}`);
  }

  if (cmd === "/linkblacklist") {
    if (!["add", "del", "list"].includes(a)) {
      return send(API, msg.chat.id, "❌ /linkblacklist add|del|list [domain]");
    }

    let list = safeJSON(await getKV(KV, "link_blacklist"), []);

    if (a === "list") {
      return send(API, msg.chat.id, renderAdminList("⛔ Link Blacklist", list));
    }

    if (!b) return send(API, msg.chat.id, "❌ Domain kosong");

    const domain = b.toLowerCase();

    if (a === "add") {
      if (list.includes(domain)) {
        return send(API, msg.chat.id, "⚠️ Domain sudah ada");
      }
      list.push(domain);
    }

    if (a === "del") {
      const before = list.length;
      list = list.filter(d => d !== domain);

      if (list.length === before) {
        return send(API, msg.chat.id, "⚠️ Domain tidak ditemukan");
      }
    }

    await safeKVPut(KV, "link_blacklist", JSON.stringify(list));
    return send(API, msg.chat.id, `⛔ Blacklist diupdate:\n${domain}`);
  }

  if (cmd === "/antiflood") {
    const limit = Number(a);
    const win = Number(b);

    if (!limit || !win || limit <= 0 || win <= 0) {
      return send(API, msg.chat.id, "❌ Format: /antiflood <limit> <detik>");
    }

    await safeKVPut(KV, "flood_limit", String(limit));
    await safeKVPut(KV, "flood_window", String(win));
    return send(API, msg.chat.id, `✅ Anti flood diset: ${limit} pesan / ${win} detik`);
  }

  if (cmd === "/setmutetime") {
    const n = Number(a);
    if (!n || n <= 0) return send(API, msg.chat.id, "❌ Angka invalid");

    await safeKVPut(KV, "mute_minutes", String(n));
    return send(API, msg.chat.id, `⏱️ Mute diset ${n} menit`);
  }

  if (cmd === "/unmute") {
    const uid = Number(a);
    if (!uid) return send(API, msg.chat.id, "❌ /unmute <user_id>");

    await unmute(API, uid);
    return send(API, msg.chat.id, `🔓 UNMUTE BERHASIL\nUser ID: ${uid}`);
  }
}

// ================== FLOOD ==================
async function isFlood(API, msg, KV) {
  const id = msg.from?.id;
  if (!id) return false;

  const now = Date.now();
  const limit = Number(await getKV(KV, "flood_limit")) || 5;
  const win = (Number(await getKV(KV, "flood_window")) || 10) * 1000;

  floodMap[id] = (floodMap[id] || []).filter(t => now - t < win);
  floodMap[id].push(now);

  if (floodMap[id].length >= limit) {
    floodMap[id] = [];
    await del(API, msg.chat.id, msg.message_id);
    await punish(API, msg, KV, "Flood / Spam");
    return true;
  }

  return false;
}

// ================== PUNISH ==================
async function punish(API, msg, KV, reason) {
  const min = getSafeNumber(await getKV(KV, "mute_minutes"), 60);

  await mute(API, GROUP_ID, msg.from.id, min);

  const logText =
`📋 *LOG PELANGGARAN*

👤 ${escapeBasicMarkdown(msg.from.first_name || "-")}
🆔 ${msg.from.id}

🚫 *Alasan*
${escapeBasicMarkdown(reason)}

⏱️ *Hukuman*
Mute ${min} menit

🕊️ *Remisi*
Hubungi @eltee168 & @osmolagouti`;

  await send(API, GROUP_ID, logText, LOG_THREAD_ID);
}

// ================== MUTE / UNMUTE ==================
async function mute(API, chatId, userId, min) {
  const until = Math.floor(Date.now() / 1000) + (min * 60);

  await tg(API, "restrictChatMember", {
    chat_id: chatId,
    user_id: userId,
    until_date: until,
    permissions: {
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
      can_pin_messages: false
    }
  });
}

async function unmute(API, userId) {
  await tg(API, "restrictChatMember", {
    chat_id: GROUP_ID,
    user_id: userId,
    permissions: {
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
      can_pin_messages: false
    }
  });
}

// ================== LINK ==================
async function linkAllowed(text, KV) {
  const wl = safeJSON(await getKV(KV, "link_whitelist"), []);
  const bl = safeJSON(await getKV(KV, "link_blacklist"), []);

  const urls = text.match(LINK_REGEX);
  if (!urls) return true;

  for (let url of urls) {
    if (!/^https?:\/\//i.test(url)) {
      url = "https://" + url;
    }

    if (Array.isArray(wl) && wl.some(w => {
      if (!w) return false;
      if (w.includes("/")) return url.includes(w);
      const host = extractDomain(url);
      return host ? host.endsWith(w) : false;
    })) {
      continue;
    }

    const domain = extractDomain(url);
    if (!domain) continue;

    if (Array.isArray(bl) && bl.some(b => b && (domain === b || domain.endsWith("." + b)))) {
      return false;
    }
  }

  return true;
}

// ================== TELEGRAM CORE ==================
async function tg(API, method, payload) {
  try {
    const res = await fetch(`${API}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(cleanUndefined(payload))
    });

    const data = await res.json().catch(() => ({}));

    if (!res.ok || data?.ok === false) {
      console.log(`TG ${method} FAILED:`, JSON.stringify(data));
      return null;
    }

    return data;
  } catch (err) {
    console.log(`TG ${method} ERROR:`, err?.message || err);
    return null;
  }
}

// ================== UTIL ==================
function extractDomain(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return null;
  }
}

function getSafeNumber(v, def) {
  const n = Number(v);
  return isNaN(n) || n <= 0 ? def : n;
}

async function getKV(KV, key) {
  try {
    const val = await KV.get(key);
    return val === null ? (DEFAULTS[key] ?? null) : val;
  } catch (err) {
    console.log(`KV GET FAILED [${key}]:`, err?.message || err);
    return DEFAULTS[key] ?? null;
  }
}

async function safeKVGet(KV, key) {
  try {
    return await KV.get(key);
  } catch (err) {
    console.log(`KV GET FAILED [${key}]:`, err?.message || err);
    return null;
  }
}

async function safeKVPut(KV, key, value) {
  try {
    await KV.put(key, value);
    return true;
  } catch (err) {
    console.log(`KV PUT FAILED [${key}]:`, err?.message || err);
    return false;
  }
}

async function safeKVDelete(KV, key) {
  try {
    await KV.delete(key);
    return true;
  } catch (err) {
    console.log(`KV DELETE FAILED [${key}]:`, err?.message || err);
    return false;
  }
}

async function send(API, chatId, text, thread) {
  return tg(API, "sendMessage", {
    chat_id: chatId,
    text,
    parse_mode: "Markdown",
    disable_web_page_preview: true,
    message_thread_id: thread ? Number(thread) : undefined,
    is_topic_message: thread ? true : undefined
  });
}

async function del(API, chatId, id) {
  return tg(API, "deleteMessage", {
    chat_id: chatId,
    message_id: id
  });
}

async function pin(API, chatId, id) {
  return tg(API, "pinChatMessage", {
    chat_id: chatId,
    message_id: id
  });
}

async function unpin(API, chatId, id) {
  return tg(API, "unpinChatMessage", {
    chat_id: chatId,
    message_id: id
  });
}

async function react(API, chatId, id, emoji) {
  return tg(API, "setMessageReaction", {
    chat_id: chatId,
    message_id: id,
    reaction: [{ type: "emoji", emoji }]
  });
}

function renderAdminList(title, list) {
  if (!Array.isArray(list) || !list.length) return "📭 Kosong";
  return `${title}\n\`\`\`\n${list.join("\n")}\n\`\`\``;
}

async function setWelcomeStep(KV, userId, step) {
  if (!userId) return false;
  return safeKVPut(KV, `welcome_setup:${userId}`, step);
}

async function getWelcomeStep(KV, userId) {
  if (!userId) return null;
  return safeKVGet(KV, `welcome_setup:${userId}`);
}

async function clearWelcomeStep(KV, userId) {
  if (!userId) return false;
  return safeKVDelete(KV, `welcome_setup:${userId}`);
}

async function isAdmin(API, chatId, userId) {
  const data = await tg(API, "getChatMember", {
    chat_id: chatId,
    user_id: userId
  });

  return !!(data?.result && ["administrator", "creator"].includes(data.result.status));
}

function safeJSON(raw, def) {
  try {
    return raw ? JSON.parse(raw) : def;
  } catch {
    return def;
  }
}

function cleanUndefined(obj) {
  return Object.fromEntries(
    Object.entries(obj).filter(([, v]) => v !== undefined)
  );
}

function escapeBasicMarkdown(text) {
  return String(text || "").replace(/([_*[\]()`])/g, "\\$1");
}

function escapeMarkdown(text) {
  return String(text || "").replace(/([_*\[\]()~`>#+\-=|{}.!\\])/g, "\\$1");
}
