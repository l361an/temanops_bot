// userCache.js
import { safeJSON, safeKVGet, safeKVPut, safeKVDelete } from "./kv.js";

function hasD1(DB) {
  return !!DB && typeof DB.prepare === "function";
}

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

function resolveCacheArgs(a, b, c) {
  if (hasD1(a)) {
    return {
      DB: a,
      chatId: Number(b),
      user: c
    };
  }

  return {
    DB: null,
    chatId: Number(a),
    user: b
  };
}

function resolveLookupArgs(a, b, c) {
  if (hasD1(a)) {
    return {
      DB: a,
      chatId: Number(b),
      username: c
    };
  }

  return {
    DB: null,
    chatId: Number(a),
    username: b
  };
}

async function readUserIdentityD1(DB, userId) {
  const row = await DB
    .prepare(`
      SELECT user_id, username, first_name, last_name, updated_at
      FROM user_identity_cache
      WHERE user_id = ?
      LIMIT 1
    `)
    .bind(Number(userId))
    .first();

  if (!row?.user_id) return null;

  return {
    id: Number(row.user_id),
    username: normalizeUsername(row.username),
    first_name: normalizeName(row.first_name),
    last_name: normalizeName(row.last_name),
    updated_at: String(row.updated_at || "")
  };
}

async function upsertUserIdentityD1(DB, identity) {
  const now = new Date().toISOString();

  await DB
    .prepare(`
      INSERT INTO user_identity_cache (
        user_id, username, first_name, last_name, updated_at
      ) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(user_id) DO UPDATE SET
        username = excluded.username,
        first_name = excluded.first_name,
        last_name = excluded.last_name,
        updated_at = excluded.updated_at
    `)
    .bind(
      Number(identity.id),
      normalizeUsername(identity.username),
      normalizeName(identity.first_name),
      normalizeName(identity.last_name),
      now
    )
    .run();

  return true;
}

async function deleteUsernameCacheD1(DB, scopeType, chatId, username) {
  const uname = normalizeUsername(username);
  if (!uname) return true;

  await DB
    .prepare(`
      DELETE FROM username_cache
      WHERE scope_type = ? AND chat_id = ? AND username = ?
    `)
    .bind(String(scopeType), Number(chatId || 0), uname)
    .run();

  return true;
}

async function upsertUsernameCacheD1(DB, scopeType, chatId, username, userId) {
  const uname = normalizeUsername(username);
  if (!uname || !userId) return false;

  await DB
    .prepare(`
      INSERT INTO username_cache (
        scope_type, chat_id, username, user_id, updated_at
      ) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(scope_type, chat_id, username) DO UPDATE SET
        user_id = excluded.user_id,
        updated_at = excluded.updated_at
    `)
    .bind(
      String(scopeType),
      Number(chatId || 0),
      uname,
      Number(userId),
      new Date().toISOString()
    )
    .run();

  return true;
}

async function getUsernameCacheD1(DB, scopeType, chatId, username) {
  const uname = normalizeUsername(username);
  if (!uname) return null;

  const row = await DB
    .prepare(`
      SELECT user_id
      FROM username_cache
      WHERE scope_type = ? AND chat_id = ? AND username = ?
      LIMIT 1
    `)
    .bind(String(scopeType), Number(chatId || 0), uname)
    .first();

  if (!row?.user_id) return null;
  return Number(row.user_id);
}

export async function cacheUserIdentity(KV, a, b, c) {
  try {
    const { DB, chatId, user } = resolveCacheArgs(a, b, c);

    if (!user?.id || user?.is_bot) return false;

    const uid = Number(user.id);
    const nextIdentity = buildIdentity(user);

    const idKey = `usercache:id:${uid}`;
    const kvIdentity = safeJSON(await safeKVGet(KV, idKey), null);
    const d1Identity = hasD1(DB) ? await readUserIdentityD1(DB, uid) : null;
    const prevIdentity = d1Identity?.id ? d1Identity : kvIdentity;

    const prevUsername = normalizeUsername(prevIdentity?.username);
    const nextUsername = normalizeUsername(nextIdentity.username);

    if (hasD1(DB) && (!d1Identity?.id || !sameIdentity(d1Identity, nextIdentity))) {
      await upsertUserIdentityD1(DB, nextIdentity);
    }

    if (!sameIdentity(kvIdentity, nextIdentity)) {
      await safeKVPut(KV, idKey, JSON.stringify(nextIdentity));
    }

    if (hasD1(DB)) {
      if (prevUsername && prevUsername !== nextUsername) {
        await Promise.all([
          deleteUsernameCacheD1(DB, "group", chatId, prevUsername),
          deleteUsernameCacheD1(DB, "global", 0, prevUsername)
        ]);
      }

      if (nextUsername) {
        await Promise.all([
          upsertUsernameCacheD1(DB, "group", chatId, nextUsername, uid),
          upsertUsernameCacheD1(DB, "global", 0, nextUsername, uid)
        ]);
      }
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

export async function getCachedUserIdByUsername(KV, a, b, c) {
  const { DB, chatId, username } = resolveLookupArgs(a, b, c);
  const uname = String(username || "").trim().replace(/^@/, "").toLowerCase();
  if (!uname) return null;

  if (hasD1(DB)) {
    const localD1 = await getUsernameCacheD1(DB, "group", chatId, uname);
    if (localD1) return Number(localD1);

    const globalD1 = await getUsernameCacheD1(DB, "global", 0, uname);
    if (globalD1) return Number(globalD1);
  }

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
