// commands/private.js

import {
  send,
  safeJSON,
  safeKVPut,
  safeKVDelete,
  getGroupKV,
  gkey,
  normalizeCaseId
} from "../kv.js";
import { getCaseRecordD1 } from "../db.js";
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

function truncateCaseField(value, max = 1500) {
  const text = String(value || "").trim();
  if (!text) return "-";
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1)}…`;
}

function formatJakartaDateTime(value) {
  if (!value) return "-";

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return String(value);
  }

  const parts = new Intl.DateTimeFormat("id-ID", {
    timeZone: "Asia/Jakarta",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false
  }).formatToParts(date);

  const map = {};
  for (const part of parts) {
    if (part.type !== "literal") {
      map[part.type] = part.value;
    }
  }

  const day = map.day || "00";
  const month = map.month || "00";
  const year = map.year || "0000";
  const hour = map.hour || "00";
  const minute = map.minute || "00";
  const second = map.second || "00";

  return `${day}/${month}/${year} ${hour}:${minute}:${second} WIB`;
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

function renderCaseDetail(record) {
  const offenderName = record?.offender?.first_name || "-";
  const offenderUsername = record?.offender?.username
    ? `@${record.offender.username}`
    : "-";
  const punishmentLabel = record?.action?.ok === false
    ? `Mute gagal \\(target ${Number(record?.action?.minutes || 0)} menit\\)`
    : `Mute ${Number(record?.action?.minutes || 0)} menit`;
  const topicLabel = record?.message_thread_id
    ? `Topic ID ${record.message_thread_id}`
    : "General";
  const evidenceText = truncateCaseField(
    record?.evidence?.text || "(pesan tanpa teks / caption)",
    1500
  );
  const displayedTime = formatJakartaDateTime(
    record?.message_date || record?.created_at || null
  );

  return `🗂️ *DETAIL CASE*

🆔 *Case ID*
\`${escapeBasicMarkdown(record?.case_id || "-")}\`

🏠 *Group*
${escapeBasicMarkdown(record?.chat_title || String(record?.chat_id || "-"))}
🆔 Group ID: \`${record?.chat_id || "-"}\`
🧵 Topic: ${escapeBasicMarkdown(topicLabel)}

👤 *Target*
${escapeBasicMarkdown(offenderName)}
🔗 ${escapeBasicMarkdown(offenderUsername)}
🆔 User ID: \`${record?.offender?.id || "-"}\`

🚫 *Alasan*
${escapeBasicMarkdown(record?.reason || "-")}

⏱️ *Hukuman*
${punishmentLabel}

🕒 *Waktu Pesan*
${escapeBasicMarkdown(displayedTime)}
🧾 Message ID: \`${record?.message_id || "-"}\`
📦 Jenis konten: ${escapeBasicMarkdown(record?.evidence?.content_type || "-")}

📄 *Bukti Tersimpan*
${escapeBasicMarkdown(evidenceText)}`;
}

async function clearWelcomeSetupSession(KV, userId) {
  await safeKVDelete(KV, getWelcomeSetupGroupKey(userId));
  await safeKVDelete(KV, getWelcomeLinkTmpKey(userId));
}

async function listManageableGroups(API, KV, userId) {
  const groups = await listTemanOpsGroups(KV);
  if (!groups.length || !userId) return [];

  const checks = await Promise.all(
    groups.map(async (group) => ({
      group,
      allowed: await isAdmin(API, group.chat_id, userId)
    }))
  );

  return checks.filter((x) => x.allowed).map((x) => x.group);
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

export async function handlePrivateCommand(API, msg, KV, DB) {
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
• /case [CASE_ID]

• /banword add [kata]
• /banword del [kata]
• /banword list

• /linkwhitelist add [domain]
• /linkwhitelist del [domain]
• /linkwhitelist list

• /linkblacklist add [domain]
• /linkblacklist del [domain]
• /linkblacklist list

• /linkmode hybrid
• /linkmode whitelistonly
• /linkmode status

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
• /temanops on
• /temanops off
• /temanops status
• /log on
• /log off
• /log status
• /aktifkanpengawasan
• /nonaktifkanpengawasan
• /statuspengawasan
• /unmute [@username|user_id]
• reply pesan user lalu /unmute
• /listcmdgroup

ℹ️ Private management + /case bisa dipakai admin group target yang relevan.
ℹ️ Sebelum manage config, pilih group dulu pakai /listgroup lalu /setgroup [group_id]
ℹ️ Bot akan selalu tampilkan nama group + ID biar tidak ketuker.`
    );
  }

  if (cmd === "/case") {
    const rawCaseId = String(parts[1] || "").trim();
    const caseId = normalizeCaseId(rawCaseId);

    if (!caseId) {
      return send(API, msg.chat.id, "❌ Format: /case ABCD234K");
    }

    let record = null;

    if (DB) {
      record = await getCaseRecordD1(DB, caseId);
    }

    if (!record) {
      return send(API, msg.chat.id, `❌ Case tidak ditemukan: \`${escapeBasicMarkdown(caseId)}\``);
    }

    const caseChatId = Number(record.chat_id || 0);
    if (!caseChatId) {
      return send(API, msg.chat.id, "❌ Data case rusak: chat_id tidak valid");
    }

    const allowed = await isAdmin(API, caseChatId, userId);
    if (!allowed) {
      return send(
        API,
        msg.chat.id,
        "❌ Kamu bukan admin group pada case ini, jadi detail bukti tidak bisa dibuka."
      );
    }

    return send(API, msg.chat.id, renderCaseDetail(record));
  }

  const manageableGroups = await listManageableGroups(API, KV, userId);

  if (!manageableGroups.length) {
    return send(
      API,
      msg.chat.id,
      "❌ Kamu bukan admin di group TeManOps yang terdaftar, atau bot belum melihat group targetmu."
    );
  }

  if (cmd === "/listgroup") {
    const selectedId = await getSelectedGroup(KV, userId);

    const text =
`📚 *Daftar Group TeManOps*

${manageableGroups.map((g, i) =>
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
    const target = manageableGroups.find((g) => Number(g.chat_id) === targetChatId);

    if (!target) {
      return send(
        API,
        msg.chat.id,
        "❌ Group tidak ditemukan atau kamu bukan admin group tersebut.\nCek lagi lewat /listgroup"
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

    const allowed = await isAdmin(API, targetChatId, userId);
    if (!allowed) {
      await clearSelectedGroup(KV, userId);
      await clearWelcomeSetupSession(KV, userId);
      await send(
        API,
        msg.chat.id,
        "❌ Kamu bukan admin group target ini. Pilihan group direset, silakan pilih lagi lewat /listgroup."
      );
      return null;
    }

    const summary = await getTemanOpsGroupSummary(KV, targetChatId);

    return {
      chatId: targetChatId,
      title: summary.title || String(targetChatId),
      enabled: summary.enabled
    };
  };

  if (cmd === "/groupaktif") {
    const group = await requireSelectedGroup();
    if (!group) return true;

    const summary = await getTemanOpsGroupSummary(KV, group.chatId);
    const linkMode = String(await getGroupKV(KV, group.chatId, "link_mode") || "hybrid").toLowerCase();

    return send(
      API,
      msg.chat.id,
`${summary.enabled ? "✅" : "⛔"} *Group Aktif Saat Ini*

🏠 Group: ${escapeBasicMarkdown(summary.title || String(summary.chat_id))}
🆔 ID: \`${summary.chat_id}\`
📌 Status: ${summary.enabled ? "AKTIF" : "NONAKTIF"}
📝 Log target: ${escapeBasicMarkdown(summary.log_label)}
🔗 Link mode: ${escapeBasicMarkdown(linkMode)}`
    );
  }

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
      (l) => String(l.text || "").trim().toLowerCase() !== title.toLowerCase()
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
      .map((x) => x.trim().toLowerCase())
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

      list = list.filter((w) => w !== word);
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
      list = list.filter((d) => d !== domain);

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
      list = list.filter((d) => d !== domain);

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

  if (cmd === "/linkmode") {
    const group = await requireSelectedGroup();
    if (!group) return true;

    const mode = String(parts[1] || "").trim().toLowerCase();
    const currentMode = String(await getGroupKV(KV, group.chatId, "link_mode") || "hybrid").toLowerCase();

    if (!mode || mode === "status") {
      return send(
        API,
        msg.chat.id,
`🔗 *Status Link Mode*

🏠 Group: ${escapeBasicMarkdown(group.title)}
🆔 ID: \`${group.chatId}\`
📌 Mode: ${escapeBasicMarkdown(currentMode)}

Mode tersedia:
• hybrid
• whitelistonly`
      );
    }

    if (!["hybrid", "whitelistonly"].includes(mode)) {
      return send(
        API,
        msg.chat.id,
        "❌ Gunakan: /linkmode hybrid\n/linkmode whitelistonly\n/linkmode status"
      );
    }

    await safeKVPut(KV, gkey(group.chatId, "link_mode"), mode);

    const note =
      mode === "whitelistonly"
        ? "Semua link akan diblok kecuali yang ada di whitelist."
        : "Link whitelist tetap lolos, link blacklist tetap diblok, sisanya tetap boleh.";

    return send(
      API,
      msg.chat.id,
`✅ Link mode diupdate

🏠 Group: ${escapeBasicMarkdown(group.title)}
🆔 ID: \`${group.chatId}\`
📌 Mode: ${escapeBasicMarkdown(mode)}

ℹ️ ${note}`
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
