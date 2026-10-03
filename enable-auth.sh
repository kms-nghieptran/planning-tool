#!/bin/sh
# ─────────────────────────────────────────────────────────────────────────
#  Turn authentication on, on THIS instance, and create the first account.
#
#  ORDER IS DELIBERATE: the account is created and PROVEN to work before
#  authentication is switched on. The other way round has a failure mode with
#  no way out — auth on, no usable account, every route 401, including the one
#  that would fix it.
#
#  config.json is backed up before it is touched, and only the `auth` key is
#  added. Your Jira token, GitHub token and mail password are read, re-written
#  byte for byte, and never printed.
# ─────────────────────────────────────────────────────────────────────────
set -e
cd "$(dirname "$0")"

if [ ! -f config.json ]; then echo "  No config.json here. Run this from the Planning Tool folder."; exit 1; fi

STAMP=$(date +%Y-%m-%dT%H-%M-%S)
cp config.json "config.pre-auth.$STAMP.json"
echo "  config.json backed up to config.pre-auth.$STAMP.json"

node -e '
  const fs = require("node:fs");
  const crypto = require("node:crypto");
  const auth = require("./lib/auth");

  (async () => {
    const EMAIL = process.argv[1];

    /* ── 1. the account ────────────────────────────────────────────────
       Created first, so that switching authentication on below is a change
       that can be undone by signing in rather than by editing a file. */
    if (auth.countUsers() > 0) {
      const who = auth.listUsers().map(u => `${u.email} (${auth.actorFor(u.id).role})`).join(", ");
      console.log("");
      console.log("  Accounts already exist on this instance, so none was created:");
      console.log("    " + who);
      console.log("  Use `node reset-password.js <email>` if you need a new password.");
    } else {
      const pw = crypto.randomBytes(18).toString("base64url");
      const u = await auth.createUser({
        email: EMAIL, name: "Nghiep Tran", password: pw,
        roles: [{ role: "project-admin" }], createdBy: "enable-auth",
      });

      /* PROVEN, not assumed. A hash that does not verify is a locked door, and
         the moment to find that out is now — before the flag flips. */
      const check = await auth.verifyPassword(pw, auth.findUser(u.id).password_hash);
      if (!check) throw new Error("the password did not verify after being set — refusing to enable authentication");

      console.log("");
      console.log("  ┌─ Your sign-in ────────────────────────────────────────────");
      console.log("  │  " + u.email);
      console.log("  │  " + pw);
      console.log("  │  Project admin.");
      console.log("  └───────────────────────────────────────────────────────────");
      console.log("  Written down nowhere else. Put it in your password manager now.");
    }

    /* ── 2. the flag ───────────────────────────────────────────────────
       Every other key is preserved exactly: this reads the file, adds one
       object, and writes it back. `secureCookies` stays FALSE because there
       is no TLS in front yet — setting it on plain HTTP makes the browser
       discard the cookie silently, so the login succeeds and the next
       request is anonymous. It goes true the day a proxy terminates TLS. */
    const cfg = JSON.parse(fs.readFileSync("config.json", "utf8"));
    cfg.auth = Object.assign({ enabled: true, secureCookies: false, sessionDays: 14 }, cfg.auth, { enabled: true });
    fs.writeFileSync("config.json", JSON.stringify(cfg, null, 2), { mode: 0o600 });
    try { fs.chmodSync("config.json", 0o600); } catch (_) {}
    console.log("");
    console.log("  Authentication is ON. config.json keys: " + Object.keys(cfg).join(", "));
    console.log("  The running server picks this up on its next request — no restart needed.");
  })().catch(e => { console.error("  FAILED: " + e.message); console.error("  Authentication was NOT enabled."); process.exit(1); });
' "nghieptran@kms-technology.com" 2>&1 | grep -v ExperimentalWarning | grep -v "trace-warnings"
