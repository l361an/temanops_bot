import { GROUP_ID } from "../config.js";
import { send, safeKVPut, getGroupKV } from "../kv.js";
import {
  canManageTemanOps,
  canUseGroupAdminCommands
} from "../permissions.js";
import {
  setTemanOpsEnabled,
  isTemanOpsEnabled,
  getTemanOpsTitle,
  setGroupLogTarget,
  getGroupLogTarget
} from "../status.js";
import { mute, unmute } from "../moderation.js";
import { getCachedUserIdByUsername } from "../userCache.js";
import {
  setUsernameWatchTarget,
  getUsernameWatchTarget,
  clearUsernameWatchTarget
} from "../surveillance.js";
import {
  setIdentityTrackerTarget,
  getIdentityTrackerTarget,
  clearIdentityTrackerTarget
} from "../identityTracker.js";
import { escapeBasicMarkdown } from "../utils.js";

function normalizeTelegramUsername(value) {
  return String(value || "").trim().replace(/^@+/, "").toLowerCase();
}

function isReservedAnonymousUsername(rawTarget) {
  return normalizeTelegramUsername(rawTarget) === "groupanonymousbot";
}

function classifyReplyTarget(replyMsg, chatId) {
  if (!replyMsg) return { kind: "none" };

  if (replyMsg.sender_chat?.id) {
    if (String(replyMsg.sender_chat.id) === String(chatId)) {
      return { kind: "anonymous_admin" };
    }
    return { kind: "sender_chat" };
  }

  const repliedUser = replyMsg.from;
  if (!repliedUser?.id) {
    return { kind: "unknown" };
  }

  const uname = normalizeTelegramUsername(repliedUser.username);
  if (uname === "groupanonymousbot") {
    return { kind: "anonymous_admin" };
  }

  if (repliedUser.is_bot) {
    return { kind: "bot", user: repliedUser };
  }

  return { kind: "user", user: repliedUser };
}

function extractTargetIdFromBotReply(replyMsg) {
  const replyText = String(replyMsg?.text || replyMsg?.caption || "");
  const idMatch = replyText.match(/Target ID:\s*(\d+)/i);
  return idMatch ? Number(idMatch[1]) : null;
}

export async function handleGroupCommand(API, msg, KV) {
  const parts = String(msg.text || "").trim().split(/\s+/);
  const raw = parts[0] || "";
  const a = parts[1];
  const cmd = raw.split("@")[0].toLowerCase();
  const chatId = Number(msg.chat.id);
  const replyThreadId = msg.message_thread_id ? Number(msg.message_thread_id) : null;

  const reply = (text) => send(API, msg.chat.id, text, replyThreadId);

  const temanOpsAction = String(parts[1] || "").trim().toLowerCase();
  const logAction = String(parts[1] || "").trim().toLowerCase();

  const requireGeneralOnly = async () => {
    if (replyThreadId) {
      await reply("❌ Command ini wajib dijalankan di *General*.");
      return true;
    }
    return false;
  };

  const requireTopicOnly = async (label) => {
    if (!replyThreadId) {
      await reply(`❌ Command ini wajib dijalankan di topic target ${label}, bukan di *General*.`);
      return true;
    }
    return false;
  };

  const groupCommands = new Set([
    "/temanops",
    "/log",
    "/aktifkanpengawasan",
    "/nonaktifkanpengawasan",
    "/statuspengawasan",
    "/aktifkantracker",
    "/nonaktifkantracker",
    "/statustracker",
    "/mute",
    "/unmute",
    "/listcmdgroup"
  ]);

  const movedToPrivateCommands = new Set([
    "/banword",
    "/linkwhitelist",
    "/linkblacklist",
    "/linkmode",
    "/antiflood",
    "/setmutetime",
    "/updatewelcometext",
    "/updatewelcomemedia",
    "/delwelcomemedia",
    "/addwelcomelink",
    "/delwelcomelink",
    "/listwelcomelink"
  ]);

  const creatorOnlyRuntimeCommands = new Set([
    "/aktifkanpengawasan",
    "/nonaktifkanpengawasan",
    "/aktifkantracker",
    "/nonaktifkantracker"
  ]);

  if (!["group", "supergroup"].includes(msg.chat.type)) {
    if (groupCommands.has(cmd) || movedToPrivateCommands.has(cmd)) {
      await send(API, msg.chat.id, "❌ Command ini hanya di group");
      return true;
    }
    return false;
  }

  if (movedToPrivateCommands.has(cmd)) {
    await reply(
      "ℹ️ Command config ini sekarang dijalankan via private bot.\nGunakan /listgroup di private, lalu pilih group target dengan /setgroup.\nBot akan tampilkan nama group + ID agar tidak ketuker."
    );
    return true;
  }

  if (!groupCommands.has(cmd)) return false;

  if (cmd === "/temanops" && !["on", "off", "status"].includes(temanOpsAction)) {
    await reply("❌ Gunakan: /temanops on\n/temanops off\n/temanops status");
    return true;
  }

  if (cmd === "/temanops" && temanOpsAction === "on") {
    if (await requireGeneralOnly()) return true;

    const allowed = await canManageTemanOps(API, msg);
    if (!allowed) {
      await reply(
        "❌ Command ini hanya untuk *owner* atau *anonymous admin atas nama group ini*"
      );
      return true;
    }

    await setTemanOpsEnabled(KV, chatId, true);
    await safeKVPut(KV, `temanops_title:${chatId}`, String(msg.chat.title || chatId));
    await setGroupLogTarget(KV, chatId, chatId, null);

    await reply("✅ *TeManOps aktif* di group ini");
    return true;
  }

  if (cmd === "/temanops" && temanOpsAction === "off") {
    if (await requireGeneralOnly()) return true;

    const allowed = await canManageTemanOps(API, msg);
    if (!allowed) {
      await reply(
        "❌ Command ini hanya untuk *owner* atau *anonymous admin atas nama group ini*"
      );
      return true;
    }

    if (chatId === Number(GROUP_ID)) {
      await reply(
        "⚠️ Group legacy utama tidak bisa dinonaktifkan pada tahap ini"
      );
      return true;
    }

    await setTemanOpsEnabled(KV, chatId, false);
    await safeKVPut(KV, `temanops_title:${chatId}`, String(msg.chat.title || chatId));

    await reply("⛔ *TeManOps nonaktif* di group ini");
    return true;
  }

  if (cmd === "/temanops" && temanOpsAction === "status") {
    if (await requireGeneralOnly()) return true;

    const enabled = await isTemanOpsEnabled(KV, chatId);
    const title = await getTemanOpsTitle(KV, chatId);
    const logTarget = await getGroupLogTarget(KV, chatId);

    let logInfo = "General";
    if (logTarget?.thread_id) {
      logInfo = `Topic ID ${logTarget.thread_id}`;
    }

    await reply(
      enabled
        ? `✅ Status TeManOps: *AKTIF*\n🏠 Group: ${escapeBasicMarkdown(title)}\n🆔 ID: \`${chatId}\`\n📝 Log target: ${escapeBasicMarkdown(logInfo)}`
        : `⛔ Status TeManOps: *NONAKTIF*\n🏠 Group: ${escapeBasicMarkdown(title)}\n🆔 ID: \`${chatId}\`\n📝 Log target: ${escapeBasicMarkdown(logInfo)}`
    );
    return true;
  }

  if (cmd === "/log" && !["on", "off", "status"].includes(logAction)) {
    await reply("❌ Gunakan: /log on\n/log off\n/log status");
    return true;
  }

  const adminAllowed = await canUseGroupAdminCommands(API, msg, KV);
  if (!adminAllowed.ok) {
    await reply(adminAllowed.message);
    return true;
  }

  if (cmd === "/log") {
    const allowed = await canManageTemanOps(API, msg);
    if (!allowed) {
      await reply(
        "❌ Command ini hanya untuk *owner* atau *anonymous admin atas nama group ini*"
      );
      return true;
    }

    if (logAction === "on") {
      if (await requireTopicOnly("log")) return true;

      await setGroupLogTarget(KV, chatId, chatId, replyThreadId);

      await send(
        API,
        msg.chat.id,
        "✅ Log TeManOps untuk group ini sekarang diarahkan ke topic ini.",
        replyThreadId
      );
      return true;
    }

    if (logAction === "off") {
      const currentTarget = await getGroupLogTarget(KV, chatId);

      if (!currentTarget?.thread_id) {
        await reply("⚠️ Log TeManOps saat ini sudah diarahkan ke *General*.");
        return true;
      }

      if (!replyThreadId) {
        await reply(
          "❌ Command ini wajib dijalankan di topic target log yang sedang aktif."
        );
        return true;
      }

      if (Number(currentTarget.thread_id) !== replyThreadId) {
        await reply("⚠️ Topic ini bukan target log TeManOps yang aktif.");
        return true;
      }

      await setGroupLogTarget(KV, chatId, chatId, null);
      await reply("✅ Log TeManOps untuk group ini dikembalikan ke *General*.");
      return true;
    }

    if (logAction === "status") {
      const title = await getTemanOpsTitle(KV, chatId);
      const currentTarget = await getGroupLogTarget(KV, chatId);
      const targetLabel = currentTarget?.thread_id
        ? `Topic ID ${currentTarget.thread_id}`
        : "General";

      await reply(
        `📝 *Status Log TeManOps*\n\n🏠 Group: ${escapeBasicMarkdown(title)}\n🆔 ID: \`${chatId}\`\n📌 Target: ${escapeBasicMarkdown(targetLabel)}`
      );
      return true;
    }
  }

  if (creatorOnlyRuntimeCommands.has(cmd)) {
    const allowed = await canManageTemanOps(API, msg);
    if (!allowed) {
      await reply(
        "❌ Command ini hanya untuk *owner* atau *anonymous admin atas nama group ini*"
      );
      return true;
    }
  }

  if (cmd === "/aktifkanpengawasan") {
    if (await requireTopicOnly("pengawasan")) return true;

    await setUsernameWatchTarget(KV, chatId, chatId, replyThreadId);

    await send(
      API,
      msg.chat.id,
      "✅ Pengawasan user tanpa username sekarang aktif di topic ini.\nKartu pengawasan akan otomatis dihapus saat user sudah pasang username.",
      replyThreadId
    );
    return true;
  }

  if (cmd === "/nonaktifkanpengawasan") {
    const target = await getUsernameWatchTarget(KV, chatId);

    if (!target?.chat_id) {
      await reply("⚠️ Pengawasan user tanpa username saat ini *NONAKTIF*.");
      return true;
    }

    if (!target.thread_id) {
      if (replyThreadId) {
        await reply("⚠️ Pengawasan aktif di *General*. Jalankan command ini di *General*.");
        return true;
      }

      await clearUsernameWatchTarget(KV, chatId);
      await reply("✅ Pengawasan user tanpa username dinonaktifkan untuk group ini.");
      return true;
    }

    if (!replyThreadId) {
      await reply(
        "❌ Command ini wajib dijalankan di topic target pengawasan yang sedang aktif."
      );
      return true;
    }

    if (Number(target.thread_id) !== replyThreadId) {
      await reply("⚠️ Topic ini bukan target pengawasan yang aktif.");
      return true;
    }

    await clearUsernameWatchTarget(KV, chatId);
    await reply("✅ Pengawasan user tanpa username dinonaktifkan untuk group ini.");
    return true;
  }

  if (cmd === "/statuspengawasan") {
    const title = await getTemanOpsTitle(KV, chatId);
    const target = await getUsernameWatchTarget(KV, chatId);

    if (!target?.chat_id) {
      await reply(
        `👁️ *Status Pengawasan Username*\n\n🏠 Group: ${escapeBasicMarkdown(title)}\n🆔 ID: \`${chatId}\`\n📌 Status: NONAKTIF\n📝 Target: -`
      );
      return true;
    }

    if (!target.thread_id) {
      if (replyThreadId) {
        await reply("⚠️ Pengawasan aktif di *General*, bukan di topic ini.");
        return true;
      }

      await reply(
        `👁️ *Status Pengawasan Username*\n\n🏠 Group: ${escapeBasicMarkdown(title)}\n🆔 ID: \`${chatId}\`\n📌 Status: AKTIF\n📝 Target: General`
      );
      return true;
    }

    if (!replyThreadId) {
      await reply("⚠️ Pengawasan aktif di topic lain, bukan di *General*.");
      return true;
    }

    if (Number(target.thread_id) !== replyThreadId) {
      await reply("⚠️ Topic ini bukan target pengawasan yang aktif.");
      return true;
    }

    await reply(
      `👁️ *Status Pengawasan Username*\n\n🏠 Group: ${escapeBasicMarkdown(title)}\n🆔 ID: \`${chatId}\`\n📌 Status: AKTIF\n📝 Target: Topic ID ${target.thread_id}`
    );
    return true;
  }

  if (cmd === "/aktifkantracker") {
    if (await requireTopicOnly("tracker")) return true;

    await setIdentityTrackerTarget(KV, chatId, chatId, replyThreadId);

    await send(
      API,
      msg.chat.id,
      "✅ Tracker identitas sekarang aktif di topic ini.\nPerubahan username / nama akan dikirim ke topic ini.",
      replyThreadId
    );
    return true;
  }

  if (cmd === "/nonaktifkantracker") {
    const target = await getIdentityTrackerTarget(KV, chatId);

    if (!target?.chat_id) {
      await reply("⚠️ Tracker identitas saat ini *NONAKTIF*.");
      return true;
    }

    if (!target.thread_id) {
      if (replyThreadId) {
        await reply("⚠️ Tracker identitas aktif di *General*. Jalankan command ini di *General*.");
        return true;
      }

      await clearIdentityTrackerTarget(KV, chatId);
      await reply("✅ Tracker identitas dinonaktifkan untuk group ini.");
      return true;
    }

    if (!replyThreadId) {
      await reply(
        "❌ Command ini wajib dijalankan di topic target tracker yang sedang aktif."
      );
      return true;
    }

    if (Number(target.thread_id) !== replyThreadId) {
      await reply("⚠️ Topic ini bukan target tracker identitas yang aktif.");
      return true;
    }

    await clearIdentityTrackerTarget(KV, chatId);
    await reply("✅ Tracker identitas dinonaktifkan untuk group ini.");
    return true;
  }

  if (cmd === "/statustracker") {
    const title = await getTemanOpsTitle(KV, chatId);
    const target = await getIdentityTrackerTarget(KV, chatId);

    if (!target?.chat_id) {
      await reply(
        `🕵️ *Status Tracker Identitas*\n\n🏠 Group: ${escapeBasicMarkdown(title)}\n🆔 ID: \`${chatId}\`\n📌 Status: NONAKTIF\n📝 Target: -`
      );
      return true;
    }

    if (!target.thread_id) {
      if (replyThreadId) {
        await reply("⚠️ Tracker identitas aktif di *General*, bukan di topic ini.");
        return true;
      }

      await reply(
        `🕵️ *Status Tracker Identitas*\n\n🏠 Group: ${escapeBasicMarkdown(title)}\n🆔 ID: \`${chatId}\`\n📌 Status: AKTIF\n📝 Target: General`
      );
      return true;
    }

    if (!replyThreadId) {
      await reply("⚠️ Tracker identitas aktif di topic lain, bukan di *General*.");
      return true;
    }

    if (Number(target.thread_id) !== replyThreadId) {
      await reply("⚠️ Topic ini bukan target tracker identitas yang aktif.");
      return true;
    }

    await reply(
      `🕵️ *Status Tracker Identitas*\n\n🏠 Group: ${escapeBasicMarkdown(title)}\n🆔 ID: \`${chatId}\`\n📌 Status: AKTIF\n📝 Target: Topic ID ${target.thread_id}`
    );
    return true;
  }

  if (cmd === "/listcmdgroup") {
    await reply(
`🛠️ *Group Commands*

*General Only*
• /temanops on
• /temanops off
• /temanops status

*Topic Log*
• /log on
• /log off
• /log status

*Topic Pengawasan Username*
• /aktifkanpengawasan
• /nonaktifkanpengawasan
• /statuspengawasan

*Topic Tracker Identitas*
• /aktifkantracker
• /nonaktifkantracker
• /statustracker

*User Control*
• reply pesan user lalu /mute
• reply pesan user lalu /mute [menit]
• /unmute [@username|user_id]
• reply pesan user lalu /unmute

*Config Commands via Private Bot*
• /listgroup
• /setgroup [group_id]
• /groupaktif
• /cleargroup
• /banword add|del|list
• /linkwhitelist add|del|list
• /linkblacklist add|del|list
• /linkmode hybrid|whitelistonly|status
• /antiflood [limit] [detik]
• /setmutetime [menit]
• /updatewelcometext
• /updatewelcomemedia
• /delwelcomemedia
• /addwelcomelink
• /delwelcomelink [judul]
• /listwelcomelink

ℹ️ Command status hidup-mati TeManOps wajib dijalankan di *General*.
ℹ️ /log on dan /log off dijalankan di topic target log.
ℹ️ /log status menampilkan target log aktif saat ini.
ℹ️ /aktifkanpengawasan, /nonaktifkanpengawasan, dan /statuspengawasan dijalankan di topic target pengawasan.
ℹ️ /aktifkantracker, /nonaktifkantracker, dan /statustracker dijalankan di topic target tracker identitas.
ℹ️ Untuk @username, user harus sudah pernah terlihat oleh bot di group ini.`
    );
    return true;
  }

  if (cmd === "/mute") {
    let targetId = null;
    let targetLabel = "";
    const defaultMinutes = Number(await getGroupKV(KV, chatId, "mute_minutes")) || 60;
    let minutes = defaultMinutes;

    if (msg.reply_to_message) {
      const replyTarget = classifyReplyTarget(msg.reply_to_message, chatId);

      if (replyTarget.kind === "user") {
        targetId = Number(replyTarget.user.id);
        targetLabel = replyTarget.user.username
          ? `@${replyTarget.user.username}`
          : String(targetId);

        if (a) {
          if (!/^\d+$/.test(String(a).trim())) {
            await reply(
              "❌ Format salah.\nGunakan reply pesan user lalu /mute atau /mute <menit>"
            );
            return true;
          }
          minutes = Number(a);
        }
      } else if (replyTarget.kind === "anonymous_admin" || replyTarget.kind === "sender_chat") {
        await reply(
          "❌ Reply target ini bukan member asli. Jangan reply pesan anonymous admin / sender chat. Reply pesan user asli lalu kirim /mute."
        );
        return true;
      } else {
        await reply(
          "❌ Gunakan reply pesan user lalu /mute atau /mute <menit>\n\nContoh:\n• reply user lalu /mute\n• reply user lalu /mute 30"
        );
        return true;
      }
    } else {
      await reply(
        "❌ Gunakan reply pesan user lalu /mute atau /mute <menit>\n\nContoh:\n• reply user lalu /mute\n• reply user lalu /mute 30"
      );
      return true;
    }

    if (!targetId) {
      await reply("❌ User tidak ditemukan");
      return true;
    }

    if (!minutes || minutes <= 0) {
      await reply("❌ Durasi mute harus lebih dari 0 menit.");
      return true;
    }

    const ok = await mute(API, chatId, targetId, minutes);

    if (!ok) {
      await reply(
        `❌ Mute gagal untuk ${targetLabel || targetId}\nCek apakah bot masih admin dan punya izin restrict members.`
      );
      return true;
    }

    await reply(
      `🔇 MUTE BERHASIL\nTarget: ${targetLabel || targetId}\nTarget ID: ${targetId}\nDurasi: ${minutes} menit`
    );
    return true;
  }

  if (cmd === "/unmute") {
    let targetId = null;
    let targetLabel = "";
    const rawTarget = String(a || "").trim();

    if (rawTarget) {
      if (/^\d+$/.test(rawTarget)) {
        targetId = Number(rawTarget);
        targetLabel = rawTarget;
      } else if (/^@[\w\d_]{5,}$/.test(rawTarget)) {
        if (isReservedAnonymousUsername(rawTarget)) {
          await reply(
            "❌ @GroupAnonymousBot bukan member asli. Gunakan /unmute @username member atau user_id member yang valid."
          );
          return true;
        }

        const username = rawTarget.slice(1).toLowerCase();
        const resolvedId = await getCachedUserIdByUsername(KV, chatId, username);

        if (!resolvedId) {
          await reply(
            "❌ Username belum ditemukan di cache bot.\nSuruh user kirim pesan dulu di group, atau reply pesan user, atau pakai user_id."
          );
          return true;
        }

        targetId = Number(resolvedId);
        targetLabel = rawTarget;
      } else {
        await reply(
          "❌ Format salah. Gunakan: /unmute @username atau user_id"
        );
        return true;
      }
    } else if (msg.reply_to_message) {
      const replyTarget = classifyReplyTarget(msg.reply_to_message, chatId);

      if (replyTarget.kind === "user") {
        targetId = Number(replyTarget.user.id);
        targetLabel = replyTarget.user.username
          ? `@${replyTarget.user.username}`
          : String(targetId);
      } else if (replyTarget.kind === "bot") {
        const parsedTargetId = extractTargetIdFromBotReply(msg.reply_to_message);
        if (!parsedTargetId) {
          await reply(
            "❌ Reply ke pesan user asli, atau reply ke pesan bot yang berisi *Target ID*, atau pakai /unmute @username / user_id"
          );
          return true;
        }

        targetId = parsedTargetId;
        targetLabel = String(parsedTargetId);
      } else if (replyTarget.kind === "anonymous_admin" || replyTarget.kind === "sender_chat") {
        await reply(
          "❌ Reply target ini adalah anonymous admin / sender chat, bukan member asli. Reply pesan user asli, atau pakai /unmute @username / user_id."
        );
        return true;
      } else {
        await reply(
          "❌ Reply ke pesan user asli, atau pakai /unmute @username / user_id"
        );
        return true;
      }
    } else {
      await reply(
        "❌ Gunakan: /unmute @username atau user_id, atau reply pesan user / pesan mute bot lalu kirim /unmute"
      );
      return true;
    }

    if (!targetId) {
      await reply("❌ User tidak ditemukan");
      return true;
    }

    const ok = await unmute(API, chatId, targetId);

    if (!ok) {
      await reply(
        `❌ Unmute gagal untuk ${targetLabel || targetId}\nCek apakah bot masih admin dan punya izin restrict members.`
      );
      return true;
    }

    await reply(`🔓 UNMUTE BERHASIL\nTarget: ${targetLabel || targetId}`);
    return true;
  }

  return false;
}
