/**
 * Briefing — commander-style narrative layer over the technical logs.
 *
 * Adds personality to key moments without replacing the technical detail.
 * All functions return formatted strings logged via the standard logger.
 */

const logger = require('./logger');

// ── Utilities ──────────────────────────────────────────────────────────────

const fmt = (n) => {
  if (n === null || n === undefined || isNaN(n)) return '?';
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000)     return `${(n / 1_000).toFixed(0)}k`;
  return String(n);
};

const bar = (char = '═', width = 52) => char.repeat(width);

// ── Cycle lifecycle ────────────────────────────────────────────────────────

function missionStart(cycleCount) {
  const time = new Date().toLocaleTimeString('pl-PL', { timeZone: 'Europe/Warsaw', hour12: false });
  logger.info('');
  logger.info(`  ╔${bar('═', 48)}╗`);
  logger.info(`  ║${''.padEnd(14)}⚔  MISSION CYCLE #${String(cycleCount).padEnd(4)}  ⚔${''.padEnd(14)}║`);
  logger.info(`  ║${''.padEnd(15)}Warsaw time: ${time}${''.padEnd(15)}║`);
  logger.info(`  ╚${bar('═', 48)}╝`);
}

function missionComplete(cycleCount, snapshots, actionsCount, nextWaitSec) {
  const totalMetal    = snapshots.reduce((s, x) => s + (x.resources?.metal    ?? 0), 0);
  const totalCrystal  = snapshots.reduce((s, x) => s + (x.resources?.crystal  ?? 0), 0);
  const totalDeuteria = snapshots.reduce((s, x) => s + (x.resources?.deuterium ?? 0), 0);
  const energyIssues  = snapshots.filter(x => (x.energy ?? 0) < -200).length;

  logger.info('');
  logger.info(`  ┌${bar('─', 48)}┐`);
  logger.info(`  │  📊  CYCLE #${cycleCount} SITREP${' '.repeat(Math.max(0, 35 - String(cycleCount).length))}│`);
  logger.info(`  │  🌍  Worlds surveyed : ${String(snapshots.length).padEnd(27)}│`);
  logger.info(`  │  💎  Treasury        : M:${fmt(totalMetal).padEnd(7)} C:${fmt(totalCrystal).padEnd(7)} D:${fmt(totalDeuteria).padEnd(5)}│`);
  logger.info(`  │  🏗️   Orders issued   : ${String(actionsCount).padEnd(27)}│`);
  if (energyIssues > 0) {
    logger.info(`  │  ⚡  Energy alerts   : ${String(energyIssues + ' planet(s)').padEnd(27)}│`);
  }
  logger.info(`  │  ⏭️   Next sweep in   : ${String(nextWaitSec + 's').padEnd(27)}│`);
  logger.info(`  └${bar('─', 48)}┘`);
  logger.info('');
}

// ── Planet scanning ────────────────────────────────────────────────────────

function intelSweepStart(planetCount) {
  logger.info(`[Intel] 🔭 Initiating empire-wide survey — ${planetCount} world(s) in scope`);
}

function intelSweepComplete(snapshots) {
  const planets    = snapshots.filter(s => !s.planet?.isMoon);
  const moons      = snapshots.filter(s =>  s.planet?.isMoon);
  const totalM     = planets.reduce((s, x) => s + (x.resources?.metal    ?? 0), 0);
  const totalC     = planets.reduce((s, x) => s + (x.resources?.crystal  ?? 0), 0);
  const totalD     = planets.reduce((s, x) => s + (x.resources?.deuterium ?? 0), 0);
  const lowEnergy  = planets.filter(x => (x.energy ?? 0) < -200);
  const method     = snapshots[0]?.scannedVia === 'empire' ? 'Empire overview (single pass)' : 'Per-planet sweep';

  logger.info(`[Intel] ✅ Survey complete — ${planets.length} planet(s)${moons.length ? `, ${moons.length} moon(s)` : ''} via ${method}`);
  logger.info(`[Intel]    Resources on hand: M:${fmt(totalM)}  C:${fmt(totalC)}  D:${fmt(totalD)}`);
  if (lowEnergy.length > 0) {
    logger.warn(`[Intel]    ⚡ Energy deficit on: ${lowEnergy.map(s => s.planet?.coords).join(', ')}`);
  }
}

// ── Directives ────────────────────────────────────────────────────────────

function commanderDirective(directive) {
  logger.info(`[Command] 🎯 Commander's order: "${directive.text}"`);
  logger.info(`[Command]    Classification: ${directive.type.toUpperCase()}${directive.forced ? '  [FORCED — ALL SAFETY CHECKS BYPASSED]' : ''}`);
}

function directiveAcknowledged(interpretation) {
  logger.info(`[Command] ✅ Order acknowledged — ${interpretation.explanation}`);
}

function directiveBlocked(reason, directiveText) {
  logger.warn(`[Command] ⛔ ORDER SUSPENDED — High Command flags execution risk:`);
  logger.warn(`[Command]    Risk: ${reason}`);
  logger.warn(`[Command]    To override: type  force: ${directiveText}`);
}

function directiveForced(reason) {
  logger.warn(`[Command] ⚡ OVERRIDING safety gate on Commander's authority — ${reason}`);
}

function directiveComplete(text, result) {
  logger.info(`[Command] 🏁 Directive complete: "${text}"${result ? `  (${result})` : ''}`);
}

// ── AI Strategic plan ─────────────────────────────────────────────────────

function strategicBriefing(plan, cycleCount, lastAiCycle, refreshEvery) {
  if (cycleCount === lastAiCycle) {
    // Fresh from AI this cycle
    logger.info(`[HQ] 🧠 Strategic assessment (fresh): ${plan.advice ?? 'no summary'}`);
  } else {
    const age = cycleCount - lastAiCycle;
    logger.info(`[HQ] 🧠 Strategic plan (age: ${age} cycle(s)): ${plan.advice ?? 'no summary'}`);
  }
}

// ── Per-planet ────────────────────────────────────────────────────────────

function planetBriefing(planet, snap, aiAction) {
  const res = snap?.resources ?? {};
  const energy = snap?.energy ?? 0;
  const energyStr = energy < -500 ? `⚡ DEFICIT ${energy}` : energy < 0 ? `⚡ ${energy}` : `✓ +${energy}`;
  const flag = planet.isMoon ? '🌙' : '🌍';
  logger.info(`[${planet.coords}] ${flag} ${planet.name}  M:${fmt(res.metal)}  C:${fmt(res.crystal)}  D:${fmt(res.deuterium)}  E:${energyStr}`);
  if (aiAction) {
    logger.info(`[${planet.coords}]    HQ suggestion: ${aiAction.buildNext}  — ${aiAction.reason}`);
  }
}

// ── Economics ─────────────────────────────────────────────────────────────

function buildOrdered(coords, buildingName, reason) {
  const icons = {
    'metal mine': '⛏️', 'crystal mine': '💎', 'deuterium': '🧪',
    'solar': '☀️', 'fusion': '⚛️', 'storage': '🏦',
    'robotics': '🤖', 'nanite': '⚡', 'shipyard': '🚀',
    'research lab': '🔬', 'missile silo': '🎯',
  };
  const icon = Object.entries(icons).find(([k]) => buildingName.toLowerCase().includes(k))?.[1] ?? '🏗️';
  const tag = coords ? `[${coords}]` : '[Build]';
  logger.info(`${tag} ${icon} Commissioning: ${buildingName}${reason ? `  (${reason})` : ''}`);
}

function energyDeficitAlert(coords, deficit, satellites, slot) {
  logger.warn(`[${coords}] ⚡ ENERGY CRISIS  deficit=${deficit}  → deploying ${satellites}× Solar Satellite (slot ${slot})`);
}

function nothingAffordable(coords, section) {
  logger.info(`[${coords}]    No affordable ${section} upgrades this cycle`);
}

// ── Attacker ──────────────────────────────────────────────────────────────

function raidTargetsFound(count) {
  if (count === 0) {
    logger.info('[Attacker] 🕵️  No viable raid targets in espionage reports');
  } else {
    logger.info(`[Attacker] 🕵️  ${count} viable target(s) identified`);
  }
}

function raidDispatched(targetCoords, ships, lootEstimate) {
  logger.info(`[Attacker] 🚀 Strike dispatched → ${targetCoords}  ships:${ships}  est.loot: M:${fmt(lootEstimate?.metal)}+C:${fmt(lootEstimate?.crystal)}+D:${fmt(lootEstimate?.deuterium)}`);
}

function raidSkipped(targetCoords, reason) {
  logger.info(`[Attacker]    Skipping ${targetCoords} — ${reason}`);
}

// ── Session / system ──────────────────────────────────────────────────────

function sessionAlert(reason) {
  const messages = {
    logged_out:  '🔒 Session expired — re-authenticating …',
    banned:      '🚨 Account suspended — standing down for 30 min',
    maintenance: '🔧 Server maintenance — resuming in 10 min',
  };
  logger.warn(`[Alert] ${messages[reason] ?? `Session issue: ${reason}`}`);
}

function standingBy(seconds) {
  const mins = Math.round(seconds / 60);
  if (mins >= 2) {
    logger.info(`[Agent] 💤 Standing by, Commander — next sweep in ${mins} min`);
  } else {
    logger.info(`[Agent] ⏳ Standing by — next sweep in ${seconds}s`);
  }
}

function idleBreakAnnounce() {
  const quips = [
    "Taking a breather — even empires need rest.",
    "Admiral stepping away from the helm briefly …",
    "Passive patrol mode. Nothing to report.",
    "Scanning long-range sensors …",
    "Reviewing star charts …",
  ];
  logger.info(`[Agent] 💤 ${quips[Math.floor(Math.random() * quips.length)]}`);
}

function outsideActiveHours(hour) {
  logger.info(`[Agent] 🌙 Outside active hours (${hour}:xx Warsaw) — fleet stands down`);
}

module.exports = {
  missionStart,
  missionComplete,
  intelSweepStart,
  intelSweepComplete,
  commanderDirective,
  directiveAcknowledged,
  directiveBlocked,
  directiveForced,
  directiveComplete,
  strategicBriefing,
  planetBriefing,
  buildOrdered,
  energyDeficitAlert,
  nothingAffordable,
  raidTargetsFound,
  raidDispatched,
  raidSkipped,
  sessionAlert,
  standingBy,
  idleBreakAnnounce,
  outsideActiveHours,
};
