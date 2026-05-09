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

Given the player's directive and their current game state, return:
1. The primary OGame tactic to use: "economics", "defense", "attacker", or "collector"
2. Specific params for that tactic (e.g. which planets to target, what resources to move, how aggressive to be)
3. A plain-English explanation of WHAT will happen when this executes
4. Whether this is DESTRUCTIVE — meaning it would very likely destroy the player's fleet or severely damage their empire
   (only flag as destructive for clear catastrophic risks: attacking a planet with 10x stronger defense than our fleet)
5. If destructive, a brief reason why

Respond ONLY with valid JSON — no markdown:
{
  "tactic": "attacker" | "economics" | "defense" | "collector",
  "params": {
    "preferNearby": true | false,
    "aggressiveness": "conservative" | "normal" | "aggressive",
    "buildTarget": "Building Name or null",
    "notes": "any extra execution notes"
  },
  "explanation": "≤60-word plain English: what the agent will do to carry out this command",
  "destructive": false,
  "destructiveReason": "null or brief reason why this is risky"
}`;

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

    const response = await client.chat.completions.create({
      model:       MODEL,
      max_tokens:  300,
      temperature: 0.3,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user',   content: `Game state:\n${JSON.stringify(context, null, 2)}\n\nPlayer directive: "${directiveText}"\n\nHow should the agent execute this?` },
      ],
      response_format: { type: 'json_object' },
    });

    const raw = response.choices[0]?.message?.content ?? '{}';
    const result = JSON.parse(raw);

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
