// Access levels, lowest first. Each level can do everything the one below it can.
//
//   trainee    – a member who can't assign other people, take them off tasks or
//                close tasks; finished work goes to Review instead.
//   member     – the usual rights.
//   admin      – people, invites, labels, import, the in-progress limit, any task.
//   executive  – an admin who can also manage admins.
//   superadmin – shown as "Owner": one per organization; can also manage executives.
//                Nobody can change it. (Separate from the platform admin, who runs
//                the whole app and isn't part of any organization.)
//
// The rule for managing people is the same at every level: you can act on people
// below you, and give them any level below yours.
export const ROLES = ['trainee', 'member', 'admin', 'executive', 'superadmin'];

// Levels an invite can carry (superadmin is never given out).
export const INVITE_ROLES = ROLES.filter((r) => r !== 'superadmin');

export const rank = (role) => ROLES.indexOf(role);

// Admin rights: admin, executive and superadmin.
export const ADMIN_ROLES = ['admin', 'executive', 'superadmin'];
export const isAdminRole = (role) => rank(role) >= rank('admin');
export const isAdmin = (user) => !!user && isAdminRole(user.role);
export const isTrainee = (user) => !!user && user.role === 'trainee';

// Can `actor` act on someone whose level is `targetRole` (change level, disable,
// reset link, invite, rename)?
export const canManage = (actor, targetRole) => isAdmin(actor) && rank(targetRole) >= 0 && rank(targetRole) < rank(actor.role);

// The levels `actor` can give, lowest first.
export const grantable = (actor) => (isAdmin(actor) ? ROLES.slice(0, rank(actor.role)) : []);

export const canGrant = (actor, role) => grantable(actor).includes(role);

// Error messages shared by the website and the connector.
export const TRAINEE_CLOSE = 'trainees cannot close tasks';
export const TRAINEE_ASSIGN = 'trainees can only assign themselves';

// For pickers: trainees only see themselves.
export const pickable = (user, people) => (isTrainee(user) ? people.filter((p) => p.id === user.id) : people);
