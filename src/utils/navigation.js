const logger = require('./logger');
const { thinkTime, humanDelay, delay } = require('./delay');

const BASE_URL = process.env.OGAME_SERVER || 'https://s261-pl.ogame.gameforge.com';

// ── Session health ─────────────────────────────────────────────────────────────

/**
 * Known non-game URLs that indicate the session has ended or been blocked.
 * Throws a typed SessionError so callers can react appropriately.
 */
class SessionError extends Error {
  constructor(reason, url) {
    super(`Session lost: ${reason} (url: ${url})`);
    this.name = 'SessionError';
    this.reason = reason; // 'logged_out' | 'banned' | 'captcha' | 'maintenance'
  }
}

/**
 * Inspect the current page URL and DOM to detect session loss.
 * Call this after every navigation.
 *
 * Throws SessionError if the session is no longer valid.
 */
async function assertSessionAlive(page) {
  const url = page.url();

  // If we've been bounced to the Gameforge lobby / login pages
  if (url.includes('gameforge.com/') && !url.includes(BASE_URL.replace('https://', ''))) {
    throw new SessionError('logged_out', url);
  }
  if (url.includes('lobby') || url.includes('/login') || url.includes('register')) {
    throw new SessionError('logged_out', url);
  }

  // Detect ban / suspicious activity page
  const isBanned = await page.evaluate(() => {
    const body = document.body?.innerText?.toLowerCase() || '';
    return (
      body.includes('ban') && (body.includes('account') || body.includes('suspended')) ||
      body.includes('your account has been') ||
      body.includes('suspicious activity') ||
      body.includes('access denied') ||
      !!document.querySelector('.ban-info, #banInfo, .suspended')
    );
  }).catch(() => false);
  if (isBanned) throw new SessionError('banned', url);

  // Detect maintenance
  const isMaintenance = await page.evaluate(() => {
    const body = document.body?.innerText?.toLowerCase() || '';
    return body.includes('maintenance') || body.includes('serwer') && body.includes('przerwa');
  }).catch(() => false);
  if (isMaintenance) throw new SessionError('maintenance', url);

  // Confirm the in-game UI is actually visible
  const hasGameUI = await page.evaluate(() =>
    !!(document.querySelector(
      // Regular ingame pages
      '#resources_metal, #metal_box, #resourcesbar, #planetList, ' +
      '#topBar, #bar, .content-box-c, #inhalt, [id*="resources"], ' +
      // Standalone pages (e.g. Empire view) have their own container
      '.empire-overview, #empire, .empiretable, [class*="empire"], ' +
      '.standalone, #standalone'
    ))
  ).catch(() => false);

  if (!hasGameUI) {
    // Allow lobby/accounts pages as transient states (during login)
    if (!url.includes('index.php')) return; // not yet in-game, skip check
    throw new SessionError('logged_out', url);
  }
}

/**
 * Navigate to any URL or path, wait for network idle, then apply think time.
 * Throws SessionError if the session has been lost.
 */
async function goto(page, url, options = {}) {
  const fullUrl = url.startsWith('http') ? url : `${BASE_URL}${url}`;
  logger.debug(`→ ${fullUrl}`);
  await page.goto(fullUrl, { waitUntil: 'networkidle', timeout: 30_000, ...options });
  await assertSessionAlive(page);
  await thinkTime();
}

/**
 * Navigate to an in-game component (supplies, facilities, research, …).
 * Preserves the current planet/moon (cp= param) so switching components
 * does not jump back to the home planet.
 * Throws SessionError if the session has been lost.
 */
async function gotoComponent(page, component) {
  const currentUrl = page.url();
  const cpMatch    = currentUrl.match(/[?&]cp=(\d+)/);
  const cpParam    = cpMatch ? `&cp=${cpMatch[1]}` : '';
  await goto(page, `/game/index.php?page=ingame&component=${component}${cpParam}`);
}

/**
 * Wait for a selector to appear in the DOM.
 */
async function waitFor(page, selector, timeout = 15_000) {
  return page.waitForSelector(selector, { timeout });
}

/**
 * Read a numeric resource value from the resource bar.
 * OGame uses period/dot as thousands separator and stores the real value
 * in the `data-raw` attribute when present.
 */
async function readResourceValue(page, selector) {
  try {
    const el = await page.$(selector);
    if (!el) return 0;
    const raw = await el.getAttribute('data-raw');
    if (raw !== null) return parseInt(raw, 10);
    const text = await el.innerText();
    return parseInt(text.replace(/[^0-9]/g, ''), 10) || 0;
  } catch {
    return 0;
  }
}

/**
 * Read all three resource stocks from the resource bar.
 * Tries multiple selector strategies for different OGame versions.
 * Returns { metal, crystal, deuterium }.
 */
async function readResources(page) {
  try {
    return await page.evaluate(() => {
      const parse = (el) => {
        if (!el) return 0;
        const raw = el.dataset?.raw ?? el.getAttribute('data-raw');
        if (raw) return parseInt(raw, 10) || 0;
        // strip thousands separators (period or space) then parse
        return parseInt((el.innerText || el.textContent || '0').replace(/[^0-9]/g, ''), 10) || 0;
      };

      // Strategy 1: standard data-raw on resource li
      const m1 = document.querySelector('#resources_metal');
      const c1 = document.querySelector('#resources_crystal');
      const d1 = document.querySelector('#resources_deuterium');
      if (m1) return { metal: parse(m1), crystal: parse(c1), deuterium: parse(d1) };

      // Strategy 2: metal_box / crystal_box / deuterium_box spans
      const m2 = document.querySelector('#metal_box .value, #metal_box span');
      const c2 = document.querySelector('#crystal_box .value, #crystal_box span');
      const d2 = document.querySelector('#deuterium_box .value, #deuterium_box span');
      if (m2) return { metal: parse(m2), crystal: parse(c2), deuterium: parse(d2) };

      // Strategy 3: resource icons with title attr
      const spans = [...document.querySelectorAll('[id*="metal"],[id*="crystal"],[id*="deuterium"]')];
      const find  = key => spans.find(s => s.id?.toLowerCase().includes(key));
      return {
        metal:     parse(find('metal')),
        crystal:   parse(find('crystal')),
        deuterium: parse(find('deuterium')),
      };
    });
  } catch {
    return { metal: 0, crystal: 0, deuterium: 0 };
  }
}

/**
 * Check whether a building/unit queue slot is currently occupied.
 */
async function isBuildQueueFull(page) {
  try {
    // OGame shows active builds in #buildingList .building-item.active
    const active = await page.$$('.buildingList .active, #buildingList .building-item.active');
    return active.length > 0;
  } catch {
    return false;
  }
}

/**
 * Retry a function up to `attempts` times with a delay between retries.
 */
async function withRetry(fn, attempts = 3, delayMs = 3000) {
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      if (i === attempts - 1) throw err;
      logger.warn(`Retrying (${i + 1}/${attempts}) after error: ${err.message}`);
      await delay(delayMs);
    }
  }
}

/**
 * Discover all planets (and moons) from the planet sidebar.
 * Returns an array of { id, name, coords, isMoon } objects.
 */
async function getPlanets(page) {
  try {
    const planets = await page.evaluate(() => {
      // Broad selector: any element with a cp= link in the sidebar
      const allLinks = [...document.querySelectorAll('a[href*="cp="]')];

      // Deduplicate by cp id
      const seen = new Set();
      const results = [];

      for (const link of allLinks) {
        const href = link.getAttribute('href') || '';
        const m = href.match(/[?&]cp=(\d+)/);
        if (!m) continue;
        const id = parseInt(m[1], 10);
        if (seen.has(id)) continue;
        seen.add(id);

        // Walk up to find the container with coords/name
        const container = link.closest('.smallplanet, .planet-item, li, [id^="planet-"]') || link.parentElement;
        const nameEl    = container?.querySelector('.planet-name, .planetname, .name, [class*="name"]');
        const coordEl   = container?.querySelector('.planet-koords, .coords, [class*="coord"]');
        const isMoon    = link.classList.contains('moonlink') ||
                          href.includes('&type=1') ||
                          (link.querySelector('img')?.src || '').includes('moon');

        results.push({
          id,
          name:   nameEl?.innerText?.trim() || (isMoon ? 'Moon' : 'Planet'),
          coords: coordEl?.innerText?.trim() || '',
          isMoon,
          href,
        });
      }
      return results;
    });

    require('./logger').info(`[Nav] Planet discovery: found ${planets.length} entries — ${planets.map(p=>`${p.name}${p.coords?` ${p.coords}`:''}`).join(', ')}`);
    return planets;
  } catch (err) {
    require('./logger').warn(`[Nav] Could not read planet list: ${err.message}`);
    return [];
  }
}

/**
 * Switch to a planet/moon by clicking its sidebar link (cp= param).
 * Keeps the current page component (supplies/facilities/etc.) if possible.
 */
async function switchPlanet(page, planet) {
  require('./logger').info(`[Nav] Switching to: ${planet.name} ${planet.coords}`);
  // Build URL preserving the current component
  const currentUrl = page.url();
  const compMatch  = currentUrl.match(/component=([^&]+)/);
  const component  = compMatch ? compMatch[1] : 'supplies';
  const url = `${BASE_URL}/game/index.php?page=ingame&component=${component}&cp=${planet.id}`;
  await page.goto(url, { waitUntil: 'networkidle', timeout: 30_000 });
  await thinkTime();
}

module.exports = {
  goto,
  gotoComponent,
  assertSessionAlive,
  SessionError,
  waitFor,
  readResources,
  isBuildQueueFull,
  withRetry,
  getPlanets,
  switchPlanet,
  BASE_URL,
};
