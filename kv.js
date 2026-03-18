// kv.js

import { DEFAULTS } from "./config.js";
import { tg } from "./telegram.js";

export function gkey(chatId, key) {
  return `group:${chatId}:${key}`;
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
