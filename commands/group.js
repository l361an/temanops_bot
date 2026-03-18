// commands/group.js

import { GROUP_ID } from "../config.js";
import {
  send,
  safeKVPut,
  safeJSON,
  gkey,
  getGroupKV
} from "../kv.js";
import {
  renderAdminList,
  normalizeDomainInput,
  escapeBasicMarkdown
} from "../utils.js";
import {
  canManageTemanOps,
  canUseGroupAdminCommands
} from "../permissions.js";
import {
  setTemanOpsEnabled,
  isTemanOpsEnabled,
  getTemanOpsTitle
} from "../status.js";
import {
  setGroupLogTarget,
  getGroupLogTarget
} from "../status.js";
import { getCachedUserIdByUsername } from "../userCache.js";
import { unmute } from "../moderation.js";

export async function handleGroupCommand(API, msg, KV) {
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
    "/nonaktifkanlogtemanops",
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
ℹ️ /nonaktifkanlogtemanops mengembalikan log ke General.
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
