/**
 * Defense tactic — builds and maintains planetary defence structures.
 *
 * Human-like behaviour:
 *  - Picks ONE unit type per visit (not everything at once)
 *  - Quantities are "round-ish" human numbers, not always the maximum
 *  - Sometimes skips a cycle if resources aren't compelling
 *  - Occasionally builds cheaper/easier units instead of always the most expensive
 *  - Shield domes are still prioritised as one-time critical builds
 */

const logger = require('../utils/logger');
const { humanDelay, thinkTime, randomBetween } = require('../utils/delay');
const { gotoComponent, readResources, withRetry } = require('../utils/navigation');

// OGame technology IDs for defence units
const DEFENSE_UNITS = [
  { id: 401, name: 'Rocket Launcher',   metal: 2000,  crystal: 0,     deut: 0 },
  { id: 402, name: 'Light Laser',       metal: 1500,  crystal: 500,   deut: 0 },
  { id: 403, name: 'Heavy Laser',       metal: 6000,  crystal: 2000,  deut: 0 },
  { id: 404, name: 'Gauss Cannon',      metal: 20000, crystal: 15000, deut: 2000 },
  { id: 405, name: 'Ion Cannon',        metal: 2000,  crystal: 6000,  deut: 0 },
  { id: 406, name: 'Plasma Turret',     metal: 50000, crystal: 50000, deut: 30000 },
  { id: 407, name: 'Small Shield Dome', metal: 10000, crystal: 10000, deut: 0 },
  { id: 408, name: 'Large Shield Dome', metal: 50000, crystal: 50000, deut: 0 },
];

const DOME_IDS = new Set([407, 408]);

// ── Helpers ───────────────────────────────────────────────────────────────────

async function isDefenseQueueBusy(page) {
  const el = await page.$('.defenseList .on, .buildingList .active, .countdown');
  return !!el;
}

async function unitExists(page, unitId) {
  const block = await page.$(`[data-technology="${unitId}"]`);
  if (!block) return false;
  const amountEl = await block.$('.amount, .level');
  if (!amountEl) return false;
  const text = await amountEl.innerText();
  return parseInt(text.replace(/[^0-9]/g, ''), 10) > 0;
}

async function getUnitControls(page, unitId) {
  const block = await page.$(`[data-technology="${unitId}"]`);
  if (!block) return null;
  const buildBtn = await block.$(
    'button.upgrade:not([disabled]), a.build_link:not(.disabled), .research:not(.disabled)'
  );
  if (!buildBtn) return null;
  const inputEl = await block.$('input.build_amount, input[type="number"]');
  return { inputEl, buildBtn };
}

/** Maximum units affordable given current resources. */
function maxAffordable(resources, unit) {
  const byMetal   = unit.metal   > 0 ? Math.floor(resources.metal     / unit.metal)   : Infinity;
  const byCrystal = unit.crystal > 0 ? Math.floor(resources.crystal   / unit.crystal) : Infinity;
  const byDeut    = unit.deut    > 0 ? Math.floor(resources.deuterium / unit.deut)    : Infinity;
  return Math.min(byMetal, byCrystal, byDeut);
}

/**
 * Convert a raw "maximum affordable" count into a human-like order quantity.
 * Humans don't order exactly as much as they can — they pick round-ish numbers,
 * leave a buffer, and sometimes order less than they could.
 */
function humaniseCount(max) {
  if (max <= 0) return 0;
  if (max === 1) return 1;

  // Use 40–80% of what we could afford, then round to a "human" number
  const fraction = 0.40 + Math.random() * 0.40;
  const raw = Math.max(1, Math.round(max * fraction));

  // Round to nearest "human" increment based on magnitude
  if (raw >= 100) return Math.round(raw / 25) * 25;
  if (raw >= 50)  return Math.round(raw / 10) * 10;
  if (raw >= 20)  return Math.round(raw / 5)  * 5;
  if (raw >= 10)  return Math.round(raw / 2)  * 2;
  return raw;
}

/**
 * Pick which unit to build this visit.
 * Weighted random: prioritises mid-to-high tier but occasionally does cheap filler.
 * Returns the chosen unit or null.
 */
function pickUnit(affordable) {
  // affordable = [{ unit, max }] sorted by unit cost descending
  if (!affordable.length) return null;

  // 70% chance: pick from the top half (better units)
  // 30% chance: pick any unit at random
  const pool = Math.random() < 0.70
    ? affordable.slice(0, Math.max(1, Math.ceil(affordable.length / 2)))
    : affordable;

  return pool[Math.floor(Math.random() * pool.length)];
}

// ── Main runner ───────────────────────────────────────────────────────────────

async function run(page) {
  logger.info('━━ [Defense] tactic start ━━');

  try {
    await gotoComponent(page, 'defenses');
    await thinkTime();

    if (await isDefenseQueueBusy(page)) {
      logger.info('[Defense] Defence queue busy, skipping');
      logger.info('━━ [Defense] tactic end ━━');
      return;
    }

    const resources = await readResources(page);
    logger.info(`[Defense] Resources — M:${resources.metal} C:${resources.crystal} D:${resources.deuterium}`);

    // ── Shield domes: one-time critical builds — always do these first ─────
    for (const unit of DEFENSE_UNITS.filter(u => DOME_IDS.has(u.id))) {
      const canAfford =
        resources.metal     >= unit.metal   &&
        resources.crystal   >= unit.crystal &&
        resources.deuterium >= unit.deut;
      if (!canAfford) continue;

      if (await unitExists(page, unit.id)) {
        logger.info(`[Defense] ${unit.name} already built`);
        continue;
      }

      logger.info(`[Defense] Building ${unit.name}`);
      const controls = await getUnitControls(page, unit.id);
      if (!controls) continue;

      await controls.buildBtn.scrollIntoViewIfNeeded();
      await humanDelay(400, 900);
      await controls.buildBtn.click();
      await humanDelay(500, 1000);
      const confirmBtn = await page.$('.overlay button.yes, #confirmOkay');
      if (confirmBtn) await confirmBtn.click();

      logger.info(`[Defense] ${unit.name} queued ✓`);
      logger.info('━━ [Defense] tactic end ━━');
      return;
    }

    // ── Regular units: pick ONE type this visit ───────────────────────────
    // Build the list of what we can actually afford (at least 1)
    const affordable = DEFENSE_UNITS
      .filter(u => !DOME_IDS.has(u.id))
      .map(u => ({ unit: u, max: maxAffordable(resources, u) }))
      .filter(e => e.max >= 1)
      .sort((a, b) => (b.unit.metal + b.unit.crystal) - (a.unit.metal + a.unit.crystal)); // expensive first

    if (!affordable.length) {
      logger.info('[Defense] Cannot afford any defence unit right now');
      logger.info('━━ [Defense] tactic end ━━');
      return;
    }

    // Occasionally skip if resources aren't very compelling (acts like "meh, later")
    const totalResources = resources.metal + resources.crystal;
    if (totalResources < 50_000 && Math.random() < 0.35) {
      logger.info('[Defense] Resources low — skipping defence this cycle');
      logger.info('━━ [Defense] tactic end ━━');
      return;
    }

    const chosen = pickUnit(affordable);
    const count  = humaniseCount(chosen.max);

    if (count < 1) {
      logger.info('━━ [Defense] tactic end ━━');
      return;
    }

    logger.info(`[Defense] Building ${count}× ${chosen.unit.name}`);
    const controls = await getUnitControls(page, chosen.unit.id);
    if (!controls) {
      logger.info('━━ [Defense] tactic end ━━');
      return;
    }

    const { inputEl, buildBtn } = controls;
    if (inputEl) {
      await inputEl.scrollIntoViewIfNeeded();
      await humanDelay(300, 600);
      await inputEl.click({ clickCount: 3 });
      await inputEl.fill(String(count));
      await humanDelay(300, 600);
    }

    await buildBtn.scrollIntoViewIfNeeded();
    await humanDelay(300, 700);
    await buildBtn.click();
    await humanDelay(500, 1000);
    const confirmBtn = await page.$('.overlay button.yes, #confirmOkay');
    if (confirmBtn) await confirmBtn.click();

    logger.info(`[Defense] Queued ${count}× ${chosen.unit.name} ✓`);
  } catch (err) {
    logger.error(`[Defense] Error: ${err.message}`);
  }

  logger.info('━━ [Defense] tactic end ━━');
}

module.exports = { run };

