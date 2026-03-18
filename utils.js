// utils.js

export function renderAdminList(title, list) {
  if (!Array.isArray(list) || !list.length) return "📭 Kosong";
  return `${title}\n\`\`\`\n${list.join("\n")}\n\`\`\``;
}

export function extractDomain(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return null;
  }
}

export function normalizeDomainInput(input) {
  const s = String(input || "").trim().toLowerCase();
  if (!s) return s;

  try {
    const withProtocol = /^https?:\/\//i.test(s) ? s : `https://${s}`;
    const u = new URL(withProtocol);
    const host = (u.hostname || "").replace(/^www\./, "");
    const path = (u.pathname && u.pathname !== "/") ? u.pathname : "";
    return path ? `${host}${path}` : host;
  } catch {
    return s
      .replace(/^https?:\/\//i, "")
      .replace(/^www\./i, "")
      .replace(/\/+$/g, "");
  }
}

export function getSafeNumber(v, def) {
  const n = Number(v);
  return isNaN(n) || n <= 0 ? def : n;
}

export function cleanUndefined(obj) {
  return Object.fromEntries(
    Object.entries(obj).filter(([, v]) => v !== undefined)
  );
}

export function escapeBasicMarkdown(text) {
  return String(text || "").replace(/([_*[\]()`])/g, "\\$1");
}
