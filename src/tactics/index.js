const economics = require('./economics');
const defense   = require('./defense');
const collector = require('./collector');
const attacker  = require('./attacker');

const REGISTRY = { economics, defense, collector, attacker };

/**
 * Run a single named tactic. Logs timing and catches errors.
 * @param {string} name - tactic name
 * @param {object} page - Playwright page
 * @param {object} opts - passed to tactic.run() (e.g. { includeResearch, targets })
 */
async function runTactic(name, page, opts = {}) {
  const tactic = REGISTRY[name];
  if (!tactic) {
    require('../utils/logger').warn(`[Tactics] Unknown tactic: "${name}"`);
    return;
  }
  const t0 = Date.now();
  await tactic.run(page, opts);
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  require('../utils/logger').info(`[Tactics] "${name}" completed in ${elapsed}s`);
}

module.exports = { runTactic, REGISTRY };
