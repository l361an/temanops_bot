// permissions.js

import { tg } from "./telegram.js";
import { isTemanOpsEnabled } from "./status.js";

export async function isAdmin(API, chatId, userId) {
  if (!userId) return false;

  const data = await tg(API, "getChatMember", {
    chat_id: chatId,
    user_id: userId
  });

  return !!(data?.result && ["administrator", "creator"].includes(data.result.status));
}

export async function isCreator(API, chatId, userId) {
  if (!userId) return false;

  const data = await tg(API, "getChatMember", {
    chat_id: chatId,
    user_id: userId
  });

  return data?.result?.status === "creator";
}

export function isAnonymousGroupAdminMessage(msg) {
  return !!(
    msg?.chat?.id &&
    msg?.sender_chat?.id &&
    String(msg.sender_chat.id) === String(msg.chat.id)
  );
}

export async function canManageTemanOps(API, msg) {
  if (await isCreator(API, msg.chat.id, msg.from?.id)) {
    return true;
  }

  if (isAnonymousGroupAdminMessage(msg)) {
    return true;
  }

  return false;
}

export async function canUseGroupAdminCommands(API, msg, KV) {
  const chatId = Number(msg.chat.id);
  const enabled = await isTemanOpsEnabled(KV, chatId);

  if (!enabled) {
    return {
      ok: false,
      message: "❌ TeManOps belum aktif di group ini. Jalankan /aktifkantemanops dulu."
    };
  }

  if (isAnonymousGroupAdminMessage(msg)) {
    return { ok: true };
  }

  const admin = await isAdmin(API, chatId, msg.from?.id);
  if (!admin) {
    return {
      ok: false,
      message: "❌ Command ini hanya untuk admin / creator group ini"
    };
  }

  return { ok: true };
}
