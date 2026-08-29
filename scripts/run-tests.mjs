// Hmelj — test runner for `npm test`.
//
// Every suite under test/ is a standalone Node script that throws (or exits
// non-zero) on the first failed assertion; there is no test framework and
// deliberately no dependency to add one. This just finds them, runs each in its
// own process so one suite cannot leak state into the next, and fails the run if
// any of them do.
//
// Files matching *-test.mjs are suites. Everything else in test/ is a fixture or
// a mock server (mock-mail-server.js, mock-graph-server.js, mock-oauth-server.js,
// filter-e2e-harness.mjs) that a suite starts for itself.
import { readdirSync } from 'fs';
import { spawnSync } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dir = path.join(root, 'test');
const suites = readdirSync(dir).filter((f) => f.endsWith('-test.mjs')).sort();

if (!suites.length) {
  console.error('No test suites found in test/');
  process.exit(1);
}

const failed = [];
for (const suite of suites) {
  process.stdout.write(`\n── ${suite} ${'─'.repeat(Math.max(0, 60 - suite.length))}\n`);
  // --openssl-legacy-provider for the same reason `npm start` needs it: httpntlm
  // (the Exchange/EWS transport) computes a DES-ECB LM hash on every auth
  // handshake, which OpenSSL 3 no longer exposes by default.
  const r = spawnSync(process.execPath, ['--openssl-legacy-provider', path.join(dir, suite)], {
    cwd: root, stdio: 'inherit',
  });
  if (r.status !== 0) failed.push(suite);
}

console.log(`\n${'═'.repeat(64)}`);
if (failed.length) {
  console.log(`${suites.length - failed.length}/${suites.length} suites passed — FAILED: ${failed.join(', ')}`);
  process.exit(1);
}
console.log(`${suites.length}/${suites.length} suites passed`);
