/**
 * AI Analyst — hybrid decision layer.
 *
 * Called by the agent at the start of each cycle (or on anomalies).
 * Sends a structured game state + screenshot to the AI and receives
 * strategic guidance that overrides or adjusts the default tactic rotation.
 *
 * Response schema (JSON):
 * {
 *   "tacticOrder":   ["economics", "defense", "collector", "attacker"],
 *   "skipTactics":   [],
 *   "urgentAction":  null | { "tactic": "defense", "reason": "No shield dome" },
 *   "advice":        "Short human-readable summary of current strategy",
 *   "confidence":    0-1
 * }
 */

const logger              = require('../utils/logger');
const { client, MODEL }   = require('./client');
const { collectGameState }= require('./gameState');

// Consult AI at most every N cycles to avoid hammering the API
const AI_CONSULT_EVERY = parseInt(process.env.AI_CONSULT_EVERY ?? '1', 10); // every cycle
let cyclesSinceLastConsult = AI_CONSULT_EVERY; // force consult on first cycle

const VALID_TACTICS = ['economics', 'defense', 'collector', 'attacker'];

const SYSTEM_PROMPT = `\
You are an expert OGame strategy advisor embedded in an automated agent.
The agent manages a planet on OGame server s261 (Polish).

You will receive a structured JSON snapshot of the current game state.
Your job is to return tactical recommendations by calling available tools.

AVAILABLE TOOLS:

TOOL 1: set_tactic_order(economics, defense, collector, attacker)
- Arrange tactics in priority order for this cycle
- Each argument must be one of: "economics", "defense", "collector", "attacker"
- All four tactics must appear exactly once in the call

TOOL 2: skip_tactics(economics|defense|collector|attacker|null)
- Skip a specific tactic this cycle (pass null if none to skip)
- Use only when absolutely necessary due to game state constraints

TOOL 3: flag_urgent_action(tactic, reason)
- Flag an urgent action that must be prioritized above all else
- tactic: "economics" | "defense" | "collector" | "attacker"
- reason: brief explanation (≤ 50 chars)

RULES (non-negotiable):
  - NEVER include or recommend attacking active players.
  - Do NOT skip "defense" unless defenses.totalPoints is high AND both
    shield domes (ids 407 and 408) are already built.
  - If building/research queues are busy, deprioritise "economics".
  - Prioritise long-term survival and economy over aggression.
  - "attacker" should be last unless there is a clear profitable target.

Call set_tactic_order as your primary recommendation. Call other tools only if specific conditions apply.`;

// ── Tool Call Parsing for consult() ───────────────────────────────────────────

function parseConsultTools(response) {
  const result = {
    tacticOrder:  ['economics', 'defense', 'collector', 'attacker'],
    skipTactics:  [],
    urgentAction: null,
    advice:       'Using default tactic order (AI not consulted this cycle).',
    confidence:   1.0,
  };

  const tools = response.choices?.[0]?.message?.tool_calls ?? [];
  
  for (const toolCall of tools) {
    const func = toolCall.function;
    const name = func.name;
    const args = JSON.parse(func.arguments);

    if (name === 'set_tactic_order') {
      // Extract from function arguments — should be all four tactics
      result.tacticOrder = [args.economics, args.defense, args.collector, args.attacker].filter(Boolean);
    } else if (name === 'skip_tactics' && args) {
      const skipped = ['economics', 'defense', 'collector', 'attacker'];
      if (skipped.includes(args)) {
        result.skipTactics.push(args);
      }
    } else if (name === 'flag_urgent_action') {
      result.urgentAction = { tactic: args.tactic, reason: args.reason };
    }
  }

  // Generate advice from tool calls
  const reasons = [
    ...result.skipTactics.map(s => `Skipping ${s}`),
    ...(result.urgentAction ? [`Urgent: ${result.urgentAction.tactic} — ${result.urgentAction.reason}`] : [])
  ];
  result.advice = `AI analysis: ${reasons.join('; ') || 'Standard priority order.'}`;

  return result;
}

async function askAI(gameState) {
  const stateJson = JSON.stringify(gameState, null, 2);

  const tools = [
    {
      type: "function",
      function: {
        name: "set_tactic_order",
        description: "Set the priority order for tactics this cycle. Must include all four tactics exactly once.",
        parameters: {
          type: "object",
          properties: {
            economics:{ type: "string" },
            defense:   { type: "string" },
            collector: { type: "string" },
            attacker:  { type: "string" }
          },
          required: ["economics", "defense", "collector", "attacker"]
        }
      }
    },
    {
      type: "function",
      function: {
        name: "skip_tactics",
        description: "Skip a specific tactic this cycle. Pass null if no tactics to skip.",
        parameters: {
          type: "object",
          properties: {
            economics:{ 
              type: "string", 
              enum: ["economics", "defense", "collector", "attacker"] 
            },
            defense:   { 
              type: "string", 
              enum: ["economics", "defense", "collector", "attacker"] 
            },
            collector: { 
              type: "string", 
              enum: ["economics", "defense", "collector", "attacker"] 
            },
            attacker:  { 
              type: "string", 
              enum: ["economics", "defense", "collector", "attacker"] 
            }
          },
          required: []
        }
      }
    },
    {
      type: "function",
      function: {
        name: "flag_urgent_action",
        description: "Flag an urgent action that must be prioritized immediately.",
        parameters: {
          type: "object",
          properties: {
            tactic:{ 
              type: "string", 
              enum: ["economics", "defense", "collector", "attacker"] 
            },
            reason:  { type: "string", maxLength: 50 }
          },
          required: ["tactic", "reason"]
        }
      }
    }
  ];

  const response = await client.chat.completions.create({
    model:       MODEL,
    max_tokens:  300,
    temperature: 0.2,
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user',   content: `Current game state:\n\`\`\`json\n${stateJson}\n\`\`\`\n\nCall set_tactic_order with your recommended priority sequence.` },
    ],
    tools,
  });

  return parseConsultTools(response);
}

// ── Default fallback ──────────────────────────────────────────────────────────

function defaultRecommendation() {
  return {
    tacticOrder:  ['economics', 'defense', 'collector', 'attacker'],
    skipTactics:  [],
    urgentAction: null,
    advice:       'Using default tactic order (AI not consulted this cycle).',
    confidence:   1.0,
  };
}

// ── Element discovery via AI ──────────────────────────────────────────────────

/**
 * When normal CSS selectors fail, extract all interactive elements from the
 * current page and ask the AI to identify which one matches the description.
 *
 * Returns { selector, text, found } — selector is a best-effort CSS string
 * the caller can use to click the element.
 */
async function findElementWithAI(page, description) {
  const aiEnabled = !!process.env.OPENAI_API_KEY;
  if (!aiEnabled) return { found: false };

  try {
    logger.info(`[AI] Element discovery: looking for "${description}" …`);

    // Collect all interactive elements with enough context to identify them
    const elements = await page.evaluate(() => {
      const sel = 'a, button, [role="tab"], li[id], li[data-tab], [data-tab], [data-messagetyp], .tab, .subtab';
      return [...document.querySelectorAll(sel)]
        .slice(0, 80)
        .map((el, idx) => ({
          idx,
          tag:      el.tagName,
          id:       el.id || '',
          classes:  el.className?.toString().slice(0, 80) || '',
          text:     (el.innerText || el.textContent || '').trim().slice(0, 60),
          href:     el.getAttribute('href') || '',
          dataTab:  el.dataset?.tab || el.dataset?.messagetyp || '',
          visible:  el.offsetParent !== null,
        }))
        .filter(el => el.text || el.id || el.dataTab);
    });

    const tools = [
      {
        type: "function",
        function: {
          name: "select_element",
          description: "Identify the element that best matches the given description. Return idx of matching element or -1 if not found.",
          parameters: {
            type: "object",
            properties: {
              idx:    { 
                type: "integer", 
                description: "Element index from the provided list, or -1 if nothing matches" 
              },
              reason:{ 
                type: "string", 
                description: "Brief explanation of why this element (or lack thereof) was chosen" 
              }
            },
            required: ["idx", "reason"]
          }
        }
      }
    ];

    const response = await client.chat.completions.create({
      model:       MODEL,
      max_tokens:  150,
      temperature: 0.1,
      messages: [
        {
          role: 'system',
          content:
            'You are an OGame UI expert. Given interactive DOM elements from an OGame page, ' +
            'identify which element best matches the description. ' +
            'Return JSON using tool_calling format with select_element tool.',
        },
        {
          role: 'user',
          content: `Looking for: ${description}\n\nPage URL contains: "${page.url().split('?')[1] ?? ''}"\n\nElements:\n${JSON.stringify(elements, null, 2)}`,
        },
      ],
      tools,
    });

    const result = parseElementTools(response);
    if (result.idx < 0 || result.idx >= elements.length) {
      logger.warn(`[AI] Element discovery: not found — ${result.reason}`);
      return { found: false };
    }

    const match = elements[result.idx];
    logger.info(`[AI] Element found: "${match.text}" (${match.tag}#${match.id}) — ${result.reason}`);

    // Build a best-effort selector
    let selector = match.tag.toLowerCase();
    if (match.id)      selector = `#${match.id}`;
    else if (match.dataTab) selector = `[data-tab="${match.dataTab}"], [data-messagetyp="${match.dataTab}"]`;
    else if (match.text)    selector = `${match.tag.toLowerCase()}:has-text("${match.text.slice(0, 30)}")`;

    return { found: true, selector, text: match.text, element: match };
  } catch (err) {
    logger.warn(`[AI] Element discovery failed: ${err.message}`);
    return { found: false };
  }
}

// ── Tool Call Parsing for findElementWithAI() ─────────────────────────────────

function parseElementTools(response) {
  const tools = response.choices?.[0]?.message?.tool_calls ?? [];
  
  if (tools.length > 0) {
    const func = tools[0].function;
    const args = JSON.parse(func.arguments);
    return { idx: args.idx, reason: args.reason };
  }

  return { idx: -1, reason: 'no tool call — fallback to default' };
}

// ── Espionage target analysis ─────────────────────────────────────────────────

/**
 * Ask the AI whether a specific raid target is worth attacking.
 * Returns { attack: boolean, reason: string, confidence: number }
 */
async function analyzeTarget(targetData) {
  const aiEnabled = !!process.env.OPENAI_API_KEY;
  if (!aiEnabled) return { attack: false, reason: 'AI disabled', confidence: 0 };

  try {
    const tools = [
      {
        type: "function",
        function: {
          name: "evaluate_attack_target",
          description: "Evaluate whether attacking an inactive target is profitable and safe. Never recommend if defensePoints > 5000 or reportAgeHours > 6.",
          parameters: {
            type: "object",
            properties: {
              attack:     { type: "boolean" },
              reason:     { 
                type: "string", 
                description: "Brief explanation of why this target is recommended or not" 
              },
              confidence: { 
                type: "number", 
                description: "Confidence in the evaluation (0.0-1.0)" 
              }
            },
            required: ["attack", "reason", "confidence"]
          }
        }
      }
    ];

    const response = await client.chat.completions.create({
      model:       MODEL,
      max_tokens:  120,
      temperature: 0.1,
      messages: [
        {
          role: 'system',
          content:
            'You are an OGame combat strategist. Evaluate whether attacking this inactive target is profitable and safe. ' +
            'Consider: resources vs fleet cost, defense level, report age. ' +
            'NEVER recommend attacking if defensePoints > 5000 or reportAgeHours > 6. ' +
            'Call the evaluate_attack_target tool with your recommendation.',
        },
        {
          role: 'user',
          content: `Target data:\n${JSON.stringify(targetData, null, 2)}`,
        },
      ],
      tools,
    });

    const result = parseTargetTools(response);
    logger.info(`[AI] Target ${targetData.coords}: attack=${result.attack} — ${result.reason}`);
    return result;
  } catch (err) {
    logger.warn(`[AI] Target analysis failed: ${err.message}`);
    return { attack: false, reason: 'AI error', confidence: 0 };
  }
}

// ── Tool Call Parsing for analyzeTarget() ─────────────────────────────────────

function parseTargetTools(response) {
  const tools = response.choices?.[0]?.message?.tool_calls ?? [];
  
  if (tools.length > 0) {
    const func = tools[0].function;
    const args = JSON.parse(func.arguments);
    return { attack: !!args.attack, reason: args.reason, confidence: args.confidence || 0 };
  }

  return { attack: false, reason: 'no tool call — default to no attack', confidence: 0 };
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Consult the AI analyst.
 * Returns a recommendation object. Falls back to defaults on any error.
 *
 * @param {import('playwright').Page} page
 * @param {boolean} force  - bypass the cycle throttle
 */
async function consult(page, force = false) {
  cyclesSinceLastConsult++;

  const aiEnabled = !!process.env.OPENAI_API_KEY;
  if (!aiEnabled) {
    logger.info('[AI] OPENAI_API_KEY not set — using default tactic order');
    return defaultRecommendation();
  }

  if (!force && cyclesSinceLastConsult < AI_CONSULT_EVERY) {
    logger.info(`[AI] Skipping AI consult (next in ${AI_CONSULT_EVERY - cyclesSinceLastConsult} cycle(s))`);
    return defaultRecommendation();
  }

  logger.info('[AI] Consulting AI analyst …');
  cyclesSinceLastConsult = 0;

  try {
    const gameState = await collectGameState(page, { fast: true });

    const recommendation = await askAI(gameState);

    // Validate — ensure tacticOrder contains only known tactic names
    if (!Array.isArray(recommendation.tacticOrder) || !recommendation.tacticOrder.length) {
      throw new Error('AI returned invalid tacticOrder');
    }
    recommendation.tacticOrder = recommendation.tacticOrder.filter(t => VALID_TACTICS.includes(t));
    recommendation.skipTactics  = (recommendation.skipTactics ?? []).filter(t => VALID_TACTICS.includes(t));
    if (recommendation.urgentAction && !VALID_TACTICS.includes(recommendation.urgentAction.tactic)) {
      recommendation.urgentAction = null;
    }

    logger.info(`[AI] Recommendation: ${JSON.stringify(recommendation)}`);
    logger.info(`[AI] Advice: ${recommendation.advice}`);

    if (recommendation.urgentAction) {
      logger.warn(`[AI] ⚡ Urgent: run "${recommendation.urgentAction.tactic}" — ${recommendation.urgentAction.reason}`);
    }

    return recommendation;
  } catch (err) {
    logger.error(`[AI] Error during consultation: ${err.message} — falling back to defaults`);
    return defaultRecommendation();
  }
}

module.exports = { consult, findElementWithAI, analyzeTarget };
