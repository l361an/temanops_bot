// commands/group.js

import { GROUP_ID } from "../config.js";
import { send, safeKVPut } from "../kv.js";
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
import { unmute } from "../moderation.js";
import { getCachedUserIdByUsername } from "../userCache.js";
import {
  setUsernameWatchTarget,
  getUsernameWatchTarget,
  clearUsernameWatchTarget
} from "../surveillance.js";
import { escapeBasicMarkdown } from "../utils.js";

export async function handleGroupCommand(API, msg, KV) {
  const parts = String(msg.text || "").trim().split(/\s+/);
  const raw = parts[0] || "";
  const a = parts[1];
  const cmd = raw.split("@")[0].toLowerCase();
  const chatId = Number(msg.chat.id);
  const replyThreadId = msg.message_thread_id ? Number(msg.message_thread_id) : null;

  const reply = (text) => send(API, msg.chat.id, text, replyThreadId);

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
    "/aktifkantemanops",
    "/nonaktifkantemanops",
    "/statustemanops",
    "/aktifkanlogtemanops",
    "/nonaktifkanlogtemanops",
    "/aktifkanpengawasan",
    "/nonaktifkanpengawasan",
    "/statuspengawasan",
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
    "/addwelcomelink",
    "/delwelcomelink",
    "/listwelcomelink"
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

  if (cmd === "/aktifkantemanops") {
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

  if (cmd === "/nonaktifkantemanops") {
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

  if (cmd === "/statustemanops") {
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

  const adminAllowed = await canUseGroupAdminCommands(API, msg, KV);
  if (!adminAllowed.ok) {
    await reply(adminAllowed.message);
    return true;
  }

  if (cmd === "/aktifkanlogtemanops") {
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

  if (cmd === "/nonaktifkanlogtemanops") {
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

  if (cmd === "/listcmdgroup") {
    await reply(
`🛠️ *Group Commands*

*General Only*
• /aktifkantemanops
• /nonaktifkantemanops
• /statustemanops

*Topic Log*
• /aktifkanlogtemanops
• /nonaktifkanlogtemanops

*Topic Pengawasan Username*
• /aktifkanpengawasan
• /nonaktifkanpengawasan
• /statuspengawasan

*User Control*
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
• /addwelcomelink
• /delwelcomelink [judul]
• /listwelcomelink

ℹ️ Command status hidup-mati TeManOps wajib dijalankan di *General*.
ℹ️ /aktifkanlogtemanops dan /nonaktifkanlogtemanops dijalankan di topic target log.
ℹ️ /aktifkanpengawasan, /nonaktifkanpengawasan, dan /statuspengawasan dijalankan di topic target pengawasan.
ℹ️ Untuk @username, user harus sudah pernah terlihat oleh bot di group ini.`
    );
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
        await reply(
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
