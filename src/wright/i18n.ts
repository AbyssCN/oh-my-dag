/**
 * src/wright/i18n.ts — bilingual (EN/ZH) string primitive for the Xihe CLI + skills.
 *
 * Mechanism A (inline co-located literals): every user-facing string is written as
 * `m({ en, zh })` right at its call site, so the two languages live in the same object
 * and cannot drift into separate files. The `Bilingual` type makes BOTH branches
 * mandatory — forgetting `zh:` is a `tsc` compile error, which is a stronger
 * missing-translation guard than any runtime test (see CLAUDE.md i18n decision: A).
 *
 * Command NAMES stay English (`/iterate`, `/audit`); only the human-facing
 * `description` / notify / status strings flow through `m()`.
 *
 * Locale priority (highest first):
 *   XIHE_LANG env (en|zh)             ← explicit override, also our headless/test knob
 *     → .wright/config.json "lang"     ← durable, TUI-settable (persistLang)
 *       → $LC_ALL / $LANG / $LANGUAGE ← zh_CN.UTF-8 → zh (auto, OSS default flow)
 *         → 'en'                      ← OSS default (GitHub-convention English-first)
 *
 * The resolved language is cached once per process: CLI descriptions register at boot,
 * so a single resolution is correct. `setLang` / `resetLangCache` are the test + runtime
 * switch hooks (TUI `/lang` would call persistLang then resetLangCache).
 */
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { configPath } from '../model/role-models';

export type Lang = 'en' | 'zh';

/** A user-facing string in both supported languages. Both mandatory → `tsc` rejects half-translations. */
export interface Bilingual {
  en: string;
  zh: string;
}

export const SUPPORTED_LANGS: readonly Lang[] = ['en', 'zh'];

// ---------------------------------------------------------------------------
// language resolution
// ---------------------------------------------------------------------------

/** Map a raw tag (env value, $LANG, config) to a supported Lang, or null if unrecognized. */
export function normalizeLang(raw: string | undefined | null): Lang | null {
  if (!raw) return null;
  const s = raw.trim().toLowerCase();
  if (!s) return null;
  // zh_CN.UTF-8 / zh-Hans / zh-TW / chinese / 中文 → zh
  if (s.startsWith('zh') || s.startsWith('chinese') || s.includes('中文') || s.includes('hans') || s.includes('hant')) {
    return 'zh';
  }
  // en_US.UTF-8 / en-GB / english → en
  if (s.startsWith('en') || s.startsWith('english')) return 'en';
  return null;
}

let langCache: Lang | null = null;
let overrideLang: Lang | null = null;

/** Read the `lang` field from .wright/config.json (silent on any failure, like role-models). */
function configLang(path = configPath()): Lang | null {
  try {
    statSync(path); // fast existence check; avoid throwing read on missing file
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as { lang?: string };
    return normalizeLang(parsed.lang);
  } catch {
    return null;
  }
}

/** Resolve the active language by priority. Pure given (env, config file); not cached here. */
export function resolveLang(env: Record<string, string | undefined> = process.env): Lang {
  if (overrideLang) return overrideLang;
  const explicit = normalizeLang(env.XIHE_LANG);
  if (explicit) return explicit;
  const fromFile = configLang();
  if (fromFile) return fromFile;
  const auto = normalizeLang(env.LC_ALL ?? env.LANG ?? env.LANGUAGE);
  if (auto) return auto;
  return 'en';
}

/** The active language, resolved once per process and cached. */
export function lang(): Lang {
  if (langCache === null) langCache = resolveLang();
  return langCache;
}

/** Force the active language (test hook + TUI runtime switch). Pass null to clear the override. */
export function setLang(l: Lang | null): void {
  overrideLang = l;
  langCache = null;
}

/** Drop the cached resolution — call after an out-of-band config write or env change (test hook). */
export function resetLangCache(): void {
  langCache = null;
}

// ---------------------------------------------------------------------------
// the primitive
// ---------------------------------------------------------------------------

/**
 * Pick the active-language branch of a bilingual string. Falls back to `en` when the
 * active branch is empty (defensive: an accidental `zh: ''` never renders blank).
 */
export function m(b: Bilingual, active: Lang = lang()): string {
  const picked = b[active];
  return picked && picked.length > 0 ? picked : b.en;
}

// ---------------------------------------------------------------------------
// durable persistence (symmetric with persistRoleModel; backs a future TUI /lang)
// ---------------------------------------------------------------------------

/** Durably set the UI language in .wright/config.json, preserving other sections. */
export function persistLang(l: Lang, path = configPath()): void {
  let cfg: Record<string, unknown> = { version: 1 };
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
    if (parsed && typeof parsed === 'object') cfg = parsed;
  } catch {
    // new / unreadable — start fresh
  }
  if (cfg.version === undefined) cfg.version = 1;
  cfg.lang = l;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(cfg, null, 2)}\n`);
  resetLangCache();
}
