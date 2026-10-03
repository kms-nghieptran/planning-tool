'use strict';
/**
 * reset-password.js — the way back in.
 *
 * WHY THIS EXISTS. The password is generated once and printed once; there is
 * no copy anywhere. Without this script, losing it means deleting auth.db —
 * which takes every account, every role and every lead's team scope with it.
 * A recovery path that destroys the thing it is recovering is not one.
 *
 * RUN FROM THE CONSOLE, DELIBERATELY. It needs no session and checks no
 * permission, because it cannot: the person it is for is the one who cannot
 * sign in. Its security is that running it requires shell access to the
 * server — the same property the first-run setup token relies on.
 *
 *   node reset-password.js                      list the accounts
 *   node reset-password.js someone@kms...       set them a new password
 *   node reset-password.js someone@kms... --admin   ...and make them an admin
 */

const crypto = require('node:crypto');
const auth = require('./lib/auth');

const [, , email, ...flags] = process.argv;
const makeAdmin = flags.includes('--admin');

(async () => {
  const users = auth.listUsers();

  if (!users.length) {
    console.log('\n  No accounts on this instance yet.');
    console.log('  Start the server with auth enabled — it prints a one-time setup link.\n');
    return;
  }

  if (!email) {
    console.log('\n  Accounts on this instance:\n');
    for (const u of users) {
      const a = auth.actorFor(u.id);
      const scope = a.role === 'lead' ? ` → ${a.leadTeams.join(', ') || 'NO TEAMS'}` : '';
      const dead = u.status === 'active' ? '' : '  [disabled]';
      console.log(`    ${u.email.padEnd(38)} ${a.role}${scope}${dead}`);
    }
    console.log('\n  node reset-password.js <email> [--admin]\n');
    return;
  }

  const u = auth.findByEmail(email);
  if (!u) {
    console.error(`\n  No account for ${email}. Run with no arguments to list them.\n`);
    process.exit(1);
  }

  const pw = crypto.randomBytes(18).toString('base64url');
  /* NOT `mustChange`. This is the owner getting back into their own tool, and
     forcing a change on the very next screen would mean the password just
     read off the console is spent before it is in a password manager. An
     admin resetting somebody ELSE's password does force one — that path is on
     the Accounts screen, where the person receiving it is not the one typing. */
  await auth.setPassword(u.id, pw, { mustChange: false });

  /* EVERY SESSION ENDS. A password reset is usually a response to losing
     control of the account; leaving the old sessions live answers the worry
     with "yes, and they are still in". */
  const ended = auth.endAllSessions(u.id);

  if (makeAdmin && auth.actorFor(u.id).role !== 'project-admin') {
    for (const r of auth.rolesFor(u.id)) auth.revoke(u.id, r.role, r.teamId);
    auth.grant(u.id, 'project-admin');
  }
  if (u.status !== 'active') auth.setStatus(u.id, 'active');

  const a = auth.actorFor(u.id);
  console.log('');
  console.log('  ┌─ New password ────────────────────────────────────────────');
  console.log(`  │  ${u.email}`);
  console.log(`  │  ${pw}`);
  console.log(`  │  ${a.role}${a.role === 'lead' ? ` → ${a.leadTeams.join(', ')}` : ''}`);
  console.log('  └───────────────────────────────────────────────────────────');
  if (ended) console.log(`  ${ended} existing session${ended === 1 ? '' : 's'} signed out.`);
  console.log('  Shown once. Put it in your password manager now.\n');
})().catch(e => { console.error(`\n  FAILED: ${e.message}\n`); process.exit(1); });
