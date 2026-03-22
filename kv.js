// kv.js

import { DEFAULTS } from "./config.js";
import { tg } from "./telegram.js";

const CASE_KEY_PREFIX = "case:";
const MAX_CASE_ID_ATTEMPTS = 5;
const CASE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const CASE_ID_LENGTH = 8;

export function gkey(chatId, key) {
  return `group:${chatId}:${key}`;
}

function buildCaseKey(caseId) {
  return `${CASE_KEY_PREFIX}${caseId}`;
}

function randomCaseToken(length = CASE_ID_LENGTH) {
  const out = [];
  const cryptoObj = globalThis.crypto;

  if (cryptoObj?.getRandomValues) {
    const bytes = new Uint8Array(length);
    cryptoObj.getRandomValues(bytes);

    for (let i = 0; i < length; i += 1) {
      out.push(CASE_ALPHABET[bytes[i] % CASE_ALPHABET.length]);
    }

    return out.join("");
  }

  for (let i = 0; i < length; i += 1) {
    const idx = Math.floor(Math.random() * CASE_ALPHABET.length);
    out.push(CASE_ALPHABET[idx]);
  }

  return out.join("");
}

function createCaseId() {
  return randomCaseToken(CASE_ID_LENGTH);
}

export function normalizeCaseId(value) {
  const normalized = String(value || "")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");

  return /^[A-Z0-9]{8}$/.test(normalized) ? normalized : null;
}

export async function getGroupKV(KV, chatId, key) {
  try {
    const val = await KV.get(gkey(chatId, key));
    return val === null ? (DEFAULTS[key] ?? null) : val;
  } catch (err) {
    console.log(`KV GET FAILED [group:${chatId}:${key}]:`, err?.message || err);
    return DEFAULTS[key] ?? null;
  }
}

export async function getKV(KV, key) {
  try {
    const val = await KV.get(key);
    return val === null ? (DEFAULTS[key] ?? null) : val;
  } catch (err) {
    console.log(`KV GET FAILED [${key}]:`, err?.message || err);
    return DEFAULTS[key] ?? null;
  }
}

export async function safeKVGet(KV, key) {
  try {
    return await KV.get(key);
  } catch (err) {
    console.log(`KV GET FAILED [${key}]:`, err?.message || err);
    return null;
  }
}

export async function safeKVPut(KV, key, value) {
  try {
    await KV.put(key, value);
    return true;
  } catch (err) {
    console.log(`KV PUT FAILED [${key}]:`, err?.message || err);
    return false;
  }
}

export async function safeKVDelete(KV, key) {
  try {
    await KV.delete(key);
    return true;
  } catch (err) {
    console.log(`KV DELETE FAILED [${key}]:`, err?.message || err);
    return false;
  }
}

export async function createCaseRecord(KV, payload) {
  if (!KV || !payload || typeof payload !== "object") {
    return null;
  }

  const now = new Date();

  for (let i = 0; i < MAX_CASE_ID_ATTEMPTS; i += 1) {
    const caseId = createCaseId();
    const key = buildCaseKey(caseId);
    const existing = await safeKVGet(KV, key);

    if (existing !== null) {
      continue;
    }

    const record = {
      schema_version: 1,
      case_id: caseId,
      created_at: now.toISOString(),
      ...payload
    };

    const ok = await safeKVPut(KV, key, JSON.stringify(record));
    if (!ok) {
      return null;
    }

    return record;
  }

  console.log("CASE CREATE FAILED: unable to allocate unique case id");
  return null;
}

export async function getCaseRecord(KV, rawCaseId) {
  const caseId = normalizeCaseId(rawCaseId);
  if (!caseId) {
    return null;
  }

  const raw = await safeKVGet(KV, buildCaseKey(caseId));
  const parsed = safeJSON(raw, null);

  if (!parsed || typeof parsed !== "object") {
    return null;
  }

  return {
    ...parsed,
    case_id: normalizeCaseId(parsed.case_id) || caseId
  };
}

export async function send(API, chatId, text, thread) {
  return tg(API, "sendMessage", {
    chat_id: chatId,
    text,
    parse_mode: "Markdown",
    disable_web_page_preview: true,
    message_thread_id: thread ? Number(thread) : undefined,
    is_topic_message: thread ? true : undefined
  });
}

export async function del(API, chatId, id) {
  return tg(API, "deleteMessage", {
    chat_id: chatId,
    message_id: id
  });
}

export function safeJSON(raw, def) {
  try {
    return raw ? JSON.parse(raw) : def;
  } catch {
    return def;
  }
}
