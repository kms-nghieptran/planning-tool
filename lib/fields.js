'use strict';
/**
 * fields.js — work out which Jira fields actually hold anything.
 *
 * The problem this exists for: a Jira instance can carry several fields called
 * "Story Points" — a legacy company-managed one, a team-managed "Story point
 * estimate", whatever a migration left behind — and only one of them is filled
 * in. Matching on the NAME picks the wrong one about as often as the right one,
 * and the failure is silent: 7,143 issues arrive with no estimate, every
 * velocity and forecast reads zero, and nothing on screen says why.
 *
 * A name cannot settle this. Data can. So: read the field catalogue, pull a
 * sample of real issues with EVERY field attached, and count how many carry a
 * value for each. The field that is populated is the field you want, and the
 * answer takes one query instead of one count per candidate.
 */

/** Fields the tool already maps by hand; everything else is a candidate. */
const ROLES = {
  storyPoints: {
    label: 'Story points',
    names: ['story points', 'story point estimate', 'story points estimate'],
    type: 'number',
    why: 'Everything measured in points — velocity, capacity, the forecast, the backlog — is this one field.',
  },
  sprint: {
    label: 'Sprint',
    names: ['sprint'],
    type: 'array',
    why: 'Which sprint an issue is in. Without it nothing can be attributed to a sprint.',
  },
  automationStatus: {
    label: 'Automation status',
    names: ['automation status'],
    type: 'option',
    why: 'The whole automation coverage report is built on this.',
  },
  team: {
    label: 'Team',
    names: ['team'],
    type: 'any',
    why: 'Used to attribute work to a team when no board says otherwise.',
  },
};

/** Is there anything here? `0` and `false` are values; `[]`, `''` and null are not. */
function hasValue(v) {
  if (v === null || v === undefined || v === '') return false;
  if (Array.isArray(v)) return v.length > 0;
  if (typeof v === 'object') return Object.keys(v).length > 0;
  return true;
}

/** A short, readable rendering of a sample value, for the "looks like" column. */
function preview(v) {
  if (!hasValue(v)) return '';
  if (Array.isArray(v)) return `${v.length} × ${preview(v[0])}`;
  if (typeof v === 'object') {
    return String(v.value ?? v.name ?? v.displayName ?? v.key ?? JSON.stringify(v)).slice(0, 40);
  }
  return String(v).slice(0, 40);
}

/**
 * Profile every field against a sample of real issues.
 *
 * @param {Array}  catalogue  from GET /rest/api/3/field — [{id, name, custom, schema}]
 * @param {Array}  sample     raw issues, each with a full `fields` object
 * @returns fields sorted by how useful they look: populated first, then named
 */
function profile(catalogue, sample) {
  const n = sample.length;
  const counts = new Map();
  const examples = new Map();
  const numericish = new Map();

  for (const issue of sample) {
    const f = issue.fields || {};
    for (const [id, v] of Object.entries(f)) {
      if (!hasValue(v)) continue;
      counts.set(id, (counts.get(id) || 0) + 1);
      if (!examples.has(id)) examples.set(id, preview(v));
      if (typeof v === 'number') numericish.set(id, (numericish.get(id) || 0) + 1);
    }
  }

  const byId = new Map(catalogue.map(c => [c.id, c]));
  // A field can appear in the sample without being in the catalogue and vice
  // versa; the union is what the user should be choosing from.
  const ids = new Set([...catalogue.map(c => c.id), ...counts.keys()]);

  return [...ids].map(id => {
    const meta = byId.get(id) || {};
    const filled = counts.get(id) || 0;
    return {
      id,
      name: meta.name || id,
      custom: Boolean(meta.custom),
      type: (meta.schema && (meta.schema.type || meta.schema.custom)) || (numericish.get(id) ? 'number' : null),
      filled,
      sampled: n,
      // The number that settles the argument.
      fillRate: n ? Math.round(filled / n * 1000) / 10 : 0,
      example: examples.get(id) || '',
      numeric: (numericish.get(id) || 0) > 0,
    };
  }).sort((a, b) => b.filled - a.filled || String(a.name).localeCompare(String(b.name)));
}

/**
 * For each role the tool needs, rank the fields that could fill it.
 *
 * Name match gets a field onto the shortlist; FILL RATE decides the order, and
 * a named-but-empty field is explicitly marked so the reason for not picking it
 * is visible rather than implied.
 */
function candidatesFor(profiled, role) {
  const def = ROLES[role];
  if (!def) return [];
  const named = profiled.filter(f => def.names.includes(String(f.name).toLowerCase()));

  // Nothing matched by name — for a numeric role, offer populated numeric custom
  // fields instead of leaving the user with nothing to choose from.
  const pool = named.length ? named
    : def.type === 'number' ? profiled.filter(f => f.custom && f.numeric && f.filled > 0)
    : [];

  return pool
    .map(f => ({ ...f, nameMatch: def.names.includes(String(f.name).toLowerCase()) }))
    .sort((a, b) => b.filled - a.filled || Number(b.nameMatch) - Number(a.nameMatch));
}

/**
 * The recommendation for every role, with the reason stated.
 *
 * `confident` is false when the choice is a guess — no candidate holds a value,
 * or two candidates are equally populated. A recommendation that cannot admit
 * doubt is how the wrong field got picked in the first place.
 */
function recommend(profiled, configured = {}) {
  const out = {};
  for (const role of Object.keys(ROLES)) {
    const list = candidatesFor(profiled, role);
    const top = list[0] || null;
    const current = configured[role] || null;
    const currentProfile = current ? profiled.find(f => f.id === current) || null : null;

    let reason, confident = false;
    if (!list.length) {
      reason = `No field named "${ROLES[role].label}" exists on this Jira.`;
    } else if (!top.filled) {
      reason = `Every candidate is empty on all ${top.sampled} sampled issues — this field may not be in use.`;
    } else if (list.length > 1 && list[1].filled === top.filled) {
      reason = `${list[0].name} and ${list[1].name} are equally populated — pick the one your team uses.`;
    } else {
      reason = `Populated on ${top.filled} of ${top.sampled} sampled issues (${top.fillRate}%).`;
      confident = true;
    }

    out[role] = {
      role,
      label: ROLES[role].label,
      why: ROLES[role].why,
      recommended: top ? top.id : null,
      recommendedName: top ? top.name : null,
      configured: current,
      // The whole point: is what you are USING actually populated?
      configuredFillRate: currentProfile ? currentProfile.fillRate : null,
      configuredLooksWrong: Boolean(current && currentProfile && currentProfile.filled === 0),
      wouldChange: Boolean(top && current && top.id !== current && top.filled > 0),
      confident,
      reason,
      candidates: list.slice(0, 8),
    };
  }
  return out;
}

module.exports = { ROLES, profile, candidatesFor, recommend, hasValue, preview };
