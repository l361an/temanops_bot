// userCache.js

import { safeJSON, safeKVGet, safeKVPut, safeKVDelete } from "./kv.js";

function normalizeUsername(value) {
  return String(value || "").trim().replace(/^@+/, "").toLowerCase();
}

function normalizeName(value) {
  return String(value || "").trim();
}

function buildIdentity(user) {
  return {
    id: Number(user?.id || 0),
    username: normalizeUsername(user?.username),
    first_name: normalizeName(user?.first_name),
    last_name: normalizeName(user?.last_name)
  };
}

function sameIdentity(a, b) {
  return (
    Number(a?.id || 0) === Number(b?.id || 0) &&
    normalizeUsername(a?.username) === normalizeUsername(b?.username) &&
    normalizeName(a?.first_name) === normalizeName(b?.first_name) &&
    normalizeName(a?.last_name) === normalizeName(b?.last_name)
  );
}

export async function cacheUserIdentity(KV, chatId, user) {
  try {
    if (!user?.id || user?.is_bot) return false;

    const uid = Number(user.id);
    const nextIdentity = buildIdentity(user);

    const idKey = `usercache:id:${uid}`;
    const prevIdentity = safeJSON(await safeKVGet(KV, idKey), null);

    const prevUsername = normalizeUsername(prevIdentity?.username);
    const nextUsername = normalizeUsername(nextIdentity.username);

    if (!sameIdentity(prevIdentity, nextIdentity)) {
      await safeKVPut(KV, idKey, JSON.stringify(nextIdentity));
    }

    if (prevUsername !== nextUsername) {
      if (prevUsername) {
        await safeKVDelete(KV, `usercache:group:${chatId}:uname:${prevUsername}`);
        await safeKVDelete(KV, `usercache:global:uname:${prevUsername}`);
      }

      if (nextUsername) {
        await safeKVPut(KV, `usercache:group:${chatId}:uname:${nextUsername}`, String(uid));
        await safeKVPut(KV, `usercache:global:uname:${nextUsername}`, String(uid));
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

export async function setSelectedGroup(KV, userId, chatId) {
  if (!userId || !chatId) return false;
  return safeKVPut(KV, `admin_target_group:${userId}`, String(Number(chatId)));
}

export async function getSelectedGroup(KV, userId) {
  if (!userId) return null;
  const raw = await safeKVGet(KV, `admin_target_group:${userId}`);
  if (raw && /^-?\d+$/.test(raw)) return Number(raw);
  return null;
}

export async function clearSelectedGroup(KV, userId) {
  if (!userId) return false;
  return safeKVDelete(KV, `admin_target_group:${userId}`);
}
