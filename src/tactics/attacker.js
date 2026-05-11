/**
 * Attacker tactic — raids INACTIVE players only, espionage-gated.
 *
 * Full execution chain (automatic dependency resolution):
 *
 *  Phase 1 — PROBE (when no reports exist):
 *    1. Scan nearby galaxy systems for planets with inactive status.
 *    2. Send espionage probes to the closest inactives.
 *    3. Log "probing N targets — check next cycle".
 *
 *  Phase 2 — ATTACK (next cycle, when reports are available):
 *    1. Read espionage reports from messages.
 *    2. Filter: inactive badge, defense < threshold, loot > fleet cost.
 *    3. Dispatch Light Fighters to viable targets.
 *
 * Safety rules (hard constraints, never overridden):
 *  - NEVER attack active players.
 *  - NEVER attack if defense > DEFENSE_SAFE_THRESHOLD.
 *  - Skip report if older than REPORT_MAX_AGE_H hours.
 *  - Skip if expected loot < fleet replacement cost × MIN_PROFIT_RATIO.
 */

const logger = require('../utils/logger');
const { humanDelay, thinkTime } = require('../utils/delay');
const { gotoComponent, readResources, withRetry, BASE_URL } = require('../utils/navigation');

const DEFENSE_SAFE_THRESHOLD = parseInt(process.env.DEFENSE_SAFE_THRESHOLD ?? '5000', 10);
const ESPIONAGE_MIN_LEVEL    = parseInt(process.env.ESPIONAGE_MIN_LEVEL    ?? '5',    10);
const REPORT_MAX_AGE_H       = 6;    // ignore reports older than 6 hours

// ── Scanning strategy configuration ───────────────────────────────────────────
const SCAN_MODE      = (process.env.ATTACK_SCAN_MODE     ?? 'standard').trim().toLowerCase();
const PROBE_RANGE    = parseInt(process.env.ATTACK_PROBE_RANGE        ?? '4', 10);

// Random mode: "MAX_PICKS,MAX_DISTANCE" e.g., "6,500" means 6 random picks in range 1-500
const RANDOM_SYSTEMS_RANGE= process.env.ATTACK_RANDOM_SYSTEMS_RANGE    ?? '6,500';

function parseRandomRange() {
  const [maxPicks, maxDistance] = RANDOM_SYSTEMS_RANGE.split(',').map(s => s.trim());
  return {
    MAX_RANDOM_PICKS: parseInt(maxPicks, 10) || MAX_PROBES_PER_CYCLE,
    SCANNER_MAX_DIST: parseInt(maxDistance, 10) || 500
  };
}

// ── Probe dispatch limits ─────────────────────────────────────────────────────
const MAX_PROBES_PER_CYCLE   = 6;    // max probe dispatches in one cycle
const PROBES_PER_TARGET      = Math.max(ESPIONAGE_MIN_LEVEL, 3); // probes to send per target

// ── Validation helpers ────────────────────────────────────────────────────────

function validateScanMode() {
  if (SCAN_MODE !== 'standard' && SCAN_MODE !== 'random') {
    logger.warn(`[Attacker] Invalid SCAN_MODE "${SCAN_MODE}" — falling back to "standard"`);
    SCAN_MODE = 'standard';
  }
}

// ── Public API for scanning logic ──────────────────────────────────────────────

/**
 * Scan galaxy and return inactive planet candidates.
 *
 * Mode "standard": Scans ±PROBE_RANGE systems around home planet (deterministic radius)
 * Mode "random": Picks up to MAX_RANDOM_PICKS random locations in 1–SCANNER_MAX_DIST range
 */
async function findInactiveCandidates(page, homeCoords) {
  validateScanMode();

  const [g, sys] = homeCoords.replace(/[\[\]]/g, '').split(':').map(Number);
  if (!g || !sys) return [];

  logger.info(`[Attacker] Scan mode: ${SCAN_MODE}`);

  // Parse random range on first call (cached internally)
  const { MAX_RANDOM_PICKS, SCANNER_MAX_DIST } = parseRandomRange();

  if (SCAN_MODE === 'standard') {
    return await scanStandardMode(page, g, sys);
  } else {
    return await scanRandomMode(page, MAX_RANDOM_PICKS, SCANNER_MAX_DIST);
  }
}

// Light Fighter stats (used for fleet cost estimate)
const LF_COST = { metal: 3000, crystal: 1000, deut: 0 };

// ── Espionage report parsing ──────────────────────────────────────────────────

/**
 * Navigate to the espionage messages tab and extract viable attack targets.
 * Returns an array of { coords, resources, defensePoints, reportAge }
 */
async function collectEspionageReports(page) {
  logger.info('[Attacker] Reading espionage reports …');
  // Messages page lands on Espionage tab by default in English OGame — no tab click needed
  await gotoComponent(page, 'messages');
  await humanDelay(400, 800);

  const targets = [];
  const reports = await page.$$('.msg, .report-item, .espionage-msg');
  logger.info(`[Attacker] Found ${reports.length} espionage reports`);

  for (const report of reports) {
    try {
      const target = await parseReport(page, report);
      if (!target) continue;
      const ok = await shouldAttackTarget(target);
      if (ok) targets.push(target);
    } catch (e) {
      logger.debug(`[Attacker] Skipping report: ${e.message}`);
    }
  }

  return targets;
}

/**
 * Parse a single espionage report element.
 * Returns a target object or null if the target is not safe to attack.
 */
async function parseReport(page, reportEl) {
  // Coordinates like [1:234:5]
  const coordEl = await reportEl.$('.coords, .msg_head .coords, a[href*="galaxy"]');
  if (!coordEl) return null;
  const coordText = await coordEl.innerText();
  const coords = coordText.trim().replace(/[\[\]]/g, '');

  // Report timestamp
  const timeEl = await reportEl.$('.msg_date, .date');
  const timeText = timeEl ? await timeEl.innerText() : '';
  const reportAge = parseReportAge(timeText);
  if (reportAge > REPORT_MAX_AGE_H) {
    logger.debug(`[Attacker] Report for ${coords} too old (${reportAge.toFixed(1)}h), skipping`);
    return null;
  }

  // Defence points — shown as "Defence: X" or in a stats table
  const defText = await reportEl.$eval(
    '.defense-points, [data-defense], .defenses .value',
    el => el.innerText
  ).catch(() => '0');
  const defensePoints = parseInt(String(defText).replace(/[^0-9]/g, ''), 10) || 0;

  if (defensePoints > DEFENSE_SAFE_THRESHOLD) {
    logger.info(`[Attacker] ${coords} — defence ${defensePoints} > threshold, skipping`);
    return null;
  }

  // Resources available on target planet
  const metal     = await extractStat(reportEl, 'metal,    .metal-amount,    .resources .metal');
  const crystal   = await extractStat(reportEl, 'crystal,  .crystal-amount,  .resources .crystal');
  const deuterium = await extractStat(reportEl, 'deuterium,.deuterium-amount,.resources .deuterium');

  const totalLoot = (metal + crystal + deuterium) / 2; // OGame gives 50% of stocks

  // Inactive status indicator
  const inactiveEl = await reportEl.$('.player-status.inactive, .inactive, [title*="inactive"], [title*="Inactive"]');
  if (!inactiveEl) {
    logger.debug(`[Attacker] ${coords} — no inactive badge, skipping`);
    return null;
  }

  return { coords, resources: { metal, crystal, deuterium }, defensePoints, totalLoot, reportAge };
}

async function shouldAttackTarget(target) {
  // Hard rules — no AI needed, saves tokens
  if (target.defensePoints > DEFENSE_SAFE_THRESHOLD) return false;
  if (target.reportAge > REPORT_MAX_AGE_H) return false;
  if (target.totalLoot < LF_COST.metal * MIN_PROFIT_RATIO) return false;
  return true;
}

function parseReportAge(timeText) {
  // Try to extract hours from strings like "08.05.2026 12:34:56"
  try {
    const reportDate = new Date(timeText.trim().split(' ').reverse().join(' '));
    const diffMs = Date.now() - reportDate.getTime();
    return diffMs / (1000 * 3600);
  } catch {
    return Infinity;
  }
}

async function extractStat(el, selectors) {
  for (const sel of selectors.split(',').map(s => s.trim())) {
    try {
      const text = await el.$eval(sel, e => e.innerText);
      const val = parseInt(String(text).replace(/[^0-9]/g, ''), 10);
      if (!isNaN(val)) return val;
    } catch { /* try next */ }
  }
  return 0;
}

// ── Galaxy scanner for inactive planets ──────────────────────────────────────

/**
 * Scan a single OGame system for inactive players.
 * Returns an array of coord strings "G:S:P" (inactive or inactive-long only).
 */
async function scanSystemForInactives(page, galaxy, system) {
  const url = `${BASE_URL}/game/index.php?page=ingame&component=galaxy&galaxy=${galaxy}&system=${system}`;
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await humanDelay(600, 1200);

  return page.evaluate(() => {
    const results = [];
    const galaxyVal = document.querySelector('#galaxy_input, [name="galaxy"]')?.value
      || new URLSearchParams(location.search).get('galaxy');
    const systemVal = document.querySelector('#system_input, [name="system"]')?.value
      || new URLSearchParams(location.search).get('system');
    if (!galaxyVal || !systemVal) return results;

    // Each position row — OGame uses tr.row or table rows with a position cell
    document.querySelectorAll('table#galaxytable tr[data-pos], table#galaxytable tr.row').forEach(row => {
      // Position: data-pos attr, or first td text
      const pos = row.dataset?.pos || row.querySelector('td.position')?.innerText?.trim();
      if (!pos || isNaN(Number(pos))) return;

      // Inactive detection: player status cell gets class inactive / longinactive / playerInactive
      const playerCell = row.querySelector('td.playername, td.player');
      if (!playerCell) return;
      const hasInactive = playerCell.classList.contains('inactive')
        || playerCell.classList.contains('longinactive')
        || playerCell.classList.contains('playerInactive')
        || !!playerCell.querySelector('.inactive, .longinactive, [class*="inactive"]')
        // Some OGame skins put [I] or [IM] text next to the name
        || /\[i\]/i.test(playerCell.innerText);

      if (hasInactive) {
        results.push(`${galaxyVal}:${systemVal}:${pos}`);
      }
    });
    return results;
  });
}

// ── Standard mode: deterministic radius scan around home planet ───────────────

/**
 * Scan ±PROBE_RANGE systems around home planet for inactive planets.
 * Returns candidates sorted by distance (nearest first), capped at MAX_PROBES_PER_CYCLE.
 */
async function scanStandardMode(page, galaxy, homeSys) {
  const candidates = [];
  const MAX_SYSTEMS = 499;

  const scanStart = Math.max(1, homeSys - PROBE_RANGE);
  const scanEnd = Math.min(MAX_SYSTEMS, homeSys + PROBE_RANGE);
  
  logger.info(`[Attacker] Standard mode: scanning systems [${scanStart}-${scanEnd}] around ${galaxy}:${homeSys}`);

  for (let offset = 0; offset <= PROBE_RANGE; offset++) {
    const systemsToScan = offset === 0
      ? [homeSys]
      : [...new Set([Math.max(1, homeSys - offset), Math.min(MAX_SYSTEMS, homeSys + offset)])];

    for (const s of systemsToScan) {
      try {
        const inactives = await scanSystemForInactives(page, galaxy, s);
        for (const coords of inactives) {
          candidates.push({ coords, distance: Math.abs(s - homeSys) });
        }
        await humanDelay(300, 700);
      } catch (err) {
        logger.debug(`[Attacker] Galaxy scan ${galaxy}:${s} error: ${err.message}`);
      }
    }

    if (candidates.length >= MAX_PROBES_PER_CYCLE) break;
  }

  candidates.sort((a, b) => a.distance - b.distance);
  logger.info(`[Attacker] Standard mode found ${candidates.length} inactive planet(s)`);
  return candidates.slice(0, MAX_PROBES_PER_CYCLE);
}

// ── Random mode: stochastic scan across galaxy ───────────────────────────────

/**
 * Pick up to maxPicks random systems in the galaxy (1–maxDistance)
 * and scan for inactive planets. Returns candidates capped at MAX_PROBES_PER_CYCLE.
 */
async function scanRandomMode(page, maxPicks, maxDistance = 500) {
  const candidates = [];

  logger.info(`[Attacker] Random mode: picking ${maxPicks} random systems in [1-${maxDistance}]`);

  // Generate unique random system combinations across the entire galaxy
  const visitedSystems = new Set();
  const maxAttempts = maxPicks * 5; // Retry if collisions occur

  for (let attempt = 0; attempt < maxAttempts && candidates.length < MAX_PROBES_PER_CYCLE; attempt++) {
    // Pick random galaxy (1–100) and system (1-maxDistance)
    const randomGalaxy = Math.floor(Math.random() * 100) + 1;
    const randomSystem = Math.floor(Math.random() * maxDistance) + 1;
    const key = `${randomGalaxy}:${randomSystem}`;

    // Skip if already scanned this cycle
    if (visitedSystems.has(key)) continue;

    try {
      const inactives = await scanSystemForInactives(page, randomGalaxy, randomSystem);
      
      for (const coords of inactives) {
        // Parse coordinates to calculate distance from home (optional metric)
        const [cg, cs] = coords.split(':')[0].split(':').map(Number);
        const distance = Math.sqrt(Math.pow(cg - 47, 2) + Math.pow(cs - maxDistance/2, 2));
        
        candidates.push({ 
          coords, 
          distance: Math.round(distance * 10) / 10, // Distance in "galaxy units"
          randomPick: true 
        });
      }

      visitedSystems.add(key);
      
      if (candidates.length > 0) {
        logger.debug(`[Attacker] Random pick ${randomGalaxy}:${randomSystem}: found ${inactives.length} inactive(s)`);
      }
    } catch (err) {
      // Silent fail on random scans — they're meant to be exploratory
    }

    await humanDelay(300, 500); // Brief pause between random picks
  }

  logger.info(`[Attacker] Random mode: scanned ${visitedSystems.size} systems, found ${candidates.length} inactive(s)`);
  return candidates.slice(0, MAX_PROBES_PER_CYCLE);
}

// ── Probe dispatch ────────────────────────────────────────────────────────────

/**
 * Send PROBES_PER_TARGET espionage probes to the given coords.
 * Returns true if dispatch succeeded.
 */
async function dispatchProbe(page, coords) {
  logger.info(`[Attacker] 🔭 Probing ${coords}`);

  await gotoComponent(page, 'fleetdispatch');
  await thinkTime();

  // Espionage Probe = tech id 210
  const probeInput = await page.$('[data-technology="210"] input, #ship_210');
  if (!probeInput) {
    logger.warn('[Attacker] No espionage probes available in hangar');
    return false;
  }

  await probeInput.scrollIntoViewIfNeeded();
  await humanDelay(300, 600);
  await probeInput.click({ clickCount: 3 });
  await probeInput.fill(String(PROBES_PER_TARGET));
  await humanDelay(400, 800);

  // Continue to target selection
  const continueBtn = await page.$('#continue, button.continue, .continue-btn, button[data-step="2"]');
  if (!continueBtn) { logger.warn('[Attacker] Probe: continue button not found'); return false; }
  await continueBtn.scrollIntoViewIfNeeded();
  await humanDelay(400, 900);
  await continueBtn.click();
  await humanDelay(900, 1600);

  // Fill coordinates
  const [galaxy, system, position] = coords.split(':');
  await fillCoord(page, '#galaxy, [name="galaxy"]', galaxy);
  await fillCoord(page, '#system, [name="system"]', system);
  await fillCoord(page, '#position, [name="position"]', position);
  await humanDelay(400, 800);

  // Select mission 6 = Espionage
  const missionBtn = await page.$('[name="mission"][value="6"], #missionButton6, label[for*="mission6"]');
  if (missionBtn) {
    await humanDelay(300, 500);
    await missionBtn.click();
    await humanDelay(400, 700);
  }

  // Second continue
  const continueBtn2 = await page.$('#continue, button.continue, button[data-step="3"]');
  if (continueBtn2) {
    await continueBtn2.click();
    await humanDelay(800, 1400);
  }

  // Send
  const sendBtn = await page.$('#sendFleet, button.sendFleet, .sendFleet, button[data-step="send"]');
  if (!sendBtn) { logger.warn(`[Attacker] Probe to ${coords}: send button not found`); return false; }
  await sendBtn.scrollIntoViewIfNeeded();
  await humanDelay(500, 1000);
  await sendBtn.click();

  logger.info(`[Attacker] ✅ Probe dispatched → ${coords}`);
  return true;
}

/**
 * Probe inactive planets when we have no espionage reports.
 * Returns the number of probes successfully sent.
 */
async function probeNearbyInactives(page, homeCoords) {
  logger.info(`[Attacker] 🗺️  Scanning galaxy for inactive targets at ${homeCoords}…`);
  const candidates = await findInactiveCandidates(page, homeCoords);

  if (!candidates.length) {
    logger.info('[Attacker] No inactive planets found in scan area');
    return 0;
  }

  logger.info(`[Attacker] Found ${candidates.length} inactive planet(s) — dispatching probes`);
  let sent = 0;
  for (const { coords } of candidates) {
    const ok = await dispatchProbe(page, coords);
    if (ok) sent++;
    await humanDelay(800, 1500);
  }
  return sent;
}

/**
 * Calculate how many Light Fighters are needed to carry max loot.
 * LF cargo capacity = 50 units. Each LF costs ~4000 metal-equiv.
 */
function calcFleet(totalLoot) {
  const lfNeeded = Math.ceil(totalLoot / 50) + 2; // +2 safety margin
  return lfNeeded;
}

function fleetCost(lfCount) {
  return {
    metal:   lfCount * LF_COST.metal,
    crystal: lfCount * LF_COST.crystal,
    deut:    lfCount * LF_COST.deut,
  };
}

/**
 * Dispatch a fleet to the given coordinates.
 * Uses the fleet dispatch component with mission type 1 (Attack).
 */
async function dispatchFleet(page, target, lfCount) {
  logger.info(`[Attacker] Dispatching ${lfCount}× LF to ${target.coords}`);

  await gotoComponent(page, 'fleetdispatch');
  await thinkTime();

  // Set number of Light Fighters (technology id 204)
  const lfInput = await page.$('[data-technology="204"] input, #ship_204');
  if (!lfInput) {
    logger.warn('[Attacker] Light Fighter input not found — no fleet available?');
    return false;
  }

  await lfInput.scrollIntoViewIfNeeded();
  await humanDelay(300, 600);
  await lfInput.click({ clickCount: 3 });
  await lfInput.fill(String(lfCount));
  await humanDelay(400, 800);

  // Click Continue / Next
  const continueBtn = await page.$('#continue, button.continue, .continue-btn');
  if (!continueBtn) { logger.warn('[Attacker] Continue button not found'); return false; }
  await continueBtn.scrollIntoViewIfNeeded();
  await humanDelay(400, 900);
  await continueBtn.click();
  await humanDelay(1000, 2000);

  // Fill in target coordinates
  const [galaxy, system, position] = target.coords.split(':');
  await fillCoord(page, '#galaxy, [name="galaxy"]', galaxy);
  await fillCoord(page, '#system, [name="system"]', system);
  await fillCoord(page, '#position, [name="position"]', position);
  await humanDelay(500, 1000);

  // Mission: Attack (1)
  const missionBtn = await page.$('[name="mission"][value="1"], #missionButton1');
  if (missionBtn) {
    await humanDelay(300, 600);
    await missionBtn.click();
  }
  await humanDelay(500, 1000);

  // Second continue
  const continueBtn2 = await page.$('#continue, button.continue');
  if (continueBtn2) {
    await continueBtn2.click();
    await humanDelay(800, 1500);
  }

  // Final send button
  const sendBtn = await page.$('#sendFleet, button.sendFleet, .sendFleet');
  if (!sendBtn) { logger.warn('[Attacker] Send button not found'); return false; }
  await sendBtn.scrollIntoViewIfNeeded();
  await humanDelay(600, 1200);
  await sendBtn.click();

  logger.info(`[Attacker] Fleet dispatched to ${target.coords} ✓`);
  return true;
}

async function fillCoord(page, sel, value) {
  const el = await page.$(sel);
  if (!el) return;
  await el.click({ clickCount: 3 });
  await el.fill(String(value));
  await humanDelay(200, 400);
}

// ── Main entry ────────────────────────────────────────────────────────────────

/** Collect viable raid targets from espionage reports (call ONCE per cycle). */
async function collectTargets(page) {
  try {
    return await withRetry(() => collectEspionageReports(page));
  } catch (err) {
    logger.error(`[Attacker] Failed to collect targets: ${err.message}`);
    return [];
  }
}

/**
 * Dispatch raids from the CURRENT planet toward pre-collected targets.
 *
 * opts.targets      — viable targets from collectTargets() (already read this cycle)
 * opts.homeCoords   — "G:S:P" of the home/current planet (used if probing is needed)
 * opts.preferNearby — hint from player directive (ignored in probe phase)
 */
async function run(page, opts = {}) {
  logger.info('━━ [Attacker] tactic start ━━');

  try {
    // opts can be passed as raw array (legacy) or opts object
    const viableTargets = Array.isArray(opts) ? opts : (opts.targets ?? []);
    const homeCoords    = opts.homeCoords ?? null;

    // ── PHASE 2: Attack from existing reports ─────────────────────────────────
    if (viableTargets.length) {
      viableTargets.sort((a, b) => b.totalLoot - a.totalLoot);
      const resources = await readResources(page);

      for (const target of viableTargets) {
        const lfCount = calcFleet(target.totalLoot);
        const cost    = fleetCost(lfCount);
        const fleetCostEquiv = cost.metal + cost.crystal * 1.5;
        const profitRatio    = target.totalLoot / (fleetCostEquiv || 1);

        if (profitRatio < MIN_PROFIT_RATIO) {
          logger.info(`[Attacker] ${target.coords} — ratio ${profitRatio.toFixed(2)} < ${MIN_PROFIT_RATIO}, skipping`);
          continue;
        }
        if (resources.metal < cost.metal || resources.crystal < cost.crystal) {
          logger.info(`[Attacker] ${target.coords} — can't cover fleet cost, skipping`);
          continue;
        }

        logger.info(`[Attacker] 🎯 Target ${target.coords}: loot≈${Math.round(target.totalLoot)} def=${target.defensePoints}`);
        await dispatchFleet(page, target, lfCount);
        await humanDelay(800, 1500);
      }
      logger.info('━━ [Attacker] tactic end ━━');
      return;
    }

    // ── PHASE 1: No reports — scan galaxy and probe inactive planets ──────────
    if (!homeCoords) {
      logger.info('[Attacker] No reports and no home coords — cannot probe, skipping');
      logger.info('━━ [Attacker] tactic end ━━');
      return;
    }

    logger.info('[Attacker] No espionage reports found — initiating probe phase');
    const probesSent = await probeNearbyInactives(page, homeCoords);

    if (probesSent > 0) {
      logger.info(`[Attacker] 📡 ${probesSent} probe(s) dispatched — reports will be ready next cycle`);
    } else {
      logger.info('[Attacker] No suitable inactive targets found nearby — will retry next cycle');
    }
  } catch (err) {
    logger.error(`[Attacker] Error: ${err.message}`);
  }

  logger.info('━━ [Attacker] tactic end ━━');
}

// ── Public API ────────────────────────────────────────────────────────────────

module.exports = { 
  run,              // Main entry point for attacker tactic
  collectTargets,   // Collect targets from espionage messages
  findInactiveCandidates  // Get inactive planet candidates (standard or random mode)
};
