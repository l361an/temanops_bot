// workers.js

// ================== LEGACY CONFIG ==================
// Dipakai sementara untuk grup lama / welcome lama.
// Tahap berikutnya baru kita lepas dari hardcode ini.
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
      // ===== JOIN VIA chat_member (legacy: masih grup lama) =====
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

      const chatId = Number(msg.chat.id);

      // ===== FALLBACK JOIN VIA new_chat_members (legacy: masih grup lama) =====
      if (msg?.chat?.id === GROUP_ID && Array.isArray(msg.new_chat_members)) {
        for (const member of msg.new_chat_members) {
          if (!member?.is_bot) {
            await welcome(API, KV, member);
          }
        }
        return new Response("OK");
      }

      // ===== GROUP COMMAND: AKTIF / NONAKTIF TEMANOPS =====
      if (
        msg.chat?.type &&
        ["group", "supergroup"].includes(msg.chat.type) &&
        typeof msg.text === "string" &&
        msg.text.startsWith("/")
      ) {
        const cmd = msg.text.trim().split(/\s+/)[0].split("@")[0].toLowerCase();

        if (cmd === "/aktifkantemanops") {
          const allowed = await canManageTemanOps(API, msg);
          if (!allowed) {
            await send(
              API,
              msg.chat.id,
              "❌ Command ini hanya untuk *owner* atau *anonymous admin atas nama group ini*"
            );
            return new Response("OK");
          }

          await setTemanOpsEnabled(KV, chatId, true);
          await safeKVPut(KV, `temanops_title:${chatId}`, String(msg.chat.title || chatId));

          // seed log target default ke group itu sendiri
          await setGroupLogTarget(KV, chatId, chatId, null);

          await send(API, msg.chat.id, "✅ *TeManOps aktif* di group ini");
          return new Response("OK");
        }

        if (cmd === "/nonaktifkantemanops") {
          const allowed = await canManageTemanOps(API, msg);
          if (!allowed) {
            await send(
              API,
              msg.chat.id,
              "❌ Command ini hanya untuk *owner* atau *anonymous admin atas nama group ini*"
            );
            return new Response("OK");
          }

          await setTemanOpsEnabled(KV, chatId, false);
          await safeKVPut(KV, `temanops_title:${chatId}`, String(msg.chat.title || chatId));

          await send(API, msg.chat.id, "⛔ *TeManOps nonaktif* di group ini");
          return new Response("OK");
        }

        if (cmd === "/statustemanops") {
          const enabled = await isTemanOpsEnabled(KV, chatId);
          const title = await safeKVGet(KV, `temanops_title:${chatId}`);

          await send(
            API,
            msg.chat.id,
            enabled
              ? `✅ Status TeManOps: *AKTIF*\n🏠 Group: ${escapeBasicMarkdown(title || msg.chat.title || String(chatId))}`
              : `⛔ Status TeManOps: *NONAKTIF*\n🏠 Group: ${escapeBasicMarkdown(title || msg.chat.title || String(chatId))}`
          );
          return new Response("OK");
        }
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
      if (
        ["group", "supergroup"].includes(msg.chat.type) &&
        msg.from &&
        !msg.from.is_bot &&
        await shouldRunModeration(KV, msg.chat.id)
      ) {
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
// legacy: masih kirim ke GROUP_ID hardcode
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
  const userId = msg.from?.id;

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

*Pemilihan Group*
• /groups
• /setgroup [chat_id]
• /where

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
🔐 Khusus admin / creator di group yang dipilih`
    );
  }

  // ===== pilih group aktif =====
  if (cmd === "/groups") {
    const groups = await getEnabledGroupsForUser(API, KV, userId);

    if (!groups.length) {
      return send(
        API,
        msg.chat.id,
        "📭 Belum ada group aktif yang bisa lo kelola.\nAktifkan dulu di group dengan /aktifkantemanops"
      );
    }

    return send(
      API,
      msg.chat.id,
      [
        "📋 *Group aktif yang bisa lo kelola*",
        "",
        ...groups.map(g => `• ${escapeBasicMarkdown(g.title)} → \`${g.chatId}\``),
        "",
        "Pilih target: /setgroup <chat_id>"
      ].join("\n")
    );
  }

  if (cmd === "/setgroup") {
    if (!a) {
      return send(API, msg.chat.id, "❌ Format: /setgroup <chat_id>");
    }

    const chatId = Number(a);
    if (!chatId) {
      return send(API, msg.chat.id, "❌ chat_id tidak valid");
    }

    const enabled = await isTemanOpsEnabled(KV, chatId);
    if (!enabled) {
      return send(API, msg.chat.id, "❌ Group itu belum aktif /aktifkantemanops");
    }

    const ok = await isAdmin(API, chatId, userId);
    if (!ok) {
      return send(API, msg.chat.id, "❌ Lo bukan admin di group itu");
    }

    await setSelectedGroup(KV, userId, chatId);
    const title = await getTemanOpsTitle(KV, chatId);

    return send(
      API,
      msg.chat.id,
      `✅ Target group aktif:\n🏠 ${escapeBasicMarkdown(title)}\n🆔 \`${chatId}\``
    );
  }

  if (cmd === "/where") {
    const selected = await getSelectedGroup(KV, userId);
    if (!selected) {
      return send(API, msg.chat.id, "📭 Belum pilih group. Pakai /groups lalu /setgroup <chat_id>");
    }

    const title = await getTemanOpsTitle(KV, selected);
    return send(
      API,
      msg.chat.id,
      `🎯 Target sekarang:\n🏠 ${escapeBasicMarkdown(title)}\n🆔 \`${selected}\``
    );
  }

  // semua command di bawah wajib punya selected group
  const selectedGroupId = await getSelectedGroup(KV, userId);
  if (!selectedGroupId) {
    return send(API, msg.chat.id, "❌ Pilih group dulu. Gunakan /groups lalu /setgroup <chat_id>");
  }

  const enabled = await isTemanOpsEnabled(KV, selectedGroupId);
  if (!enabled) {
    return send(API, msg.chat.id, "❌ Group yang dipilih sudah nonaktif");
  }

  const isUserAdmin = await isAdmin(API, selectedGroupId, userId);
  if (!isUserAdmin) {
    return send(API, msg.chat.id, `❌ Lo bukan admin di group \`${selectedGroupId}\``);
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

    let links = safeJSON(await getGroupKV(KV, selectedGroupId, "welcome_links"), []);
    const before = links.length;

    links = links.filter(
      l => String(l.text || "").trim().toLowerCase() !== title.toLowerCase()
    );

    if (links.length === before) {
      return send(API, msg.chat.id, "⚠️ Judul tidak ditemukan");
    }

    await safeKVPut(KV, gkey(selectedGroupId, "welcome_links"), JSON.stringify(links));
    return send(API, msg.chat.id, `🗑️ Welcome button dihapus:\n${title}`);
  }

  if (cmd === "/listwelcomelink") {
    const links = safeJSON(await getGroupKV(KV, selectedGroupId, "welcome_links"), []);

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

    let list = String(await getGroupKV(KV, selectedGroupId, "banned_words"))
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
      await safeKVPut(KV, gkey(selectedGroupId, "banned_words"), list.join(","));
      return send(API, msg.chat.id, `✅ Kata *${escapeBasicMarkdown(word)}* ditambahkan`);
    }

    if (action === "del") {
      if (!list.includes(word)) {
        return send(API, msg.chat.id, `⚠️ Kata *${escapeBasicMarkdown(word)}* tidak ditemukan`);
      }
      list = list.filter(w => w !== word);
      await safeKVPut(KV, gkey(selectedGroupId, "banned_words"), list.join(","));
      return send(API, msg.chat.id, `🗑️ Kata *${escapeBasicMarkdown(word)}* dihapus`);
    }

    return send(API, msg.chat.id, "❌ Gunakan add / del / list");
  }

  if (cmd === "/linkwhitelist") {
    if (!["add", "del", "list"].includes(a)) {
      return send(API, msg.chat.id, "❌ /linkwhitelist add|del|list [domain]");
    }

    let list = safeJSON(await getGroupKV(KV, selectedGroupId, "link_whitelist"), []);

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

    await safeKVPut(KV, gkey(selectedGroupId, "link_whitelist"), JSON.stringify(list));
    return send(API, msg.chat.id, `✅ Whitelist diupdate:\n${domain}`);
  }

  if (cmd === "/linkblacklist") {
    if (!["add", "del", "list"].includes(a)) {
      return send(API, msg.chat.id, "❌ /linkblacklist add|del|list [domain]");
    }

    let list = safeJSON(await getGroupKV(KV, selectedGroupId, "link_blacklist"), []);

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

    await safeKVPut(KV, gkey(selectedGroupId, "link_blacklist"), JSON.stringify(list));
    return send(API, msg.chat.id, `⛔ Blacklist diupdate:\n${domain}`);
  }

  if (cmd === "/antiflood") {
    const limit = Number(a);
    const win = Number(b);

    if (!limit || !win || limit <= 0 || win <= 0) {
      return send(API, msg.chat.id, "❌ Format: /antiflood <limit> <detik>");
    }

    await safeKVPut(KV, gkey(selectedGroupId, "flood_limit"), String(limit));
    await safeKVPut(KV, gkey(selectedGroupId, "flood_window"), String(win));
    return send(API, msg.chat.id, `✅ Anti flood diset: ${limit} pesan / ${win} detik`);
  }

  if (cmd === "/setmutetime") {
    const n = Number(a);
    if (!n || n <= 0) return send(API, msg.chat.id, "❌ Angka invalid");

    await safeKVPut(KV, gkey(selectedGroupId, "mute_minutes"), String(n));
    return send(API, msg.chat.id, `⏱️ Mute diset ${n} menit`);
  }

  if (cmd === "/unmute") {
    const uid = Number(a);
    if (!uid) return send(API, msg.chat.id, "❌ /unmute <user_id>");

    await unmute(API, selectedGroupId, uid);
    return send(API, msg.chat.id, `🔓 UNMUTE BERHASIL\nUser ID: ${uid}`);
  }
}

// ================== FLOOD ==================
async function isFlood(API, msg, KV) {
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

// ================== PUNISH ==================
async function punish(API, msg, KV, reason) {
  const chatId = Number(msg.chat.id);
  const min = getSafeNumber(await getGroupKV(KV, chatId, "mute_minutes"), 60);

  await mute(API, chatId, msg.from.id, min);

  const title = await getTemanOpsTitle(KV, chatId);
  const logTarget = await getGroupLogTarget(KV, chatId);

  const logText =
`📋 *LOG PELANGGARAN*

🏠 ${escapeBasicMarkdown(title || String(chatId))}
👤 ${escapeBasicMarkdown(msg.from.first_name || "-")}
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

async function unmute(API, chatId, userId) {
  await tg(API, "restrictChatMember", {
    chat_id: chatId,
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
async function linkAllowed(text, KV, chatId) {
  const wl = safeJSON(await getGroupKV(KV, chatId, "link_whitelist"), []);
  const bl = safeJSON(await getGroupKV(KV, chatId, "link_blacklist"), []);

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

// ================== GROUP ENABLE / SELECT ==================
async function shouldRunModeration(KV, chatId) {
  const n = Number(chatId);
  if (!n) return false;

  // backward compatibility: grup lama tetap jalan walau belum diaktifkan manual
  if (n === GROUP_ID) return true;

  return await isTemanOpsEnabled(KV, n);
}

async function setTemanOpsEnabled(KV, chatId, enabled) {
  await safeKVPut(KV, `temanops_enabled:${chatId}`, enabled ? "1" : "0");
  await safeKVPut(KV, `temanops_group_registry:${chatId}`, "1");
  return true;
}

async function isTemanOpsEnabled(KV, chatId) {
  const val = await safeKVGet(KV, `temanops_enabled:${chatId}`);
  return val === "1";
}

async function setSelectedGroup(KV, userId, chatId) {
  return safeKVPut(KV, `temanops_selected_group:${userId}`, String(chatId));
}

async function getSelectedGroup(KV, userId) {
  const val = await safeKVGet(KV, `temanops_selected_group:${userId}`);
  return val ? Number(val) : null;
}

async function getEnabledGroupsForUser(API, KV, userId) {
  const all = await getAllRegisteredGroups(KV);
  const results = [];

  for (const chatId of all) {
    if (!(await isTemanOpsEnabled(KV, chatId))) continue;
    if (!(await isAdmin(API, chatId, userId))) continue;

    results.push({
      chatId,
      title: await getTemanOpsTitle(KV, chatId)
    });
  }

  return results;
}

async function getAllRegisteredGroups(KV) {
  const ids = new Set();

  try {
    let cursor = undefined;

    do {
      const res = await KV.list({
        prefix: "temanops_group_registry:",
        cursor
      });

      for (const key of res.keys || []) {
        const m = String(key.name || "").match(/^temanops_group_registry:(-?\d+)$/);
        if (m) ids.add(Number(m[1]));
      }

      cursor = res.list_complete ? undefined : res.cursor;
    } while (cursor);
  } catch (err) {
    console.log("KV LIST GROUP REGISTRY FAILED:", err?.message || err);
  }

  // seed legacy group lama supaya tetap muncul kalau user admin di sana
  ids.add(Number(GROUP_ID));

  return [...ids];
}

async function getTemanOpsTitle(KV, chatId) {
  const title = await safeKVGet(KV, `temanops_title:${chatId}`);
  return title || String(chatId);
}

// ================== GROUP LOG TARGET ==================
async function setGroupLogTarget(KV, sourceChatId, targetChatId, threadId) {
  return safeKVPut(
    KV,
    `temanops_log_target:${sourceChatId}`,
    JSON.stringify({
      chat_id: Number(targetChatId),
      thread_id: threadId ? Number(threadId) : null
    })
  );
}

async function getGroupLogTarget(KV, sourceChatId) {
  const raw = await safeKVGet(KV, `temanops_log_target:${sourceChatId}`);
  const data = safeJSON(raw, null);

  if (data?.chat_id) {
    return {
      chat_id: Number(data.chat_id),
      thread_id: data.thread_id ? Number(data.thread_id) : undefined
    };
  }

  // legacy fallback untuk grup lama
  if (Number(sourceChatId) === Number(GROUP_ID)) {
    return {
      chat_id: Number(GROUP_ID),
      thread_id: Number(LOG_THREAD_ID)
    };
  }

  // default: log ke grup asal, tanpa topic
  return {
    chat_id: Number(sourceChatId),
    thread_id: undefined
  };
}

// ================== PER-GROUP KV ==================
function gkey(chatId, key) {
  return `group:${chatId}:${key}`;
}

async function getGroupKV(KV, chatId, key) {
  try {
    const val = await KV.get(gkey(chatId, key));
    return val === null ? (DEFAULTS[key] ?? null) : val;
  } catch (err) {
    console.log(`KV GET FAILED [group:${chatId}:${key}]:`, err?.message || err);
    return DEFAULTS[key] ?? null;
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
  if (!userId) return false;

  const data = await tg(API, "getChatMember", {
    chat_id: chatId,
    user_id: userId
  });

  return !!(data?.result && ["administrator", "creator"].includes(data.result.status));
}

async function isCreator(API, chatId, userId) {
  if (!userId) return false;

  const data = await tg(API, "getChatMember", {
    chat_id: chatId,
    user_id: userId
  });

  return data?.result?.status === "creator";
}

function isAnonymousGroupAdminMessage(msg) {
  return !!(
    msg?.chat?.id &&
    msg?.sender_chat?.id &&
    String(msg.sender_chat.id) === String(msg.chat.id)
  );
}

async function canManageTemanOps(API, msg) {
  if (await isCreator(API, msg.chat.id, msg.from?.id)) {
    return true;
  }

  if (isAnonymousGroupAdminMessage(msg)) {
    return true;
  }

  return false;
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
