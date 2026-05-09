/**
 * SQLite persistence layer — stores planet snapshots, AI decisions, and
 * cycle totals so decisions can be correlated with growth outcomes later.
 */

const path    = require('path');
const Database = require('better-sqlite3');
const logger  = require('../utils/logger');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, '../../ogame-stats.db');

let db;

function getDb() {
  if (db) return db;
  db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  applyMigrations(db);
  logger.info(`[DB] Opened database: ${DB_PATH}`);
  return db;
}

function applyMigrations(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS planet_snapshots (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      ts          TEXT    NOT NULL DEFAULT (datetime('now')),
      cycle       INTEGER,
      planet_id   TEXT,
      planet_name TEXT,
      coords      TEXT,
      is_moon     INTEGER DEFAULT 0,
      metal       INTEGER DEFAULT 0,
      crystal     INTEGER DEFAULT 0,
      deuterium   INTEGER DEFAULT 0,
      energy      INTEGER DEFAULT 0,
      buildings   TEXT    DEFAULT '{}',
      fleet       TEXT    DEFAULT '{}',
      defense     TEXT    DEFAULT '{}'
    );

    CREATE TABLE IF NOT EXISTS decisions (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      ts           TEXT    NOT NULL DEFAULT (datetime('now')),
      cycle        INTEGER,
      decision_type TEXT,
      planet_from  TEXT,
      planet_to    TEXT,
      payload      TEXT,
      reasoning    TEXT,
      confidence   REAL
    );

    CREATE TABLE IF NOT EXISTS cycle_totals (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      ts             TEXT    NOT NULL DEFAULT (datetime('now')),
      cycle          INTEGER UNIQUE,
      total_metal    INTEGER,
      total_crystal  INTEGER,
      total_deuterium INTEGER,
      planet_count   INTEGER,
      decision_count INTEGER,
      ai_advice      TEXT
    );

    CREATE TABLE IF NOT EXISTS directives (
      id      INTEGER PRIMARY KEY AUTOINCREMENT,
      ts      TEXT NOT NULL DEFAULT (datetime('now')),
      text    TEXT NOT NULL,
      set_at  TEXT,
      cycle   INTEGER DEFAULT 0,
      active  INTEGER DEFAULT 1
    );

    CREATE INDEX IF NOT EXISTS idx_snapshots_cycle  ON planet_snapshots(cycle);
    CREATE INDEX IF NOT EXISTS idx_snapshots_coords ON planet_snapshots(coords);
    CREATE INDEX IF NOT EXISTS idx_decisions_cycle  ON decisions(cycle);
  `);
}

// ── Write helpers ──────────────────────────────────────────────────────────────

function savePlanetSnapshot(cycle, planet, resources, buildings = {}, fleet = {}, defense = {}) {
  const stmt = getDb().prepare(`
    INSERT INTO planet_snapshots
      (cycle, planet_id, planet_name, coords, is_moon, metal, crystal, deuterium, energy, buildings, fleet, defense)
    VALUES
      (@cycle, @planet_id, @planet_name, @coords, @is_moon, @metal, @crystal, @deuterium, @energy, @buildings, @fleet, @defense)
  `);
  stmt.run({
    cycle,
    planet_id:   String(planet.id),
    planet_name: planet.name,
    coords:      planet.coords,
    is_moon:     planet.isMoon ? 1 : 0,
    metal:       resources.metal    || 0,
    crystal:     resources.crystal  || 0,
    deuterium:   resources.deuterium|| 0,
    energy:      resources.energy   || 0,
    buildings:   JSON.stringify(buildings),
    fleet:       JSON.stringify(fleet),
    defense:     JSON.stringify(defense),
  });
}

function saveDecision(cycle, type, planetFrom, planetTo, payload, reasoning, confidence = 0.8) {
  getDb().prepare(`
    INSERT INTO decisions (cycle, decision_type, planet_from, planet_to, payload, reasoning, confidence)
    VALUES (@cycle, @type, @planetFrom, @planetTo, @payload, @reasoning, @confidence)
  `).run({ cycle, type, planetFrom: planetFrom || '', planetTo: planetTo || '', payload: JSON.stringify(payload), reasoning, confidence });
}

function saveCycleTotals(cycle, snapshots, decisionCount, aiAdvice = '') {
  const total = snapshots.reduce((acc, s) => ({
    metal:     acc.metal     + (s.resources?.metal     || 0),
    crystal:   acc.crystal   + (s.resources?.crystal   || 0),
    deuterium: acc.deuterium + (s.resources?.deuterium || 0),
  }), { metal: 0, crystal: 0, deuterium: 0 });

  getDb().prepare(`
    INSERT OR REPLACE INTO cycle_totals
      (cycle, total_metal, total_crystal, total_deuterium, planet_count, decision_count, ai_advice)
    VALUES
      (@cycle, @total_metal, @total_crystal, @total_deuterium, @planet_count, @decision_count, @ai_advice)
  `).run({
    cycle,
    total_metal:     total.metal,
    total_crystal:   total.crystal,
    total_deuterium: total.deuterium,
    planet_count:    snapshots.length,
    decision_count:  decisionCount,
    ai_advice:       aiAdvice,
  });
}

function saveDirective(directive) {
  if (!directive) return;
  getDb().prepare(`
    UPDATE directives SET active = 0 WHERE active = 1
  `).run();
  getDb().prepare(`
    INSERT INTO directives (text, set_at, cycle, active) VALUES (?, ?, ?, 1)
  `).run(directive.text, directive.setAt, directive.cycle ?? 0);
}

function loadActiveDirective() {
  const row = getDb().prepare(`
    SELECT text, set_at as setAt, cycle FROM directives WHERE active = 1 ORDER BY id DESC LIMIT 1
  `).get();
  return row || null;
}

function clearSavedDirective() {
  getDb().prepare(`UPDATE directives SET active = 0 WHERE active = 1`).run();
}



function getLastNcycles(n = 5) {
  return getDb().prepare(`
    SELECT cycle, total_metal, total_crystal, total_deuterium, planet_count, ai_advice, ts
    FROM cycle_totals ORDER BY cycle DESC LIMIT ?
  `).all(n);
}

function getGrowthTrend() {
  const rows = getLastNcycles(10);
  if (rows.length < 2) return null;
  const newest = rows[0];
  const oldest = rows[rows.length - 1];
  return {
    metalDelta:     newest.total_metal     - oldest.total_metal,
    crystalDelta:   newest.total_crystal   - oldest.total_crystal,
    deuteriumDelta: newest.total_deuterium - oldest.total_deuterium,
    cycles:         rows.length,
  };
}

module.exports = { savePlanetSnapshot, saveDecision, saveCycleTotals, getLastNcycles, getGrowthTrend, saveDirective, loadActiveDirective, clearSavedDirective };
