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
      // ===== JOIN VIA chat_member (legacy welcome: group lama saja) =====
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

        if (newUser?.id) {
          await cacheUserIdentity(KV, GROUP_ID, newUser);
        }

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

      // ===== CACHE USER IDENTITIES =====
      if (msg.from?.id && !msg.from?.is_bot) {
        await cacheUserIdentity(KV, chatId, msg.from);
      }

      if (msg.reply_to_message?.from?.id && !msg.reply_to_message?.from?.is_bot) {
        await cacheUserIdentity(KV, chatId, msg.reply_to_message.from);
      }

      if (Array.isArray(msg.new_chat_members)) {
        for (const member of msg.new_chat_members) {
          if (member?.id && !member?.is_bot) {
            await cacheUserIdentity(KV, chatId, member);
          }
        }
      }

      // ===== FALLBACK JOIN VIA new_chat_members (legacy welcome: group lama saja) =====
      if (msg?.chat?.id === GROUP_ID && Array.isArray(msg.new_chat_members)) {
        for (const member of msg.new_chat_members) {
          if (!member?.is_bot) {
            await welcome(API, KV, member);
          }
        }
        return new Response("OK");
      }

      // ===== GROUP COMMANDS =====
      if (
        ["group", "supergroup"].includes(msg.chat.type) &&
        typeof msg.text === "string" &&
        msg.text.startsWith("/")
      ) {
        const handled = await handleGroupCommand(API, msg, KV);
        if (handled) return new Response("OK");
      }

      // ===== PRIVATE COMMAND =====
      if (msg.chat.type === "private" && msg.text?.startsWith("/")) {
        const step = await getWelcomeStep(KV, msg.from?.id);
        if (step && msg.from?.id) await clearWelcomeStep(KV, msg.from.id);

        await handlePrivateCommand(API, msg, KV);
        return new Response("OK");
      }

      // ===== WELCOME SETUP (PRIVATE ONLY / LEGACY) =====
      if (msg.chat.type === "private") {
        const userId = msg.from?.id;
        if (!userId) return new Response("OK");

        const step = await getWelcomeStep(KV, userId);
        if (!step) return new Response("OK");

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
        await shouldRunModeration(KV, chatId)
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

// ================== GROUP COMMANDS ==================
async function handleGroupCommand(API, msg, KV) {
  const parts = String(msg.text || "").trim().split(/\s+/);
  const raw = parts[0] || "";
  const a = parts[1];
  const b = parts[2];
  const cmd = raw.split("@")[0].toLowerCase();
  const chatId = Number(msg.chat.id);

  const groupOnlyCommands = new Set([
    "/aktifkantemanops",
    "/nonaktifkantemanops",
    "/statustemanops",
    "/aktifkanlogtemanops",
    "/banword",
    "/linkwhitelist",
    "/linkblacklist",
    "/antiflood",
    "/setmutetime",
    "/unmute",
    "/listcmdgroup"
  ]);

  if (!groupOnlyCommands.has(cmd)) return false;

  if (!["group", "supergroup"].includes(msg.chat.type)) {
    await send(API, msg.chat.id, "❌ Command ini hanya di group");
    return true;
  }

  if (cmd === "/aktifkantemanops") {
    const allowed = await canManageTemanOps(API, msg);
    if (!allowed) {
      await send(
        API,
        msg.chat.id,
        "❌ Command ini hanya untuk *owner* atau *anonymous admin atas nama group ini*"
      );
      return true;
    }

    await setTemanOpsEnabled(KV, chatId, true);
    await safeKVPut(KV, `temanops_title:${chatId}`, String(msg.chat.title || chatId));

    // Default log ke General saat pertama diaktifkan
    await setGroupLogTarget(KV, chatId, chatId, null);

    await send(API, msg.chat.id, "✅ *TeManOps aktif* di group ini");
    return true;
  }

  if (cmd === "/nonaktifkantemanops") {
    const allowed = await canManageTemanOps(API, msg);
    if (!allowed) {
      await send(
        API,
        msg.chat.id,
        "❌ Command ini hanya untuk *owner* atau *anonymous admin atas nama group ini*"
      );
      return true;
    }

    if (chatId === Number(GROUP_ID)) {
      await send(API, msg.chat.id, "⚠️ Group legacy utama tidak bisa dinonaktifkan pada tahap ini");
      return true;
    }

    await setTemanOpsEnabled(KV, chatId, false);
    await safeKVPut(KV, `temanops_title:${chatId}`, String(msg.chat.title || chatId));

    await send(API, msg.chat.id, "⛔ *TeManOps nonaktif* di group ini");
    return true;
  }

  if (cmd === "/statustemanops") {
    const enabled = await isTemanOpsEnabled(KV, chatId);
    const title = await getTemanOpsTitle(KV, chatId);
    const logTarget = await getGroupLogTarget(KV, chatId);

    let logInfo = "General";
    if (logTarget?.thread_id) {
      logInfo = `Topic ID ${logTarget.thread_id}`;
    }

    await send(
      API,
      msg.chat.id,
      enabled
        ? `✅ Status TeManOps: *AKTIF*\n🏠 Group: ${escapeBasicMarkdown(title)}\n📝 Log target: ${escapeBasicMarkdown(logInfo)}`
        : `⛔ Status TeManOps: *NONAKTIF*\n🏠 Group: ${escapeBasicMarkdown(title)}\n📝 Log target: ${escapeBasicMarkdown(logInfo)}`
    );
    return true;
  }

  const adminAllowed = await canUseGroupAdminCommands(API, msg, KV);
  if (!adminAllowed.ok) {
    await send(API, msg.chat.id, adminAllowed.message);
    return true;
  }

  if (cmd === "/aktifkanlogtemanops") {
    const threadId = msg.message_thread_id ? Number(msg.message_thread_id) : null;

    await setGroupLogTarget(KV, chatId, chatId, threadId);

    if (threadId) {
      await send(
        API,
        msg.chat.id,
        "✅ Log TeManOps untuk group ini sekarang diarahkan ke topic ini.",
        threadId
      );
    } else {
      await send(
        API,
        msg.chat.id,
        "✅ Log TeManOps untuk group ini sekarang diarahkan ke General."
      );
    }
    return true;
  }

  if (cmd === "/listcmdgroup") {
    await send(
      API,
      msg.chat.id,
`🛠️ *Group Commands*

*Status*
• /aktifkantemanops
• /nonaktifkantemanops
• /statustemanops
• /aktifkanlogtemanops

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

*User Control*
• /unmute [@username|user_id]
• reply pesan user lalu /unmute

ℹ️ /aktifkanlogtemanops dijalankan di topic target log.
ℹ️ Kalau belum pernah diaktifkan, log tetap ke General.
ℹ️ Untuk @username, user harus sudah pernah terlihat oleh bot di group ini.`
    );
    return true;
  }

  if (cmd === "/banword") {
    if (!a) {
      await send(
        API,
        msg.chat.id,
        "❌ Format:\n/banword add <kata>\n/banword del <kata>\n/banword list"
      );
      return true;
    }

    let list = String(await getGroupKV(KV, chatId, "banned_words"))
      .split(",")
      .map(x => x.trim().toLowerCase())
      .filter(Boolean);

    if (a === "list") {
      if (list.length === 0) {
        await send(API, msg.chat.id, "📭 Banword masih kosong");
        return true;
      }

      await send(
        API,
        msg.chat.id,
        `🚫 *Daftar Banword*\n\n${list.map((w, i) => `${i + 1}. ${escapeBasicMarkdown(w)}`).join("\n")}`
      );
      return true;
    }

    if (!b) {
      await send(
        API,
        msg.chat.id,
        "❌ Format:\n/banword add <kata>\n/banword del <kata>"
      );
      return true;
    }

    const action = a.toLowerCase();
    const word = b.toLowerCase();

    if (action === "add") {
      if (list.includes(word)) {
        await send(API, msg.chat.id, `⚠️ Kata *${escapeBasicMarkdown(word)}* sudah ada`);
        return true;
      }
      list.push(word);
      await safeKVPut(KV, gkey(chatId, "banned_words"), list.join(","));
      await send(API, msg.chat.id, `✅ Kata *${escapeBasicMarkdown(word)}* ditambahkan`);
      return true;
    }

    if (action === "del") {
      if (!list.includes(word)) {
        await send(API, msg.chat.id, `⚠️ Kata *${escapeBasicMarkdown(word)}* tidak ditemukan`);
        return true;
      }
      list = list.filter(w => w !== word);
      await safeKVPut(KV, gkey(chatId, "banned_words"), list.join(","));
      await send(API, msg.chat.id, `🗑️ Kata *${escapeBasicMarkdown(word)}* dihapus`);
      return true;
    }

    await send(API, msg.chat.id, "❌ Gunakan add / del / list");
    return true;
  }

  if (cmd === "/linkwhitelist") {
    if (!["add", "del", "list"].includes(a)) {
      await send(API, msg.chat.id, "❌ /linkwhitelist add|del|list [domain]");
      return true;
    }

    let list = safeJSON(await getGroupKV(KV, chatId, "link_whitelist"), []);

    if (a === "list") {
      await send(API, msg.chat.id, renderAdminList("✅ Link Whitelist", list));
      return true;
    }

    if (!b) {
      await send(API, msg.chat.id, "❌ Domain kosong");
      return true;
    }

    const domain = normalizeDomainInput(b);

    if (a === "add") {
      if (list.includes(domain)) {
        await send(API, msg.chat.id, "⚠️ Domain sudah ada");
        return true;
      }
      list.push(domain);
    }

    if (a === "del") {
      const before = list.length;
      list = list.filter(d => d !== domain);

      if (list.length === before) {
        await send(API, msg.chat.id, "⚠️ Domain tidak ditemukan");
        return true;
      }
    }

    await safeKVPut(KV, gkey(chatId, "link_whitelist"), JSON.stringify(list));
    await send(API, msg.chat.id, `✅ Whitelist diupdate:\n${escapeBasicMarkdown(domain)}`);
    return true;
  }

  if (cmd === "/linkblacklist") {
    if (!["add", "del", "list"].includes(a)) {
      await send(API, msg.chat.id, "❌ /linkblacklist add|del|list [domain]");
      return true;
    }

    let list = safeJSON(await getGroupKV(KV, chatId, "link_blacklist"), []);

    if (a === "list") {
      await send(API, msg.chat.id, renderAdminList("⛔ Link Blacklist", list));
      return true;
    }

    if (!b) {
      await send(API, msg.chat.id, "❌ Domain kosong");
      return true;
    }

    const domain = normalizeDomainInput(b);

    if (a === "add") {
      if (list.includes(domain)) {
        await send(API, msg.chat.id, "⚠️ Domain sudah ada");
        return true;
      }
      list.push(domain);
    }

    if (a === "del") {
      const before = list.length;
      list = list.filter(d => d !== domain);

      if (list.length === before) {
        await send(API, msg.chat.id, "⚠️ Domain tidak ditemukan");
        return true;
      }
    }

    await safeKVPut(KV, gkey(chatId, "link_blacklist"), JSON.stringify(list));
    await send(API, msg.chat.id, `⛔ Blacklist diupdate:\n${escapeBasicMarkdown(domain)}`);
    return true;
  }

  if (cmd === "/antiflood") {
    const limit = Number(a);
    const win = Number(b);

    if (!limit || !win || limit <= 0 || win <= 0) {
      await send(API, msg.chat.id, "❌ Format: /antiflood <limit> <detik>");
      return true;
    }

    await safeKVPut(KV, gkey(chatId, "flood_limit"), String(limit));
    await safeKVPut(KV, gkey(chatId, "flood_window"), String(win));
    await send(API, msg.chat.id, `✅ Anti flood diset: ${limit} pesan / ${win} detik`);
    return true;
  }

  if (cmd === "/setmutetime") {
    const n = Number(a);
    if (!n || n <= 0) {
      await send(API, msg.chat.id, "❌ Angka invalid");
      return true;
    }

    await safeKVPut(KV, gkey(chatId, "mute_minutes"), String(n));
    await send(API, msg.chat.id, `⏱️ Mute diset ${n} menit`);
    return true;
  }

  if (cmd === "/unmute") {
    let targetId = null;
    let targetLabel = "";

    if (msg.reply_to_message?.from?.id) {
      targetId = Number(msg.reply_to_message.from.id);
      targetLabel = msg.reply_to_message.from.username
        ? `@${msg.reply_to_message.from.username}`
        : String(targetId);
    } else {
      const rawTarget = String(a || "").trim();

      if (!rawTarget) {
        await send(
          API,
          msg.chat.id,
          "❌ Gunakan: /unmute @username atau user_id, atau reply pesan user lalu kirim /unmute"
        );
        return true;
      }

      if (/^\d+$/.test(rawTarget)) {
        targetId = Number(rawTarget);
        targetLabel = rawTarget;
      } else if (/^@[\w\d_]{5,}$/.test(rawTarget)) {
        const username = rawTarget.slice(1).toLowerCase();
        const resolvedId = await getCachedUserIdByUsername(KV, chatId, username);

        if (!resolvedId) {
          await send(
            API,
            msg.chat.id,
            "❌ Username belum ditemukan di cache bot.\nSuruh user kirim pesan dulu di group, atau reply pesan user, atau pakai user_id."
          );
          return true;
        }

        targetId = Number(resolvedId);
        targetLabel = rawTarget;
      } else {
        await send(
          API,
          msg.chat.id,
          "❌ Format salah. Gunakan: /unmute @username atau user_id"
        );
        return true;
      }
    }

    if (!targetId) {
      await send(API, msg.chat.id, "❌ User tidak ditemukan");
      return true;
    }

    const ok = await unmute(API, chatId, targetId);

    if (!ok) {
      await send(
        API,
        msg.chat.id,
        `❌ Unmute gagal untuk ${targetLabel || targetId}\nCek apakah bot masih admin dan punya izin restrict members.`
      );
      return true;
    }

    await send(API, msg.chat.id, `🔓 UNMUTE BERHASIL\nTarget: ${targetLabel || targetId}`);
    return true;
  }

  return false;
}

// ================== PRIVATE COMMANDS ==================
async function handlePrivateCommand(API, msg, KV) {
  const parts = String(msg.text || "").trim().split(/\s+/);
  const raw = parts[0] || "";
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

  if (cmd === "/listcmd" || cmd === "/help") {
    return send(
      API,
      msg.chat.id,
`🛠️ *TeManOps*

*Group Commands*
Jalankan langsung di group target:
• /aktifkantemanops
• /nonaktifkantemanops
• /statustemanops
• /aktifkanlogtemanops
• /banword add|del|list
• /linkwhitelist add|del|list
• /linkblacklist add|del|list
• /antiflood [limit] [detik]
• /setmutetime [menit]
• /unmute [@username|user_id]
• reply pesan user lalu /unmute
• /listcmdgroup

*Private Commands*
• /listcmd
• /updatewelcometext
• /updatewelcomemedia
• /addwelcomelink
• /delwelcomelink [judul]
• /listwelcomelink

ℹ️ Untuk @username, user harus sudah pernah terlihat oleh bot di group target.
ℹ️ /aktifkanlogtemanops dijalankan di topic target log.
ℹ️ Kalau belum pernah diaktifkan, log tetap ke General.
ℹ️ Untuk sekarang, setting moderation dilakukan langsung dari group.
ℹ️ Welcome masih mode legacy.`
    );
  }

  const is_user_admin = await isAdmin(API, GROUP_ID, msg.from?.id);
  if (!is_user_admin) {
    return send(API, msg.chat.id, "❌ Bukan admin group legacy");
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

  return send(API, msg.chat.id, "ℹ️ Command itu sekarang dijalankan langsung di group target.");
}

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

  const res = await tg(API, "restrictChatMember", {
    chat_id: chatId,
    user_id: userId,
    until_date: until,
    use_independent_chat_permissions: true,
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
      can_pin_messages: false,
      can_manage_topics: false
    }
  });

  return !!res?.ok;
}

async function unmute(API, chatId, userId) {
  const res = await tg(API, "restrictChatMember", {
    chat_id: chatId,
    user_id: userId,
    use_independent_chat_permissions: true,
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
      can_pin_messages: false,
      can_manage_topics: false
    }
  });

  return !!res?.ok;
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

// ================== ENABLE / STATUS ==================
async function shouldRunModeration(KV, chatId) {
  const n = Number(chatId);
  if (!n) return false;
  if (n === Number(GROUP_ID)) return true;
  return await isTemanOpsEnabled(KV, n);
}

async function setTemanOpsEnabled(KV, chatId, enabled) {
  await safeKVPut(KV, `temanops_enabled:${chatId}`, enabled ? "1" : "0");
  await safeKVPut(KV, `temanops_group_registry:${chatId}`, "1");
  return true;
}

async function isTemanOpsEnabled(KV, chatId) {
  if (Number(chatId) === Number(GROUP_ID)) return true;
  const val = await safeKVGet(KV, `temanops_enabled:${chatId}`);
  return val === "1";
}

async function getTemanOpsTitle(KV, chatId) {
  return (
    await safeKVGet(KV, `temanops_title:${chatId}`)
  ) || (Number(chatId) === Number(GROUP_ID) ? "Legacy Group" : String(chatId));
}

// ================== LOG TARGET ==================
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

  // Default: semua group fallback ke General group itu sendiri
  return {
    chat_id: Number(sourceChatId),
    thread_id: undefined
  };
}

// ================== USER CACHE ==================
async function cacheUserIdentity(KV, chatId, user) {
  try {
    if (!user?.id || user?.is_bot) return false;

    const uid = Number(user.id);
    await safeKVPut(KV, `usercache:id:${uid}`, JSON.stringify({
      id: uid,
      username: user.username || "",
      first_name: user.first_name || "",
      last_name: user.last_name || ""
    }));

    if (user.username) {
      const uname = String(user.username).trim().replace(/^@/, "").toLowerCase();
      if (uname) {
        await safeKVPut(KV, `usercache:group:${chatId}:uname:${uname}`, String(uid));
        await safeKVPut(KV, `usercache:global:uname:${uname}`, String(uid));
      }
    }

    return true;
  } catch (err) {
    console.log("CACHE USER FAILED:", err?.message || err);
    return false;
  }
}

async function getCachedUserIdByUsername(KV, chatId, username) {
  const uname = String(username || "").trim().replace(/^@/, "").toLowerCase();
  if (!uname) return null;

  const local = await safeKVGet(KV, `usercache:group:${chatId}:uname:${uname}`);
  if (local && /^\d+$/.test(local)) return Number(local);

  const global = await safeKVGet(KV, `usercache:global:uname:${uname}`);
  if (global && /^\d+$/.test(global)) return Number(global);

  return null;
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

function normalizeDomainInput(input) {
  const s = String(input || "").trim().toLowerCase();
  if (!s) return s;

  try {
    const withProtocol = /^https?:\/\//i.test(s) ? s : `https://${s}`;
    const u = new URL(withProtocol);
    const host = (u.hostname || "").replace(/^www\./, "");
    const path = (u.pathname && u.pathname !== "/") ? u.pathname : "";
    return path ? `${host}${path}` : host;
  } catch {
    return s
      .replace(/^https?:\/\//i, "")
      .replace(/^www\./i, "")
      .replace(/\/+$/g, "");
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

async function canUseGroupAdminCommands(API, msg, KV) {
  const chatId = Number(msg.chat.id);
  const enabled = await isTemanOpsEnabled(KV, chatId);

  if (!enabled) {
    return {
      ok: false,
      message: "❌ TeManOps belum aktif di group ini. Jalankan /aktifkantemanops dulu."
    };
  }

  if (isAnonymousGroupAdminMessage(msg)) {
    return { ok: true };
  }

  const admin = await isAdmin(API, chatId, msg.from?.id);
  if (!admin) {
    return {
      ok: false,
      message: "❌ Command ini hanya untuk admin / creator group ini"
    };
  }

  return { ok: true };
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
