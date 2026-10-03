#!/bin/sh
# ─────────────────────────────────────────────────────────────────────────
#  A THROWAWAY INSTANCE, for looking at the sign-in flow.
#
#  Touches NOTHING of yours: its own port, its own store under /tmp, its own
#  config file. Your real server on 4322, your config.json and your planning
#  store are not read and not written.
#
#  Stop it with Ctrl-C. Delete /tmp/pt-demo afterwards, or leave it — it is
#  in /tmp and goes on its own.
# ─────────────────────────────────────────────────────────────────────────
set -e
DEMO=/tmp/pt-demo
rm -rf "$DEMO"
mkdir -p "$DEMO/store"

cat > "$DEMO/config.json" <<'JSON'
{
  "auth": { "enabled": true, "secureCookies": false },
  "server": { "port": 4399, "readOnly": false },
  "jira": { "baseUrl": "", "email": "", "apiToken": "", "projectKey": "DEMO" }
}
JSON

# Two teams, because the point of the walkthrough is that a lead of one
# cannot touch the other. Invented data — nothing of yours is copied in.
cat > "$DEMO/store/plan.json" <<'JSON'
{
  "version": 1,
  "teams": [
    { "id": "ruby", "name": "Katalon RDA (Ruby)", "jiraName": "Katalon RDA", "boardId": "1",
      "jiraTeams": [], "components": [], "sprintKeywords": [],
      "settings": { "hoursPerDay": 7, "hoursPerPoint": 2.9, "ceremonyHours": 9 },
      "members": [ { "id": "ruby-a", "name": "Thao Dang", "role": "Auto QA", "status": "Active", "supportPct": 0 } ] },
    { "id": "titan", "name": "Katalon PSA (Titan)", "jiraName": "Katalon PSA", "boardId": "2",
      "jiraTeams": [], "components": [], "sprintKeywords": [],
      "settings": { "hoursPerDay": 7, "hoursPerPoint": 2.9, "ceremonyHours": 9 },
      "members": [ { "id": "titan-a", "name": "Hien Phan", "role": "Auto QA", "status": "Active", "supportPct": 0 } ] }
  ],
  "sprints": [
    { "id": "S41", "number": 41, "name": "Sprint 41", "start": "2026-09-17", "end": "2026-09-30",
      "byTeam": {
        "ruby":  { "jiraId": "9001", "name": "Ruby Sprint 41",  "state": "active" },
        "titan": { "jiraId": "9002", "name": "Titan Sprint 41", "state": "active" } } }
  ],
  "availability": {}, "support": {}, "ceremony": {}, "overrides": {}, "calcExempt": {},
  "excluded": {}, "sprintRoster": {}, "risks": [], "notes": {}, "holidays": [], "scenarios": []
}
JSON

cat > "$DEMO/store/snapshot.json" <<'JSON'
{ "source": "jira", "syncedAt": "2026-10-02T00:00:00.000Z", "sprints": [], "issues": {},
  "byTeam": { "ruby":  { "sprintIssues": {}, "sprints": [], "backlog": [], "people": [] },
              "titan": { "sprintIssues": {}, "sprints": [], "backlog": [], "people": [] } },
  "testops": { "projects": [] }, "github": {}, "verification": [] }
JSON

# ── your account, seeded ─────────────────────────────────────────────────
#
#  THE PASSWORD IS GENERATED HERE AND PRINTED IN THIS TERMINAL, which is the
#  only place it ever exists. Not in this script, not in a config file, not in
#  a chat log. Same reasoning as the setup token it replaces: the one person
#  who should be able to read it is whoever is running the process.
STORE_DIR="$DEMO" node -e '
  const auth = require("./lib/auth");
  const crypto = require("node:crypto");
  (async () => {
    // 24 random characters — comfortably past the 12-character floor, and not
    // a word a blocklist would recognise.
    const pw = crypto.randomBytes(18).toString("base64url");
    const u = await auth.createUser({
      email: "nghieptran@kms-technology.com",
      name: "Nghiep Tran",
      password: pw,
      roles: [{ role: "project-admin" }],
      createdBy: "demo-seed",
    });
    console.log("");
    console.log("  ┌─ Your demo sign-in ───────────────────────────────────────");
    console.log("  │  " + u.email);
    console.log("  │  " + pw);
    console.log("  │  Project admin. This instance only — it is not your real one.");
    console.log("  └───────────────────────────────────────────────────────────");
  })().catch(e => { console.error("  Could not seed the account: " + e.message); process.exit(1); });
' 2>&1 | grep -v ExperimentalWarning | grep -v "trace-warnings"

echo "  demo store:  $DEMO   (nothing of yours is touched)"
STORE_DIR="$DEMO" CONFIG_FILE="$DEMO/config.json" PORT=4399 exec node server.js
