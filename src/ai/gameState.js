/**
 * Game state extractor.
 *
 * Scrapes the current OGame page to build a structured JSON snapshot
 * of everything relevant to strategic decision-making.
 * This is sent to the AI alongside a screenshot.
 */

const { gotoComponent, readResources } = require('../utils/navigation');
const logger = require('../utils/logger');

// ── Helpers ───────────────────────────────────────────────────────────────────

async function safeInt(page, selector, attr = null) {
  try {
    const el = await page.$(selector);
    if (!el) return 0;
    const raw = attr ? await el.getAttribute(attr) : await el.innerText();
    return parseInt(String(raw).replace(/[^0-9]/g, ''), 10) || 0;
  } catch {
    return 0;
  }
}

async function safeText(page, selector) {
  try {
    const el = await page.$(selector);
    return el ? (await el.innerText()).trim() : '';
  } catch {
    return '';
  }
}

// ── Sub-extractors ────────────────────────────────────────────────────────────

async function extractResources(page) {
  return readResources(page);
}

async function extractScore(page) {
  return {
    total:    await safeInt(page, '#stat_list_content .score, .highscore-total'),
    economy:  await safeInt(page, '.score-economy'),
    research: await safeInt(page, '.score-research'),
    military: await safeInt(page, '.score-military'),
  };
}

/**
 * Extract level of each building/tech by its OGame technology ID.
 * Returns { [id]: level }.
 */
async function extractLevels(page, ids) {
  const result = {};
  for (const id of ids) {
    const el = await page.$(`[data-technology="${id}"] .level, [data-technology="${id}"] .amount`);
    result[id] = el ? parseInt((await el.innerText()).replace(/[^0-9]/g, ''), 10) || 0 : null;
  }
  return result;
}

async function extractSupplies(page) {
  await gotoComponent(page, 'supplies');
  return extractLevels(page, [1, 2, 3, 4, 12, 13, 14]); // mines + solar + storages
}

async function extractFacilities(page) {
  await gotoComponent(page, 'facilities');
  return extractLevels(page, [14, 15, 21, 22]);
}

async function extractResearch(page) {
  await gotoComponent(page, 'research');
  return extractLevels(page, [106, 108, 109, 110, 111, 113, 114, 115, 116, 117, 118, 120, 121, 122, 123, 199]);
}

async function extractDefenses(page) {
  await gotoComponent(page, 'defenses');
  const ids = [401, 402, 403, 404, 405, 406, 407, 408];
  const levels = await extractLevels(page, ids);
  const totalPoints = Object.values(levels).reduce((s, v) => s + (v || 0), 0);
  return { units: levels, totalPoints };
}

async function extractFleet(page) {
  await gotoComponent(page, 'fleetdispatch');
  const ids = [202, 203, 204, 205, 206, 207, 208, 209, 210, 211, 212, 213, 214, 215, 218, 219];
  const ships = await extractLevels(page, ids);
  const fleetSlots = await safeText(page, '#slots .fleetSlots, .fleet-slots');
  return { ships, fleetSlots };
}

async function extractActiveQueues(page) {
  await gotoComponent(page, 'overview');
  const queues = {};

  const buildCountdown = await safeText(page, '.buildingCountdown, .construction-time');
  const researchCountdown = await safeText(page, '.researchCountdown, .research-time');
  const shipyardCountdown = await safeText(page, '.shipyardCountdown, .shipyard-time');

  queues.building  = buildCountdown    || 'idle';
  queues.research  = researchCountdown || 'idle';
  queues.shipyard  = shipyardCountdown || 'idle';
  return queues;
}

// ── Main export ───────────────────────────────────────────────────────────────

/**
 * Collect the full game state.
 * Pass `fast: true` to skip slow pages (facilities/research/fleet) for mid-cycle checks.
 */
async function collectGameState(page, { fast = false } = {}) {
  logger.info('[GameState] Collecting game state …');

  try {
    const resources    = await extractResources(page);
    const activeQueues = await extractActiveQueues(page);
    const supplies     = await extractSupplies(page);

    let facilities = null;
    let research   = null;
    let defenses   = null;
    let fleet      = null;
    let score      = null;

    if (!fast) {
      facilities = await extractFacilities(page);
      research   = await extractResearch(page);
      defenses   = await extractDefenses(page);
      fleet      = await extractFleet(page);
      score      = await extractScore(page);
    }

    const state = {
      timestamp: new Date().toISOString(),
      resources,
      activeQueues,
      supplies,
      facilities,
      research,
      defenses,
      fleet,
      score,
    };

    logger.info('[GameState] State collected ✓');
    return state;
  } catch (err) {
    logger.error(`[GameState] Error collecting state: ${err.message}`);
    return { timestamp: new Date().toISOString(), error: err.message };
  }
}

module.exports = { collectGameState };
