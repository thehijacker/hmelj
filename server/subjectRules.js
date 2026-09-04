// Hmelj — Settings > Subject: rewriting the subject a LIST shows.
//
// Machine-generated mail buries the useful half of the subject behind a fixed
// prefix — "[Dogodek 2608260021] Posodobljen — Napovedana vzdrževalna dela A1:
// Obalno-kraška in Goriška". A phone's list row truncates long before
// "Napovedana", so every one of those rows reads identically and scanning the
// list tells you nothing. A rule turns that into "U-Napovedana vzdrževalna dela
// A1: …" (U as in updated), and a second one turns "Noc ticketing" into
// "NOC TT".
//
// DISPLAY ONLY, and that is the whole design:
//   - nothing is written to the mail server, ever
//   - the cache keeps the real subject, so SEARCH still matches what the sender
//     actually wrote ("Dogodek" still finds these) — the rows just read better
//   - the reading pane keeps the real subject too, which is both the escape
//     hatch (open it to see the truth) and what stops a Reply going out with
//     "Re: U-…" as its subject
// The two places it IS applied are the message list (server/index.js's list
// routes) and push notifications (server/sync.js) — the two places you read a
// subject without having opened the message.
//
// Rules chain: every enabled rule runs, top to bottom, each on the previous
// one's output, so "strip the prefix" and "shorten a word inside it" compose
// instead of competing.
//
// Pure, no I/O — same reasoning as searchQuery.js / notifyText.js /
// threading.js: the point is to be able to run it over a few hundred real
// subjects and check what comes out (test/subject-rules-test.mjs).
//
// ---------------------------------------------------------------------------
// A note on regex safety, because this is the one module here that runs
// USER-AUTHORED PATTERNS on the server, over every message in every list
// response.
//
// A pattern like /(a+)+$/ backtracks catastrophically, and Node offers no way
// to time a match out: once RegExp.exec is running, the event loop is gone —
// for everyone on the instance, not just its author. The linear-time engine
// that would settle this (RE2) is a native build, which this project
// deliberately does not carry (see the better-sqlite3 --ignore-scripts commit:
// no compiler in the image, on purpose).
//
// So the guard is layered and best-effort, and this comment is the honest
// statement of that:
//   1. the input is capped (MAX_SUBJECT) — backtracking cost is a function of
//      input length, and a bounded input bounds the blast radius
//   2. the pattern itself is capped (MAX_FIND) and the rule list is capped
//      (MAX_RULES)
//   3. saving probes each pattern against adversarial inputs under a time
//      budget (see probe() below) and REFUSES the ones that blow it
// A pattern that is fast on the probes and pathological on some real subject
// still gets through. That residual risk is accepted here: this is a
// self-hosted instance whose users already own server-side filters that can
// forward their mail to an arbitrary address, so the trust boundary this sits
// inside was already drawn well outside it.
// ---------------------------------------------------------------------------

/** RFC 5322 caps a header line at 998 octets; nothing longer is a real subject,
 *  and a bounded input is the first half of the backtracking guard above. */
export const MAX_SUBJECT = 998;
/** A find pattern longer than this is not something a person typed. */
export const MAX_FIND = 400;
/** Per person. Rules run on every row of every list response, so the list is
 *  meant to stay short enough to read, not to become a program. */
export const MAX_RULES = 50;
/** How long one probe match may take before a pattern is refused (see probe). */
export const PROBE_BUDGET_MS = 50;

export const MODES = ['text', 'regex'];

/** Escapes every regex metacharacter, so plain-text mode means what it says:
 *  a rule finding "[Dogodek]" finds those nine characters, not a character
 *  class. This is the difference between the two modes — everything else
 *  (flags, chaining, replacement) is identical. */
function escapeLiteral(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * One rule → the RegExp it matches with, or null if the rule can't run at all
 * (empty find, unknown mode, a pattern that doesn't compile).
 *
 * Returning null rather than throwing is deliberate: a rule with a typo in it
 * must be inert, never something that can fail a list response. The editor is
 * where a bad pattern gets reported (validate() below), not the read path.
 */
export function compile(rule) {
  if (!rule || typeof rule.find !== 'string' || !rule.find) return null;
  if (rule.find.length > MAX_FIND) return null;
  const mode = MODES.includes(rule.mode) ? rule.mode : 'text';
  let flags = '';
  if (rule.ignoreCase) flags += 'i';
  if (rule.all) flags += 'g';
  try {
    return new RegExp(mode === 'regex' ? rule.find : escapeLiteral(rule.find), flags);
  } catch {
    return null; // not a valid pattern — inert, see above
  }
}

/** Does this rule apply to this account? An empty (or missing) accountIds means
 *  "every account" — the same convention filters use for a null accountId, but
 *  as a LIST, since a subject rewrite is pure text and, unlike a filter's
 *  move-to-folder action, is perfectly meaningful across several accounts at
 *  once. */
export function appliesTo(rule, accountId) {
  const ids = rule?.accountIds;
  if (!Array.isArray(ids) || !ids.length) return true;
  return ids.includes(accountId);
}

/** The rules that would actually run for this account, in order. */
function activeRules(rules, accountId) {
  return (Array.isArray(rules) ? rules : [])
    .filter((r) => r && r.enabled !== false && appliesTo(r, accountId));
}

/**
 * The subject to SHOW. Never throws, never returns anything but a string —
 * a broken rule is skipped, not propagated into a list response.
 *
 * `replace` goes through String.prototype.replace verbatim, so $1/$2 capture
 * references work in regex mode. That is the point: "[Dogodek (\\d+)]" →
 * "#$1" is exactly the kind of rule this exists for.
 */
export function applyRules(subject, rules, accountId) {
  let out = String(subject == null ? '' : subject).slice(0, MAX_SUBJECT);
  for (const rule of activeRules(rules, accountId)) {
    const re = compile(rule);
    if (!re) continue;
    try {
      out = out.replace(re, String(rule.replace == null ? '' : rule.replace));
    } catch {
      // A malformed replacement ($ handling is forgiving, but not infinitely)
      // leaves this step out rather than losing the whole subject.
    }
  }
  return out;
}

/**
 * Same walk, but reporting each step — what the Test panel in Settings renders.
 * Only rules that actually CHANGED something are listed: a rule that matched
 * nothing is not interesting, and listing it as a no-op step reads like it did
 * something.
 *
 * @returns {{result: string, steps: {id, name, before, after}[]}}
 */
export function explain(subject, rules, accountId) {
  let out = String(subject == null ? '' : subject).slice(0, MAX_SUBJECT);
  const steps = [];
  for (const rule of activeRules(rules, accountId)) {
    const re = compile(rule);
    if (!re) continue;
    let after;
    try {
      after = out.replace(re, String(rule.replace == null ? '' : rule.replace));
    } catch {
      continue;
    }
    if (after === out) continue;
    steps.push({ id: rule.id, name: rule.name || '', before: out, after });
    out = after;
  }
  return { result: out, steps };
}

// Adversarial input SHAPES for the save-time probe: a long run of one thing
// with nothing at the end to match, which is what forces a nested-quantifier
// pattern to try every way of splitting the run before giving up. Each is a
// function of length, because the probe walks a LADDER of lengths — see below.
const PROBE_SHAPES = [
  (n) => 'a'.repeat(n),
  (n) => 'ab'.repeat(Math.ceil(n / 2)).slice(0, n),
  (n) => 'a'.repeat(Math.max(0, n - 1)) + '!',
  (n) => ' '.repeat(Math.max(0, n - 1)) + 'x',
  (n) => '[Dogodek 2608260021] Posodobljen — Napovedana vzdrževalna dela A1 '.repeat(Math.ceil(n / 64)).slice(0, n),
];

// The ladder, short to long. This is the whole trick, and the first version of
// this file got it wrong in the most embarrassing possible way: it probed at
// full length only, timed the match AFTERWARDS, and so HUNG on the very
// pattern it existed to refuse — a timer after the fact cannot cut short a
// match that never returns.
//
// Backtracking cost grows with input length — exponentially for a nested
// quantifier like (a+)+$, polynomially for a*a*b. So walk up from an input too
// short for even an exponential pattern to cost anything measurable, and stop
// at the FIRST length that blows the budget. A benign pattern is a linear scan
// and finishes every rung in microseconds; a catastrophic one blows up around
// rung 5 or 6, having cost only the budget to find out. What is never done is
// handing a 998-character string to an unvetted pattern and hoping.
const PROBE_LENGTHS = [12, 16, 20, 24, 28, 32, 48, 64, 96, 128, 192, 256, 384, 512, 768, MAX_SUBJECT];

/**
 * Times a compiled rule against progressively longer adversarial inputs, up to
 * the longest the read path could ever hand it (MAX_SUBJECT — see applyRules).
 * Anything that blows the budget on any rung is refused at save time rather
 * than being allowed to stall the event loop later, once per listed message.
 *
 * Not a proof — see the header. It catches the patterns people actually write
 * by accident ((.*)+, (a|a)*, a*a*b, nested optional groups), which is the
 * population this is defending against.
 *
 * @returns {{ok: true} | {ok: false, error: string, ms: number, length: number}}
 */
export function probe(rule) {
  const re = compile(rule);
  if (!re) return { ok: true }; // inert anyway; validate() reports the reason
  for (const n of PROBE_LENGTHS) {
    for (const shape of PROBE_SHAPES) {
      const input = shape(n);
      const t0 = Date.now();
      try {
        // Fresh lastIndex each time: a /g/ regex carries state between calls,
        // and a stale one would make the probe test a different thing than it
        // looks like it is testing.
        re.lastIndex = 0;
        input.replace(re, '');
      } catch {
        return { ok: true }; // it fails, it doesn't hang — compile()/validate() own that
      }
      const ms = Date.now() - t0;
      if (ms > PROBE_BUDGET_MS) {
        return {
          ok: false, ms, length: n,
          error: `pattern is too slow (${ms}ms on a ${n}-character subject) — on a real subject it would stall the server on every message`,
        };
      }
    }
  }
  return { ok: true };
}

/**
 * Is this rule safe and sane to store? Called by the save route, which refuses
 * the whole list if any rule fails — a partially-saved rule set is worse than
 * a rejected one, since the rules chain and half a chain is not a smaller
 * version of the same thing.
 *
 * @returns {{ok: true} | {ok: false, error: string}}
 */
export function validate(rule) {
  if (!rule || typeof rule !== 'object') return { ok: false, error: 'not a rule' };
  if (typeof rule.find !== 'string' || !rule.find) return { ok: false, error: 'nothing to find' };
  if (rule.find.length > MAX_FIND) return { ok: false, error: `the text to find is longer than ${MAX_FIND} characters` };
  if (rule.replace != null && typeof rule.replace !== 'string') return { ok: false, error: 'the replacement must be text' };
  if (rule.mode != null && !MODES.includes(rule.mode)) return { ok: false, error: `mode must be one of ${MODES.join(', ')}` };
  if (rule.accountIds != null && !Array.isArray(rule.accountIds)) return { ok: false, error: 'accountIds must be a list' };
  if (rule.mode === 'regex' && !compile(rule)) return { ok: false, error: 'not a valid regular expression' };
  const timed = probe(rule);
  if (!timed.ok) return { ok: false, error: timed.error };
  return { ok: true };
}

/**
 * Validates a whole list. Returns the first problem found, named by the rule it
 * belongs to, so the editor can say WHICH rule it refused rather than just
 * that something was wrong.
 *
 * @returns {{ok: true} | {ok: false, error: string, index: number}}
 */
export function validateAll(rules) {
  if (!Array.isArray(rules)) return { ok: false, error: 'expected a list of rules', index: -1 };
  if (rules.length > MAX_RULES) return { ok: false, error: `at most ${MAX_RULES} rules`, index: -1 };
  for (let i = 0; i < rules.length; i++) {
    const r = validate(rules[i]);
    if (!r.ok) return { ok: false, error: `"${rules[i]?.name || `rule ${i + 1}`}": ${r.error}`, index: i };
  }
  return { ok: true };
}
