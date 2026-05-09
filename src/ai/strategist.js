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

Your job is to produce strategic recommendations by calling the available tools.

AVAILABLE TOOLS — call each tool with parameters that match the requirements below:

TOOL 1: plan_planet(coords, buildNext, buildId, reason, urgent)
- Recommend a specific building construction on a planet
- coords: "G:S:P" format
- buildNext: full building name (e.g., "Metal Mine")
- buildId: OGame tech ID number
- reason: brief explanation (≤ 50 chars)
- urgent: true only if energy is critically low or queue can afford it

TOOL 2: move_transport(from, to, metal, crystal, deuterium, reason)
- Recommend resource transport between planets
- from/to: "G:S:P" format
- metal/crystal/deuterium: amounts to transfer (0 if none)
- reason: why this transport is beneficial (≤ 50 chars)

TOOL 3: recommend_research(techName, priority)
- Recommend a global research investment
- techName: full technology name or null
- priority: "high" | "normal" | "low"

KEY RULES:
- Buildings listed under "buildings" use OGame technology IDs (1=Metal Mine, 2=Crystal Mine, 3=Deut Synthesizer, 4=Solar Plant, 12=Metal Storage, 13=Crystal Storage, 14=Deuterium Tank, 21=Robotics Factory, 22=Missile Silo, 23=Research Lab, 15=Shipyard, 31=Lunar Base, 33=Sensor Phalanx, 34=Jump Gate)
- Solar Plant (id=4) should only be recommended if energy is NEGATIVE (deficit)
- Main energy source is Solar Satellites — prefer mines over power plants
- Research is global — recommend it only once (for any planet)
- Transports: only recommend if source planet has enough resources AND the target genuinely needs them for a specific build
- Transport ships: Large Cargo (id=203) carries 25000 units each — check fleet before recommending transport
- If a planet queue is busy, recommend the NEXT build not the current one

Call tools only when you have a concrete recommendation. If no action needed for a category, omit that tool call.`;

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

// ── Tool Call Parsing ────────────────────────────────────────────────────────

/**
 * Parse tool calls from AI response and convert to structured plan object.
 */
function parseToolCalls(response) {
  const plan = {
    planetActions: [],
    transports: [],
    researchNext: null,
    advice: '',
    confidence: 0.5,
  };

  const tools = response.choices?.[0]?.message?.tool_calls ?? [];
  
  for (const toolCall of tools) {
    const func = toolCall.function;
    const name = func.name;
    const args = JSON.parse(func.arguments);

    if (name === 'plan_planet') {
      plan.planetActions.push(args);
    } else if (name === 'move_transport') {
      plan.transports.push(args);
    } else if (name === 'recommend_research') {
      if (args.techName && args.priority !== 'low') {
        plan.researchNext = `${args.techName} (${args.priority})`;
      }
    }
  }

  // Extract advice from tool call reason fields or use default
  const allReasons = [
    ...(plan.planetActions?.map(a => a.reason) ?? []),
    ...(plan.transports?.map(t => t.reason) ?? [])
  ];
  plan.advice = `Plan: ${allReasons.length} recommendations. Prioritise economy and energy.`;

  return plan;
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

    const tools = [
      {
        type: "function",
        function: {
          name: "plan_planet",
          description: "Recommend a specific building construction on a planet. Use when you have identified what to build next.",
          parameters: {
            type: "object",
            properties: {
              coords:    { type: "string" },
              buildNext: { type: "string" },
              buildId:   { type: "integer" },
              reason:    { type: "string" },
              urgent:    { type: "boolean" }
            },
            required: ["coords", "buildNext", "buildId", "reason", "urgent"]
          }
        }
      },
      {
        type: "function",
        function: {
          name: "move_transport",
          description: "Recommend a resource transport between planets. Use when source has surplus and target needs for specific builds.",
          parameters: {
            type: "object",
            properties: {
              from:     { type: "string" },
              to:       { type: "string" },
              metal:    { type: "integer" },
              crystal:  { type: "integer" },
              deuterium:{ type: "integer" },
              reason:   { type: "string" }
            },
            required: ["from", "to", "metal", "crystal", "deuterium", "reason"]
          }
        }
      },
      {
        type: "function",
        function: {
          name: "recommend_research",
          description: "Recommend a global research investment. Use once to identify priority tech.",
          parameters: {
            type: "object",
            properties: {
              techName:  { type: "string" },
              priority:  { type: "string", enum: ["high", "normal", "low"] }
            },
            required: ["techName", "priority"]
          }
        }
      }
    ];

    const response = await client.chat.completions.create({
      model:       MODEL,
      max_tokens:  700,
      temperature: 0.2,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user',   content: `Planet snapshots:\n${userMsg}\n\nCall tools with your strategic recommendations.` },
      ],
      tools: tools,
    });

    const plan = parseToolCalls(response);

    logger.info(`[Strategist] Plan ready: ${plan.planetActions.length} actions, ${plan.transports.length} transports. ${plan.advice}`);

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
