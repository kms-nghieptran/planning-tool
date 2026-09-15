'use strict';
/**
 * testops.js — Katalon TestOps execution health.
 *
 * Why a planning tool cares: failing suites are next sprint's maintenance load.
 * The Forecast view turns "N suites failing / M flaky" into predicted maintenance
 * points so you stop being surprised by it at sprint planning.
 *
 * Auth is HTTP Basic with the API key as the username and an empty password,
 * which is how TestOps' public API works.
 */

class TestOps {
  constructor(cfg = {}) {
    this.baseUrl = String(cfg.baseUrl || 'https://testops.katalon.io').replace(/\/+$/, '');
    this.apiKey = cfg.apiKey || '';
    this.projectIds = cfg.projectIds || [];
  }

  get configured() { return Boolean(this.apiKey); }

  async request(pathname) {
    if (!this.configured) throw new Error('Katalon TestOps is not configured — add an API key in Settings.');
    const auth = Buffer.from(`${this.apiKey}:`).toString('base64');
    let res;
    try {
      res = await fetch(`${this.baseUrl}${pathname}`, {
        headers: { Authorization: `Basic ${auth}`, Accept: 'application/json' },
        signal: AbortSignal.timeout(Number(process.env.HTTP_TIMEOUT_MS) || 60000),
      });
    } catch (err) {
      const host = new URL(this.baseUrl).host;
      if (err.name === 'TimeoutError' || err.name === 'AbortError') throw new Error(`${host} did not respond within 60s.`);
      throw new Error(`Could not reach ${host} — ${err.message}`);
    }
    if (res.status === 401 || res.status === 403) throw new Error('TestOps rejected the API key (401/403).');
    if (!res.ok) throw new Error(`TestOps ${res.status} on ${pathname}`);
    return res.json();
  }

  async projects() {
    const data = await this.request('/api/v1/projects?pagination.size=100');
    const list = data.content || data || [];
    return list.map(p => ({ id: String(p.id), name: p.name, teamId: p.teamId ? String(p.teamId) : null }));
  }

  /** Recent executions for a project, newest first. */
  async executions(projectId, limit = 60) {
    const data = await this.request(`/api/v1/executions?projectId=${projectId}&pagination.size=${limit}&pagination.sorts=startTime,desc`);
    const list = data.content || data || [];
    return list.map(e => ({
      id: String(e.id),
      order: e.order,
      projectId: String(projectId),
      name: e.name || (e.executionTestSuiteResources && e.executionTestSuiteResources[0] && e.executionTestSuiteResources[0].name) || `Run ${e.order}`,
      startTime: e.startTime,
      total: num(e.totalTests), passed: num(e.totalPassedTests), failed: num(e.totalFailedTests),
      error: num(e.totalErrorTests), skipped: num(e.totalSkippedTests),
      duration: e.duration,
      status: e.status,
    }));
  }

  /**
   * Roll recent executions into the signals planning needs.
   *  passRate  — headline health
   *  flakyRate — same suite flipping pass/fail across consecutive runs
   *  worstSuites — where the maintenance effort will land
   */
  static summarise(executions) {
    const runs = (executions || []).filter(e => e.total > 0);
    if (!runs.length) return { runs: 0, passRate: null, flakyRate: null, worstSuites: [], trend: [] };

    const totals = runs.reduce((t, r) => ({ total: t.total + r.total, passed: t.passed + r.passed, failed: t.failed + r.failed + r.error }), { total: 0, passed: 0, failed: 0 });

    const bySuite = new Map();
    for (const r of runs) {
      if (!bySuite.has(r.name)) bySuite.set(r.name, []);
      bySuite.get(r.name).push(r);
    }
    let flips = 0, pairs = 0;
    const worstSuites = [];
    for (const [name, list] of bySuite) {
      const ordered = list.slice().sort((a, b) => new Date(a.startTime) - new Date(b.startTime));
      for (let i = 1; i < ordered.length; i++) {
        const a = ordered[i - 1].failed + ordered[i - 1].error > 0;
        const b = ordered[i].failed + ordered[i].error > 0;
        pairs++; if (a !== b) flips++;
      }
      const total = ordered.reduce((t, r) => t + r.total, 0);
      const passed = ordered.reduce((t, r) => t + r.passed, 0);
      const failing = ordered.reduce((t, r) => t + r.failed + r.error, 0);
      worstSuites.push({ name, runs: ordered.length, passRate: total ? Math.round(passed / total * 1000) / 10 : null, failingTests: failing });
    }
    worstSuites.sort((a, b) => (a.passRate ?? 101) - (b.passRate ?? 101) || b.failingTests - a.failingTests);

    const trend = runs.slice().sort((a, b) => new Date(a.startTime) - new Date(b.startTime))
      .map(r => ({ at: r.startTime, passRate: r.total ? Math.round(r.passed / r.total * 1000) / 10 : null }));

    return {
      runs: runs.length,
      passRate: totals.total ? Math.round(totals.passed / totals.total * 1000) / 10 : null,
      failingTests: totals.failed,
      flakyRate: pairs ? Math.round(flips / pairs * 1000) / 10 : null,
      worstSuites: worstSuites.slice(0, 12),
      trend: trend.slice(-30),
    };
  }
}

function num(v) { const n = Number(v); return Number.isFinite(n) ? n : 0; }

module.exports = { TestOps };
