/**
 * Minimal GitHub REST client for the static editor. Everything runs in the browser:
 * the token never leaves this device except in requests to api.github.com.
 */
// The repository the site is built from. The Pages workflow passes it in
// (NEXT_PUBLIC_GITHUB_REPOSITORY = owner/name), so moving the repo needs no code change.
const [repoOwner, repoName] = (process.env.NEXT_PUBLIC_GITHUB_REPOSITORY || "sf2224/rsm").split("/") as [string, string];
export const REPO = {
  owner: repoOwner,
  repo: repoName,
  branch: "main",
  file: "data/published/snapshots.json",
} as const;
const API = "https://api.github.com";

export class GitHubError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
  }
}

async function gh<T>(token: string, path: string, init: RequestInit = {}): Promise<T> {
  let r: Response;
  try {
    r = await fetch(`${API}${path}`, {
      ...init,
      cache: "no-store",
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "X-GitHub-Api-Version": "2022-11-28",
        ...(init.body ? { "Content-Type": "application/json" } : {}),
      },
    });
  } catch {
    throw new GitHubError("Немає з'єднання з інтернетом або сервіс недоступний. Перевірте з'єднання й спробуйте ще раз.", 0);
  }
  if (!r.ok) {
    // People using the editor do not need GitHub's own (English) wording: plain messages only.
    const msg =
      r.status === 401
        ? "Ключ доступу не підійшов: його скопійовано не повністю, або він прострочений. Зверніться до адміністратора сайту."
        : r.status === 403 || r.status === 404
          ? "Цей ключ доступу не дає права змінювати дані сайту. Зверніться до адміністратора сайту."
          : r.status === 409
            ? "Дані щойно змінив хтось інший. Натисніть «Завантажити заново» і внесіть зміни ще раз."
            : r.status >= 500 || r.status === 0
              ? "Сервіс тимчасово недоступний. Спробуйте за кілька хвилин."
              : `Не вдалося зберегти зміни (код ${r.status}). Спробуйте ще раз або зверніться до адміністратора сайту.`;
    throw new GitHubError(msg, r.status);
  }
  return (await r.json()) as T;
}

/**
 * Checks that the token can write to the repository. Returns the GitHub login.
 *
 * `permissions.push` on the repository is not reliable for fine-grained tokens: the
 * repo is public, so a token with "Read and write" on code can still get push:false or
 * no `permissions` at all. When it is not true, the check creates a tiny git blob:
 * that needs Contents write, and an unreferenced blob changes nothing visible in the
 * repository (no commit, no file, no deploy) and is garbage-collected by GitHub.
 */
export async function checkAccess(token: string): Promise<string> {
  const repo = await gh<{ permissions?: { push?: boolean } }>(token, `/repos/${REPO.owner}/${REPO.repo}`);
  if (!repo.permissions?.push) {
    try {
      await gh(token, `/repos/${REPO.owner}/${REPO.repo}/git/blobs`, {
        method: "POST",
        body: JSON.stringify({
          content: "imi-editor-access-check",
          encoding: "utf-8",
        }),
      });
    } catch (e) {
      if (e instanceof GitHubError && (e.status === 403 || e.status === 404))
        throw new GitHubError("Цей ключ доступу не дає права змінювати дані сайту. Зверніться до адміністратора сайту.", 403);
      throw e;
    }
  }
  try {
    const me = await gh<{ login: string }>(token, "/user");
    return me.login;
  } catch {
    return "GitHub";
  }
}

const b64ToUtf8 = (b64: string) => new TextDecoder().decode(Uint8Array.from(atob(b64.replace(/\n/g, "")), (c) => c.charCodeAt(0)));
const utf8ToB64 = (s: string) => {
  const bytes = new TextEncoder().encode(s);
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
};

export async function readDataFile(token: string): Promise<{ json: unknown; sha: string }> {
  const f = await gh<{ content: string; sha: string; encoding: string }>(token, `/repos/${REPO.owner}/${REPO.repo}/contents/${REPO.file}?ref=${REPO.branch}`);
  return { json: JSON.parse(b64ToUtf8(f.content)), sha: f.sha };
}

/** One commit that replaces the data file. Fails with 409 if someone changed it meanwhile. */
export async function writeDataFile(token: string, json: unknown, sha: string, message: string): Promise<{ sha: string; commit: string }> {
  const r = await gh<{ content: { sha: string }; commit: { sha: string } }>(token, `/repos/${REPO.owner}/${REPO.repo}/contents/${REPO.file}`, {
    method: "PUT",
    body: JSON.stringify({
      message,
      content: utf8ToB64(`${JSON.stringify(json, null, 2)}\n`),
      sha,
      branch: REPO.branch,
    }),
  });
  return { sha: r.content.sha, commit: r.commit.sha };
}

export type RunState = {
  status: string;
  conclusion: string | null;
  url: string;
} | null;

/** State of the "Deploy site to GitHub Pages" run for a commit. */
export async function deployState(token: string, commit: string): Promise<RunState> {
  const r = await gh<{
    workflow_runs: Array<{
      name: string;
      status: string;
      conclusion: string | null;
      html_url: string;
    }>;
  }>(token, `/repos/${REPO.owner}/${REPO.repo}/actions/runs?head_sha=${commit}&per_page=10`);
  const run = r.workflow_runs.find((w) => w.name.toLowerCase().includes("pages")) ?? r.workflow_runs[0];
  return run ? { status: run.status, conclusion: run.conclusion, url: run.html_url } : null;
}

/* ---------------- token kept on this device, encrypted with the editor password ---------------- */

const STORE = "imi-editor-vault-v1";
const enc = new TextEncoder();

async function keyFrom(password: string, salt: Uint8Array<ArrayBuffer>) {
  const base = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey({ name: "PBKDF2", salt, iterations: 600_000, hash: "SHA-256" }, base, { name: "AES-GCM", length: 256 }, false, [
    "encrypt",
    "decrypt",
  ]);
}
const toB64 = (a: ArrayBuffer | Uint8Array) => btoa(String.fromCharCode(...new Uint8Array(a)));
const fromB64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

export function hasVault(): boolean {
  try {
    return !!localStorage.getItem(STORE);
  } catch {
    return false;
  }
}

export function vaultLogin(): string | null {
  try {
    const v = JSON.parse(localStorage.getItem(STORE) ?? "null") as {
      login?: string;
    } | null;
    return v?.login ?? null;
  } catch {
    return null;
  }
}

export async function saveVault(token: string, password: string, login: string) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await keyFrom(password, salt);
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, enc.encode(token));
  localStorage.setItem(
    STORE,
    JSON.stringify({
      v: 1,
      login,
      salt: toB64(salt),
      iv: toB64(iv),
      ct: toB64(ct),
    }),
  );
}

export async function openVault(password: string): Promise<string> {
  const v = JSON.parse(localStorage.getItem(STORE) ?? "null") as {
    salt: string;
    iv: string;
    ct: string;
  } | null;
  if (!v) throw new Error("На цьому пристрої немає збереженого входу.");
  try {
    const key = await keyFrom(password, fromB64(v.salt));
    const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: fromB64(v.iv) }, key, fromB64(v.ct));
    return new TextDecoder().decode(pt);
  } catch {
    throw new Error("Неправильний пароль.");
  }
}

export function forgetVault() {
  try {
    localStorage.removeItem(STORE);
  } catch {
    /* ignore */
  }
}
