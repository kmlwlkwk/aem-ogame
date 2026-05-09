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
 * Navigate to the empire standalone page, then scrape ALL planet data.
 *
 * The empire view (page=standalone&component=empire) renders every planet as a
 * column of tech rows. We collect all data in one scrollable view.
 *
 * Also tries ?page=ingame&component=empire if the standalone URL redirects.
 *
 * Returns an array of snapshots, or null if the page is unavailable / parsing fails.
 */
async function scanViaEmpirePage(page, planets) {
  try {
    logger.info('[Scanner] Loading Empire overview page …');

    // Occasionally visit the overview first to vary the entry point
    if (Math.random() < 0.25) {
      await goto(page, `${BASE_URL}/game/index.php?page=ingame&component=overview`);
      await humanDelay(800, 2000);
    }

    await goto(page, `${BASE_URL}/game/index.php?page=standalone&component=empire`);

    // Human behaviour: read the page, scroll a bit — NO tab clicks (they navigate away)
    await humanDelay(1200, 3000);
    await maybeScroll(page, 0.6);
    await maybeDistract(0.08);

    let currentUrl = page.url();
    logger.debug(`[Scanner] Empire URL after load: ${currentUrl}`);

    // The game sometimes redirects standalone → ingame. Both are fine as long as
    // 'empire' is still in the component.
    if (!currentUrl.includes('empire')) {
      // Last resort: try ingame variant
      logger.warn(`[Scanner] Empire page redirected to: ${currentUrl} — trying ingame variant`);
      await goto(page, `${BASE_URL}/game/index.php?page=ingame&component=empire`);
      await humanDelay(1000, 2000);
      currentUrl = page.url();
      if (!currentUrl.includes('empire')) {
        logger.warn(`[Scanner] Ingame empire also redirected to: ${currentUrl} — falling back`);
        return null;
      }
    }

    // Scroll through the full page so lazy-loaded content appears
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight / 2)).catch(() => {});
    await humanDelay(400, 800);
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight)).catch(() => {});
    await humanDelay(400, 800);
    await page.evaluate(() => window.scrollTo(0, 0)).catch(() => {});
    await humanDelay(300, 600);

    // ── DOM extraction ───────────────────────────────────────────────────────
    const empireData = await page.evaluate(() => {
      /**
       * The empire page renders a wide table:
       *   - <thead> rows contain planet name + coords per column
       *   - <tbody> rows are keyed by data-technology, values per column
       *
       * Selector priority:
       *   1. Table-based layout (most OGame versions)
       *   2. Card/column layout (some alternate skins)
       *   3. Flat data-technology + data-planet-id scan (fallback)
       */

      const parseNum = (text) =>
        parseInt(String(text || '0').replace(/[^0-9-]/g, ''), 10) || 0;

      // ── Strategy 1: table-based layout ───────────────────────────────────
      // OGame uses various class/ID combos across versions
      const table = document.querySelector([
        '#empiretable table',
        '#empiretable',
        '.empire-overview table',
        '.empiretable table',
        '.empiretable',
        '#empire table',
        'table.empiretable',
        '.empire table',
        '#main table.table',
        '.content-box table',
      ].join(', '));

      if (table && table.tagName === 'TABLE') {
        // Detect planet columns from header row
        const headerRow = table.querySelector('thead tr, tr:first-child');
        if (headerRow) {
          const headerCells = Array.from(headerRow.querySelectorAll('th, td'));
          // First column is the label column; planet columns start at index 1
          const planets = [];
          for (let i = 1; i < headerCells.length; i++) {
            const cell = headerCells[i];
            const name   = cell.querySelector('.planet-name, .name, h3, h4, .planetname')?.innerText?.trim() ||
                           cell.innerText?.split('\n')[0]?.trim() || `Planet ${i}`;
            const coords = cell.querySelector('.planet-koords, .coords, .coordinates, .koords')?.innerText?.trim() ||
                           cell.innerText?.match(/\[\d+:\d+:\d+\]/)?.[0] || '';
            const planetId = cell.querySelector('[data-planet-id]')?.dataset?.planetId ||
                             cell.dataset?.planetId || String(i);
            const isMoon = name.toLowerCase().includes('moon') ||
                           cell.querySelector('.moon, [class*="moon"]') !== null;
            planets.push({ idx: i - 1, name, coords, planetId, isMoon,
                           resources: {}, energy: 0, buildings: {}, fleet: {}, defense: {} });
          }

          if (planets.length > 0) {
            // Parse each data row
            const dataRows = table.querySelectorAll('tbody tr, tr[data-technology]');
            dataRows.forEach(row => {
              const techId = row.dataset?.technology || row.getAttribute('data-technology');
              const cells  = Array.from(row.querySelectorAll('td'));
              planets.forEach((planet, pi) => {
                const cell = cells[pi + 1];
                if (!cell) return;
                const val = parseNum(cell.dataset?.value ?? cell.getAttribute('data-value') ?? cell.innerText);
                if (!techId) return;
                if (techId === '901') planet.resources.metal      = val;
                else if (techId === '902') planet.resources.crystal   = val;
                else if (techId === '903') planet.resources.deuterium = val;
                else if (techId === '904') planet.energy               = val;
                else if (Number(techId) >= 400 && Number(techId) < 500) planet.defense[techId] = val;
                else if (Number(techId) >= 200 && Number(techId) < 400) planet.fleet[techId]   = val;
                else if (val > 0 || cell.innerText.trim() !== '')        planet.buildings[techId] = val;
              });
            });

            return { layout: 'table', planets };
          }
        }
      }

      // ── Strategy 2: card/column layout ───────────────────────────────────
      const planetCards = document.querySelectorAll([
        '.planet-overview',
        '.empire-planet',
        '[class*="empire"] [class*="planet"]',
        '.planetInfo',
        '.planet-col',
        '.empire-col',
      ].join(', '));

      if (planetCards.length > 0) {
        const planets = [];
        planetCards.forEach((card, idx) => {
          const name   = card.querySelector('.planet-name, .name, h3, h4, .planetname')?.innerText?.trim() || `Planet ${idx + 1}`;
          const coords = card.querySelector('.planet-koords, .coords, .coordinates, .koords')?.innerText?.trim() ||
                         card.innerText?.match(/\[\d+:\d+:\d+\]/)?.[0] || '';
          const isMoon = name.toLowerCase().includes('moon') ||
                         card.querySelector('.moon, [class*="moon"]') !== null;
          const snap   = { idx, name, coords, isMoon, resources: {}, energy: 0, buildings: {}, fleet: {}, defense: {} };

          card.querySelectorAll('[data-technology]').forEach(el => {
            const techId = el.getAttribute('data-technology');
            const valEl  = el.querySelector('.amount, .data_value, .level strong, .value');
            const val    = parseNum(valEl?.innerText ?? el.dataset?.value ?? el.innerText);
            if (!techId) return;
            if (Number(techId) >= 400 && Number(techId) < 500) snap.defense[techId] = val;
            else if (Number(techId) >= 200 && Number(techId) < 400) snap.fleet[techId] = val;
            else snap.buildings[techId] = val;
          });

          const resBar = card.querySelector('#resources_metal, .metal .value, [id*="metal"]');
          if (resBar) {
            snap.resources.metal     = parseNum(resBar.dataset?.raw ?? resBar.innerText);
            snap.resources.crystal   = parseNum(card.querySelector('#resources_crystal, .crystal .value')?.dataset?.raw ?? card.querySelector('#resources_crystal, .crystal .value')?.innerText);
            snap.resources.deuterium = parseNum(card.querySelector('#resources_deuterium, .deuterium .value')?.dataset?.raw ?? card.querySelector('#resources_deuterium, .deuterium .value')?.innerText);
          }

          planets.push(snap);
        });

        if (planets.length > 0) return { layout: 'cards', planets };
      }

      // ── Strategy 3: flat data-technology scan with data-planet grouping ──
      const grouped = {};
      document.querySelectorAll('[data-technology][data-planet-id]').forEach(el => {
        const techId   = el.getAttribute('data-technology');
        const planetId = el.getAttribute('data-planet-id');
        const val = parseNum(
          el.querySelector('.amount, .data_value, .level strong')?.innerText ??
          el.dataset?.value ?? el.innerText
        );
        if (!grouped[planetId]) grouped[planetId] = { planetId, buildings: {}, fleet: {}, defense: {}, resources: {}, energy: 0 };
        const snap = grouped[planetId];
        if (Number(techId) >= 400 && Number(techId) < 500) snap.defense[techId]   = val;
        else if (Number(techId) >= 200 && Number(techId) < 400) snap.fleet[techId] = val;
        else snap.buildings[techId] = val;
      });

      const flatPlanets = Object.values(grouped);
      if (flatPlanets.length > 0) return { layout: 'flat', planets: flatPlanets };

      return null;
    });

    if (!empireData || !empireData.planets || empireData.planets.length < 2) {
      // Rich DOM diagnostic to help identify real selectors on next failure
      const domHint = await page.evaluate(() => {
        const title = document.title;
        // Find any empire-related elements
        const empireEls = Array.from(document.querySelectorAll('[id*="empire"],[class*="empire"]'))
          .slice(0, 10)
          .map(e => `${e.tagName.toLowerCase()}${e.id ? '#' + e.id : ''}${e.className ? '.' + String(e.className).trim().split(/\s+/).slice(0, 3).join('.') : ''}`);
        // Any data-technology elements (should be present on empire page)
        const techCount = document.querySelectorAll('[data-technology]').length;
        const planetIdCount = document.querySelectorAll('[data-planet-id]').length;
        // Tables
        const tables = Array.from(document.querySelectorAll('table'))
          .slice(0, 5)
          .map(t => `table${t.id ? '#' + t.id : ''}${t.className ? '.' + String(t.className).split(/\s+/)[0] : ''} (${t.rows.length}rows)`);
        // Error messages
        const errorEl = document.querySelector('.error, .alert, #error');
        return {
          title,
          url: location.href,
          empireEls,
          techCount,
          planetIdCount,
          tables,
          error: errorEl?.innerText?.slice(0, 100) ?? null,
        };
      }).catch(e => ({ evalError: e.message }));

      logger.warn(`[Scanner] Empire parse failed — got ${empireData?.planets?.length ?? 0} planets`);
      logger.warn(`[Scanner] DOM diagnostic: title="${domHint.title}" techElements=${domHint.techCount} planetIdElements=${domHint.planetIdCount}`);
      if (domHint.empireEls?.length) logger.warn(`[Scanner] Empire elements: ${domHint.empireEls.join(' | ')}`);
      if (domHint.tables?.length)    logger.warn(`[Scanner] Tables: ${domHint.tables.join(' | ')}`);
      if (domHint.error)             logger.warn(`[Scanner] Page error: ${domHint.error}`);
      logger.warn('[Scanner] Falling back to per-planet scan');
      return null;
    }

    logger.info(`[Scanner] Empire page: layout=${empireData.layout} planets=${empireData.planets.length}`);

    // ── Merge empire data with known planet list ─────────────────────────────
    // The planets array from getPlanets() has IDs + cp params we need later.
    // We match by coords (most reliable cross-reference).
    const snapshots = empireData.planets.map(emp => {
      // Try to match to a known planet by coordinates
      const known = planets?.find(p => p.coords && emp.coords && p.coords === emp.coords);

      const planet = known ?? {
        name:    emp.name,
        coords:  emp.coords,
        id:      emp.planetId,
        isMoon:  emp.isMoon,
        isHome:  false,
      };

      logger.info(
        `[Scanner] ${planet.coords || emp.coords}: ` +
        `M=${emp.resources?.metal ?? '?'} C=${emp.resources?.crystal ?? '?'} ` +
        `D=${emp.resources?.deuterium ?? '?'} E=${emp.energy ?? 0} ` +
        `buildings=${Object.keys(emp.buildings || {}).length} ` +
        `fleet=${Object.keys(emp.fleet || {}).length} ` +
        `defense=${Object.keys(emp.defense || {}).length}`
      );

      return {
        planet,
        resources: emp.resources ?? {},
        energy:    emp.energy    ?? 0,
        buildings: emp.buildings ?? {},
        fleet:     emp.fleet     ?? {},
        defense:   emp.defense   ?? {},
        scannedVia: 'empire',
      };
    });

    logger.info(`[Scanner] Empire scan complete — ${snapshots.length} planets`);
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

