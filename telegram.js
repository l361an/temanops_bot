// telegram.js

import { cleanUndefined } from "./utils.js";

export async function tg(API, method, payload) {
  try {
    const res = await fetch(`${API}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(cleanUndefined(payload))
    });

    const data = await res.json().catch(() => ({}));

    if (!res.ok || data?.ok === false) {
      console.log(`TG ${method} FAILED:`, JSON.stringify(data));
      return null;
    }

    return data;
  } catch (err) {
    console.log(`TG ${method} ERROR:`, err?.message || err);
    return null;
  }
}
