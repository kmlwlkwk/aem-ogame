/**
 * Planet scanner — collects full snapshots for all planets.
 *
 * PRIMARY method: Empire page (?page=standalone&component=empire)
 *   - One page load instead of 4-5 navigations × N planets
 *   - Scrapes buildings, resources, fleet, defense in a single view
 *   - Human-like: scroll, random pause, occasionally visit a random game page first
 *
 * FALLBACK method: per-planet page-by-page scan (legacy behaviour)
 *   - Used when Empire page parsing yields < 2 planets
 *   - Randomised page order, timing modes, occasional skips
 *
 * Returns an array of PlanetSnapshot objects (same shape either way).
 */

const logger  = require('./utils/logger');
const brief   = require('./utils/briefing');
const { goto, gotoComponent, readResources, switchPlanet, assertSessionAlive } = require('./utils/navigation');
const { thinkTime, scanThink, burstDelay, microDistraction, humanDelay, randomBetween, delay } = require('./utils/delay');
const { humanScroll } = require('./utils/human');

const BASE_URL = process.env.OGAME_SERVER || 'https://s261-pl.ogame.gameforge.com';

// ── Timing helpers ─────────────────────────────────────────────────────────────

function pickTimingMode() {
  const r = Math.random();
  if (r < 0.20) return 'burst';
  if (r < 0.80) return 'normal';
  return 'slow';
}

async function navPause(mode) {
  if (mode === 'burst') return burstDelay();
  if (mode === 'slow')  return thinkTime();
  return scanThink();
}

function shuffled(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

async function maybeScroll(page, probability = 0.35) {
  if (Math.random() < probability) {
    const delta = randomBetween(150, 600) * (Math.random() < 0.5 ? 1 : -1);
    await humanScroll(page, delta).catch(() => {});
    await delay(randomBetween(80, 250));
  }
}

async function maybeDistract(probability = 0.05) {
  if (Math.random() < probability) {
    logger.debug('[Scanner] micro-distraction …');
    await microDistraction();
  }
}

// ── Empire page scraper ────────────────────────────────────────────────────────

/**
 * Scrape the empire table that is currently visible in the #empire container.
 * Called once per tab. Returns { planets[], data{} } or null.
 */
async function _scrapeVisibleEmpireTab(page) {
  return page.evaluate(() => {
    const parseNum = (text) =>
      parseInt(String(text || '0').replace(/[^0-9-]/g, ''), 10) || 0;

    const container = document.querySelector('#empire, #empireComponent');
    if (!container) return null;

    const table = container.querySelector('table');
    if (!table) return null;

    // ── Planet headers (first <tr> in thead or whole table) ──────────────────
    const headerRow = table.querySelector('thead tr, tr:first-child');
    if (!headerRow) return null;

    const headerCells = Array.from(headerRow.querySelectorAll('th, td'));
    // Column 0 is always the label column; planets start at index 1
    const planetHeaders = [];
    for (let i = 1; i < headerCells.length; i++) {
      const cell  = headerCells[i];
      const text  = cell.innerText ?? '';
      const name  = cell.querySelector('[class*="name"], h3, h4, span')?.innerText?.trim()
                    || text.split('\n')[0]?.trim()
                    || `Planet ${i}`;
      const coords = text.match(/\[\d+:\d+:\d+\]/)?.[0]
                     || cell.querySelector('[class*="coord"], [class*="koord"]')?.innerText?.trim()
                     || '';
      const planetId = cell.dataset?.planetId
                       || cell.querySelector('[data-planet-id]')?.dataset?.planetId
                       || String(i);
      const isMoon = name.toLowerCase().includes('moon')
                     || !!cell.querySelector('[class*="moon"]');
      planetHeaders.push({ colIdx: i - 1, name, coords, planetId, isMoon });
    }

    if (planetHeaders.length === 0) return null;

    // ── Technology rows ───────────────────────────────────────────────────────
    const rows = table.querySelectorAll('tbody tr[data-technology], tbody tr');
    const data = {};   // keyed by planet column index

    rows.forEach(row => {
      const techId = row.getAttribute('data-technology') || row.dataset?.technology;
      if (!techId) return;

      const cells = Array.from(row.querySelectorAll('td'));
      planetHeaders.forEach((planet, pi) => {
        const cell = cells[pi + 1];
        if (!cell) return;

        if (!data[pi]) {
          data[pi] = {
            ...planet,
            buildings: {}, fleet: {}, defense: {}, resources: {}, energy: 0,
          };
        }

        const val = parseNum(
          cell.getAttribute('data-value') ?? cell.dataset?.value ?? cell.innerText
        );
        const tid = Number(techId);

        // Resource pseudo-IDs used in empire view
        if (techId === '901')      data[pi].resources.metal      = val;
        else if (techId === '902') data[pi].resources.crystal    = val;
        else if (techId === '903') data[pi].resources.deuterium  = val;
        else if (techId === '904') data[pi].energy               = val;
        // Fleet (200–399), Defense (400–499), everything else = buildings
        else if (tid >= 400 && tid < 500) data[pi].defense[techId]   = val;
        else if (tid >= 200 && tid < 400) data[pi].fleet[techId]     = val;
        else if (val > 0)                 data[pi].buildings[techId] = val;
      });
    });

    return { planets: planetHeaders, data };
  }).catch(() => null);
}

/**
 * Merge one tab's scrape result into the running mergedData map.
 * mergedData is keyed by planet coords (or planetId as fallback).
 */
function _mergeTabData(mergedData, tabResult) {
  if (!tabResult) return;
  const { planets, data } = tabResult;
  planets.forEach((planet, pi) => {
    const key = planet.coords || planet.planetId;
    if (!mergedData[key]) {
      mergedData[key] = {
        ...planet,
        buildings: {}, fleet: {}, defense: {}, resources: {}, energy: 0,
      };
    }
    const src = data[pi];
    if (!src) return;
    Object.assign(mergedData[key].buildings, src.buildings);
    Object.assign(mergedData[key].fleet,     src.fleet);
    Object.assign(mergedData[key].defense,   src.defense);
    Object.assign(mergedData[key].resources, src.resources);
    if (src.energy) mergedData[key].energy = src.energy;
  });
}

/**
 * Navigate to the empire standalone page, click through each tab so AJAX
 * content loads, and collect full planet snapshots.
 *
 * OGame's empire page loads content LAZILY per tab (#empireTab).
 * Without clicking each tab, [data-technology] elements never appear.
 *
 * Returns an array of snapshots, or null to trigger the per-planet fallback.
 */
async function scanViaEmpirePage(page, planets) {
  try {
    logger.info('[Scanner] Loading Empire overview page …');

    // Occasionally visit overview first for variety
    if (Math.random() < 0.25) {
      await goto(page, `${BASE_URL}/game/index.php?page=ingame&component=overview`);
      await humanDelay(800, 2000);
    }

    await goto(page, `${BASE_URL}/game/index.php?page=standalone&component=empire`);
    await humanDelay(1200, 2500);

    let currentUrl = page.url();
    logger.debug(`[Scanner] Empire URL after load: ${currentUrl}`);

    if (!currentUrl.includes('empire')) {
      logger.warn(`[Scanner] Empire page redirected to: ${currentUrl} — trying ingame variant`);
      await goto(page, `${BASE_URL}/game/index.php?page=ingame&component=empire`);
      await humanDelay(1000, 2000);
      currentUrl = page.url();
      if (!currentUrl.includes('empire')) {
        logger.warn(`[Scanner] Ingame empire also redirected — falling back`);
        return null;
      }
    }

    // Wait for the empire component to be present in DOM
    const empireEl = await page.waitForSelector(
      '#empireComponent, #empire, [id*="empire"]',
      { timeout: 12000 }
    ).catch(() => null);

    if (!empireEl) {
      logger.warn('[Scanner] Empire component never appeared in DOM — falling back');
      return null;
    }

    await humanDelay(400, 800);

    // ── Discover tabs ─────────────────────────────────────────────────────────
    // #empireTab contains links/buttons that trigger AJAX content loading per
    // category (Buildings, Research, Fleet, Defense, Resources).
    // Each tab either navigates to a URL with a category param, or fires JS.
    const tabInfo = await page.evaluate(() => {
      const container = document.querySelector('#empireTab');
      if (!container) return [];
      return Array.from(container.querySelectorAll('a, button')).map((el, i) => ({
        index:    i,
        text:     el.innerText.trim(),
        href:     el.getAttribute('href') || '',
        tagName:  el.tagName.toLowerCase(),
        selector: el.id ? `#${el.id}` : `#empireTab a:nth-of-type(${i + 1})`,
      }));
    });

    logger.debug(`[Scanner] Tabs found: ${tabInfo.map(t => `"${t.text}"(${t.href || 'js'})`).join(', ')}`);

    const mergedData = {};

    if (tabInfo.length === 0) {
      // No tabs — maybe content is already rendered (some OGame versions)
      logger.debug('[Scanner] No tabs found — attempting direct scrape');
      _mergeTabData(mergedData, await _scrapeVisibleEmpireTab(page));
    } else {
      for (const tab of tabInfo) {
        // Determine whether this is a navigable URL or a JS-only tab
        const isNavigable = tab.href && tab.href !== '#'
          && !tab.href.startsWith('javascript')
          && tab.href !== currentUrl;

        if (isNavigable) {
          // Navigate directly to the tab URL
          const fullUrl = tab.href.startsWith('http')
            ? tab.href
            : `${BASE_URL}${tab.href.startsWith('/') ? '' : '/game/'}${tab.href}`;
          logger.debug(`[Scanner] Navigating to tab "${tab.text}": ${fullUrl}`);
          await goto(page, fullUrl);
          await humanDelay(700, 1400);
          if (!page.url().includes('empire')) {
            logger.warn(`[Scanner] Tab "${tab.text}" navigated away from empire — skipping`);
            await goto(page, `${BASE_URL}/game/index.php?page=standalone&component=empire`);
            await humanDelay(800, 1500);
            continue;
          }
        } else {
          // JS-driven tab: use Playwright click
          logger.debug(`[Scanner] Clicking JS tab "${tab.text}"`);
          const tabEl = await page.$(`#empireTab a:nth-of-type(${tab.index + 1}), #empireTab button:nth-of-type(${tab.index + 1})`).catch(() => null);
          if (!tabEl) continue;
          await tabEl.click();
          await humanDelay(400, 800);
          // If clicking navigated away, restore and stop tab iteration
          if (!page.url().includes('empire')) {
            logger.warn(`[Scanner] Tab click navigated away — restoring empire page`);
            await goto(page, `${BASE_URL}/game/index.php?page=standalone&component=empire`);
            await humanDelay(800, 1500);
            break;
          }
        }

        // Wait for [data-technology] rows to appear after tab switch
        await page.waitForSelector('[data-technology]', { timeout: 8000 }).catch(() => null);
        await maybeScroll(page, 0.3);

        const tabResult = await _scrapeVisibleEmpireTab(page);
        if (tabResult) {
          const techCount = Object.values(tabResult.data).reduce(
            (s, d) => s + Object.keys(d.buildings).length + Object.keys(d.fleet).length + Object.keys(d.defense).length, 0
          );
          logger.debug(`[Scanner] Tab "${tab.text}": ${tabResult.planets.length} planets, ${techCount} tech values`);
          _mergeTabData(mergedData, tabResult);
        }

        await maybeDistract(0.05);
        await humanDelay(300, 700);
      }
    }

    // ── Validate ──────────────────────────────────────────────────────────────
    const snapshotCount = Object.keys(mergedData).length;

    if (snapshotCount < 2) {
      const domHint = await page.evaluate(() => {
        const empireEls = Array.from(document.querySelectorAll('[id*="empire"],[class*="empire"]'))
          .slice(0, 8)
          .map(e => `${e.tagName.toLowerCase()}${e.id ? '#' + e.id : ''}${e.className ? '.' + String(e.className).split(/\s+/).slice(0, 2).join('.') : ''}`);
        const techCount = document.querySelectorAll('[data-technology]').length;
        const tables    = Array.from(document.querySelectorAll('table')).slice(0, 4)
          .map(t => `table${t.id ? '#' + t.id : ''}(${t.rows.length}rows)`);
        return { empireEls, techCount, tables, url: location.href };
      }).catch(() => ({}));

      logger.warn(`[Scanner] Empire parse failed — got ${snapshotCount} planets from ${tabInfo.length} tabs`);
      logger.warn(`[Scanner] techElements=${domHint.techCount}  empireEls: ${domHint.empireEls?.join(' | ')}`);
      if (domHint.tables?.length) logger.warn(`[Scanner] Tables: ${domHint.tables.join(' | ')}`);
      logger.warn('[Scanner] Falling back to per-planet scan');
      return null;
    }

    logger.info(`[Scanner] Empire scan complete — ${snapshotCount} planets across ${tabInfo.length} tab(s)`);

    // ── Build snapshots from mergedData ──────────────────────────────────────
    const snapshots = Object.values(mergedData).map(emp => {
      const known = planets?.find(p => p.coords && emp.coords && p.coords === emp.coords);
      const planet = known ?? {
        name:   emp.name,
        coords: emp.coords,
        id:     emp.planetId,
        isMoon: emp.isMoon,
        isHome: false,
      };

      logger.info(
        `[Scanner] ${planet.coords || emp.coords}: ` +
        `M=${emp.resources?.metal ?? '?'} C=${emp.resources?.crystal ?? '?'} ` +
        `D=${emp.resources?.deuterium ?? '?'} E=${emp.energy ?? 0} ` +
        `bldg=${Object.keys(emp.buildings || {}).length} ` +
        `fleet=${Object.keys(emp.fleet || {}).length} ` +
        `def=${Object.keys(emp.defense || {}).length}`
      );

      return {
        planet,
        resources:  emp.resources  ?? {},
        energy:     emp.energy     ?? 0,
        buildings:  emp.buildings  ?? {},
        fleet:      emp.fleet      ?? {},
        defense:    emp.defense    ?? {},
        scannedVia: 'empire',
      };
    });

    return snapshots;

  } catch (err) {
    if (err.name === 'SessionError') throw err;
    logger.warn(`[Scanner] Empire page error: ${err.message} — falling back`);
    return null;
  }
}

// ── Legacy per-planet fallback scan ───────────────────────────────────────────

async function readBuildingLevels(page) {
  return page.evaluate(() => {
    const levels = {};
    document.querySelectorAll('[data-technology]').forEach(el => {
      const id      = el.getAttribute('data-technology');
      const levelEl = el.querySelector('.level strong, .data_value, [class*="level"] strong');
      const val     = levelEl?.innerText?.replace(/[^0-9]/g, '') ??
                      el.querySelector('.level')?.getAttribute('data-value') ??
                      '0';
      if (id) levels[id] = parseInt(val, 10) || 0;
    });
    return levels;
  }).catch(() => ({}));
}

async function readFleet(page) {
  await gotoComponent(page, 'fleetdispatch');
  await scanThink();
  return page.evaluate(() => {
    const fleet = {};
    document.querySelectorAll('[data-technology]').forEach(el => {
      const id    = el.getAttribute('data-technology');
      const amtEl = el.querySelector('.group-amount, .amount, .fleet-amount');
      const input = el.querySelector('input[type="number"]');
      const val   = amtEl?.innerText?.replace(/[^0-9]/g, '') ??
                    input?.getAttribute('data-max') ??
                    input?.value ?? '0';
      const n = parseInt(val, 10) || 0;
      if (id && n > 0) fleet[id] = n;
    });
    return fleet;
  }).catch(() => ({}));
}

async function readDefense(page) {
  await gotoComponent(page, 'defenses');
  await scanThink();
  return page.evaluate(() => {
    const def = {};
    document.querySelectorAll('[data-technology]').forEach(el => {
      const id    = el.getAttribute('data-technology');
      const amtEl = el.querySelector('.amount, .data_value, .group-amount');
      const n     = parseInt(amtEl?.innerText?.replace(/[^0-9]/g, '') || '0', 10);
      if (id && n > 0) def[id] = n;
    });
    return def;
  }).catch(() => ({}));
}

async function readEnergy(page) {
  return page.evaluate(() => {
    const el = document.querySelector(
      '#resources_energy, #energy_box .value, [id*="energy"] .value'
    );
    if (!el) return 0;
    const raw = el.dataset?.raw ?? el.getAttribute('data-raw');
    return raw !== null
      ? parseInt(raw, 10)
      : parseInt((el.innerText || '0').replace(/[^0-9-]/g, ''), 10) || 0;
  }).catch(() => 0);
}

async function scanPlanet(page, planet) {
  const mode = pickTimingMode();
  logger.info(`[Scanner] Scanning ${planet.name} ${planet.coords} [${mode} mode] …`);
  const snapshot = { planet, resources: {}, energy: 0, buildings: {}, fleet: {}, defense: {}, scannedVia: 'perplanet' };

  try {
    await gotoComponent(page, 'supplies');
    await navPause(mode);
    snapshot.resources = await readResources(page);
    snapshot.energy    = await readEnergy(page);
    Object.assign(snapshot.buildings, await readBuildingLevels(page));
    await maybeScroll(page);

    const remainingPages = planet.isMoon
      ? shuffled(['facilities', 'defenses'])
      : shuffled(['facilities', 'defenses', 'fleet']);

    const finalPages = remainingPages.filter(p =>
      p === 'facilities' || Math.random() > 0.15
    );

    for (const pg of finalPages) {
      await navPause(mode);
      await maybeDistract();

      if (pg === 'facilities') {
        await gotoComponent(page, 'facilities');
        await navPause(mode);
        Object.assign(snapshot.buildings, await readBuildingLevels(page));
        await maybeScroll(page);
      } else if (pg === 'fleet' && !planet.isMoon) {
        snapshot.fleet = await readFleet(page);
        await maybeScroll(page);
      } else if (pg === 'defenses') {
        snapshot.defense = await readDefense(page);
        await maybeScroll(page);
      }
    }

    logger.info(
      `[Scanner] ${planet.coords}: M=${snapshot.resources.metal} ` +
      `C=${snapshot.resources.crystal} D=${snapshot.resources.deuterium} ` +
      `E=${snapshot.energy} buildings=${Object.keys(snapshot.buildings).length}`
    );
  } catch (err) {
    logger.warn(`[Scanner] Error scanning ${planet.coords}: ${err.message}`);
    if (err.name === 'SessionError') throw err;
  }

  return snapshot;
}

async function scanAllPlanetsFallback(page, planets) {
  logger.info('[Scanner] Using per-planet fallback scan …');
  const [home, ...rest] = planets;
  const visitOrder = home ? [home, ...shuffled(rest)] : shuffled(planets);
  const snapshots = [];

  for (const planet of visitOrder) {
    await switchPlanet(page, planet);
    if (Math.random() < 0.25) await humanDelay(500, 1500);
    snapshots.push(await scanPlanet(page, planet));
  }

  logger.info(`[Scanner] Fallback scan complete — ${snapshots.length} planets`);
  return snapshots;
}

// ── Public API ─────────────────────────────────────────────────────────────────

/**
 * Scan all planets. Tries Empire page first; falls back to per-planet scan if
 * the Empire page yields insufficient data or encounters an error.
 */
async function scanAllPlanets(page, planets) {
  const empireSnapshots = await scanViaEmpirePage(page, planets);
  if (empireSnapshots && empireSnapshots.length >= 1) {
    brief.intelSweepComplete(empireSnapshots);
    return empireSnapshots;
  }
  const fallback = await scanAllPlanetsFallback(page, planets);
  brief.intelSweepComplete(fallback);
  return fallback;
}

module.exports = { scanAllPlanets, scanPlanet };

