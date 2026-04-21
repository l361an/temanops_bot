// worker.js
import { handleGroupCommand } from "./commands/group.js";
import { handlePrivateCommand } from "./commands/private.js";
import { welcome } from "./welcome.js";
import { handleModeration } from "./moderation.js";
import {
  cacheUserIdentity,
  getWelcomeStep,
  clearWelcomeStep,
  setWelcomeStep
} from "./userCache.js";
import {
  safeJSON,
  send,
  getKV,
  safeKVGet,
  safeKVPut,
  safeKVDelete,
  gkey
} from "./kv.js";
import { shouldRunModeration, getTemanOpsTitle } from "./status.js";
import { escapeBasicMarkdown } from "./utils.js";
import { auditUsernameSurveillance } from "./surveillance.js";
import { auditIdentityTracker } from "./identityTracker.js";
import { ensureTemanOpsDb } from "./db.js";

function getWelcomeSetupGroupKey(userId) {
  return `welcome_setup_group:${userId}`;
}

function getWelcomeLinkTmpKey(userId) {
  return `welcome_link_tmp:${userId}`;
}

async function readWelcomeTargetChatId(KV, userId) {
  const raw = await safeKVGet(KV, getWelcomeSetupGroupKey(userId));
  if (raw && /^-?\d+$/.test(raw)) return Number(raw);
  return null;
}

async function clearWelcomeSession(KV, userId) {
  await clearWelcomeStep(KV, userId);
  await safeKVDelete(KV, getWelcomeSetupGroupKey(userId));
  await safeKVDelete(KV, getWelcomeLinkTmpKey(userId));
}

function isCancelText(value) {
  const text = String(value || "").trim().toLowerCase();
  return text === "/cancel" || text === "cancel" || text === "batal";
}

async function cancelWelcomeSession(API, KV, privateChatId, userId) {
  await clearWelcomeSession(KV, userId);
  await send(
    API,
    privateChatId,
    "🧹 Sesi setup welcome dibatalkan.\nGunakan lagi command welcome dari private bot kalau mau mulai ulang."
  );
}

async function handleWelcomePrivateFlow(API, KV, msg) {
  const userId = msg.from?.id;
  if (!userId) return false;

  const step = await getWelcomeStep(KV, userId);
  if (!step) return false;

  if (isCancelText(msg.text)) {
    await cancelWelcomeSession(API, KV, msg.chat.id, userId);
    return true;
  }

  const targetChatId = await readWelcomeTargetChatId(KV, userId);
  if (!targetChatId) {
    await clearWelcomeSession(KV, userId);
    await send(
      API,
      msg.chat.id,
      "❌ Sesi config welcome tidak valid.\nPilih lagi group target dengan /listgroup lalu /setgroup, lalu ulangi command welcome."
    );
    return true;
  }

  const targetTitle = await getTemanOpsTitle(KV, targetChatId);

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
      await send(
        API,
        msg.chat.id,
        "❌ Kirim *foto / video / gif*, bukan teks.\nKalau mau batal, kirim /cancel"
      );
      return true;
    }

    await safeKVPut(
      KV,
      gkey(targetChatId, "welcome_media"),
      JSON.stringify({ type, file_id: fileId })
    );
    await clearWelcomeSession(KV, userId);

    await send(
      API,
      msg.chat.id,
`✅ Welcome media berhasil disimpan

🏠 Group: ${escapeBasicMarkdown(targetTitle)}
🆔 ID: \`${targetChatId}\`

ℹ️ Kalau nanti ingin hapus media dan pakai text-only welcome, gunakan /delwelcomemedia`
    );
    return true;
  }

  if (step === "text") {
    if (!msg.text) {
      await send(
        API,
        msg.chat.id,
        "❌ Kirim *teks*, bukan media.\nKalau mau batal, kirim /cancel"
      );
      return true;
    }

    await safeKVPut(KV, gkey(targetChatId, "welcome_text"), msg.text);
    await clearWelcomeSession(KV, userId);

    await send(
      API,
      msg.chat.id,
`✅ Welcome text berhasil disimpan

🏠 Group: ${escapeBasicMarkdown(targetTitle)}
🆔 ID: \`${targetChatId}\`

ℹ️ Placeholder yang didukung:
• {username}
• {nama}`
    );
    return true;
  }

  if (step === "link_title") {
    if (!msg.text) {
      await send(
        API,
        msg.chat.id,
        "❌ Kirim *judul button* berupa teks.\nKalau mau batal, kirim /cancel"
      );
      return true;
    }

    await safeKVPut(
      KV,
      getWelcomeLinkTmpKey(userId),
      JSON.stringify({
        chat_id: targetChatId,
        text: msg.text
      })
    );

    await setWelcomeStep(KV, userId, "link_url");
    await send(
      API,
      msg.chat.id,
`🔗 Sekarang kirim *URL link*

🏠 Group: ${escapeBasicMarkdown(targetTitle)}
🆔 ID: \`${targetChatId}\`

Contoh:
https://t.me/namagroup`
    );
    return true;
  }

  if (step === "link_url") {
    if (!msg.text || !/^https?:\/\//i.test(msg.text)) {
      await send(
        API,
        msg.chat.id,
        "❌ URL tidak valid.\nHarus diawali http:// atau https://\nKalau mau batal, kirim /cancel"
      );
      return true;
    }

    const tmp = safeJSON(await safeKVGet(KV, getWelcomeLinkTmpKey(userId)), {});
    let links = safeJSON(await getKV(KV, gkey(targetChatId, "welcome_links")), []);

    if (!tmp?.text || Number(tmp.chat_id) !== Number(targetChatId)) {
      await clearWelcomeSession(KV, userId);
      await send(API, msg.chat.id, "❌ Sesi link tidak valid. Ulangi /addwelcomelink");
      return true;
    }

    links.push({
      text: tmp.text,
      url: msg.text
    });

    await safeKVPut(
      KV,
      gkey(targetChatId, "welcome_links"),
      JSON.stringify(links)
    );
    await clearWelcomeSession(KV, userId);

    await send(
      API,
      msg.chat.id,
`✅ Welcome button berhasil ditambahkan

🏠 Group: ${escapeBasicMarkdown(targetTitle)}
🆔 ID: \`${targetChatId}\``
    );
    return true;
  }

  return false;
}

export default {
  async fetch(req, env) {
    if (req.method !== "POST") return new Response("OK");

    const BOT_TOKEN = env.BOT_TOKEN;
    const KV = env.TEMANOPS_KV;
    const DB = env.TEMANOPS_DB;

    if (!BOT_TOKEN || !KV || !DB) {
      console.log(
        "ENV ERROR:",
        JSON.stringify({
          has_bot_token: !!BOT_TOKEN,
          has_kv: !!KV,
          has_db: !!DB
        })
      );
      return new Response("ENV ERROR", { status: 500 });
    }

    try {
      await ensureTemanOpsDb(DB);
    } catch (err) {
      console.log("D1 INIT FAILED:", err?.stack || err?.message || String(err));
      return new Response("D1 INIT FAILED", { status: 500 });
    }

    const requestDB = DB;
    const API = `https://api.telegram.org/bot${BOT_TOKEN}`;
    const update = await req.json().catch(() => ({}));
    console.log("UPDATE:", JSON.stringify(update));

    try {
      if (update.chat_member?.chat?.id) {
        const memberChatId = Number(update.chat_member.chat.id);
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
          await cacheUserIdentity(KV, requestDB, memberChatId, newUser);
          await auditUsernameSurveillance(API, KV, requestDB, memberChatId, newUser);
          await auditIdentityTracker(API, KV, requestDB, memberChatId, newUser, "chat_member");
        }

        if (
          justJoined &&
          !newUser?.is_bot &&
          await shouldRunModeration(KV, memberChatId)
        ) {
          await welcome(API, KV, memberChatId, newUser);
        }

        return new Response("OK");
      }

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
      const isGroupChat = ["group", "supergroup"].includes(msg.chat.type);

      if (msg.from?.id && !msg.from?.is_bot) {
        await cacheUserIdentity(KV, requestDB, chatId, msg.from);
        if (isGroupChat) {
          await auditUsernameSurveillance(API, KV, requestDB, chatId, msg.from);
          await auditIdentityTracker(API, KV, requestDB, chatId, msg.from, "message");
        }
      }

      if (msg.reply_to_message?.from?.id && !msg.reply_to_message?.from?.is_bot) {
        await cacheUserIdentity(KV, requestDB, chatId, msg.reply_to_message.from);
        if (isGroupChat) {
          await auditUsernameSurveillance(API, KV, requestDB, chatId, msg.reply_to_message.from);
          await auditIdentityTracker(API, KV, requestDB, chatId, msg.reply_to_message.from, "reply");
        }
      }

      if (Array.isArray(msg.new_chat_members)) {
        for (const member of msg.new_chat_members) {
          if (member?.id && !member?.is_bot) {
            await cacheUserIdentity(KV, requestDB, chatId, member);
            if (isGroupChat) {
              await auditUsernameSurveillance(API, KV, requestDB, chatId, member);
              await auditIdentityTracker(API, KV, requestDB, chatId, member, "new_chat_member");
            }
          }
        }

        if (isGroupChat && await shouldRunModeration(KV, chatId)) {
          for (const member of msg.new_chat_members) {
            if (!member?.is_bot) {
              await welcome(API, KV, chatId, member);
            }
          }
        }

        if (isGroupChat) {
          return new Response("OK");
        }
      }

      if (
        ["group", "supergroup"].includes(msg.chat.type) &&
        typeof msg.text === "string" &&
        msg.text.startsWith("/")
      ) {
        const handled = await handleGroupCommand(API, msg, KV);
        if (handled) return new Response("OK");
      }

      if (msg.chat.type === "private" && msg.text?.startsWith("/")) {
        const step = await getWelcomeStep(KV, msg.from?.id);

        if (step && msg.from?.id && !isCancelText(msg.text)) {
          await clearWelcomeSession(KV, msg.from.id);
        }

        await handlePrivateCommand(API, msg, KV, requestDB);
        return new Response("OK");
      }

      if (msg.chat.type === "private") {
        const handledWelcomeFlow = await handleWelcomePrivateFlow(API, KV, msg);
        if (handledWelcomeFlow) {
          return new Response("OK");
        }
      }

      if (msg.text === "ping") {
        await send(API, msg.chat.id, "pong");
        return new Response("OK");
      }

      if (
        ["group", "supergroup"].includes(msg.chat.type) &&
        msg.from &&
        !msg.from.is_bot &&
        await shouldRunModeration(KV, chatId)
      ) {
        await handleModeration(API, msg, KV, requestDB);
      }

      return new Response("OK");
    } catch (err) {
      console.log("FETCH ERROR:", err?.stack || err?.message || String(err));
      return new Response("OK");
    }
  }
};
