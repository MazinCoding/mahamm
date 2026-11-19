import { after, before, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { loadConfig } from '../src/config.js';
import { CARD_URI } from '../src/ui/card.js';
import { connectApp, createUser, resetLimits, setup, teardown, testEnv } from './helpers.js';

const RETURN = 'https://app.example.test/callback';
const DOMAIN = '0123456789abcdef0123456789abcdef.cards.example.test';
let app;
before(async () => ({ app } = await setup({ OAUTH_REDIRECT_URIS: RETURN, CONNECTOR_UI_DOMAIN: DOMAIN })));
after(teardown);
beforeEach(resetLimits);

let nextId = 1;
async function rpc(token, method, params) {
  const res = await request(app).post('/connector').set('Authorization', `Bearer ${token}`).send({ jsonrpc: '2.0', id: nextId++, method, params });
  assert.equal(res.status, 200, res.text);
  return res.body;
}

describe('connector: cards', () => {
  test('the card tools point to the card; the confirm tools are for the card only', async () => {
    const token = await connectApp(app, await createUser({ name: 'Card Person One' }), RETURN);
    const init = await rpc(token, 'initialize', { protocolVersion: '2025-11-25', capabilities: {} });
    assert.ok(init.result.capabilities.resources);
    const { tools } = (await rpc(token, 'tools/list', {})).result;
    const withCard = tools.filter((t) => t._meta?.ui?.resourceUri === CARD_URI).map((t) => t.name);
    assert.deepEqual(withCard, ['my_work', 'get_task', 'create_tasks', 'update_tasks', 'close_tasks', 'join_task', 'admin_change']);
    for (const name of ['confirm_preview', 'cancel_preview']) {
      const t = tools.find((x) => x.name === name);
      assert.deepEqual(t._meta.ui.visibility, ['app']);
      assert.equal(t._meta.ui.resourceUri, undefined);
    }
  });

  test('the card resource: one page with both languages, the configured domain, nothing external', async () => {
    const token = await connectApp(app, await createUser({ name: 'Card Person Two' }), RETURN);
    const { resources } = (await rpc(token, 'resources/list', {})).result;
    assert.deepEqual(resources.map((r) => [r.uri, r.mimeType]), [[CARD_URI, 'text/html;profile=mcp-app']]);
    const { contents: [card] } = (await rpc(token, 'resources/read', { uri: CARD_URI })).result;
    assert.equal(card.mimeType, 'text/html;profile=mcp-app');
    assert.equal(card._meta.ui.domain, DOMAIN);
    assert.equal(card._meta.ui.prefersBorder, true);
    assert.deepEqual(card._meta.ui.csp, { connectDomains: [], resourceDomains: [] });
    assert.ok(card.text.startsWith('<!doctype html>'));
    assert.ok(!card.text.includes('__STRINGS__'));
    assert.ok(card.text.includes('"addedOne":"Added 1 task"'));
    assert.ok(card.text.includes('"addedOne":"أُضيفت مهمة واحدة"'));
    assert.ok(!/innerHTML|outerHTML|insertAdjacentHTML|eval\(|new Function/.test(card.text));
    assert.ok(!/(src|href)="https?:/.test(card.text));
    assert.equal((await rpc(token, 'resources/templates/list', {})).result.resourceTemplates.length, 0);
    const unknown = await rpc(token, 'resources/read', { uri: 'ui://mahamm/other.html' });
    assert.equal(unknown.error.code, -32602);
  });

  test('card results say which tool and whose language; other results carry no card', async () => {
    const me = await createUser({ name: 'Card Person Three' });
    const token = await connectApp(app, me, RETURN);
    const call = async (name, args) => (await rpc(token, 'tools/call', { name, arguments: args })).result;
    const added = await call('create_tasks', { tasks: [{ title: 'Card test task', assign_to_me: true }] });
    assert.deepEqual(added._meta['mahamm/card'], {
      tool: 'create_tasks', lang: 'en', you: 'Card Person Three', timezone: 'Asia/Muscat', origin: 'http://localhost:3000', app_name: 'Mahamm',
    });
    const id = added.structuredContent.tasks[0].id;
    assert.equal((await call('get_task', { task_id: id }))._meta['mahamm/card'].tool, 'get_task');
    assert.equal((await call('my_work', {}))._meta['mahamm/card'].tool, 'my_work');
    assert.equal((await call('search_tasks', { words: ['Card test'] }))._meta, undefined);
  });

  test('the card domain must look like a host name', () => {
    assert.throws(() => loadConfig({ ...testEnv, CONNECTOR_UI_DOMAIN: 'https://bad domain/' }));
    assert.equal(loadConfig({ ...testEnv, CONNECTOR_UI_DOMAIN: DOMAIN }).oauth.uiDomain, DOMAIN);
    assert.equal(loadConfig(testEnv).oauth.uiDomain, null);
  });
});
