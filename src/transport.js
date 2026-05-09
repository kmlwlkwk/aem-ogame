/**
 * Resource transport — moves resources between planets using cargo ships.
 *
 * Uses fleet dispatch (mission 3 = Transport).
 * Large Cargo (id=203) capacity: 25,000 units each.
 * Small Cargo (id=202) capacity: 5,000 units each.
 */

const logger = require('./utils/logger');
const { gotoComponent, BASE_URL } = require('./utils/navigation');
const { humanDelay, thinkTime } = require('./utils/delay');

const LARGE_CARGO_ID = 203;
const SMALL_CARGO_ID = 202;
const LARGE_CARGO_CAP = 25_000;
const SMALL_CARGO_CAP =  5_000;
const MISSION_TRANSPORT = 3;

/**
 * Execute a single transport instruction.
 * @param {object} page - Playwright page (currently on source planet)
 * @param {object} transport - { from, to, metal, crystal, deuterium, reason }
 * @param {object} fleet     - current fleet on this planet { shipId: count }
 */
async function executeTransport(page, transport, fleet = {}) {
  const total = transport.metal + transport.crystal + transport.deuterium;
  if (total <= 0) return false;

  // Calculate ships needed
  const largeCargo = fleet[LARGE_CARGO_ID] || 0;
  const smallCargo = fleet[SMALL_CARGO_ID] || 0;
  const capacity   = largeCargo * LARGE_CARGO_CAP + smallCargo * SMALL_CARGO_CAP;

  if (capacity < total) {
    logger.warn(`[Transport] Not enough cargo capacity (${capacity}) for ${total} resources on ${transport.from} — skipping`);
    return false;
  }

  // How many large cargoes needed (prefer large over small)
  const lcNeeded = Math.min(largeCargo, Math.ceil(total / LARGE_CARGO_CAP));
  const remaining = total - lcNeeded * LARGE_CARGO_CAP;
  const scNeeded  = remaining > 0 ? Math.min(smallCargo, Math.ceil(remaining / SMALL_CARGO_CAP)) : 0;

  logger.info(`[Transport] ${transport.from} → ${transport.to}: M=${transport.metal} C=${transport.crystal} D=${transport.deuterium} (${lcNeeded}LC + ${scNeeded}SC)`);

  try {
    await gotoComponent(page, 'fleetdispatch');
    await thinkTime();

    // Set large cargo count
    if (lcNeeded > 0) await setShipCount(page, LARGE_CARGO_ID, lcNeeded);
    if (scNeeded > 0) await setShipCount(page, SMALL_CARGO_ID, scNeeded);

    // Click Continue
    const contBtn = await page.$('button#continueToFleet2, .continue-btn, button.continue, #continue');
    if (!contBtn) { logger.warn('[Transport] Continue button not found'); return false; }
    await humanDelay(300, 600);
    await contBtn.click();
    await page.waitForLoadState('networkidle', { timeout: 15_000 });

    // Fill target coordinates
    const [galaxy, system, position] = transport.to.split(':');
    await fillField(page, '#galaxy,  [name="galaxy"]',   galaxy);
    await fillField(page, '#system,  [name="system"]',   system);
    await fillField(page, '#position,[name="position"]', position);
    await humanDelay(400, 700);

    // Select Transport mission
    const missionBtn = await page.$(`[name="mission"][value="${MISSION_TRANSPORT}"], #missionButton${MISSION_TRANSPORT}`);
    if (missionBtn) {
      await humanDelay(200, 400);
      await missionBtn.click();
    }
    await humanDelay(400, 700);

    // Click Continue to resource selection
    const cont2 = await page.$('button#continueToFleet3, .continue-btn, button.continue, #continue');
    if (!cont2) { logger.warn('[Transport] Second continue button not found'); return false; }
    await cont2.click();
    await page.waitForLoadState('networkidle', { timeout: 15_000 });

    // Fill resources
    if (transport.metal)     await fillField(page, '#metal,     [name="metal"]',     transport.metal);
    if (transport.crystal)   await fillField(page, '#crystal,   [name="crystal"]',   transport.crystal);
    if (transport.deuterium) await fillField(page, '#deuterium, [name="deuterium"]', transport.deuterium);
    await humanDelay(400, 700);

    // Send
    const sendBtn = await page.$('#sendFleet, button.send-flight, .sendFleet');
    if (!sendBtn) { logger.warn('[Transport] Send button not found'); return false; }
    await humanDelay(600, 1000);
    await sendBtn.click();
    await page.waitForLoadState('networkidle', { timeout: 15_000 });

    logger.info(`[Transport] ✓ Sent ${total} resources from ${transport.from} → ${transport.to}`);
    return true;
  } catch (err) {
    logger.error(`[Transport] Error: ${err.message}`);
    return false;
  }
}

async function setShipCount(page, shipId, count) {
  const input = await page.$(`[data-technology="${shipId}"] input, #ship_${shipId}`);
  if (!input) return;
  await input.click({ clickCount: 3 });
  await input.fill(String(count));
  await humanDelay(100, 200);
}

async function fillField(page, selector, value) {
  const el = await page.$(selector);
  if (!el) return;
  await el.click({ clickCount: 3 });
  await el.fill(String(value));
  await humanDelay(150, 300);
}

/**
 * Execute all transports from a given source planet.
 */
async function executeTransportsFromPlanet(page, transports, planetCoords, fleet) {
  const mine = transports.filter(t => t.from === planetCoords);
  if (!mine.length) return;
  logger.info(`[Transport] ${mine.length} transport(s) queued from ${planetCoords}`);
  for (const t of mine) {
    await executeTransport(page, t, fleet);
    await humanDelay(500, 1000);
  }
}

module.exports = { executeTransport, executeTransportsFromPlanet };
