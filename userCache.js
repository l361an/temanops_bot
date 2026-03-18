// userCache.js

import { safeKVGet, safeKVPut, safeKVDelete } from "./kv.js";

export async function cacheUserIdentity(KV, chatId, user) {
  try {
    if (!user?.id || user?.is_bot) return false;

    const uid = Number(user.id);
    await safeKVPut(
      KV,
      `usercache:id:${uid}`,
      JSON.stringify({
        id: uid,
        username: user.username || "",
        first_name: user.first_name || "",
        last_name: user.last_name || ""
      })
    );

    if (user.username) {
      const uname = String(user.username).trim().replace(/^@/, "").toLowerCase();
      if (uname) {
        await safeKVPut(KV, `usercache:group:${chatId}:uname:${uname}`, String(uid));
        await safeKVPut(KV, `usercache:global:uname:${uname}`, String(uid));
      }
    }

    return true;
  } catch (err) {
    console.log("CACHE USER FAILED:", err?.message || err);
    return false;
  }
}

export async function getCachedUserIdByUsername(KV, chatId, username) {
  const uname = String(username || "").trim().replace(/^@/, "").toLowerCase();
  if (!uname) return null;

  const local = await safeKVGet(KV, `usercache:group:${chatId}:uname:${uname}`);
  if (local && /^\d+$/.test(local)) return Number(local);

  const global = await safeKVGet(KV, `usercache:global:uname:${uname}`);
  if (global && /^\d+$/.test(global)) return Number(global);

  return null;
}

export async function setWelcomeStep(KV, userId, step) {
  if (!userId) return false;
  return safeKVPut(KV, `welcome_setup:${userId}`, step);
}

export async function getWelcomeStep(KV, userId) {
  if (!userId) return null;
  return safeKVGet(KV, `welcome_setup:${userId}`);
}

export async function clearWelcomeStep(KV, userId) {
  if (!userId) return false;
  return safeKVDelete(KV, `welcome_setup:${userId}`);
}
