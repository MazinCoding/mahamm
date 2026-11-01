import { audit } from '../audit.js';
import { one, tx } from '../db.js';

export const WIP_MIN = 1;
export const WIP_MAX = 50;

// The in-progress limit: the admins' choice if they made one, otherwise WIP_LIMIT.
export async function getWipLimit(fallback) {
  const row = await one(`SELECT value FROM app_settings WHERE key = 'wip_limit'`);
  const n = Number(row?.value);
  return Number.isInteger(n) && n >= WIP_MIN && n <= WIP_MAX ? n : fallback;
}

export async function setWipLimit(value, fallback, actor, ip) {
  return tx(async (db) => {
    const { rows } = await db.query(`SELECT value FROM app_settings WHERE key = 'wip_limit' FOR UPDATE`);
    const from = rows[0] ? Number(rows[0].value) : fallback;
    if (from === value) return { changed: false };
    await db.query(
      `INSERT INTO app_settings (key, value, updated_at, updated_by) VALUES ('wip_limit', $1, now(), $2)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now(), updated_by = EXCLUDED.updated_by`,
      [JSON.stringify(value), actor.id],
    );
    await audit(db, { actorId: actor.id, action: 'settings.wip_limit_changed', details: { from, to: value }, ip });
    return { changed: true, from };
  });
}

export async function inProgressCount() {
  return (await one(`SELECT count(*)::int AS n FROM tasks WHERE closed_at IS NULL AND status = 'progress'`)).n;
}
