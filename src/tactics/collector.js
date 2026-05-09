/**
 * Collector tactic — upgrades resource mines based on return-on-investment.
 *
 * Logic:
 *  1. Read current resource stocks.
 *  2. Parse each mine's current level and upgrade cost from the Supplies page.
 *  3. Calculate a simple ROI score: production_gain / upgrade_cost_in_metal_equiv.
 *  4. If we can afford the best-ROI mine and no build is in progress, upgrade it.
 */

const logger = require('../utils/logger');
const { humanDelay, thinkTime } = require('../utils/delay');
const { gotoComponent, readResources, withRetry } = require('../utils/navigation');

// Metal-equivalent exchange rates for cost normalisation
const EXCHANGE = { metal: 1, crystal: 1.5, deuterium: 3 };

// Production per hour per level (approximate base values used for ROI scoring)
const PRODUCTION_BASE = {
  1: 30,   // Metal Mine   — metal/h per level
  2: 20,   // Crystal Mine — crystal/h per level
  3: 10,   // Deuterium Synthesizer — deut/h per level
};

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Normalise a cost object to a metal-equivalent value. */
function toMetalEquiv({ metal = 0, crystal = 0, deut = 0 }) {
  return metal * EXCHANGE.metal + crystal * EXCHANGE.crystal + deut * EXCHANGE.deuterium;
}

/**
 * Parse mine data from the Supplies page.
 * Returns an array of { id, name, level, cost, btn } objects.
 */
async function parseMines(page) {
  const MINE_IDS = [
    { id: 1, name: 'Metal Mine' },
    { id: 2, name: 'Crystal Mine' },
    { id: 3, name: 'Deuterium Synthesizer' },
  ];

  const mines = [];
  for (const mine of MINE_IDS) {
    const block = await page.$(`[data-technology="${mine.id}"]`);
    if (!block) continue;

    // Current level
    const levelEl = await block.$('.level, .amount');
    const level = levelEl
      ? parseInt((await levelEl.innerText()).replace(/[^0-9]/g, ''), 10)
      : 0;

    // Upgrade button (disabled when can't afford or queue full)
    const btn = await block.$(
      'button.upgrade:not([disabled]), a.upgradeLinkTechnology:not(.disabled)'
    );

    // Upgrade cost — OGame stores it in data attributes on the button or nearby spans
    const costMetal    = await block.$eval('[data-metal]',    el => parseInt(el.dataset.metal,    10)).catch(() => 0);
    const costCrystal  = await block.$eval('[data-crystal]',  el => parseInt(el.dataset.crystal,  10)).catch(() => 0);
    const costDeuterium= await block.$eval('[data-deuterium]',el => parseInt(el.dataset.deuterium,10)).catch(() => 0);

    mines.push({
      id: mine.id,
      name: mine.name,
      level,
      cost: { metal: costMetal, crystal: costCrystal, deut: costDeuterium },
      btn,
    });
  }
  return mines;
}

/** Check whether the Supplies build queue is occupied. */
async function isQueueBusy(page) {
  const el = await page.$('.buildingList .active, .on.cancel, .countdown');
  return !!el;
}

/**
 * Select the mine with the best ROI we can currently afford.
 * ROI score = production_gain_per_hour / metal_equivalent_cost
 */
function bestMine(mines, resources) {
  let best = null;
  let bestScore = -Infinity;

  for (const mine of mines) {
    if (!mine.btn) continue; // can't afford or queue full

    const costEquiv = toMetalEquiv(mine.cost);
    if (costEquiv === 0) continue;

    const canAfford =
      resources.metal     >= mine.cost.metal   &&
      resources.crystal   >= mine.cost.crystal &&
      resources.deuterium >= mine.cost.deut;

    if (!canAfford) continue;

    const prodBase = PRODUCTION_BASE[mine.id] ?? 10;
    const roi = (prodBase * (mine.level + 1)) / costEquiv;

    if (roi > bestScore) {
      bestScore = roi;
      best = mine;
    }
  }
  return best;
}

// ── Main entry ────────────────────────────────────────────────────────────────

async function run(page) {
  logger.info('━━ [Collector] tactic start ━━');

  try {
    await gotoComponent(page, 'supplies');
    await thinkTime();

    if (await isQueueBusy(page)) {
      logger.info('[Collector] Build queue busy, skipping mine upgrade');
      return;
    }

    const resources = await readResources(page);
    logger.info(`[Collector] Resources — M:${resources.metal} C:${resources.crystal} D:${resources.deuterium}`);

    const mines  = await parseMines(page);
    const target = bestMine(mines, resources);

    if (!target) {
      logger.info('[Collector] Cannot afford any mine upgrade right now');
      return;
    }

    logger.info(`[Collector] Best ROI upgrade: ${target.name} (lvl ${target.level} → ${target.level + 1})`);
    await target.btn.scrollIntoViewIfNeeded();
    await humanDelay(400, 900);
    await target.btn.click();

    await humanDelay(600, 1200);
    const confirmBtn = await page.$('.overlay button.yes, #confirmOkay');
    if (confirmBtn) await confirmBtn.click();

    logger.info(`[Collector] ${target.name} upgrade queued ✓`);
  } catch (err) {
    logger.error(`[Collector] Error: ${err.message}`);
  }

  logger.info('━━ [Collector] tactic end ━━');
}

module.exports = { run };
