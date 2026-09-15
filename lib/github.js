'use strict';
/**
 * github.js — PR + commit activity per repo.
 *
 * Planning value: technical work often never reaches Jira. A member with zero
 * Jira points but 14 merged PRs is not idle — the Capacity view flags that
 * mismatch instead of letting you plan on a wrong picture.
 */

class GitHub {
  constructor(cfg = {}) {
    this.baseUrl = String(cfg.baseUrl || 'https://api.github.com').replace(/\/+$/, '');
    this.token = cfg.token || '';
    this.repos = cfg.repos || [];               // ["org/repo", ...]
    this.loginMap = cfg.loginMap || {};         // { "github-login": "memberId" }
  }

  get configured() { return Boolean(this.token && this.repos.length); }

  async request(pathname) {
    if (!this.token) throw new Error('GitHub is not configured — add a personal access token in Settings.');
    let res;
    try {
      res = await fetch(`${this.baseUrl}${pathname}`, {
        headers: { Authorization: `Bearer ${this.token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' },
        signal: AbortSignal.timeout(Number(process.env.HTTP_TIMEOUT_MS) || 60000),
      });
    } catch (err) {
      const host = new URL(this.baseUrl).host;
      if (err.name === 'TimeoutError' || err.name === 'AbortError') throw new Error(`${host} did not respond within 60s.`);
      throw new Error(`Could not reach ${host} — ${err.message}`);
    }
    if (res.status === 401 || res.status === 403) throw new Error('GitHub rejected the token (401/403), or the rate limit is exhausted.');
    if (!res.ok) throw new Error(`GitHub ${res.status} on ${pathname}`);
    return res.json();
  }

  /** Pull requests updated since a date, across all configured repos. */
  async pullRequests(sinceISO) {
    const out = [];
    for (const repo of this.repos) {
      for (let page = 1; page <= 5; page++) {
        const list = await this.request(`/repos/${repo}/pulls?state=all&sort=updated&direction=desc&per_page=100&page=${page}`);
        let reachedEnd = list.length < 100;
        for (const pr of list) {
          if (sinceISO && new Date(pr.updated_at) < new Date(sinceISO)) { reachedEnd = true; break; }
          out.push({
            repo,
            number: pr.number,
            title: pr.title,
            author: pr.user && pr.user.login,
            state: pr.merged_at ? 'merged' : pr.state,
            created: pr.created_at,
            updated: pr.updated_at,
            merged: pr.merged_at,
            draft: Boolean(pr.draft),
            url: pr.html_url,
            issueKeys: extractIssueKeys(`${pr.title} ${pr.head && pr.head.ref || ''}`),
          });
        }
        if (reachedEnd) break;
      }
    }
    return out;
  }

  /** Per-member activity in a date window, mapped onto team members where possible. */
  static summarise(prs, { start, end, loginMap = {} } = {}) {
    const from = start ? new Date(start) : null;
    const to = end ? new Date(`${end}T23:59:59Z`) : null;
    const inWindow = (d) => d && (!from || new Date(d) >= from) && (!to || new Date(d) <= to);
    const byAuthor = new Map();
    let open = 0, merged = 0, stale = 0;
    const now = Date.now();
    for (const pr of prs || []) {
      const touched = inWindow(pr.merged) || inWindow(pr.updated);
      if (!touched) continue;
      const key = loginMap[pr.author] || pr.author || 'unknown';
      if (!byAuthor.has(key)) byAuthor.set(key, { author: pr.author, memberId: loginMap[pr.author] || null, open: 0, merged: 0, linkedIssues: new Set() });
      const rec = byAuthor.get(key);
      if (pr.state === 'merged') { rec.merged++; merged++; } else if (pr.state === 'open') {
        rec.open++; open++;
        if (now - new Date(pr.updated).getTime() > 7 * 864e5) stale++;
      }
      for (const k of pr.issueKeys) rec.linkedIssues.add(k);
    }
    return {
      open, merged, stalePrs: stale,
      byAuthor: [...byAuthor.values()].map(r => ({ ...r, linkedIssues: [...r.linkedIssues] }))
        .sort((a, b) => (b.merged + b.open) - (a.merged + a.open)),
    };
  }
}

function extractIssueKeys(text) {
  return [...new Set((String(text).match(/[A-Z][A-Z0-9]+-\d+/g) || []))];
}

module.exports = { GitHub, extractIssueKeys };
