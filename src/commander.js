/**
 * Commander — real-time player directive interface.
 *
 * Reads lines from stdin while the agent runs. Directives are parsed for intent
 * and executed directly — the player is the highest authority.
 *
 * Intent types (handled without AI involvement):
 *   attack / loot / raid   → force attacker tactic immediately
 *   defend / shield        → force defense tactic
 *   economics / grow       → force economics focus
 *   build <X>              → inject specific build into economics
 *   transport / move       → trigger resource transport
 *   (anything else)        → custom — passed to AI for interpretation
 *
 * Commands:
 *   force: <text>    — skip safety warnings, execute as-is
 *   clear / reset    — remove the current directive
 *   status           — print the current directive
 *   done             — mark the current directive completed
 *   help             — list commands
 */

const readline = require('readline');
const logger   = require('./utils/logger');

let activeDirective = null; // { text, type, forced, setAt, cycle, interpretation? }

// ── Intent detection ─────────────────────────────────────────────────────────

const INTENT_MAP = [
  { type: 'attack',    keywords: ['attack', 'raid', 'loot', 'grab', 'steal', 'plunder', 'hit', 'farm', 'inactive'] },
  { type: 'defend',    keywords: ['defend', 'defense', 'defence', 'shield', 'protect', 'fortify'] },
  { type: 'economics', keywords: ['economy', 'economics', 'mine', 'resource', 'grow', 'production', 'harvest', 'economic'] },
  { type: 'research',  keywords: ['research', 'tech', 'technology', 'science'] },
  { type: 'transport', keywords: ['transport', 'move resources', 'send resources', 'transfer'] },
  { type: 'collect',   keywords: ['collect', 'debris', 'harvest fleet'] },
];

/**
 * Parse a natural-language directive into a structured intent.
 * Returns { type, forced, text } — type is 'custom' when no keywords match.
 */
function parseDirective(raw) {
  const forced   = /^force:?\s+/i.test(raw);
  const text     = raw.replace(/^force:?\s+/i, '').trim();
  const lower    = text.toLowerCase();

  for (const { type, keywords } of INTENT_MAP) {
    if (keywords.some(k => lower.includes(k))) {
      return { type, forced, text };
    }
  }

  return { type: 'custom', forced, text };
}

// ── State management ──────────────────────────────────────────────────────────

function setDirective(raw, cycle = 0) {
  const parsed = parseDirective(raw);
  activeDirective = { ...parsed, setAt: new Date().toISOString(), cycle };
  logger.info(`[Commander] 🎯 Directive: "${parsed.text}" [intent=${parsed.type}${parsed.forced ? ' FORCED' : ''}]`);
  logger.info('[Commander]    Applied from next cycle. Type "clear" to cancel.');
}

function clearDirective() {
  if (activeDirective) {
    logger.info(`[Commander] ✓ Directive cleared: "${activeDirective.text}"`);
  }
  activeDirective = null;
}

function getDirective() {
  return activeDirective ?? null;
}

function markDirectiveDone(reason = '') {
  if (activeDirective) {
    logger.info(`[Commander] ✅ Directive completed: "${activeDirective.text}"${reason ? ` — ${reason}` : ''}`);
  }
  activeDirective = null;
}

// ── Readline interface ────────────────────────────────────────────────────────

function startCommandInterface(dbSave, dbLoad) {
  if (dbLoad) {
    const saved = dbLoad();
    if (saved) {
      activeDirective = saved;
      logger.info(`[Commander] Restored directive from DB: "${saved.text}" [intent=${saved.type}]`);
    }
  }

  if (!process.stdin.isTTY) {
    logger.info('[Commander] Non-interactive stdin — directive input disabled');
    return;
  }

  const rl = readline.createInterface({
    input:    process.stdin,
    output:   process.stdout,
    terminal: true,
    prompt:   '',
  });

  logger.info('[Commander] 💬 Ready for directives. Type a command and press Enter:');
  logger.info('[Commander]   <message>        — set player directive');
  logger.info('[Commander]   force: <message> — bypass safety checks');
  logger.info('[Commander]   clear | status | done');

  rl.on('line', (line) => {
    const input = line.trim();
    if (!input) return;
    const lower = input.toLowerCase();

    // Slash commands take priority
    const { handleSlash } = require('./commands/slash');
    if (handleSlash(input, null)) return;

    // Legacy plain-text commands
    if (lower === 'help') {
      logger.info('[Commander] Commands: /help | /clear | /status | /pause | /resume | /attack | /defend | /eco | /collect | /research | force: <text>');
    } else if (lower === 'clear' || lower === 'reset') {
      clearDirective();
    } else if (lower === 'status') {
      if (activeDirective) {
        logger.info(`[Commander] Active: "${activeDirective.text}" [${activeDirective.type}${activeDirective.forced ? ' FORCED' : ''}] set ${activeDirective.setAt}`);
      } else {
        logger.info('[Commander] No active directive.');
      }
    } else if (lower === 'done') {
      markDirectiveDone('marked done by player');
    } else {
      setDirective(input);
      if (dbSave) dbSave(activeDirective);
    }
  });

  rl.on('close', () => {
    logger.info('[Commander] stdin closed — continuing without directive input');
  });
}

/** Attach AI interpretation to the active directive (called by agent after consulting director). */
function setDirectiveInterpretation(interpretation) {
  if (activeDirective) {
    activeDirective.interpretation = interpretation;
  }
}

module.exports = {
  startCommandInterface,
  getDirective,
  setDirective,
  clearDirective,
  markDirectiveDone,
  parseDirective,
  setDirectiveInterpretation,
};
