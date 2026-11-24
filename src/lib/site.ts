import type { Locale } from "./data/schema";

/**
 * Build-time settings shared by server and client code.
 * NEXT_PUBLIC_BASE_PATH is "/<repo>" for GitHub Pages (https://<owner>.github.io/<repo>/), "" otherwise.
 */
export const BASE_PATH = (process.env.NEXT_PUBLIC_BASE_PATH ?? "").replace(/\/+$/, "");
export const IS_STATIC = process.env.NEXT_PUBLIC_STATIC_EXPORT === "1";

/** Prefix a site-absolute path ("/brand/x.svg") with the base path. */
export function withBase(path: string): string {
  return `${BASE_PATH}${path}`;
}

/** Route of a public page without base path: "/", "/en", "/present", "/en/present" (trailing slash on static hosting). */
export function routePath(locale: Locale, path: "/" | "/present" = "/"): string {
  const p = locale === "uk" ? path : `/en${path === "/" ? "" : path}`;
  if (!IS_STATIC) return p;
  return p.endsWith("/") ? p : `${p}/`;
}

/** Link to a public page, base path included. */
export function pageHref(locale: Locale, path: "/" | "/present" = "/"): string {
  return withBase(routePath(locale, path));
}
