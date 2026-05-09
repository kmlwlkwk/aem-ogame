/**
 * Economics tactic — manages building queues, research and energy.
 */

const logger = require('../utils/logger');
const brief  = require('../utils/briefing');
const { humanClickSelector, humanScroll } = require('../utils/human');
const { humanDelay, thinkTime } = require('../utils/delay');
const { gotoComponent, readResources, withRetry } = require('../utils/navigation');

const SUPPLIES_PRIORITY = [
  { id: 1, name: 'Metal Mine' },
  { id: 2, name: 'Crystal Mine' },
  { id: 3, name: 'Deuterium Synthesizer' },
  { id: 4, name: 'Solar Plant' },
  { id: 12, name: 'Metal Storage' },
  { id: 13, name: 'Crystal Storage' },
  { id: 14, name: 'Deuterium Tank' },
];

const FACILITIES_PRIORITY = [
  { id: 14, name: 'Robotics Factory' },
  { id: 15, name: 'Nanite Factory' },
  { id: 21, name: 'Research Laboratory' },
  { id: 23, name: 'Shipyard' },
  { id: 22, name: 'Missile Silo' },
];

const RESEARCH_PRIORITY = [
  { id: 113, name: 'Energy Technology' },
  { id: 115, name: 'Combustion Drive' },
  { id: 117, name: 'Impulse Drive' },
  { id: 118, name: 'Hyperspace Drive' },
  { id: 114, name: 'Laser Technology' },
  { id: 116, name: 'Ion Technology' },
  { id: 122, name: 'Hyperspace Technology' },
  { id: 121, name: 'Plasma Technology' },
  { id: 106, name: 'Espionage Technology' },
  { id: 108, name: 'Astrophysics' },
  { id: 199, name: 'Intergalactic Research Network' },
  { id: 123, name: 'Graviton Technology' },
  { id: 109, name: 'Computer Technology' },
  { id: 111, name: 'Armour Technology' },
  { id: 120, name: 'Shielding Technology' },
  { id: 110, name: 'Weapons Technology' },
];

const MOON_FACILITIES_PRIORITY = [
  { id: 14, name: 'Robotics Factory' },
  { id: 31, name: 'Lunar Base' },
  { id: 33, name: 'Sensor Phalanx' },
  { id: 34, name: 'Jump Gate' },
  { id: 21, name: 'Shipyard' },
];

const SUPPLY_BY_ID = new Map(SUPPLIES_PRIORITY.map(item => [item.id, item]));
const FACILITY_BY_ID = new Map(FACILITIES_PRIORITY.map(item => [item.id, item]));
const STORAGE_MAP = {
  metal: { id: 12, name: 'Metal Storage' },
  crystal: { id: 13, name: 'Crystal Storage' },
  deuterium: { id: 14, name: 'Deuterium Tank' },
};
const MINE_NAMES = { 1: 'Metal Mine', 2: 'Crystal Mine', 3: 'Deuterium Synthesizer' };
const MINE_ORDER = [1, 2, 3];

const SAT_ENERGY_BY_SLOT = {
  1: 44, 2: 37, 3: 32, 4: 28, 5: 24, 6: 22, 7: 20, 8: 18, 9: 17, 10: 16,
  11: 15, 12: 14, 13: 13, 14: 12, 15: 12,
};

const SOLAR_SAT_ID = 212;
const SOLAR_SAT_CRYSTAL = 2000;
const SOLAR_SAT_DEUT = 500;

function normalizeId(id) {
  return String(id);
}

function getLevel(source, id) {
  if (!source) return null;
  const raw = source[normalizeId(id)];
  if (raw === undefined || raw === null) return null;
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

function getBuildingLevel(snapshot, id, opts = {}) {
  const fromPage = getLevel(opts.levels, id);
  if (fromPage !== null) return fromPage;
  const fromSnapshot = getLevel(snapshot?.buildings, id);
  return fromSnapshot !== null ? fromSnapshot : 0;
}

function getResourceAmount(resources, snapshot, key) {
  if (resources && Number.isFinite(resources[key])) return resources[key];
  const fallback = snapshot?.resources?.[key];
  return Number.isFinite(fallback) ? fallback : 0;
}

function getPlanetCoords(snapshot, opts = {}) {
  return snapshot?.planet?.coords || opts.coords || '';
}

function getPlanetSlot(coords) {
  const slot = parseInt(String(coords || '').split(':')[2], 10);
  return Number.isFinite(slot) ? slot : 7;
}

function storageCapacity(level) {
  return level <= 0 ? 10000 : 5000 * Math.pow(2, level);
}

function uniqueById(list) {
  const seen = new Set();
  const result = [];
  for (const item of list) {
    if (!item || seen.has(item.id)) continue;
    seen.add(item.id);
    result.push(item);
  }
  return result;
}

function moveItemToPosition(list, id, position) {
  const index = list.findIndex(item => item.id === id);
  if (index === -1) return list;
  const [item] = list.splice(index, 1);
  const targetIndex = Math.max(0, Math.min(position - 1, list.length));
  list.splice(targetIndex, 0, item);
  return list;
}

function prioritiseItem(item, list) {
  return uniqueById(item ? [item, ...list] : list);
}

function buildSuppliesPriority(snapshot, energy, opts = {}) {
  const slot = getPlanetSlot(getPlanetCoords(snapshot, opts));
  const deutLevel = getBuildingLevel(snapshot, 3, opts);
  const lowFields = Number.isFinite(opts.fields?.remaining) && opts.fields.remaining < 15;

  const list = [
    SUPPLY_BY_ID.get(1),
    SUPPLY_BY_ID.get(2),
    SUPPLY_BY_ID.get(3),
    SUPPLY_BY_ID.get(4),
    SUPPLY_BY_ID.get(12),
    SUPPLY_BY_ID.get(13),
    SUPPLY_BY_ID.get(14),
  ];

  if (slot >= 7 && deutLevel >= 15 && energy < 0) {
    list.splice(4, 0, { id: 5, name: 'Fusion Reactor' });
  }

  if (lowFields) {
    return list.filter(item => item.id === 12 || item.id === 13 || item.id === 14);
  }

  if (energy >= 0) {
    return list.filter(item => item.id !== 4 && item.id !== 5);
  }

  return list;
}

function getMineRatioDecision(snapshot, opts = {}) {
  const metalLevel = getBuildingLevel(snapshot, 1, opts);
  const crystalLevel = getBuildingLevel(snapshot, 2, opts);
  const deutLevel = getBuildingLevel(snapshot, 3, opts);

  const targetMetal = Math.max(metalLevel, crystalLevel + 2, deutLevel + 4);
  const targetCrystal = targetMetal - 2;
  const targetDeut = targetMetal - 4;

  const candidates = [
    { id: 1, name: 'Metal Mine', deficit: targetMetal - metalLevel, order: 0 },
    { id: 2, name: 'Crystal Mine', deficit: targetCrystal - crystalLevel, order: 1 },
    { id: 3, name: 'Deuterium Synthesizer', deficit: targetDeut - deutLevel, order: 2 },
  ].sort((a, b) => b.deficit - a.deficit || a.order - b.order);

  const chosen = candidates[0];
  return {
    ...chosen,
    levels: { metalLevel, crystalLevel, deutLevel },
    targets: { targetMetal, targetCrystal, targetDeut },
  };
}

function getMineUpgradeCost(id, level) {
  if (id === 1) {
    return {
      metal: 60 * Math.pow(1.5, level),
      crystal: 15 * Math.pow(1.5, level),
    };
  }
  if (id === 2) {
    return {
      metal: 48 * Math.pow(1.6, level),
      crystal: 24 * Math.pow(1.6, level),
    };
  }
  if (id === 3) {
    return {
      metal: 225 * Math.pow(1.5, level),
      crystal: 75 * Math.pow(1.5, level),
    };
  }
  return { metal: 0, crystal: 0 };
}

function estimateMineBuildTimeHours(mineId, level, roboticsLevel, naniteLevel) {
  const cost = getMineUpgradeCost(mineId, level);
  const roboticsFactor = 1 + Math.max(0, roboticsLevel || 0);
  const naniteFactor = naniteLevel > 0 ? Math.pow(2, naniteLevel) : 1;
  return (cost.metal + cost.crystal) / (2500 * roboticsFactor * naniteFactor) / 3600;
}

function decideSuppliesBuild(snapshot, resources, energy, opts = {}) {
  const lowFields = Number.isFinite(opts.fields?.remaining) && opts.fields.remaining < 15;
  const supplyList = buildSuppliesPriority(snapshot, energy, opts);

  const storageStatus = [
    {
      key: 'metal',
      amount: getResourceAmount(resources, snapshot, 'metal'),
      level: getBuildingLevel(snapshot, 12, opts),
      item: STORAGE_MAP.metal,
    },
    {
      key: 'crystal',
      amount: getResourceAmount(resources, snapshot, 'crystal'),
      level: getBuildingLevel(snapshot, 13, opts),
      item: STORAGE_MAP.crystal,
    },
    {
      key: 'deuterium',
      amount: getResourceAmount(resources, snapshot, 'deuterium'),
      level: getBuildingLevel(snapshot, 14, opts),
      item: STORAGE_MAP.deuterium,
    },
  ].map(entry => ({
    ...entry,
    capacity: storageCapacity(entry.level),
  })).map(entry => ({
    ...entry,
    ratio: entry.capacity > 0 ? entry.amount / entry.capacity : 0,
  }));

  const urgentStorage = storageStatus
    .filter(entry => entry.ratio > 0.85)
    .sort((a, b) => b.ratio - a.ratio)[0];

  if (urgentStorage) {
    return {
      ...urgentStorage.item,
      reason: 'storage',
      resourceKey: urgentStorage.key,
      ratio: urgentStorage.ratio,
      capacity: urgentStorage.capacity,
      amount: urgentStorage.amount,
    };
  }

  if (lowFields) return null;

  if (energy < 0) {
    const slot = getPlanetSlot(getPlanetCoords(snapshot, opts));
    const deutLevel = getBuildingLevel(snapshot, 3, opts);
    if (slot >= 7 && deutLevel >= 15 && supplyList.some(item => item.id === 5)) {
      return { id: 5, name: 'Fusion Reactor', reason: 'energy', slot, deutLevel };
    }
    return { id: 4, name: 'Solar Plant', reason: 'energy', slot, deutLevel };
  }

  const ratioDecision = getMineRatioDecision(snapshot, opts);
  return { ...ratioDecision, reason: 'ratio' };
}

function decideFacilitiesBuild(snapshot, opts = {}) {
  const roboticsLevel = getBuildingLevel(snapshot, 14, opts);
  const naniteLevel = getBuildingLevel(snapshot, 15, opts);
  const mineCandidate = opts.mineCandidate;

  if (mineCandidate && MINE_ORDER.includes(mineCandidate.id)) {
    const mineLevel = getBuildingLevel(snapshot, mineCandidate.id, opts.mineLevels ? { levels: opts.mineLevels } : opts);
    const buildTimeHours = estimateMineBuildTimeHours(mineCandidate.id, mineLevel, roboticsLevel, naniteLevel);

    if (buildTimeHours > 4 && roboticsLevel < 10) {
      return {
        ...FACILITY_BY_ID.get(14),
        reason: 'fast-track-robotics',
        buildTimeHours,
        roboticsLevel,
      };
    }
  }

  if (roboticsLevel >= 10 && naniteLevel === 0) {
    return {
      ...FACILITY_BY_ID.get(15),
      reason: 'unlock-nanite',
      roboticsLevel,
      naniteLevel,
    };
  }

  return FACILITIES_PRIORITY[0] ? { ...FACILITIES_PRIORITY[0], reason: 'priority' } : null;
}

function buildDynamicResearchPriority(snapshot, opts = {}) {
  const list = RESEARCH_PRIORITY.map(item => ({ ...item }));
  const metalLevel = getBuildingLevel(snapshot, 1, opts);
  const crystalLevel = getBuildingLevel(snapshot, 2, opts);
  const deutLevel = getBuildingLevel(snapshot, 3, opts);
  const avgMineLevel = (metalLevel + crystalLevel + deutLevel) / 3;
  const astrophysicsLevel = getBuildingLevel(snapshot, 108, opts);
  const labLevel = getBuildingLevel(snapshot, 21, opts);
  const totalPlanets = Number.isFinite(opts.totalPlanets) ? opts.totalPlanets : null;

  if (avgMineLevel > 30) {
    moveItemToPosition(list, 121, 1);
  } else if (avgMineLevel > 20) {
    moveItemToPosition(list, 121, 2);
  }

  if (totalPlanets !== null) {
    const maxColonies = Math.floor((astrophysicsLevel || 0) / 2) + 1;
    const roomForMore = totalPlanets < maxColonies + 1;
    const unlocksNextColony = Math.floor(((astrophysicsLevel || 0) + 1) / 2) + 1 > maxColonies;

    if (roomForMore) {
      const desiredPosition = unlocksNextColony ? 2 : (avgMineLevel > 20 ? 3 : 2);
      moveItemToPosition(list, 108, desiredPosition);
    }
  }

  if (labLevel >= 10) {
    moveItemToPosition(list, 199, 4);
  }

  return uniqueById(list);
}

async function hasActiveQueue(page) {
  const selectors = [
    '.buildingList .active',
    '.technologies .on',
    '.queue-build-item',
    '.countdown',
  ];
  for (const sel of selectors) {
    const el = await page.$(sel);
    if (el) return true;
  }
  return false;
}

async function findUpgradeable(page, priorityList, buildRecommendation = null) {
  if (buildRecommendation) {
    const recommended = priorityList.find(item =>
      item.name.toLowerCase().includes(buildRecommendation.toLowerCase()) ||
      buildRecommendation.toLowerCase().includes(item.name.toLowerCase())
    );
    if (recommended) {
      const block = await page.$(`[data-technology="${recommended.id}"]`);
      if (block) {
        const btn = await block.$(
          'button.upgrade:not([disabled]), a.upgradeLinkTechnology:not(.disabled), a.build_link:not(.disabled), .research:not(.disabled)'
        );
        if (btn) {
          logger.info(`[Economics] Using AI recommendation: ${recommended.name}`);
          return { item: recommended, btn };
        }
      }
    }
  }

  for (const item of priorityList) {
    const block = await page.$(`[data-technology="${item.id}"]`);
    if (!block) continue;
    const btn = await block.$(
      'button.upgrade:not([disabled]), a.upgradeLinkTechnology:not(.disabled), a.build_link:not(.disabled), .research:not(.disabled)'
    );
    if (btn) return { item, btn };
  }
  return null;
}

async function isOnMoon(page) {
  try {
    return await page.evaluate(() => {
      const active = document.querySelector('.smallplanet .moonlink.active, .active-moon, [class*="moonlink"][class*="active"]');
      if (active) return true;
      return document.title.toLowerCase().includes('moon') ||
        document.body.innerText.includes('Księżyc');
    });
  } catch {
    return false;
  }
}

async function readPageEnergy(page, fallback = 0) {
  return page.evaluate(() => {
    const el = document.querySelector('#resources_energy, #energy_box .value, [id*="energy"] .value, #resources_energy_produced');
    if (!el) return null;
    const raw = el.dataset?.raw ?? el.getAttribute('data-raw');
    return raw !== null && raw !== undefined
      ? parseInt(raw, 10)
      : parseInt((el.innerText || el.textContent || '0').replace(/[^0-9-]/g, ''), 10) || 0;
  }).then(value => (Number.isFinite(value) ? value : fallback)).catch(() => fallback);
}

async function readBuildingLevels(page, ids = null) {
  return page.evaluate((filterIds) => {
    const wanted = filterIds ? new Set(filterIds.map(String)) : null;
    const levels = {};
    document.querySelectorAll('[data-technology]').forEach(el => {
      const id = el.getAttribute('data-technology');
      if (!id || (wanted && !wanted.has(id))) return;
      const levelText =
        el.querySelector('.level strong, .data_value, .amount, [class*="level"] strong')?.innerText ||
        el.querySelector('.level')?.getAttribute('data-value') ||
        '0';
      levels[id] = parseInt(String(levelText).replace(/[^0-9]/g, ''), 10) || 0;
    });
    return levels;
  }, ids).catch(() => ({}));
}

async function readPlanetFields(page) {
  return page.evaluate(() => {
    const selectors = [
      '.planet-size',
      '#planet_size',
      '.rc_overview',
      '[class*="fields"]',
    ];

    const tryRemainingAttr = (el) => {
      if (!el) return null;
      const attrs = ['data-remaining-fields', 'data-fields-remaining', 'data-free-fields'];
      for (const attr of attrs) {
        const raw = el.getAttribute(attr);
        if (raw !== null && raw !== undefined && /-?\d+/.test(raw)) {
          return { used: null, total: null, remaining: parseInt(raw, 10) };
        }
      }
      const datasetKeys = ['remainingFields', 'fieldsRemaining', 'freeFields'];
      for (const key of datasetKeys) {
        const raw = el.dataset?.[key];
        if (raw !== null && raw !== undefined && /-?\d+/.test(raw)) {
          return { used: null, total: null, remaining: parseInt(raw, 10) };
        }
      }
      return null;
    };

    for (const sel of selectors) {
      const elements = Array.from(document.querySelectorAll(sel));
      for (const el of elements) {
        const attrMatch = tryRemainingAttr(el);
        if (attrMatch) return attrMatch;

        const childAttr = Array.from(el.querySelectorAll('*')).map(tryRemainingAttr).find(Boolean);
        if (childAttr) return childAttr;

        const text = el.innerText || el.textContent || '';
        const slash = text.match(/(\d+)\s*\/\s*(\d+)/);
        if (slash) {
          const used = parseInt(slash[1], 10);
          const total = parseInt(slash[2], 10);
          return { used, total, remaining: total - used };
        }
        const single = text.match(/(\d+)/);
        if (single) {
          return { used: null, total: null, remaining: parseInt(single[1], 10) };
        }
      }
    }

    return null;
  }).catch(() => null);
}

async function buildAndClick(page, id, count = null) {
  const block = await page.$(`[data-technology="${id}"]`);
  if (!block) return false;

  const buildBtn = await block.$(
    'button.upgrade:not([disabled]), a.upgradeLinkTechnology:not(.disabled), a.build_link:not(.disabled), .research:not(.disabled)'
  );
  if (!buildBtn) return false;

  if (count !== null && count !== undefined) {
    const inputEl = await block.$('input.build_amount, input[type="number"]');
    if (inputEl) {
      await inputEl.scrollIntoViewIfNeeded().catch(() => {});
      await humanDelay(250, 500);
      await inputEl.click({ clickCount: 3 }).catch(() => {});
      await inputEl.fill(String(count));
      await humanDelay(250, 500);
    }
  }

  await buildBtn.scrollIntoViewIfNeeded().catch(() => {});
  await humanDelay(350, 700);
  await buildBtn.click();
  await humanDelay(500, 900);

  const confirmBtn = await page.$('.overlay button.yes, #confirmOkay, .popup_middle button.upgrade');
  if (confirmBtn) {
    await confirmBtn.click();
    await humanDelay(300, 700);
  }

  return true;
}

async function fixEnergyDeficit(page, opts = {}) {
  const energy = Number.isFinite(opts.energy)
    ? opts.energy
    : await readPageEnergy(page, opts.snapshot?.energy ?? 0);

  if (energy >= -500) return false;

  const slot = getPlanetSlot(getPlanetCoords(opts.snapshot, opts));
  const satEnergy = SAT_ENERGY_BY_SLOT[slot] || SAT_ENERGY_BY_SLOT[7];
  brief.energyDeficitAlert(opts.snapshot?.planet?.coords ?? '?', energy, 0, slot);

  await withRetry(() => gotoComponent(page, 'shipyard'));
  await thinkTime();

  if (await hasActiveQueue(page)) {
    logger.info('[Economics] Shipyard busy — will fix energy deficit next cycle');
    return true;
  }

  const resources = opts.resources || await readResources(page);
  const deficit = Math.abs(energy);
  const needed = Math.ceil(deficit / satEnergy) + 5;
  const canAfford = Math.floor(Math.min(
    resources.crystal / SOLAR_SAT_CRYSTAL,
    resources.deuterium / SOLAR_SAT_DEUT,
  ));

  if (canAfford < 1) {
    logger.warn(`[Economics] Cannot afford solar satellites yet (need crystal:${SOLAR_SAT_CRYSTAL} deut:${SOLAR_SAT_DEUT})`);
    return false;
  }

  const count = Math.min(needed, canAfford);
  brief.energyDeficitAlert(opts.snapshot?.planet?.coords ?? '?', energy, count, slot);
  logger.info(`[Economics] Building ${count}× Solar Satellite (deficit=${energy}, needed≈${needed})`);

  const queued = await buildAndClick(page, SOLAR_SAT_ID, count);
  if (!queued) {
    logger.warn('[Economics] Solar Satellite build controls not available');
    return false;
  }

  logger.info(`[Economics] ✓ Queued ${count}× Solar Satellite — energy deficit will be resolved`);
  return true;
}

async function runMoonFacilities(page, opts = {}) {
  logger.info('[Economics] Checking Moon Facilities (Lunar Base / Phalanx) …');
  await withRetry(() => gotoComponent(page, 'facilities'));
  await thinkTime();

  if (await hasActiveQueue(page)) {
    logger.info('[Economics] Moon facilities queue busy, skipping');
    return false;
  }

  const target = await findUpgradeable(page, MOON_FACILITIES_PRIORITY, opts.buildRecommendation);
  if (!target) {
    logger.info('[Economics] Nothing affordable in Moon Facilities');
    return false;
  }

  logger.info(`[Economics] Moon upgrading: ${target.item.name}`);
  return buildAndClick(page, target.item.id);
}

async function run(page, options = {}) {
  logger.info('━━ [Economics] tactic start ━━');

  try {
    const moon = await isOnMoon(page);
    if (moon) {
      logger.info('[Economics] Moon detected — running facilities only');
      await runMoonFacilities(page, options);
      logger.info('━━ [Economics] tactic end ━━');
      return;
    }

    const snapshot = options.snapshot || {};

    await withRetry(() => gotoComponent(page, 'supplies'));
    await thinkTime();

    const queueBusy = await hasActiveQueue(page);
    const resources = await readResources(page);
    const energy = await readPageEnergy(page, snapshot.energy ?? 0);
    const supplyLevels = await readBuildingLevels(page, [1, 2, 3, 4, 5, 12, 13, 14]);
    const fields = await readPlanetFields(page);

    logger.info(`[Economics] Resources — M:${resources.metal} C:${resources.crystal} D:${resources.deuterium} E:${energy}`);
    if (fields?.remaining !== undefined && fields?.remaining !== null) {
      logger.info(`[Economics] Fields — remaining: ${fields.remaining}${fields.total ? ` (${fields.used}/${fields.total})` : ''}`);
    }

    const energyFixed = await fixEnergyDeficit(page, { ...options, snapshot, resources, energy });
    if (energyFixed) {
      logger.info('[Economics] Energy deficit addressed — skipping other builds this cycle');
      logger.info('━━ [Economics] tactic end ━━');
      return;
    }

    const lowFields = Number.isFinite(fields?.remaining) && fields.remaining < 15;
    if (lowFields) {
      logger.warn(`[Economics] Low fields (${fields.remaining} remaining) — skipping mine and facility upgrades this cycle`);
    }

    const supplyOpts = { ...options, snapshot, fields, levels: supplyLevels };
    const suppliesBuild = decideSuppliesBuild(snapshot, resources, energy, supplyOpts);
    const suppliesPriority = buildSuppliesPriority(snapshot, energy, supplyOpts);

    if (suppliesBuild?.reason === 'ratio') {
      logger.info(
        `[Economics] Ratio: M=${suppliesBuild.levels.metalLevel} C=${suppliesBuild.levels.crystalLevel} D=${suppliesBuild.levels.deutLevel} ` +
        `→ upgrading ${suppliesBuild.name} (deficit ${suppliesBuild.deficit})`
      );
    } else if (suppliesBuild?.reason === 'storage') {
      logger.info(
        `[Economics] Storage pressure: ${suppliesBuild.resourceKey} ${(suppliesBuild.ratio * 100).toFixed(1)}% ` +
        `(${suppliesBuild.amount}/${Math.round(suppliesBuild.capacity)}) → upgrading ${suppliesBuild.name}`
      );
    } else if (suppliesBuild?.reason === 'energy') {
      logger.info(`[Economics] Energy ${energy} on slot ${suppliesBuild.slot} → upgrading ${suppliesBuild.name}`);
    }

    if (suppliesBuild && !queueBusy) {
      const target = await findUpgradeable(page, prioritiseItem(suppliesBuild, suppliesPriority));
      if (target) {
        logger.info(`[Economics] Upgrading: ${target.item.name}`);
        const queued = await buildAndClick(page, target.item.id);
        if (queued) {
          brief.buildOrdered(null, target.item.name, suppliesBuild?.reason);
          logger.info('━━ [Economics] tactic end ━━');
          return;
        }
      } else {
        logger.info(`[Economics] Planned supplies build not available: ${suppliesBuild.name}`);
      }
    } else if (queueBusy) {
      logger.info('[Economics] Planetary build queue busy — skipping supplies and facilities');
    }

    const mineCandidate = suppliesBuild && MINE_ORDER.includes(suppliesBuild.id) ? suppliesBuild : null;
    const facilitiesBuild = lowFields
      ? null
      : decideFacilitiesBuild(snapshot, { ...options, snapshot, mineCandidate, mineLevels: supplyLevels });

    if (facilitiesBuild?.reason === 'fast-track-robotics') {
      logger.info(
        `[Economics] Mine build would take ${facilitiesBuild.buildTimeHours.toFixed(2)}h — ` +
        `fast-tracking ${facilitiesBuild.name}`
      );
    } else if (facilitiesBuild?.reason === 'unlock-nanite') {
      logger.info('[Economics] Robotics 10+ detected — prioritising Nanite Factory');
    }

    if (facilitiesBuild && !queueBusy) {
      await withRetry(() => gotoComponent(page, 'facilities'));
      await thinkTime();

      if (await hasActiveQueue(page)) {
        logger.info('[Economics] Facilities queue busy, skipping');
      } else {
        const target = await findUpgradeable(page, prioritiseItem(facilitiesBuild, FACILITIES_PRIORITY));
        if (target) {
          logger.info(`[Economics] Upgrading: ${target.item.name}`);
          const queued = await buildAndClick(page, target.item.id);
          if (queued) {
            brief.buildOrdered(null, target.item.name, facilitiesBuild?.reason);
            logger.info('━━ [Economics] tactic end ━━');
            return;
          }
        } else {
          logger.info(`[Economics] Planned facilities build not available: ${facilitiesBuild.name}`);
        }
      }
    }

    if (options.includeResearch) {
      const researchList = buildDynamicResearchPriority(snapshot, options);
      await withRetry(() => gotoComponent(page, 'research'));
      await thinkTime();

      if (await hasActiveQueue(page)) {
        logger.info('[Economics] Research queue busy, skipping');
      } else {
        const target = await findUpgradeable(page, researchList, options.researchNext ?? options.buildRecommendation);
        if (target) {
          logger.info(`[Economics] Researching: ${target.item.name}`);
          const queued = await buildAndClick(page, target.item.id);
          if (queued) {
            brief.buildOrdered(null, target.item.name, 'research');
            logger.info('━━ [Economics] tactic end ━━');
            return;
          }
        } else {
          logger.info('[Economics] Nothing affordable in Research');
        }
      }
    } else {
      logger.info('[Economics] Skipping research (not home planet)');
    }
  } catch (err) {
    if (err.name === 'SessionError') throw err;
    logger.error(`[Economics] Error: ${err.message}`);
  }

  logger.info('━━ [Economics] tactic end ━━');
}

module.exports = {
  run,
};
