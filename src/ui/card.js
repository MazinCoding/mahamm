import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// The card a connected app can show with the connector's results (an MCP App
// resource): one HTML page with its own script and styles, plus the strings it
// needs in both languages. It runs in the app's sandbox, not on Mahamm's site.

export const CARD_URI = 'ui://mahamm/card.html';
export const CARD_MIME = 'text/html;profile=mcp-app';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..', '..');
const SECTIONS = ['card', 'status', 'priority', 'preview', 'reason'];

let html = null;
export function cardHtml() {
  if (!html) {
    const strings = {};
    for (const lang of ['en', 'ar']) {
      const dict = JSON.parse(readFileSync(path.join(root, 'locales', `${lang}.json`), 'utf8'));
      strings[lang] = Object.fromEntries(SECTIONS.map((k) => [k, dict[k]]));
    }
    // Inside a script element, "<" is written as < so no string can end it.
    const json = JSON.stringify(strings).replace(/</g, '\\u003c');
    html = readFileSync(path.join(here, 'card.html'), 'utf8').replace('"__STRINGS__"', json);
  }
  return html;
}

export function cardResource(oauth) {
  const ui = { prefersBorder: true, csp: { connectDomains: [], resourceDomains: [] } };
  if (oauth.uiDomain) ui.domain = oauth.uiDomain;
  return { uri: CARD_URI, mimeType: CARD_MIME, text: cardHtml(), _meta: { ui } };
}
