// commands/private.js

import { GROUP_ID } from "../config.js";
import { send, getKV, safeJSON, safeKVPut } from "../kv.js";
import { isAdmin } from "../permissions.js";
import { setWelcomeStep } from "../userCache.js";
import { tg } from "../telegram.js";

export async function handlePrivateCommand(API, msg, KV) {
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
• /nonaktifkanlogtemanops
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
ℹ️ /nonaktifkanlogtemanops mengembalikan log ke General.
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
