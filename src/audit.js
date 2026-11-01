// Append-only audit log. The table rejects UPDATE, DELETE and TRUNCATE.

export const GROUPS = {
  task: ['task.created', 'task.edited', 'task.moved', 'task.imported', 'import.completed'],
  comment: ['task.commented', 'task.attachment_added', 'task.attachment_removed'],
  close: ['task.closed', 'task.reopened'],
  flag: ['task.flagged', 'task.flag_resolved'],
  account: [
    'setup.completed', 'auth.signed_in', 'auth.signin_paused', 'auth.password_changed', 'auth.password_reset',
    'auth.two_factor_enabled', 'auth.two_factor_disabled', 'auth.recovery_code_used',
    'user.invited', 'invite.revoked', 'invite.accepted', 'user.role_changed', 'user.disabled', 'user.enabled',
    'user.reset_link_created', 'label.created', 'label.updated', 'audit.exported', 'settings.wip_limit_changed',
  ],
};

export const TASK_ACTIONS = [...GROUPS.task, ...GROUPS.comment, ...GROUPS.close, ...GROUPS.flag];

export function groupOf(action) {
  for (const [group, actions] of Object.entries(GROUPS)) if (actions.includes(action)) return group;
  return 'account';
}

export async function audit(db, { actorId = null, action, taskId = null, subjectUserId = null, details = {}, ip = null }) {
  await db.query(
    `INSERT INTO audit_events (actor_id, action, task_id, subject_user_id, details, ip)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [actorId, action, taskId, subjectUserId, JSON.stringify(details), ip],
  );
}

const clip = (s, n = 80) => {
  const str = String(s ?? '');
  return str.length > n ? `${str.slice(0, n - 1)}…` : str;
};

// Turns an event into one readable sentence in the viewer's language.
// `names` maps user ids to display names; `labels` maps label ids to names.
export function describe(ev, t, { names = {}, labels = {} } = {}) {
  const d = ev.details || {};
  const who = (id) => names[id] || t('common.formerUser');
  const list = (ids) => (ids || []).map(who).join(t('common.listSep'));
  const st = (s) => (s === 'done' ? t('status.done') : t(`status.${s}`));
  const undo = d.undo_of ? t('ev.undo') : '';
  switch (ev.action) {
    case 'task.created': return t('ev.created');
    case 'task.imported': return t('ev.imported', { file: d.file || '' });
    case 'task.moved': return t('ev.moved', { from: st(d.from), to: st(d.to) }) + undo;
    case 'task.closed':
      return d.reason === 'completed' && d.credited?.length
        ? t('ev.closedCredit', { people: list(d.credited) })
        : t('ev.closed', { reason: t(`reason.${d.reason}`) });
    case 'task.reopened': return t('ev.reopened') + undo;
    case 'task.commented': return t('ev.commented');
    case 'task.attachment_added': return t('ev.attached', { file: d.file || '' });
    case 'task.attachment_removed': return t('ev.attachmentRemoved', { file: d.file || '' });
    case 'task.flagged': return t('ev.flagged', { reason: t(`flagReason.${d.reason}`) });
    case 'task.flag_resolved': return t('ev.flagResolved', { resolution: t(`flagResolution.${d.resolution}`) });
    case 'task.edited': {
      const lab = (ids) => (ids || []).map((id) => labels[id] || '?').join(t('common.listSep'));
      const parts = Object.keys(d.changes || {}).map((field) => {
        const c = d.changes[field];
        if (field === 'assignees' || field === 'labels') {
          const show = field === 'labels' ? lab : list;
          const bits = [];
          if (c.added?.length) bits.push(t('ev.added', { items: show(c.added) }));
          if (c.removed?.length) bits.push(t('ev.removed', { items: show(c.removed) }));
          return `${t(`field.${field}`)} (${bits.join(t('common.listSep'))})`;
        }
        if (field === 'priority') return t('ev.fieldChange', { field: t('field.priority'), from: t(`priority.${c.from}`), to: t(`priority.${c.to}`) });
        if (field === 'due_date') return t('ev.fieldChange', { field: t('field.due'), from: c.from || t('common.none'), to: c.to || t('common.none') });
        if (field === 'title') return t('ev.fieldChange', { field: t('field.title'), from: clip(c.from, 60), to: clip(c.to, 60) });
        if (field === 'description') return t('ev.fieldDescription');
        return field;
      });
      return `${t('ev.edited')}: ${parts.join('; ')}${undo}`;
    }
    case 'import.completed': return t('ev.importCompleted', { count: d.count ?? 0, skipped: d.skipped ?? 0, file: d.file || '' });
    case 'setup.completed': return t('ev.setup');
    case 'auth.signed_in': return t('ev.signedIn');
    case 'auth.signin_paused': return t('ev.signinPaused', { email: d.email || '' });
    case 'auth.password_changed': return t('ev.passwordChanged');
    case 'auth.password_reset': return t('ev.passwordReset');
    case 'auth.two_factor_enabled': return t('ev.twoFactorOn');
    case 'auth.two_factor_disabled': return t('ev.twoFactorOff');
    case 'auth.recovery_code_used': return t('ev.recoveryUsed');
    case 'user.invited': return t('ev.invited', { email: d.email || '', role: t(`role.${d.role}`) });
    case 'invite.revoked': return t('ev.inviteRevoked', { email: d.email || '' });
    case 'invite.accepted': return t('ev.inviteAccepted');
    case 'user.role_changed': return t('ev.roleChanged', { person: who(ev.subject_user_id), role: t(`role.${d.to}`) });
    case 'user.disabled': return t('ev.userDisabled', { person: who(ev.subject_user_id) });
    case 'user.enabled': return t('ev.userEnabled', { person: who(ev.subject_user_id) });
    case 'user.reset_link_created': return t('ev.resetLink', { person: who(ev.subject_user_id) });
    case 'label.created': return t('ev.labelCreated', { name: d.name || '' });
    case 'label.updated': return t('ev.labelUpdated', { name: d.name || '' });
    case 'audit.exported': return t('ev.auditExported', { rows: d.rows ?? 0 });
    case 'settings.wip_limit_changed': return t('ev.wipLimitChanged', { from: d.from ?? '', to: d.to ?? '' });
    default: return ev.action;
  }
}
