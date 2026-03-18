import { GROUP_ID } from "./config.js";
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
  safeKVDelete
} from "./kv.js";
import { shouldRunModeration } from "./status.js";

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

      if (msg?.chat?.id === GROUP_ID && Array.isArray(msg.new_chat_members)) {
        for (const member of msg.new_chat_members) {
          if (!member?.is_bot) {
            await welcome(API, KV, member);
          }
        }
        return new Response("OK");
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
        if (step && msg.from?.id) await clearWelcomeStep(KV, msg.from.id);

        await handlePrivateCommand(API, msg, KV);
        return new Response("OK");
      }

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
        await handleModeration(API, msg, KV);
      }

      return new Response("OK");
    } catch (err) {
      console.log("FETCH ERROR:", err?.stack || err?.message || String(err));
      return new Response("OK");
    }
  }
};
