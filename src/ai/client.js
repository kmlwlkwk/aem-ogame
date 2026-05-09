/**
 * OpenAI-compatible client configured for OVHcloud (or any OpenAI-compatible endpoint).
 *
 * Required env vars:
 *   OPENAI_API_KEY   — your OVHcloud AI endpoint key
 *   OPENAI_BASE_URL  — e.g. https://oai.endpoints.kepler.ai.cloud.ovh.net/v1
 *   OPENAI_MODEL     — model name exposed by the endpoint (e.g. gpt-4o, Llama-3.3-70B-Instruct)
 */

const OpenAI = require('openai');

if (!process.env.OPENAI_API_KEY) {
  throw new Error('OPENAI_API_KEY is required for AI decision-making');
}

const client = new OpenAI({
  apiKey:  process.env.OPENAI_API_KEY,
  baseURL: process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1',
});

const MODEL = process.env.OPENAI_MODEL || 'gpt-4o';

module.exports = { client, MODEL };
