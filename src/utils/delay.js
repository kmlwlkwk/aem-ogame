/**
 * Human-like timing utilities.
 * All delays are non-uniform to avoid bot-detection fingerprinting.
 */

function randomBetween(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/** Short pause between UI actions (200–600 ms) */
async function humanDelay(minMs = 200, maxMs = 600) {
  await delay(randomBetween(minMs, maxMs));
}

/**
 * "Reading the screen" pause after navigation.
 * Uses a lognormal-like distribution so most pauses are short
 * but occasional long ones (up to ~5s) happen naturally.
 */
async function thinkTime() {
  // Base 400–1200ms, but 15% of the time add an extra 1–4s "really reading" pause
  const base = randomBetween(400, 1200);
  const extra = Math.random() < 0.15 ? randomBetween(1000, 4000) : 0;
  await delay(base + extra);
}

/**
 * A quicker scan-mode think — for when you're efficiently clicking through planets.
 * 150–600ms, with rare 800ms outlier.
 */
async function scanThink() {
  const base = randomBetween(150, 600);
  const extra = Math.random() < 0.08 ? randomBetween(400, 800) : 0;
  await delay(base + extra);
}

/**
 * "Burst" mode — very fast, like you know exactly what you're doing.
 * 80–300ms
 */
async function burstDelay() {
  await delay(randomBetween(80, 300));
}

/** Simulates stepping away from keyboard (2–5 min) */
async function idleBreak() {
  const ms = randomBetween(120_000, 300_000);
  await delay(ms);
}

/**
 * Simulate a brief distraction — mouse wander, pause, then resume.
 * 2–8 seconds. Used rarely to break up scan patterns.
 */
async function microDistraction() {
  await delay(randomBetween(2000, 8000));
}

module.exports = { delay, humanDelay, thinkTime, scanThink, burstDelay, microDistraction, idleBreak, randomBetween };
