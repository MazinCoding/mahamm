import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const dictionaries = {
  en: JSON.parse(readFileSync(path.join(root, 'locales', 'en.json'), 'utf8')),
  ar: JSON.parse(readFileSync(path.join(root, 'locales', 'ar.json'), 'utf8')),
};

export const LANGS = ['en', 'ar'];

function lookup(dict, key) {
  return key.split('.').reduce((node, part) => (node && typeof node === 'object' ? node[part] : undefined), dict);
}

export function translator(lang) {
  const dict = dictionaries[lang] || dictionaries.en;
  return function t(key, vars) {
    let value = lookup(dict, key);
    if (value === undefined) value = lookup(dictionaries.en, key);
    if (typeof value !== 'string') return key;
    if (!vars) return value;
    return value.replace(/\{(\w+)\}/g, (m, k) => (vars[k] === undefined || vars[k] === null ? '' : String(vars[k])));
  };
}

export function pickLang(req) {
  if (req.user?.lang && LANGS.includes(req.user.lang)) return req.user.lang;
  if (req.session?.lang && LANGS.includes(req.session.lang)) return req.session.lang;
  const header = String(req.headers['accept-language'] || '').toLowerCase();
  return header.startsWith('ar') ? 'ar' : 'en';
}

// Locale-aware date helpers, always shown in the company's time zone.
export function formatters(lang, timezone) {
  const loc = lang === 'ar' ? 'ar-OM-u-nu-latn' : 'en-GB';
  const dateFmt = new Intl.DateTimeFormat(loc, { day: 'numeric', month: 'short', year: 'numeric', timeZone: timezone });
  const shortFmt = new Intl.DateTimeFormat(loc, { day: 'numeric', month: 'short', timeZone: timezone });
  const dayFmt = new Intl.DateTimeFormat(loc, { weekday: 'long', day: 'numeric', month: 'long', timeZone: timezone });
  const fullFmt = new Intl.DateTimeFormat(loc, {
    day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false, timeZone: timezone,
  });
  const rtf = new Intl.RelativeTimeFormat(lang === 'ar' ? 'ar-u-nu-latn' : 'en', { numeric: 'auto' });
  const toDate = (v) => (v instanceof Date ? v : new Date(v));
  // A `date` column arrives as 'YYYY-MM-DD'; format it at noon UTC so it never shifts a day.
  const dayOnly = (v) => (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) ? new Date(`${v}T12:00:00Z`) : toDate(v));
  return {
    date: (v) => (v ? dateFmt.format(dayOnly(v)) : ''),
    short: (v) => (v ? shortFmt.format(dayOnly(v)) : ''),
    day: (v) => (v ? dayFmt.format(dayOnly(v)) : ''),
    dateTime: (v) => (v ? fullFmt.format(toDate(v)) : ''),
    iso: (v) => (v ? toDate(v).toISOString() : ''),
    ago: (v) => {
      if (!v) return '';
      const diff = toDate(v).getTime() - Date.now();
      const abs = Math.abs(diff);
      if (abs < 60_000) return rtf.format(0, 'second');
      if (abs < 3_600_000) return rtf.format(Math.round(diff / 60_000), 'minute');
      if (abs < 86_400_000) return rtf.format(Math.round(diff / 3_600_000), 'hour');
      if (abs < 31 * 86_400_000) return rtf.format(Math.round(diff / 86_400_000), 'day');
      return dateFmt.format(toDate(v));
    },
  };
}
