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
import { escapeBasicMarkdown } from "../utils.js";

export async function handleGroupCommand(API, msg, KV) {
  const parts = String(msg.text || "").trim().split(/\s+/);
  const raw = parts[0] || "";
  const a = parts[1];
  const cmd = raw.split("@")[0].toLowerCase();
  const chatId = Number(msg.chat.id);

  const groupCommands = new Set([
    "/aktifkantemanops",
    "/nonaktifkantemanops",
    "/statustemanops",
    "/aktifkanlogtemanops",
    "/nonaktifkanlogtemanops",
    "/unmute",
    "/listcmdgroup"
  ]);

  const movedToPrivateCommands = new Set([
    "/banword",
    "/linkwhitelist",
    "/linkblacklist",
    "/antiflood",
    "/setmutetime"
  ]);

  if (!["group", "supergroup"].includes(msg.chat.type)) {
    if (groupCommands.has(cmd) || movedToPrivateCommands.has(cmd)) {
      await send(API, msg.chat.id, "❌ Command ini hanya di group");
      return true;
    }
    return false;
  }

  if (movedToPrivateCommands.has(cmd)) {
    await send(
      API,
      msg.chat.id,
      "ℹ️ Command config ini sekarang dijalankan via private bot.\nGunakan /listcmd di private, lalu pilih group target dengan /listgroup dan /setgroup."
    );
    return true;
  }

  if (!groupCommands.has(cmd)) return false;

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
      await send(
        API,
        msg.chat.id,
        "⚠️ Group legacy utama tidak bisa dinonaktifkan pada tahap ini"
      );
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
        ? `✅ Status TeManOps: *AKTIF*\n🏠 Group: ${escapeBasicMarkdown(title)}\n🆔 ID: \`${chatId}\`\n📝 Log target: ${escapeBasicMarkdown(logInfo)}`
        : `⛔ Status TeManOps: *NONAKTIF*\n🏠 Group: ${escapeBasicMarkdown(title)}\n🆔 ID: \`${chatId}\`\n📝 Log target: ${escapeBasicMarkdown(logInfo)}`
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

  if (cmd === "/nonaktifkanlogtemanops") {
    await setGroupLogTarget(KV, chatId, chatId, null);
    await send(
      API,
      msg.chat.id,
      "✅ Log TeManOps untuk group ini dikembalikan ke General."
    );
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
• /nonaktifkanlogtemanops

*User Control*
• /unmute [@username|user_id]
• reply pesan user lalu /unmute

*Config Commands*
Jalankan via private bot:
• /listgroup
• /setgroup [group_id]
• /groupaktif
• /cleargroup
• /banword add|del|list
• /linkwhitelist add|del|list
• /linkblacklist add|del|list
• /antiflood [limit] [detik]
• /setmutetime [menit]

ℹ️ Untuk config moderation, jalankan di private bot agar tidak terlihat member.
ℹ️ /aktifkanlogtemanops dijalankan di topic target log.
ℹ️ /nonaktifkanlogtemanops mengembalikan log ke General.
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
