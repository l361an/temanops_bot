// commands/private.js

import { GROUP_ID } from "../config.js";
import {
  send,
  safeJSON,
  safeKVPut,
  safeKVDelete,
  getGroupKV,
  gkey
} from "../kv.js";
import { isAdmin } from "../permissions.js";
import {
  setWelcomeStep,
  setSelectedGroup,
  getSelectedGroup,
  clearSelectedGroup
} from "../userCache.js";
import { tg } from "../telegram.js";
import {
  listTemanOpsGroups,
  getTemanOpsTitle,
  isTemanOpsEnabled,
  getTemanOpsGroupSummary
} from "../status.js";
import {
  renderAdminList,
  normalizeDomainInput,
  escapeBasicMarkdown
} from "../utils.js";

function getWelcomeSetupGroupKey(userId) {
  return `welcome_setup_group:${userId}`;
}

function getWelcomeLinkTmpKey(userId) {
  return `welcome_link_tmp:${userId}`;
}

async function clearWelcomeSetupSession(KV, userId) {
  await safeKVDelete(KV, getWelcomeSetupGroupKey(userId));
  await safeKVDelete(KV, getWelcomeLinkTmpKey(userId));
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

function fillWelcomeTemplate(textTpl, sampleUser) {
  const username = sampleUser.username
    ? `@${sampleUser.username}`
    : escapeBasicMarkdown(sampleUser.first_name || "User");

  const nama = escapeBasicMarkdown(sampleUser.first_name || "TeMan");

  return String(textTpl || "Selamat Bergabung di *TeMan* 🤍")
    .replace(/{username}/gi, username)
    .replace(/{nama}/gi, nama);
}

async function sendPreviewMediaOnly(API, chatId, media) {
  if (!media?.file_id || !media?.type) return false;

  let method = "sendPhoto";
  let key = "photo";

  if (media.type === "video") {
    method = "sendVideo";
    key = "video";
  } else if (media.type === "animation") {
    method = "sendAnimation";
    key = "animation";
  }

  const res = await tg(API, method, {
    chat_id: chatId,
    [key]: media.file_id
  });

  return !!res?.ok;
}

async function sendPreviewTextAndLinks(API, chatId, text, links) {
  const buttons = buildWelcomeButtons(links);

  const res = await tg(API, "sendMessage", {
    chat_id: chatId,
    text,
    parse_mode: "Markdown",
    disable_web_page_preview: true,
    reply_markup: buttons.length
      ? { inline_keyboard: buttons }
      : undefined
  });

  return !!res?.ok;
}

export async function handlePrivateCommand(API, msg, KV) {
  const parts = String(msg.text || "").trim().split(/\s+/);
  const raw = parts[0] || "";
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

  if (cmd === "/listcmd" || cmd === "/help") {
    return send(
      API,
      msg.chat.id,
`🛠️ *TeManOps*

*Private Management*
• /listgroup
• /setgroup [group_id]
• /groupaktif
• /cleargroup

• /banword add [kata]
• /banword del [kata]
• /banword list

• /linkwhitelist add [domain]
• /linkwhitelist del [domain]
• /linkwhitelist list

• /linkblacklist add [domain]
• /linkblacklist del [domain]
• /linkblacklist list

• /antiflood [limit] [detik]
• /setmutetime [menit]

*Welcome Commands*
• /updatewelcometext
• /updatewelcomemedia
• /addwelcomelink
• /delwelcomelink [judul]
• /listwelcomelink
• /previewwelcome

*Group Runtime Commands*
Jalankan langsung di group target:
• /aktifkantemanops
• /nonaktifkantemanops
• /statustemanops
• /aktifkanlogtemanops
• /nonaktifkanlogtemanops
• /unmute [@username|user_id]
• reply pesan user lalu /unmute
• /listcmdgroup

ℹ️ Semua config sensitif dijalankan via private bot.
ℹ️ Sebelum manage config, pilih group dulu pakai /listgroup lalu /setgroup [group_id]
ℹ️ Bot akan selalu tampilkan nama group + ID biar tidak ketuker.`
    );
  }

  const is_user_admin = await isAdmin(API, GROUP_ID, userId);
  if (!is_user_admin) {
    return send(API, msg.chat.id, "❌ Bukan admin group legacy");
  }

  if (cmd === "/listgroup") {
    const groups = await listTemanOpsGroups(KV);

    if (!groups.length) {
      return send(API, msg.chat.id, "📭 Belum ada group TeManOps yang terdaftar.");
    }

    const selectedId = await getSelectedGroup(KV, userId);

    const text =
`📚 *Daftar Group TeManOps*

${groups.map((g, i) =>
`${i + 1}. ${escapeBasicMarkdown(g.title || String(g.chat_id))}
🆔 \`${g.chat_id}\`
📌 Status: ${g.enabled ? "AKTIF" : "NONAKTIF"}${selectedId === g.chat_id ? "\n🎯 Sedang dipilih" : ""}`
).join("\n\n")}

Gunakan:
\`/setgroup -100xxxxxxxxxx\``;

    return send(API, msg.chat.id, text);
  }

  if (cmd === "/setgroup") {
    const rawTarget = String(parts[1] || "").trim();

    if (!/^-?\d+$/.test(rawTarget)) {
      return send(
        API,
        msg.chat.id,
        "❌ Format: /setgroup -100xxxxxxxxxx\nCek ID lewat /listgroup"
      );
    }

    const targetChatId = Number(rawTarget);
    const groups = await listTemanOpsGroups(KV);
    const target = groups.find(g => Number(g.chat_id) === targetChatId);

    if (!target) {
      return send(
        API,
        msg.chat.id,
        "❌ Group tidak ditemukan di registry TeManOps.\nCek lagi lewat /listgroup"
      );
    }

    await setSelectedGroup(KV, userId, targetChatId);

    return send(
      API,
      msg.chat.id,
`✅ Group target berhasil dipilih

🏠 Group: ${escapeBasicMarkdown(target.title || String(target.chat_id))}
🆔 ID: \`${target.chat_id}\`
📌 Status: ${target.enabled ? "AKTIF" : "NONAKTIF"}`
    );
  }

  if (cmd === "/groupaktif") {
    const targetChatId = await getSelectedGroup(KV, userId);
    if (!targetChatId) {
      return send(
        API,
        msg.chat.id,
        "❌ Belum ada group yang dipilih.\nGunakan /listgroup lalu /setgroup [group_id]"
      );
    }

    const summary = await getTemanOpsGroupSummary(KV, targetChatId);

    return send(
      API,
      msg.chat.id,
`${summary.enabled ? "✅" : "⛔"} *Group Aktif Saat Ini*

🏠 Group: ${escapeBasicMarkdown(summary.title || String(summary.chat_id))}
🆔 ID: \`${summary.chat_id}\`
📌 Status: ${summary.enabled ? "AKTIF" : "NONAKTIF"}
📝 Log target: ${escapeBasicMarkdown(summary.log_label)}`
    );
  }

  if (cmd === "/cleargroup") {
    await clearSelectedGroup(KV, userId);
    await clearWelcomeSetupSession(KV, userId);
    return send(API, msg.chat.id, "🧹 Group target berhasil dihapus. Pilih lagi lewat /listgroup");
  }

  const targetChatId = await getSelectedGroup(KV, userId);

  const requireSelectedGroup = async () => {
    if (!targetChatId) {
      await send(
        API,
        msg.chat.id,
        "❌ Belum ada group yang dipilih.\nGunakan /listgroup lalu /setgroup [group_id]"
      );
      return null;
    }

    const title = await getTemanOpsTitle(KV, targetChatId);
    const enabled = await isTemanOpsEnabled(KV, targetChatId);

    return {
      chatId: targetChatId,
      title: title || String(targetChatId),
      enabled
    };
  };

  if (cmd === "/updatewelcomemedia") {
    const group = await requireSelectedGroup();
    if (!group) return true;

    await clearWelcomeSetupSession(KV, userId);
    await safeKVPut(KV, getWelcomeSetupGroupKey(userId), String(group.chatId));
    await setWelcomeStep(KV, userId, "media");

    return send(
      API,
      msg.chat.id,
`📸 Silakan kirim *foto / video / gif* untuk welcome media

🏠 Group: ${escapeBasicMarkdown(group.title)}
🆔 ID: \`${group.chatId}\``
    );
  }

  if (cmd === "/updatewelcometext") {
    const group = await requireSelectedGroup();
    if (!group) return true;

    await clearWelcomeSetupSession(KV, userId);
    await safeKVPut(KV, getWelcomeSetupGroupKey(userId), String(group.chatId));
    await setWelcomeStep(KV, userId, "text");

    return send(
      API,
      msg.chat.id,
`✍️ *Update Welcome Text*

🏠 Group: ${escapeBasicMarkdown(group.title)}
🆔 ID: \`${group.chatId}\`

Silakan ketik welcome text.

ℹ️ Placeholder tersedia:
• {username} → username / mention klik
• {nama} → nama saja

Contoh:
Selamat datang {username} di TeMan 🤍`
    );
  }

  if (cmd === "/addwelcomelink") {
    const group = await requireSelectedGroup();
    if (!group) return true;

    await clearWelcomeSetupSession(KV, userId);
    await safeKVPut(KV, getWelcomeSetupGroupKey(userId), String(group.chatId));
    await setWelcomeStep(KV, userId, "link_title");

    return send(
      API,
      msg.chat.id,
`🧷 Silahkan kirim *judul button*

🏠 Group: ${escapeBasicMarkdown(group.title)}
🆔 ID: \`${group.chatId}\``
    );
  }

  if (cmd === "/delwelcomelink") {
    const group = await requireSelectedGroup();
    if (!group) return true;

    const title = String(msg.text || "")
      .replace(/^\/delwelcomelink(@\w+)?\s+/i, "")
      .trim();

    if (!title) {
      return send(API, msg.chat.id, "❌ /delwelcomelink <judul>");
    }

    let links = safeJSON(await getGroupKV(KV, group.chatId, "welcome_links"), []);
    const before = links.length;

    links = links.filter(
      l => String(l.text || "").trim().toLowerCase() !== title.toLowerCase()
    );

    if (links.length === before) {
      return send(
        API,
        msg.chat.id,
`⚠️ Judul tidak ditemukan

🏠 Group: ${escapeBasicMarkdown(group.title)}
🆔 ID: \`${group.chatId}\``
      );
    }

    await safeKVPut(KV, gkey(group.chatId, "welcome_links"), JSON.stringify(links));
    return send(
      API,
      msg.chat.id,
`🗑️ Welcome button dihapus

🏠 Group: ${escapeBasicMarkdown(group.title)}
🆔 ID: \`${group.chatId}\`
🧷 Judul: ${escapeBasicMarkdown(title)}`
    );
  }

  if (cmd === "/listwelcomelink") {
    const group = await requireSelectedGroup();
    if (!group) return true;

    const links = safeJSON(await getGroupKV(KV, group.chatId, "welcome_links"), []);

    if (!links.length) {
      return tg(API, "sendMessage", {
        chat_id: msg.chat.id,
        text:
`📭 Welcome button masih kosong

🏠 Group: ${group.title}
🆔 ID: ${group.chatId}`,
        disable_web_page_preview: true
      });
    }

    return tg(API, "sendMessage", {
      chat_id: msg.chat.id,
      text:
        `Daftar Welcome Button\n\n🏠 Group: ${group.title}\n🆔 ID: ${group.chatId}\n\n` +
        links.map((l, i) => `${i + 1}. ${l.text}\n${l.url}`).join("\n\n"),
      disable_web_page_preview: true
    });
  }

  if (cmd === "/previewwelcome") {
    const group = await requireSelectedGroup();
    if (!group) return true;

    const textTpl = await getGroupKV(KV, group.chatId, "welcome_text");
    const media = safeJSON(await getGroupKV(KV, group.chatId, "welcome_media"), null);
    const links = safeJSON(await getGroupKV(KV, group.chatId, "welcome_links"), []);

    const previewText = fillWelcomeTemplate(textTpl, {
      first_name: msg.from?.first_name || "Admin",
      username: msg.from?.username || ""
    });

    await send(
      API,
      msg.chat.id,
`👀 *Preview Welcome Terpisah*

🏠 Group: ${escapeBasicMarkdown(group.title)}
🆔 ID: \`${group.chatId}\`

1. Welcome media dikirim terpisah
2. Welcome text + links dikirim terpisah`
    );

    const mediaOk = await sendPreviewMediaOnly(API, msg.chat.id, media);
    if (!mediaOk) {
      await send(API, msg.chat.id, "⚠️ Welcome media belum ada / gagal dikirim. Lanjut preview text + links.");
    }

    const noteOk = await sendPreviewTextAndLinks(API, msg.chat.id, previewText, links);
    if (!noteOk) {
      await send(API, msg.chat.id, "❌ Preview welcome text / links gagal dikirim.");
    }

    return true;
  }

  if (cmd === "/banword") {
    const group = await requireSelectedGroup();
    if (!group) return true;

    const action = String(parts[1] || "").toLowerCase();
    const word = parts.slice(2).join(" ").trim().toLowerCase();

    let list = String(await getGroupKV(KV, group.chatId, "banned_words"))
      .split(",")
      .map(x => x.trim().toLowerCase())
      .filter(Boolean);

    if (!action) {
      return send(
        API,
        msg.chat.id,
        "❌ Format:\n/banword add <kata>\n/banword del <kata>\n/banword list"
      );
    }

    if (action === "list") {
      const body = list.length
        ? list.map((w, i) => `${i + 1}. ${escapeBasicMarkdown(w)}`).join("\n")
        : "📭 Banword masih kosong";

      return send(
        API,
        msg.chat.id,
`🚫 *Daftar Banword*

🏠 Group: ${escapeBasicMarkdown(group.title)}
🆔 ID: \`${group.chatId}\`

${body}`
      );
    }

    if (!word) {
      return send(
        API,
        msg.chat.id,
        "❌ Format:\n/banword add <kata>\n/banword del <kata>"
      );
    }

    if (action === "add") {
      if (list.includes(word)) {
        return send(
          API,
          msg.chat.id,
`⚠️ Kata sudah ada

🏠 Group: ${escapeBasicMarkdown(group.title)}
🆔 ID: \`${group.chatId}\`
🚫 Kata: ${escapeBasicMarkdown(word)}`
        );
      }

      list.push(word);
      await safeKVPut(KV, gkey(group.chatId, "banned_words"), list.join(","));

      return send(
        API,
        msg.chat.id,
`✅ Banword ditambahkan

🏠 Group: ${escapeBasicMarkdown(group.title)}
🆔 ID: \`${group.chatId}\`
🚫 Kata: ${escapeBasicMarkdown(word)}`
      );
    }

    if (action === "del") {
      if (!list.includes(word)) {
        return send(
          API,
          msg.chat.id,
`⚠️ Kata tidak ditemukan

🏠 Group: ${escapeBasicMarkdown(group.title)}
🆔 ID: \`${group.chatId}\`
🚫 Kata: ${escapeBasicMarkdown(word)}`
        );
      }

      list = list.filter(w => w !== word);
      await safeKVPut(KV, gkey(group.chatId, "banned_words"), list.join(","));

      return send(
        API,
        msg.chat.id,
`🗑️ Banword dihapus

🏠 Group: ${escapeBasicMarkdown(group.title)}
🆔 ID: \`${group.chatId}\`
🚫 Kata: ${escapeBasicMarkdown(word)}`
      );
    }

    return send(API, msg.chat.id, "❌ Gunakan add / del / list");
  }

  if (cmd === "/linkwhitelist") {
    const group = await requireSelectedGroup();
    if (!group) return true;

    const action = String(parts[1] || "").toLowerCase();
    const rawDomain = parts.slice(2).join(" ").trim();

    if (!["add", "del", "list"].includes(action)) {
      return send(API, msg.chat.id, "❌ /linkwhitelist add|del|list [domain]");
    }

    let list = safeJSON(await getGroupKV(KV, group.chatId, "link_whitelist"), []);

    if (action === "list") {
      return send(
        API,
        msg.chat.id,
`✅ *Link Whitelist*

🏠 Group: ${escapeBasicMarkdown(group.title)}
🆔 ID: \`${group.chatId}\`

${renderAdminList("Whitelist", list)}`
      );
    }

    if (!rawDomain) {
      return send(API, msg.chat.id, "❌ Domain kosong");
    }

    const domain = normalizeDomainInput(rawDomain);

    if (action === "add") {
      if (list.includes(domain)) {
        return send(
          API,
          msg.chat.id,
`⚠️ Domain sudah ada

🏠 Group: ${escapeBasicMarkdown(group.title)}
🆔 ID: \`${group.chatId}\`
🔗 Domain: ${escapeBasicMarkdown(domain)}`
        );
      }
      list.push(domain);
    }

    if (action === "del") {
      const before = list.length;
      list = list.filter(d => d !== domain);

      if (list.length === before) {
        return send(
          API,
          msg.chat.id,
`⚠️ Domain tidak ditemukan

🏠 Group: ${escapeBasicMarkdown(group.title)}
🆔 ID: \`${group.chatId}\`
🔗 Domain: ${escapeBasicMarkdown(domain)}`
        );
      }
    }

    await safeKVPut(KV, gkey(group.chatId, "link_whitelist"), JSON.stringify(list));
    return send(
      API,
      msg.chat.id,
`✅ Link whitelist diupdate

🏠 Group: ${escapeBasicMarkdown(group.title)}
🆔 ID: \`${group.chatId}\`
🔗 Domain: ${escapeBasicMarkdown(domain)}`
    );
  }

  if (cmd === "/linkblacklist") {
    const group = await requireSelectedGroup();
    if (!group) return true;

    const action = String(parts[1] || "").toLowerCase();
    const rawDomain = parts.slice(2).join(" ").trim();

    if (!["add", "del", "list"].includes(action)) {
      return send(API, msg.chat.id, "❌ /linkblacklist add|del|list [domain]");
    }

    let list = safeJSON(await getGroupKV(KV, group.chatId, "link_blacklist"), []);

    if (action === "list") {
      return send(
        API,
        msg.chat.id,
`⛔ *Link Blacklist*

🏠 Group: ${escapeBasicMarkdown(group.title)}
🆔 ID: \`${group.chatId}\`

${renderAdminList("Blacklist", list)}`
      );
    }

    if (!rawDomain) {
      return send(API, msg.chat.id, "❌ Domain kosong");
    }

    const domain = normalizeDomainInput(rawDomain);

    if (action === "add") {
      if (list.includes(domain)) {
        return send(
          API,
          msg.chat.id,
`⚠️ Domain sudah ada

🏠 Group: ${escapeBasicMarkdown(group.title)}
🆔 ID: \`${group.chatId}\`
🔗 Domain: ${escapeBasicMarkdown(domain)}`
        );
      }
      list.push(domain);
    }

    if (action === "del") {
      const before = list.length;
      list = list.filter(d => d !== domain);

      if (list.length === before) {
        return send(
          API,
          msg.chat.id,
`⚠️ Domain tidak ditemukan

🏠 Group: ${escapeBasicMarkdown(group.title)}
🆔 ID: \`${group.chatId}\`
🔗 Domain: ${escapeBasicMarkdown(domain)}`
        );
      }
    }

    await safeKVPut(KV, gkey(group.chatId, "link_blacklist"), JSON.stringify(list));
    return send(
      API,
      msg.chat.id,
`⛔ Link blacklist diupdate

🏠 Group: ${escapeBasicMarkdown(group.title)}
🆔 ID: \`${group.chatId}\`
🔗 Domain: ${escapeBasicMarkdown(domain)}`
    );
  }

  if (cmd === "/antiflood") {
    const group = await requireSelectedGroup();
    if (!group) return true;

    const limit = Number(parts[1]);
    const win = Number(parts[2]);

    if (!limit || !win || limit <= 0 || win <= 0) {
      return send(API, msg.chat.id, "❌ Format: /antiflood <limit> <detik>");
    }

    await safeKVPut(KV, gkey(group.chatId, "flood_limit"), String(limit));
    await safeKVPut(KV, gkey(group.chatId, "flood_window"), String(win));

    return send(
      API,
      msg.chat.id,
`✅ Anti flood diupdate

🏠 Group: ${escapeBasicMarkdown(group.title)}
🆔 ID: \`${group.chatId}\`
📌 Limit: ${limit} pesan
⏱️ Window: ${win} detik`
    );
  }

  if (cmd === "/setmutetime") {
    const group = await requireSelectedGroup();
    if (!group) return true;

    const n = Number(parts[1]);
    if (!n || n <= 0) {
      return send(API, msg.chat.id, "❌ Angka invalid");
    }

    await safeKVPut(KV, gkey(group.chatId, "mute_minutes"), String(n));

    return send(
      API,
      msg.chat.id,
`⏱️ Mute time diupdate

🏠 Group: ${escapeBasicMarkdown(group.title)}
🆔 ID: \`${group.chatId}\`
⏳ Mute: ${n} menit`
    );
  }

  return send(API, msg.chat.id, "ℹ️ Command tidak dikenali. Coba /listcmd");
}
