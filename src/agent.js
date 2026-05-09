/**
 * Agent orchestrator — scan → strategize → execute loop.
 *
 * Each cycle:
 *  1. Check active-hours window.
 *  2. Scan ALL planets (resources, building levels, fleet, defense).
 *  3. AI strategic plan — only every AI_REFRESH_CYCLES cycles (token conservation).
 *     Player directives with known intent are executed directly, bypassing AI.
 *  4. Persist snapshots + decisions to SQLite.
 *  5. Execute: transports first, then tactics per planet.
 *  6. Idle break every 2–3 cycles. Wait for next cycle.
 */

const logger      = require('./utils/logger');
const brief       = require('./utils/briefing');
const tui         = require('./ui/tui');
const { delay, idleBreak, randomBetween, humanDelay } = require('./utils/delay');
const { runTactic } = require('./tactics/index');
const { collectTargets } = require('./tactics/attacker');
const { strategize }     = require('./ai/strategist');
const { scanAllPlanets } = require('./scanner');
const { executeTransportsFromPlanet } = require('./transport');
const { savePlanetSnapshot, saveDecision, saveCycleTotals, saveDirective, loadActiveDirective, clearSavedDirective } = require('./db/index');
const { getPlanets, switchPlanet, gotoComponent, SessionError } = require('./utils/navigation');
const { getDirective, clearDirective, markDirectiveDone, setDirectiveInterpretation } = require('./commander');
const { interpretDirective } = require('./ai/director');
const { isPaused } = require('./commands/slash');

const CYCLE_INTERVAL_MS   = parseInt(process.env.CYCLE_INTERVAL_MS    ?? '150000', 10);
const ACTIVE_HOURS_START  = parseInt(process.env.ACTIVE_HOURS_START   ?? '7',  10);
const ACTIVE_HOURS_END    = parseInt(process.env.ACTIVE_HOURS_END     ?? '3',  10);
// AI is only called every N cycles — reuses cached plan in between (saves tokens)
const AI_REFRESH_CYCLES   = parseInt(process.env.AI_REFRESH_CYCLES    ?? '3',  10);
const ACTIVE_TACTICS      = (process.env.ACTIVE_TACTICS ?? 'economics,defense,collector,attacker')
  .split(',').map(t => t.trim()).filter(Boolean);

const IDLE_BREAK_EVERY = randomBetween(2, 3);
let cycleCount = 0;

// Cached AI strategic plan — reused for AI_REFRESH_CYCLES cycles
let cachedPlan     = null;
let lastAiCycle    = -Infinity;

/** Return current hour in Europe/Warsaw timezone. */
function warsawHour() {
  return parseInt(
    new Date().toLocaleString('en-GB', { timeZone: 'Europe/Warsaw', hour: '2-digit', hour12: false }),
    10
  );
}

/**
 * Is the current hour within the active window?
 * Handles overnight windows (e.g. 07:00–03:00) correctly.
 */
function isActiveHour(h) {
  if (ACTIVE_HOURS_START <= ACTIVE_HOURS_END) {
    // Same-day window: 08:00–23:00
    return h >= ACTIVE_HOURS_START && h < ACTIVE_HOURS_END;
  }
  // Overnight window: 07:00–03:00 → active if h >= 7 OR h < 3
  return h >= ACTIVE_HOURS_START || h < ACTIVE_HOURS_END;
}

/** Sleep until the active window opens, checking every minute. */
async function waitForActiveHours() {
  while (true) {
    const h = warsawHour();
    if (isActiveHour(h)) return;
    const sleepMin = randomBetween(55, 65);
    brief.outsideActiveHours(h);
    await delay(sleepMin * 1000);
  }
}

/**
 * Build tactic execution order for this cycle.
 *
 * Directive intent overrides tactic priority:
 *   - attack/collect directive → attacker runs first
 *   - defend directive → defense runs first
 *   - economics/research directive → economics runs first
 * Otherwise uses the default ACTIVE_TACTICS order.
 */
function buildTacticOrder(directiveIntent = null) {
  const order = [...ACTIVE_TACTICS];

  const promote = (tactic) => {
    const idx = order.indexOf(tactic);
    if (idx > 0) { order.splice(idx, 1); order.unshift(tactic); }
  };

  if (directiveIntent === 'attack' || directiveIntent === 'collect') promote('attacker');
  else if (directiveIntent === 'defend')    promote('defense');
  else if (directiveIntent === 'economics' || directiveIntent === 'research') promote('economics');

  return order;
}

/**
 * Decide whether to call the AI strategist this cycle.
 *
 * We skip the AI when:
 *  - A player directive with a known direct intent is active (we execute it ourselves)
 *  - The cached plan is recent enough (within AI_REFRESH_CYCLES cycles)
 *
 * We always call AI when:
 *  - No cached plan exists
 *  - Directive intent is 'custom' (AI must interpret)
 *  - AI_REFRESH_CYCLES cycles have passed since last call
 */
function shouldRefreshAiPlan(directive) {
  if (!cachedPlan) return true;
  if (directive?.type === 'custom') return true;
  if (cycleCount - lastAiCycle >= AI_REFRESH_CYCLES) return true;
  return false;
}

/**
 * Run one full cycle:
 *  1. Discover planets
 *  2. Scan all planets for full stats
 *  3. AI strategic plan — only every AI_REFRESH_CYCLES cycles
 *  4. Execute directive directly if intent is known
 *  5. Persist snapshots + decisions
 *  6. Execute transports + tactics per planet
 */
async function runCycle(page) {
  // ── Pause check — commander can freeze the agent between cycles ─────────────
  if (isPaused()) {
    tui.setMode('idle');
    logger.info('[Agent] ⏸  Standing by — agent paused by Commander. Type /resume to continue.');
    return CYCLE_INTERVAL_MS;
  }

  cycleCount++;
  brief.missionStart(cycleCount);
  tui.setMode('working');

  // ── 1. Discover planets ────────────────────────────────────────────────────
  await gotoComponent(page, 'supplies');
  const planets = await getPlanets(page);
  if (planets.length === 0) {
    logger.warn('[Agent] No planets found in sidebar — check selectors');
    tui.setMode('alert');
    return;
  }
  logger.info(`[Agent] Empire spans ${planets.length} world(s): ${planets.map(p => p.coords).join(', ')}`);
  tui.updateStats({ planets: planets.length, cycle: cycleCount });

  // ── 2. Scan all planets ────────────────────────────────────────────────────
  brief.intelSweepStart(planets.length);
  const snapshots = await scanAllPlanets(page, planets);

  // Push resource totals to TUI stats
  const totalMetal     = snapshots.reduce((s, x) => s + (x.resources?.metal      ?? 0), 0);
  const totalCrystal   = snapshots.reduce((s, x) => s + (x.resources?.crystal    ?? 0), 0);
  const totalDeuterium = snapshots.reduce((s, x) => s + (x.resources?.deuterium  ?? 0), 0);
  const energyAlerts   = snapshots.filter(x => (x.energy ?? 0) < -200).map(x => x.planet?.coords);
  tui.updateStats({ totalMetal, totalCrystal, totalDeuterium, energyAlerts });

  // ── 3. Directive handling (player is highest authority) ───────────────────
  const directive = getDirective();
  let directiveBlocked = false;
  let directiveInterpretation = directive?.interpretation ?? null;
  let actionsCount = 0;

  if (directive) {
    brief.commanderDirective(directive);
    tui.updateStats({ directive: directive.text });

    if (!directiveInterpretation) {
      directiveInterpretation = await interpretDirective(directive.text, snapshots);
      setDirectiveInterpretation(directiveInterpretation);
    }

    if (directiveInterpretation.destructive && !directive.forced) {
      brief.directiveBlocked(directiveInterpretation.destructiveReason, directive.text);
      tui.setMode('alert');
      directiveBlocked = true;
    } else {
      brief.directiveAcknowledged(directiveInterpretation);
      if (directiveInterpretation.destructive && directive.forced) {
        brief.directiveForced(directiveInterpretation.destructiveReason);
      }
    }
  } else {
    tui.updateStats({ directive: null });
  }

  // ── 4. AI strategic plan (throttled — every AI_REFRESH_CYCLES cycles) ─────
  if (shouldRefreshAiPlan(directive)) {
    cachedPlan = await strategize(snapshots);
    lastAiCycle = cycleCount;
  } else {
    logger.info(`[HQ] Reusing strategic plan (age: ${cycleCount - lastAiCycle} cycle(s), refreshes in ${AI_REFRESH_CYCLES - (cycleCount - lastAiCycle)} more)`);
  }
  const plan = cachedPlan ?? { planetActions: [], transports: [], researchNext: null, advice: 'No plan', confidence: 0 };
  brief.strategicBriefing(plan, cycleCount, lastAiCycle, AI_REFRESH_CYCLES);
  tui.updateStats({ aiPlan: plan.advice });

  // ── 5. Tactic execution order ─────────────────────────────────────────────
  const activeIntent = (!directiveBlocked && directive) ? directive.type : null;
  const order = buildTacticOrder(activeIntent);
  logger.info(`[Agent] Executing: ${order.join(' → ')}`);
  tui.updateStats({ tactics: order });

  // ── 6. Persist to DB ───────────────────────────────────────────────────────
  for (const snap of snapshots) {
    savePlanetSnapshot(cycleCount, snap.planet, snap.resources, snap.buildings, snap.fleet, snap.defense);
  }
  for (const action of plan.planetActions) {
    saveDecision(cycleCount, 'build', action.coords, null, action, action.reason, plan.confidence);
    actionsCount++;
  }
  for (const t of plan.transports) {
    saveDecision(cycleCount, 'transport', t.from, t.to, t, t.reason, plan.confidence);
    actionsCount++;
  }
  saveCycleTotals(cycleCount, snapshots, actionsCount, plan.advice);

  // ── 7. Collect espionage targets ───────────────────────────────────────────
  let raidTargets = [];
  if (order.includes('attacker')) {
    raidTargets = await collectTargets(page);
    brief.raidTargetsFound(raidTargets.length);
  }

  // ── 8. Execute per planet ─────────────────────────────────────────────────
  for (const [idx, planet] of planets.entries()) {
    const isHome   = idx === 0;
    const snap     = snapshots.find(s => s.planet.id === planet.id) ?? snapshots[idx];
    const aiAction = plan.planetActions.find(a => a.coords === planet.coords);

    const tacticFilter = planet.isMoon ? order.filter(t => t !== 'attacker') : order;
    if (tacticFilter.length === 0) continue;

    await switchPlanet(page, planet);
    brief.planetBriefing(planet, snap, aiAction);

    if (!planet.isMoon && plan.transports.length) {
      await executeTransportsFromPlanet(page, plan.transports, planet.coords, snap?.fleet ?? {});
    }

    const directiveParams = (!directiveBlocked && directiveInterpretation?.params) ? directiveInterpretation.params : {};

    // Home planet coords — used by attacker to know which area to probe
    const homePlanet = snapshots.find(s => s.planet.isHome) ?? snapshots[0];

    for (const tactic of tacticFilter) {
      const opts = {
        includeResearch:     isHome,
        buildRecommendation: directiveParams.buildTarget ?? aiAction?.buildNext,
        buildRecommendedId:  aiAction?.buildId,
        researchNext:        isHome ? plan.researchNext : undefined,
        snapshot:            snap,
        totalPlanets:        planets.length,
        targets:             tactic === 'attacker' ? raidTargets : undefined,
        homeCoords:          tactic === 'attacker' ? (homePlanet?.planet?.coords ?? planet.coords) : undefined,
        preferNearby:        directiveParams.preferNearby,
        aggressiveness:      directiveParams.aggressiveness,
      };
      await runTactic(tactic, page, opts);
      await humanDelay(300, 600);
    }
  }

  // ── 9. Directive lifecycle ─────────────────────────────────────────────────
  if (directive && !directiveBlocked) {
    saveDirective({ ...directive, cycle: cycleCount });
  }

  // ── 10. Idle break ─────────────────────────────────────────────────────────
  if (cycleCount % IDLE_BREAK_EVERY === 0) {
    brief.idleBreakAnnounce();
    tui.setMode('idle');
    await idleBreak();
  }

  // ── 11. Sitrep ────────────────────────────────────────────────────────────
  const jitter = randomBetween(-CYCLE_INTERVAL_MS * 0.2, CYCLE_INTERVAL_MS * 0.2);
  const wait   = Math.round(CYCLE_INTERVAL_MS + jitter);
  tui.setMode('idle');
  tui.updateStats({ nextIn: Math.round(wait / 1000), lastAction: `Cycle #${cycleCount} complete` });
  brief.missionComplete(cycleCount, snapshots, actionsCount, Math.round(wait / 1000));
  return wait;
}

/**
 * Start the main agent loop. Runs until the process is killed.
 * @param {object} page         - Playwright page
 * @param {Function} reAuthFn   - async () => void — called to re-authenticate when session is lost
 */
async function start(page, reAuthFn) {
  logger.info('[Agent] ⚔  OGame Agent — online and awaiting orders');
  logger.info(`[Agent]    Tactics : ${ACTIVE_TACTICS.join(' · ')}`);
  logger.info(`[Agent]    Interval: ~${CYCLE_INTERVAL_MS / 1000}s  AI refresh: every ${AI_REFRESH_CYCLES} cycles`);
  logger.info(`[Agent]    Active  : ${ACTIVE_HOURS_START}:00 – ${ACTIVE_HOURS_END}:00 Warsaw`);

  while (true) {
    await waitForActiveHours();
    let wait = CYCLE_INTERVAL_MS;
    try {
      wait = await runCycle(page) ?? CYCLE_INTERVAL_MS;
    } catch (err) {
      if (err.name === 'SessionError') {
        brief.sessionAlert(err.reason);
        if (err.reason === 'banned') {
          await delay(30 * 60 * 1000);
        } else if (err.reason === 'maintenance') {
          await delay(10 * 60 * 1000);
        } else {
          try {
            if (reAuthFn) await reAuthFn();
            logger.info('[Agent] Re-auth succeeded — resuming');
          } catch (authErr) {
            logger.error(`[Agent] Re-auth failed: ${authErr.message} — waiting 2 min`);
            await delay(2 * 60 * 1000);
          }
        }
        continue;
      }
      logger.error(`[Agent] Cycle error: ${err.message}`);
    }

    brief.standingBy(Math.round(wait / 1000));
    await delay(wait);
  }
}

module.exports = { start };
