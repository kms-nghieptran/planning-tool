'use strict';
/**
 * staleness.js — is this process running the code that is on disk?
 *
 * Node caches a module the moment it is required. A server started before an
 * update therefore keeps running the OLD code until it is restarted, silently,
 * while the files say something else. That is not cosmetic: an instance left
 * running through an update re-applied superseded logic and rewrote a team's
 * roster underneath a cleanup that had just corrected it — and nothing on screen
 * suggested anything was wrong.
 *
 * So the process records the newest source mtime it saw at load, and compares it
 * with disk on demand.
 */

const fs = require('node:fs');
const path = require('node:path');

const SOURCE_EXT = /\.(js|html|css)$/;
const SKIP_DIRS = new Set(['kms', 'node_modules', 'data', 'test']);

/** The newest mtime (ms) across the app's own source files. */
function sourceStamp(root, entries = ['server.js', 'lib', 'public']) {
  let newest = 0;
  const walk = (p) => {
    let st;
    try { st = fs.statSync(p); } catch (_) { return; }   // a deleted file is not a reason to fail
    if (st.isDirectory()) {
      const base = path.basename(p);
      if (SKIP_DIRS.has(base)) return;
      let names = [];
      try { names = fs.readdirSync(p); } catch (_) { return; }
      for (const f of names) if (!f.startsWith('.')) walk(path.join(p, f));
    } else if (SOURCE_EXT.test(p)) {
      if (st.mtimeMs > newest) newest = st.mtimeMs;
    }
  };
  for (const e of entries) walk(path.join(root, e));
  return Math.round(newest);
}

/**
 * Compare what this process loaded against what is on disk now.
 *
 * `slackMs` absorbs an editor touching a file without changing it, and the
 * coarse mtime granularity some mounted filesystems report.
 */
function compare(loadedStamp, onDiskStamp, { slackMs = 1000 } = {}) {
  return {
    loadedAt: loadedStamp ? new Date(loadedStamp).toISOString() : null,
    onDiskAt: onDiskStamp ? new Date(onDiskStamp).toISOString() : null,
    stale: Boolean(loadedStamp && onDiskStamp && onDiskStamp > loadedStamp + slackMs),
  };
}

/** Bind the two together for a running process. */
function tracker(root) {
  const loaded = sourceStamp(root);
  return {
    loaded,
    check: () => compare(loaded, sourceStamp(root)),
  };
}

module.exports = { sourceStamp, compare, tracker, SKIP_DIRS };
