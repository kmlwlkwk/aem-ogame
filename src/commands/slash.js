/**
 * Slash command handler — instant structured commands for the TUI input bar.
 *
 * Slash commands are parsed before natural-language directives, giving the
 * player immediate, structured control without going through AI interpretation.
 *
 * Available commands:
 *   /help  /?          — show command reference
 *   /status            — show active directive + agent state
 *   /attack [target]   — set attack/raid directive
 *   /defend            — focus on defense
 *   /eco  /economics   — focus on economics
 *   /collect           — collect debris / loot inactives
 *   /research [topic]  — focus on research
 *   /clear             — cancel active directive
 *   /force <text>      — execute directive, skip safety checks
 *   /pause             — pause agent between cycles
 *   /resume            — resume paused agent
 *   /version           — show version info
 */

'use strict';

const { version } = require('../../package.json');
const logger = require('../utils/logger');
const { setDirective, clearDirective, getDirective } = require('../commander');

// ── Pause state ───────────────────────────────────────────────────────────────
// Checked by agent at cycle start. When paused, agent idles instead of acting.

let _paused = false;
function isPaused()   { return _paused; }

// ── Help text (blessed tags for TUI; stripped for plain output) ───────────────

const HELP = [
  '{cyan-fg}┌─ OGame Commander  Slash Reference ─────────────────┐{/cyan-fg}',
  '{cyan-fg}│{/cyan-fg}  {bold}/help{/bold}  /?              Show this reference',
  '{cyan-fg}│{/cyan-fg}  {bold}/status{/bold}               Active directive & agent state',
  '{cyan-fg}│{/cyan-fg}  {bold}/attack{/bold} [target]      Attack/raid directive',
  '{cyan-fg}│{/cyan-fg}  {bold}/defend{/bold}               Focus on defense',
  '{cyan-fg}│{/cyan-fg}  {bold}/eco{/bold}  /economics      Focus on resource production',
  '{cyan-fg}│{/cyan-fg}  {bold}/collect{/bold}              Collect debris / loot inactives',
  '{cyan-fg}│{/cyan-fg}  {bold}/research{/bold} [topic]     Focus on research & tech',
  '{cyan-fg}│{/cyan-fg}  {bold}/clear{/bold}  /reset        Cancel active directive',
  '{cyan-fg}│{/cyan-fg}  {bold}/force{/bold} <text>         Execute directive, skip safety',
  '{cyan-fg}│{/cyan-fg}  {bold}/pause{/bold}                Pause agent after current cycle',
  '{cyan-fg}│{/cyan-fg}  {bold}/resume{/bold}               Resume paused agent',
  '{cyan-fg}│{/cyan-fg}  {bold}/version{/bold}              Show version info',
  '{cyan-fg}│{/cyan-fg}',
  '{cyan-fg}│{/cyan-fg}  Or just type naturally:  "attack nearby inactives"',
  '{cyan-fg}│{/cyan-fg}                           "build solar satellites"',
  '{cyan-fg}│{/cyan-fg}                           "force: destroy all solar plants"',
  '{cyan-fg}└────────────────────────────────────────────────────┘{/cyan-fg}',
];

// Strip blessed colour tags for plain-text (non-TUI) output
function stripTags(s) { return s.replace(/\{[^}]+\}/g, ''); }

function tuiLog(tui, line) {
  if (tui?.log) tui.log(line);
  else          logger.info(stripTags(line));
}

// ── Main handler ─────────────────────────────────────────────────────────────

/**
 * Handle a slash command typed in the input bar.
 *
 * @param {string} input — raw text from the user
 * @param {object} tui   — TUI instance (may be null in non-TUI mode)
 * @returns {boolean}    — true if the input was a slash command (consumed)
 */
function handleSlash(input, tui) {
  if (!input.startsWith('/')) return false;

  const parts = input.slice(1).trim().split(/\s+/);
  const cmd   = (parts[0] ?? '').toLowerCase();
  const args  = parts.slice(1).join(' ');

  switch (cmd) {

    // ── Help ────────────────────────────────────────────────────────────────
    case 'help':
    case '?':
      HELP.forEach(line => tuiLog(tui, line));
      break;

    // ── Status ──────────────────────────────────────────────────────────────
    case 'status': {
      const d = getDirective();
      if (d) {
        tuiLog(tui, `{magenta-fg}[Commander] 🎯 Active: "${d.text}" [${d.type}${d.forced ? ' FORCED' : ''}]{/magenta-fg}`);
      } else {
        tuiLog(tui, '{gray-fg}[Commander] 💤 No active directive — autonomous mode{/gray-fg}');
      }
      const agentState = _paused
        ? '{yellow-fg}[Commander] ⏸  Agent is PAUSED — type /resume to continue{/yellow-fg}'
        : '{green-fg}[Commander] ▶  Agent running{/green-fg}';
      tuiLog(tui, agentState);
      break;
    }

    // ── Attack ──────────────────────────────────────────────────────────────
    case 'attack':
      setDirective(args ? `attack ${args}` : 'attack nearby inactive planets to collect resources');
      break;

    // ── Defend ──────────────────────────────────────────────────────────────
    case 'defend':
      setDirective(args ? `defend: ${args}` : 'focus on defense — fortify all planets');
      break;

    // ── Economics ───────────────────────────────────────────────────────────
    case 'eco':
    case 'economics':
      setDirective(args ? `economics: ${args}` : 'focus on economics and resource production');
      break;

    // ── Collect ─────────────────────────────────────────────────────────────
    case 'collect':
      setDirective(args ? `collect ${args}` : 'collect debris fields and loot from inactive planets');
      break;

    // ── Research ────────────────────────────────────────────────────────────
    case 'research':
      setDirective(args ? `research: ${args}` : 'focus on research and technology upgrades');
      break;

    // ── Clear ───────────────────────────────────────────────────────────────
    case 'clear':
    case 'reset':
      clearDirective();
      break;

    // ── Force ───────────────────────────────────────────────────────────────
    case 'force':
      if (!args) {
        tuiLog(tui, '{yellow-fg}[Commander] ⚠  /force needs a command — e.g.  /force attack that fleet now{/yellow-fg}');
      } else {
        setDirective(`force: ${args}`);
      }
      break;

    // ── Pause ───────────────────────────────────────────────────────────────
    case 'pause':
      _paused = true;
      logger.warn('[Commander] ⏸  Agent PAUSED — will idle after current cycle completes. Type /resume to continue.');
      break;

    // ── Resume ──────────────────────────────────────────────────────────────
    case 'resume':
      if (_paused) {
        _paused = false;
        logger.info('[Commander] ▶  Agent RESUMED — next cycle starting shortly');
      } else {
        tuiLog(tui, '{gray-fg}[Commander] Agent is already running{/gray-fg}');
      }
      break;

    // ── Version ─────────────────────────────────────────────────────────────
    case 'version':
      tuiLog(tui, `{cyan-fg}[Commander] ⚔  OGame Commander by Camillo  v${version}{/cyan-fg}`);
      break;

    // ── Unknown ─────────────────────────────────────────────────────────────
    default:
      tuiLog(tui, `{yellow-fg}[Commander] Unknown command: /${cmd}  — type /help for reference{/yellow-fg}`);
  }

  return true;
}

module.exports = { handleSlash, isPaused };
