/**
 * Attacker tactic — raids INACTIVE players only, espionage-gated.
 *
 * Safety rules (hard constraints):
 *  1. NEVER attack active players (only targets with [I] or [IM] status badge).
 *  2. MUST have a fresh espionage report before dispatching any fleet.
 *  3. Skip target if defence points exceed DEFENSE_SAFE_THRESHOLD.
 *  4. Skip target if report is missing or older than REPORT_MAX_AGE_H hours.
 *  5. Only attack if expected loot > fleet replacement cost.
 *
 * Flow:
 *  1. Open Messages → Espionage Reports, collect viable targets.
 *  2. For each viable target, dispatch a small raid fleet.
 *  3. Log all decisions.
 */

const logger = require('../utils/logger');
const { humanDelay, thinkTime, delay } = require('../utils/delay');
const { gotoComponent, readResources, withRetry, BASE_URL } = require('../utils/navigation');
const { humanClickSelector, humanClick } = require('../utils/human');
const { findElementWithAI, analyzeTarget } = require('../ai/analyst');

const DEFENSE_SAFE_THRESHOLD = parseInt(process.env.DEFENSE_SAFE_THRESHOLD ?? '5000', 10);
const ESPIONAGE_MIN_LEVEL    = parseInt(process.env.ESPIONAGE_MIN_LEVEL    ?? '5',    10);
const REPORT_MAX_AGE_H       = 6;   // ignore reports older than 6 hours

// Minimum loot-to-fleet-cost ratio before attacking
const MIN_PROFIT_RATIO = 1.5;

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
  // Hard rules first (no AI needed)
  if (target.defensePoints > DEFENSE_SAFE_THRESHOLD) return false;
  if (target.reportAge > REPORT_MAX_AGE_H) return false;
  if (target.totalLoot < LF_COST.metal * MIN_PROFIT_RATIO) return false;

  // AI second opinion
  const aiDecision = await analyzeTarget(target);
  return aiDecision.attack;
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

// ── Fleet dispatch ────────────────────────────────────────────────────────────

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
 * Pass targets collected by collectTargets() so messages aren't re-read per planet.
 */
async function run(page, targets = null) {
  logger.info('━━ [Attacker] tactic start ━━');

  try {
    const viableTargets = targets ?? await collectTargets(page);

    if (!viableTargets.length) {
      logger.info('[Attacker] No viable targets from espionage reports');
      return;
    }

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

      logger.info(`[Attacker] Target ${target.coords}: loot≈${Math.round(target.totalLoot)} def=${target.defensePoints}`);
      await dispatchFleet(page, target, lfCount);
      await humanDelay(800, 1500);
    }
  } catch (err) {
    logger.error(`[Attacker] Error: ${err.message}`);
  }

  logger.info('━━ [Attacker] tactic end ━━');
}

module.exports = { run, collectTargets };
