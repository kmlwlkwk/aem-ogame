/**
 * Director — interprets player directives into concrete in-game actions.
 *
 * The player is the highest authority. This module:
 *   1. Asks AI HOW to execute the directive (specific OGame actions)
 *   2. Checks if it would be DESTRUCTIVE for the empire
 *   3. Returns { tactic, params, explanation, destructive, destructiveReason }
 *
 * The agent then:
 *   - Executes if not destructive, OR if the player used "force:" prefix
 *   - Holds and warns the player if destructive and not forced
 *
 * AI does NOT get to substitute a different action for the player's command.
 */

const logger            = require('../utils/logger');
const { client, MODEL } = require('./client');

const SYSTEM_PROMPT = `\
You are advising a player in OGame (browser space strategy game) on HOW to execute their command.
Your role is strictly advisory — you must NOT substitute a different action for what the player asked.

AVAILABLE TOOLS:

TOOL 1: interpret_directive(tactic, params, explanation, destructive, destructiveReason)
- tactic: "economics" | "defense" | "attacker" | "collector"
- params: object with preferNearby (bool), aggressiveness ("conservative"|"normal"|"aggressive"), buildTarget (string|null), notes (string)
- explanation: ≤ 60-word plain English of what the agent will do
- destructive: boolean — true only for clear catastrophic risks
- destructiveReason: null or brief reason why this is risky

CALL THE TOOL with your interpretation. Return ONLY one tool call matching the player's directive intent.`;

// ── Tool Call Parsing ────────────────────────────────────────────────────────

function parseToolCalls(response) {
  const result = {
    tactic: 'economics',
    params:   { preferNearby: true, aggressiveness: 'normal', buildTarget: null, notes: '' },
    explanation: '',
    destructive: false,
    destructiveReason: null,
  };

  const tools = response.choices?.[0]?.message?.tool_calls ?? [];
  
  for (const toolCall of tools) {
    const func = toolCall.function;
    const name = func.name;
    const args = JSON.parse(func.arguments);

    if (name === 'interpret_directive') {
      result.tactic = args.tactic || 'economics';
      result.params = args.params || { preferNearby: true, aggressiveness: 'normal', buildTarget: null, notes: '' };
      result.explanation = args.explanation || '';
      result.destructive = !!args.destructive;
      result.destructiveReason = args.destructiveReason || null;
    }
  }

  return result;
}

// ── Main API ──────────────────────────────────────────────────────────────────

/**
 * Interpret a player directive into a concrete execution plan.
 *
 * @param {string} directiveText - raw player command
 * @param {object[]} snapshots   - current planet snapshots (for fleet/defense context)
 * @returns {object} interpretation
 */
async function interpretDirective(directiveText, snapshots = []) {
  if (!process.env.OPENAI_API_KEY) {
    return defaultInterpretation(directiveText);
  }

  try {
    // Summarise fleet and defense totals — enough context without sending full planet data
    const fleetSummary = {};
    const defenseSummary = {};
    let totalFleetValue = 0;

    for (const snap of snapshots) {
      for (const [id, count] of Object.entries(snap.fleet ?? {})) {
        fleetSummary[id] = (fleetSummary[id] || 0) + count;
        // Rough fleet value estimate (metal equivalent)
        totalFleetValue += count * (id === '204' ? 160000 : id === '205' ? 250000 : 4000);
      }
      for (const [id, count] of Object.entries(snap.defense ?? {})) {
        defenseSummary[id] = (defenseSummary[id] || 0) + count;
      }
    }

    const context = {
      directive:      directiveText,
      planets:        snapshots.length,
      totalFleetValue,
      fleet:          fleetSummary,
      homePlanetDefense: defenseSummary,
    };

    logger.info(`[Director] Interpreting directive: "${directiveText}"`);

    const tools = [
      {
        type: "function",
        function: {
          name: "interpret_directive",
          description: "Interpret a player directive into specific OGame tactic and parameters. Returns the recommended execution approach.",
          parameters: {
            type: "object",
            properties: {
              tactic:         { type: "string", enum: ["economics", "defense", "attacker", "collector"] },
              params:         {
                type: "object",
                properties: {
                  preferNearby:  { type: "boolean" },
                  aggressiveness:{ 
                    type: "string", 
                    enum: ["conservative", "normal", "aggressive"] 
                  },
                  buildTarget:   { type: ["string", "null"], nullable: true },
                  notes:         { type: "string" }
                },
                required: ["preferNearby", "aggressiveness", "buildTarget", "notes"]
              },
              explanation:     { 
                type: "string", 
                description: "Plain English explanation of what the agent will do (≤ 60 words)" 
              },
              destructive:     { type: "boolean" },
              destructiveReason:{ 
                type: ["string", "null"], 
                nullable: true,
                description: "Brief reason why this is risky, or null if not destructive"
              }
            },
            required: ["tactic", "params", "explanation", "destructive", "destructiveReason"]
          }
        }
      }
    ];

    const response = await client.chat.completions.create({
      model:       MODEL,
      max_tokens:  300,
      temperature: 0.3,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user',   content: `Game state:\n${JSON.stringify(context, null, 2)}\n\nPlayer directive: "${directiveText}"\n\nCall interpret_directive with your analysis.` },
      ],
      tools: tools,
    });

    const result = parseToolCalls(response);

    logger.info(`[Director] Interpretation: tactic=${result.tactic} destructive=${result.destructive}`);
    logger.info(`[Director] Plan: ${result.explanation}`);
    if (result.destructive) {
      logger.warn(`[Director] ⚠️  Destructive risk: ${result.destructiveReason}`);
    }

    return result;
  } catch (err) {
    logger.error(`[Director] Interpretation failed: ${err.message}`);
    return defaultInterpretation(directiveText);
  }
}

/** Fallback when AI is unavailable — optimistic, non-destructive. */
function defaultInterpretation(text) {
  const lower = text.toLowerCase();
  let tactic = 'economics';
  if (/attack|raid|loot|farm|inactive/.test(lower)) tactic = 'attacker';
  else if (/defend|shield|protect/.test(lower))      tactic = 'defense';
  else if (/collect|debris/.test(lower))             tactic = 'collector';

  return {
    tactic,
    params: { preferNearby: true, aggressiveness: 'normal', buildTarget: null, notes: '' },
    explanation: `Executing "${text}" via ${tactic} tactic (AI offline — default interpretation).`,
    destructive: false,
    destructiveReason: null,
  };
}

module.exports = { interpretDirective };
