import { checkBaseUrl } from "./api-url.js";

/** OpenRouter by its host, exactly: `URL.host` would carry a port, and a suffix match would take `evilopenrouter.ai`. */
export function isOpenRouter(baseUrl: string): boolean {
  const checked = checkBaseUrl(baseUrl);
  return checked.ok && checked.url.hostname === "openrouter.ai";
}

/**
 * OpenRouter's app attribution, as Claude Code's ANTHROPIC_CUSTOM_HEADERS takes it: one
 * `Name: Value` per line. HTTP-Referer is what makes OpenRouter count the request for an app -
 * without it there is no app page and no ranking - and the URL in it is the app's identifier;
 * X-OpenRouter-Title is the name shown (X-Title is its older spelling); the category is one of
 * OpenRouter's fixed list. https://openrouter.ai/docs/app-attribution
 *
 * They name clausona and nothing else: no account, profile, model or machine.
 */
export const OPENROUTER_APP_HEADERS = [
  "HTTP-Referer: https://larcane97.github.io/clausona/",
  "X-OpenRouter-Title: clausona",
  "X-OpenRouter-Categories: cli-agent",
].join("\n");
