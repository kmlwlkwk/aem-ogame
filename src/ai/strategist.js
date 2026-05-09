/**
 * AI Strategist — holistic multi-planet strategic planner.
 *
 * Unlike the analyst (which orders tactics per cycle), the strategist
 * receives full snapshots of ALL planets and produces:
 *   1. Per-planet build recommendations
 *   2. Resource transport instructions (move resources to enable builds)
 *   3. A plain-English strategic summary
 *
 * This mirrors how an experienced player thinks: survey everything first,
 * then decide where resources are best spent.
 */

const logger            = require('../utils/logger');
const { client, MODEL } = require('./client');
const { getLastNcycles, getGrowthTrend } = require('../db/index');

const SYSTEM_PROMPT = `\
You are an expert OGame strategist managing a multi-planet empire on server s261 (English).
You receive a JSON snapshot of ALL planets with their resources, building levels, fleet, and energy.

Your job is to produce a strategic build plan that maximises long-term economic growth and defense.

KEY RULES:
- Buildings listed under "buildings" use OGame technology IDs (1=Metal Mine, 2=Crystal Mine, 3=Deut Synthesizer, 4=Solar Plant, 12=Metal Storage, 13=Crystal Storage, 14=Deuterium Tank, 21=Robotics Factory, 22=Missile Silo, 23=Research Lab, 15=Shipyard, 31=Lunar Base, 33=Sensor Phalanx, 34=Jump Gate)
- Solar Plant (id=4) should only be recommended if energy is NEGATIVE (deficit)
- Main energy source is Solar Satellites — prefer mines over power plants
- Research is global — recommend it only once (for any planet)
- Transports: only recommend if source planet has enough resources AND the target genuinely needs them for a specific build
- Transport ships: Large Cargo (id=203) carries 25000 units each — check fleet before recommending transport
- If a planet queue is busy, recommend the NEXT build not the current one

Respond ONLY with valid JSON — no markdown:
{
  "planetActions": [
    {
      "coords": "G:S:P",
      "buildNext": "Building Name",
      "buildId": N,
      "reason": "short reason",
      "urgent": false
    }
  ],
  "transports": [
    {
      "from": "G:S:P",
      "to": "G:S:P",
      "metal": N,
      "crystal": N,
      "deuterium": N,
      "reason": "short reason"
    }
  ],
  "researchNext": "Tech Name or null",
  "advice": "≤80-word strategic summary",
  "confidence": 0.0-1.0
}`;

// ── Helpers ───────────────────────────────────────────────────────────────────

function summariseSnapshot(snap) {
  return {
    coords:    snap.planet.coords,
    name:      snap.planet.name,
    isMoon:    snap.planet.isMoon,
    resources: snap.resources,
    energy:    snap.energy,
    buildings: snap.buildings,      // { techId: level }
    fleet:     snap.fleet,          // { shipId: count }
    defense:   snap.defense,        // { defId: count }
  };
}

// ── Main API ──────────────────────────────────────────────────────────────────

/**
 * Ask the AI for a full strategic plan based on all planet snapshots.
 * Directive handling is done by the agent — AI only plans builds/transports.
 * @param {object[]} snapshots  - planet scan results
 */
async function strategize(snapshots) {
  if (!process.env.OPENAI_API_KEY) {
    logger.info('[Strategist] AI disabled — no strategic plan');
    return defaultPlan(snapshots);
  }

  try {
    const planets = snapshots.map(summariseSnapshot);
    const trend   = getGrowthTrend();

    const userMsg = JSON.stringify({
      planets,
      growthTrend:  trend,
      totalPlanets: snapshots.length,
    }, null, 2);

    logger.info(`[Strategist] Requesting strategic plan for ${snapshots.length} planets …`);

    const response = await client.chat.completions.create({
      model:       MODEL,
      max_tokens:  700,
      temperature: 0.2,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user',   content: `Planet snapshots:\n\`\`\`json\n${userMsg}\n\`\`\`\n\nReturn your strategic plan.` },
      ],
      response_format: { type: 'json_object' },
    });

    const raw  = response.choices[0]?.message?.content ?? '{}';
    const plan = JSON.parse(raw);

    if (!Array.isArray(plan.planetActions)) plan.planetActions = [];
    if (!Array.isArray(plan.transports))    plan.transports    = [];

    logger.info(`[Strategist] Plan ready: ${plan.planetActions.length} actions, ${plan.transports.length} transports. ${plan.advice ?? ''}`);

    return plan;
  } catch (err) {
    logger.error(`[Strategist] Error: ${err.message} — using default plan`);
    return defaultPlan(snapshots);
  }
}

/** Minimal fallback plan when AI is unavailable. */
function defaultPlan(snapshots) {
  return {
    planetActions: snapshots
      .filter(s => !s.planet.isMoon)
      .map(s => ({
        coords:    s.planet.coords,
        buildNext: 'Metal Mine',
        buildId:   1,
        reason:    'Default: upgrade primary resource producer',
        urgent:    false,
      })),
    transports:   [],
    researchNext: null,
    advice:       'Default plan — AI not available.',
    confidence:   0.5,
  };
}

module.exports = { strategize };
