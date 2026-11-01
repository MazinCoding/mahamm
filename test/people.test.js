import { after, before, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { q } from '../src/db.js';
import { PASSWORD, auditFor, createUser, csrfIn, makeTask, post, resetLimits, setup, signIn, teardown } from './helpers.js';

let app;
let sent;
let admin;
let adminAgent;
let member;
let memberAgent;

before(async () => {
  ({ app, sent } = await setup());
  admin = await createUser({ name: 'Mazin Admin', role: 'admin', twoFactor: true });
  member = await createUser({ name: 'Aisha Member' });
  adminAgent = await signIn(app, admin);
  memberAgent = await signIn(app, member);
});
after(teardown);
beforeEach(resetLimits);

const personNamed = async (name) => (await q('SELECT * FROM users WHERE name = $1', [name])).rows[0];

async function addPerson(name) {
  const res = await post(adminAgent, '/people/add', { name }, '/people');
  assert.equal(res.status, 302, `adding ${name}`);
  return personNamed(name);
}

async function inviteFor(personId, email, role = 'member') {
  const res = await post(adminAgent, `/people/${personId}/invite`, { email, role }, '/people');
  assert.equal(res.status, 200, 'link page shown');
  return res.text.match(/value="http:\/\/localhost:3000\/invite\/([^"]+)"/)[1];
}

async function accept(token, name, guest = request.agent(app)) {
  const page = await guest.get(`/invite/${token}`);
  const res = await guest.post(`/invite/${token}`).type('form').send({ _csrf: csrfIn(page.text), name, password: PASSWORD, confirm: PASSWORD });
  return { page, res, guest };
}

describe('adding people without accounts', () => {
  test('an admin adds someone by name; they show as "No account yet" and the audit log records it', async () => {
    const person = await addPerson('Khalid Al-Hinai');
    assert.equal(person.email, null);
    assert.equal(person.password_hash, null);
    assert.equal(person.role, 'member');
    assert.equal(person.email_notifications, false);
    const page = await adminAgent.get('/people');
    assert.match(page.text, /Khalid Al-Hinai/);
    assert.match(page.text, /No account yet/);
    assert.match(page.text, new RegExp(`/people/${person.id}/invite`));
    assert.doesNotMatch(page.text, new RegExp(`/people/${person.id}/reset-link`), 'no reset link without an account');
    const ev = (await q(`SELECT actor_id, subject_user_id, details FROM audit_events WHERE action = 'person.added' AND subject_user_id = $1`, [person.id])).rows[0];
    assert.equal(ev.actor_id, admin.id);
    assert.equal(ev.details.name, 'Khalid Al-Hinai');
  });

  test('empty names and exact duplicates (ignoring case) are refused', async () => {
    await addPerson('Salim Duplicate');
    const dup = await post(adminAgent, '/people/add', { name: 'salim duplicate' }, '/people');
    assert.equal(dup.status, 409);
    assert.match(dup.text, /already on the list/);
    const empty = await post(adminAgent, '/people/add', { name: '   ' }, '/people');
    assert.equal(empty.status, 400);
    assert.equal((await q(`SELECT count(*)::int AS n FROM users WHERE lower(name) = 'salim duplicate'`)).rows[0].n, 1);
  });

  test('members cannot add, rename or invite people', async () => {
    const person = await addPerson('Huda Only Admins');
    assert.equal((await post(memberAgent, '/people/add', { name: 'Sneaky Person' })).status, 403);
    assert.equal((await post(memberAgent, `/people/${person.id}/rename`, { name: 'Renamed By Member' })).status, 403);
    assert.equal((await post(memberAgent, `/people/${person.id}/invite`, { email: 'huda@example.com', role: 'admin' })).status, 403);
    assert.equal(await personNamed('Sneaky Person'), undefined);
    assert.equal((await q('SELECT name FROM users WHERE id = $1', [person.id])).rows[0].name, 'Huda Only Admins');
    assert.equal((await q('SELECT count(*)::int AS n FROM invites WHERE user_id = $1', [person.id])).rows[0].n, 0);
  });

  test('an admin can fix the name of someone without an account, but not of someone with one', async () => {
    const person = await addPerson('Ahmd Typo');
    assert.equal((await post(adminAgent, `/people/${person.id}/rename`, { name: 'Ahmed Fixed' }, '/people')).status, 302);
    assert.equal((await q('SELECT name FROM users WHERE id = $1', [person.id])).rows[0].name, 'Ahmed Fixed');
    const ev = (await q(`SELECT details FROM audit_events WHERE action = 'person.renamed' AND subject_user_id = $1`, [person.id])).rows[0];
    assert.deepEqual({ from: ev.details.from, to: ev.details.to }, { from: 'Ahmd Typo', to: 'Ahmed Fixed' });

    await post(adminAgent, `/people/${member.id}/rename`, { name: 'Not Your Name' }, '/people');
    assert.equal((await q('SELECT name FROM users WHERE id = $1', [member.id])).rows[0].name, 'Aisha Member');
  });

  test('their role cannot be changed and no reset link can be made for them', async () => {
    const person = await addPerson('Rashid No Role');
    await post(adminAgent, `/people/${person.id}/role`, { role: 'admin' }, '/people');
    assert.equal((await q('SELECT role FROM users WHERE id = $1', [person.id])).rows[0].role, 'member');
    assert.equal((await post(adminAgent, `/people/${person.id}/reset-link`, {}, '/people')).status, 404);
    assert.equal((await q('SELECT count(*)::int AS n FROM password_resets WHERE user_id = $1', [person.id])).rows[0].n, 0);
  });

  test('the database refuses half an account', async () => {
    await assert.rejects(q(`INSERT INTO users (name, email) VALUES ('Half Account', 'half@example.com')`));
    await assert.rejects(q(`INSERT INTO users (name, role) VALUES ('Admin Without Account', 'admin')`));
  });
});

describe('working with people without accounts', () => {
  test('any member can assign and credit them; they get no notifications or emails', async () => {
    const person = await addPerson('Fatma Field Team');
    const sentBefore = sent.length;
    const id = await makeTask(memberAgent, { title: 'Count the stock in store 2', assignees: [person.id] });
    const assignees = (await q('SELECT user_id FROM task_assignees WHERE task_id = $1', [id])).rows.map((r) => r.user_id);
    assert.deepEqual(assignees, [person.id]);

    const res = await post(memberAgent, `/tasks/${id}/close`, { reason: 'completed', credited: [person.id] }, `/tasks/${id}/close`);
    assert.equal(res.status, 302);
    const credits = (await q('SELECT user_id FROM task_credits WHERE task_id = $1', [id])).rows.map((r) => r.user_id);
    assert.deepEqual(credits, [person.id]);
    const closed = (await auditFor(id)).find((e) => e.action === 'task.closed');
    assert.equal(closed.actor_id, member.id);

    assert.equal((await q('SELECT count(*)::int AS n FROM notifications WHERE user_id = $1', [person.id])).rows[0].n, 0);
    assert.equal((await q(`SELECT count(*)::int AS n FROM email_outbox WHERE to_email IS NULL`)).rows[0].n, 0);
    assert.equal(sent.length, sentBefore);
    const page = await memberAgent.get(`/tasks/${id}`);
    assert.match(page.text, /Fatma Field Team/);
  });

  test('nobody can sign in as them', async () => {
    await addPerson('Nasser No Login');
    const agent = request.agent(app);
    const page = await agent.get('/login');
    const res = await agent.post('/login').type('form').send({ _csrf: csrfIn(page.text), email: '', password: PASSWORD });
    assert.notEqual(res.headers.location, '/board');
    assert.equal((await agent.get('/board')).status, 302);
  });
});

describe('inviting a person who is already on the list', () => {
  test('accepting gives the same person an account, with their tasks, and lets them correct the name', async () => {
    const person = await addPerson('Said Field');
    const id = await makeTask(memberAgent, { title: 'Fix the gate at site B', assignees: [person.id] });
    const token = await inviteFor(person.id, 'Said.AlBalushi@Example.com');
    const invite = (await q('SELECT user_id, email, role FROM invites WHERE user_id = $1', [person.id])).rows[0];
    assert.equal(invite.email, 'said.albalushi@example.com');

    const invited = (await q(`SELECT details FROM audit_events WHERE action = 'user.invited' AND subject_user_id = $1`, [person.id])).rows[0];
    assert.equal(invited.details.user_id, person.id);

    const { page, res, guest } = await accept(token, 'Said Al-Balushi');
    assert.match(page.text, /value="Said Field"/, 'name pre-filled with what the admin typed');
    assert.equal(res.status, 302);

    const after = (await q('SELECT id, email, name, role, email_notifications, password_hash FROM users WHERE id = $1', [person.id])).rows[0];
    assert.equal(after.email, 'said.albalushi@example.com');
    assert.equal(after.name, 'Said Al-Balushi');
    assert.equal(after.email_notifications, true);
    assert.ok(after.password_hash);
    assert.equal((await q(`SELECT count(*)::int AS n FROM users WHERE email = 'said.albalushi@example.com'`)).rows[0].n, 1, 'no second person');

    const mine = await guest.get(`/tasks/${id}`);
    assert.equal(mine.status, 200);
    assert.match(mine.text, /Said Al-Balushi/);

    const accepted = (await q(`SELECT actor_id, details FROM audit_events WHERE action = 'invite.accepted' AND subject_user_id = $1`, [person.id])).rows[0];
    assert.equal(accepted.actor_id, person.id);
    assert.equal(accepted.details.existing_person, true);
    assert.equal(accepted.details.name_from, 'Said Field');

    assert.equal((await request(app).get(`/invite/${token}`)).status, 410, 'invite works once');
    await signIn(app, { email: 'said.albalushi@example.com' });
  });

  test('the role comes from the invite', async () => {
    const person = await addPerson('Maryam Future Admin');
    const token = await inviteFor(person.id, 'maryam@example.com', 'admin');
    const { res } = await accept(token, 'Maryam Future Admin');
    assert.equal(res.headers.location, '/settings/two-factor', 'new admins set up two-step first');
    assert.equal((await q('SELECT role FROM users WHERE id = $1', [person.id])).rows[0].role, 'admin');
  });

  test('the invite stops working if the person is disabled, and a new invite replaces the old one', async () => {
    const person = await addPerson('Yusuf Disabled Later');
    const first = await inviteFor(person.id, 'yusuf.one@example.com');
    const second = await inviteFor(person.id, 'yusuf.two@example.com');
    assert.equal((await request(app).get(`/invite/${first}`)).status, 410, 'older invite for the same person cancelled');
    await post(adminAgent, `/people/${person.id}/status`, { status: 'disabled' }, '/people');
    assert.equal((await request(app).get(`/invite/${second}`)).status, 410);
    const res = await post(adminAgent, `/people/${person.id}/invite`, { email: 'yusuf.three@example.com', role: 'member' }, '/people');
    assert.equal(res.status, 302, 'refused while disabled');
    assert.equal((await q('SELECT email FROM users WHERE id = $1', [person.id])).rows[0].email, null);
  });

  test('an email that already has an account is refused', async () => {
    const person = await addPerson('Zahra Taken Email');
    const res = await post(adminAgent, `/people/${person.id}/invite`, { email: member.email, role: 'member' }, '/people');
    assert.equal(res.status, 302);
    const flashPage = await adminAgent.get('/people');
    assert.match(flashPage.text, /already has an account/);
    assert.equal((await q('SELECT count(*)::int AS n FROM invites WHERE user_id = $1', [person.id])).rows[0].n, 0);
  });

  test('choosing a name someone active already has is caught on the invite page', async () => {
    const person = await addPerson('Omar To Rename');
    const token = await inviteFor(person.id, 'omar@example.com');
    const { res } = await accept(token, 'Aisha Member');
    assert.equal(res.status, 400);
    assert.match(res.text, /already uses that name/);
    assert.equal((await q('SELECT email FROM users WHERE id = $1', [person.id])).rows[0].email, null);
  });

  test('people with accounts can still be invited as before (no person attached)', async () => {
    const res = await post(adminAgent, '/people/invite', { email: 'brand.new@example.com', role: 'member' }, '/people');
    assert.equal(res.status, 200);
    const invite = (await q(`SELECT user_id FROM invites WHERE email = 'brand.new@example.com'`)).rows[0];
    assert.equal(invite.user_id, null);
  });
});

describe('Arabic', () => {
  test('the People page shows the badge and form in Arabic', async () => {
    await addPerson('ليلى الحارثية');
    await q(`UPDATE users SET lang = 'ar' WHERE id = $1`, [admin.id]);
    try {
      const page = await adminAgent.get('/people');
      assert.match(page.text, /dir="rtl"/);
      assert.match(page.text, /لا حساب بعد/);
      assert.match(page.text, /إضافة شخص بلا حساب/);
      assert.match(page.text, /<bdi>ليلى الحارثية<\/bdi>/);
    } finally {
      await q(`UPDATE users SET lang = 'en' WHERE id = $1`, [admin.id]);
    }
  });
});
