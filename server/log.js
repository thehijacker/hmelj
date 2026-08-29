// Hmelj — minimal structured logging. Level via LOG env var (error | warn |
// info | debug, default info). Each line is tagged with a scope so `debug`
// output (verbose — every IMAP round trip, every sync tick) stays greppable.
import { config } from './config.js';

const LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };
const current = LEVELS[config.logLevel] ?? LEVELS.info;

function line(level, scope, args) {
  const ts = new Date().toISOString();
  return [`${ts} [${level.toUpperCase()}] [${scope}]`, ...args];
}

/** log.scope('sync').debug('polling', account.label) */
function scoped(scope) {
  return {
    error: (...a) => { if (current >= LEVELS.error) console.error(...line('error', scope, a)); },
    warn: (...a) => { if (current >= LEVELS.warn) console.warn(...line('warn', scope, a)); },
    info: (...a) => { if (current >= LEVELS.info) console.log(...line('info', scope, a)); },
    debug: (...a) => { if (current >= LEVELS.debug) console.log(...line('debug', scope, a)); },
  };
}

export const log = { ...scoped('app'), scope: scoped };
