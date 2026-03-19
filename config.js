// config.js

export const GROUP_ID = -1001901372111;
export const LOG_THREAD_ID = 82107;

export const LINK_REGEX =
  /(https?:\/\/[^\s]+|t\.me\/[^\s]+|telegram\.me\/[^\s]+|wa\.me\/[^\s]+|bit\.ly\/[^\s]+|tinyurl\.com\/[^\s]+)/gi;

export const DEFAULTS = {
  flood_limit: "5",
  flood_window: "10",
  mute_minutes: "60",
  banned_words: "",
  link_whitelist: "[]",
  link_blacklist: "[]",
  link_mode: "hybrid",
  welcome_text: "Selamat Bergabung di *TeMan* 🤍",
  welcome_media: "",
  welcome_links: "[]"
};

export const floodMap = {};
