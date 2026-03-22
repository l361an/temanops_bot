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

export async function handleGroupCommand(API, msg, KV) {
  const parts = String(msg.text || "").trim().split(/\s+/);
  const raw = parts[0] || "";
  const a = String(parts[1] || "").trim().toLowerCase();
  const b = parts[2];
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

  const runtimeCommands = new Set([
    "/temanops",
    "/log",
    "/watcher",
    "/tracker",
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
    "/addwelcomelink",
    "/delwelcomelink",
    "/listwelcomelink"
  ]);

  if (!["group", "supergroup"].includes(msg.chat.type)) {
    if (runtimeCommands.has(cmd) || movedToPrivateCommands.has(cmd)) {
      await send(API, msg.chat.id, "❌ Command ini hanya di group");
      return true;
    }
    return false;
  }

  if (movedToPrivateCommands.has(cmd)) {
    await reply(
      `ℹ️ Command config ini sekarang dijalankan via private bot.\nGunakan /listgroup di private, lalu pilih group target dengan /setgroup.\nBot akan tampilkan nama group + ID agar tidak ketuker.`
    );
    return true;
  }

  if (!runtimeCommands.has(cmd)) return false;

  if (cmd === "/temanops") {
    if (!["on", "off", "status"].includes(a)) {
      await reply("❌ Gunakan: /temanops on|off|status");
      return true;
    }

    if (await requireGeneralOnly()) return true;

    const allowed = await canManageTemanOps(API, msg);
    if (!allowed) {
      await reply(
        "❌ Command ini hanya untuk *owner* atau *anonymous admin atas nama group ini*"
      );
      return true;
    }

    if (a === "on") {
      await setTemanOpsEnabled(KV, chatId, true);
      await safeKVPut(KV, `temanops_title:${chatId}`, String(msg.chat.title || chatId));
      await setGroupLogTarget(KV, chatId, chatId, null);

      await reply("✅ *TeManOps aktif* di group ini");
      return true;
    }

    if (a === "off") {
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

    const enabled = await isTemanOpsEnabled(KV, chatId);
    const title = await getTemanOpsTitle(KV, chatId);
    const logTarget = await getGroupLogTarget(KV, chatId);

    let logInfo = "General";
    if (logTarget?.thread_id) {
      logInfo = `Topic ID ${logTarget.thread_id}`;
    }

    await reply(
      enabled
        ? `✅ Status TeManOps: *AKTIF*
🏠 Group: ${escapeBasicMarkdown(title)}
🆔 ID: \`${chatId}\`
📝 Log target: ${escapeBasicMarkdown(logInfo)}`
        : `⛔ Status TeManOps: *NONAKTIF*
🏠 Group: ${escapeBasicMarkdown(title)}
🆔 ID: \`${chatId}\`
📝 Log target: ${escapeBasicMarkdown(logInfo)}`
    );
    return true;
  }

  const adminAllowed = await canUseGroupAdminCommands(API, msg, KV);
  if (!adminAllowed.ok) {
    await reply(adminAllowed.message);
    return true;
  }

  if (cmd === "/log") {
    if (!["on", "off", "status"].includes(a)) {
      await reply("❌ Gunakan: /log on|off|status");
      return true;
    }

    if (["on", "off"].includes(a)) {
      const allowed = await canManageTemanOps(API, msg);
      if (!allowed) {
        await reply(
          "❌ Command ini hanya untuk *owner* atau *anonymous admin atas nama group ini*"
        );
        return true;
      }
    }

    if (a === "on") {
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

    if (a === "off") {
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

    const title = await getTemanOpsTitle(KV, chatId);
    const target = await getGroupLogTarget(KV, chatId);
    const targetLabel = target?.thread_id ? `Topic ID ${target.thread_id}` : "General";

    await reply(
      `📝 *Status Log TeManOps*

🏠 Group: ${escapeBasicMarkdown(title)}
🆔 ID: \`${chatId}\`
📌 Status: AKTIF
📝 Target: ${escapeBasicMarkdown(targetLabel)}`
    );
    return true;
  }

  if (cmd === "/watcher") {
    if (!["on", "off", "status"].includes(a)) {
      await reply("❌ Gunakan: /watcher on|off|status");
      return true;
    }

    if (["on", "off"].includes(a)) {
      const allowed = await canManageTemanOps(API, msg);
      if (!allowed) {
        await reply(
          "❌ Command ini hanya untuk *owner* atau *anonymous admin atas nama group ini*"
        );
        return true;
      }
    }

    if (a === "on") {
      if (await requireTopicOnly("watcher")) return true;

      await setUsernameWatchTarget(KV, chatId, chatId, replyThreadId);

      await send(
        API,
        msg.chat.id,
        `✅ Watcher user tanpa username sekarang aktif di topic ini.\nKartu watcher akan otomatis dihapus saat user sudah pasang username.`,
        replyThreadId
      );
      return true;
    }

    if (a === "off") {
      const target = await getUsernameWatchTarget(KV, chatId);

      if (!target?.chat_id) {
        await reply("⚠️ Watcher user tanpa username saat ini *NONAKTIF*.");
        return true;
      }

      if (!target.thread_id) {
        if (replyThreadId) {
          await reply("⚠️ Watcher aktif di *General*. Jalankan command ini di *General*.");
          return true;
        }

        await clearUsernameWatchTarget(KV, chatId);
        await reply("✅ Watcher user tanpa username dinonaktifkan untuk group ini.");
        return true;
      }

      if (!replyThreadId) {
        await reply(
          "❌ Command ini wajib dijalankan di topic target watcher yang sedang aktif."
        );
        return true;
      }

      if (Number(target.thread_id) !== replyThreadId) {
        await reply("⚠️ Topic ini bukan target watcher yang aktif.");
        return true;
      }

      await clearUsernameWatchTarget(KV, chatId);
      await reply("✅ Watcher user tanpa username dinonaktifkan untuk group ini.");
      return true;
    }

    const title = await getTemanOpsTitle(KV, chatId);
    const target = await getUsernameWatchTarget(KV, chatId);

    if (!target?.chat_id) {
      await reply(
        `👁️ *Status Watcher*

🏠 Group: ${escapeBasicMarkdown(title)}
🆔 ID: \`${chatId}\`
📌 Status: NONAKTIF
📝 Target: -`
      );
      return true;
    }

    const targetLabel = target.thread_id ? `Topic ID ${target.thread_id}` : "General";

    await reply(
      `👁️ *Status Watcher*

🏠 Group: ${escapeBasicMarkdown(title)}
🆔 ID: \`${chatId}\`
📌 Status: AKTIF
📝 Target: ${escapeBasicMarkdown(targetLabel)}`
    );
    return true;
  }

  if (cmd === "/tracker") {
    if (!["on", "off", "status"].includes(a)) {
      await reply("❌ Gunakan: /tracker on|off|status");
      return true;
    }

    if (["on", "off"].includes(a)) {
      const allowed = await canManageTemanOps(API, msg);
      if (!allowed) {
        await reply(
          "❌ Command ini hanya untuk *owner* atau *anonymous admin atas nama group ini*"
        );
        return true;
      }
    }

    if (a === "on") {
      if (await requireTopicOnly("tracker")) return true;

      await setIdentityTrackerTarget(KV, chatId, chatId, replyThreadId);

      await send(
        API,
        msg.chat.id,
        `✅ Tracker identitas sekarang aktif di topic ini.\nBot akan melaporkan perubahan username, nama depan, dan nama belakang.`,
        replyThreadId
      );
      return true;
    }

    if (a === "off") {
      const target = await getIdentityTrackerTarget(KV, chatId);

      if (!target?.chat_id) {
        await reply("⚠️ Tracker identitas saat ini *NONAKTIF*.");
        return true;
      }

      if (!target.thread_id) {
        if (replyThreadId) {
          await reply("⚠️ Tracker aktif di *General*. Jalankan command ini di *General*.");
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
        await reply("⚠️ Topic ini bukan target tracker yang aktif.");
        return true;
      }

      await clearIdentityTrackerTarget(KV, chatId);
      await reply("✅ Tracker identitas dinonaktifkan untuk group ini.");
      return true;
    }

    const title = await getTemanOpsTitle(KV, chatId);
    const target = await getIdentityTrackerTarget(KV, chatId);

    if (!target?.chat_id) {
      await reply(
        `🕵️ *Status Tracker*

🏠 Group: ${escapeBasicMarkdown(title)}
🆔 ID: \`${chatId}\`
📌 Status: NONAKTIF
📝 Target: -`
      );
      return true;
    }

    const targetLabel = target.thread_id ? `Topic ID ${target.thread_id}` : "General";

    await reply(
      `🕵️ *Status Tracker*

🏠 Group: ${escapeBasicMarkdown(title)}
🆔 ID: \`${chatId}\`
📌 Status: AKTIF
📝 Target: ${escapeBasicMarkdown(targetLabel)}`
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

*Topic Watcher*
• /watcher on
• /watcher off
• /watcher status

*Topic Tracker*
• /tracker on
• /tracker off
• /tracker status

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
• /addwelcomelink
• /delwelcomelink [judul]
• /listwelcomelink

ℹ️ /temanops on|off|status wajib dijalankan di *General*.
ℹ️ /log on|off dijalankan di topic target log. /log status bisa dicek dari mana saja di group.
ℹ️ /watcher on|off dijalankan di topic target watcher. /watcher status bisa dicek dari mana saja di group.
ℹ️ /tracker on|off dijalankan di topic target tracker. /tracker status bisa dicek dari mana saja di group.
ℹ️ Untuk @username, user harus sudah pernah terlihat oleh bot di group ini.`
    );
    return true;
  }

  if (cmd === "/mute") {
    let targetId = null;
    let targetLabel = "";
    const defaultMinutes = Number(await getGroupKV(KV, chatId, "mute_minutes")) || 60;
    let minutes = defaultMinutes;

    if (msg.reply_to_message?.from?.id) {
      targetId = Number(msg.reply_to_message.from.id);
      targetLabel = msg.reply_to_message.from.username
        ? `@${msg.reply_to_message.from.username}`
        : String(targetId);

      if (a) {
        if (!/^\d+$/.test(String(a).trim())) {
          await reply(
            `❌ Format salah.\nGunakan reply pesan user lalu /mute atau /mute <menit>`
          );
          return true;
        }
        minutes = Number(a);
      }
    } else {
      await reply(
        `❌ Gunakan reply pesan user lalu /mute atau /mute <menit>\n\nContoh:\n• reply user lalu /mute\n• reply user lalu /mute 30`
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
      const repliedUser = msg.reply_to_message.from;

      if (repliedUser?.id && !repliedUser.is_bot) {
        targetId = Number(repliedUser.id);
        targetLabel = repliedUser.username
          ? `@${repliedUser.username}`
          : String(targetId);
      } else if (repliedUser?.is_bot) {
        const replyText = String(
          msg.reply_to_message.text ||
          msg.reply_to_message.caption ||
          ""
        );

        const idMatch = replyText.match(/Target ID:\s*(\d+)/i);
        if (idMatch) {
          targetId = Number(idMatch[1]);
          targetLabel = String(targetId);
        } else {
          await reply(
            "❌ Reply ke pesan user asli, atau reply ke pesan bot yang berisi *Target ID*, atau pakai /unmute @username / user_id"
          );
          return true;
        }
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
