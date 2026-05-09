/**
 * Human emulation layer.
 * All interactions go through these helpers to mimic real user behaviour:
 *  - Bézier-curve mouse paths
 *  - Random click offsets from element centre
 *  - Character-by-character typing with jitter and occasional typos
 *  - Stepped scrolling
 */

const { randomBetween, delay, humanDelay } = require('./delay');

// ── Mouse movement ────────────────────────────────────────────────────────────

/** Cubic Bézier interpolation for a single axis value. */
function bezier(t, p0, p1, p2, p3) {
  const mt = 1 - t;
  return mt * mt * mt * p0 + 3 * mt * mt * t * p1 + 3 * mt * t * t * p2 + t * t * t * p3;
}

/**
 * Move mouse from (fromX, fromY) to (toX, toY) along a randomised
 * cubic Bézier curve, emulating a natural hand movement.
 */
async function moveMouse(page, fromX, fromY, toX, toY) {
  const steps = randomBetween(10, 20);

  // Randomised control points create curve deviation
  const cp1x = fromX + (toX - fromX) * 0.25 + randomBetween(-60, 60);
  const cp1y = fromY + (toY - fromY) * 0.25 + randomBetween(-60, 60);
  const cp2x = fromX + (toX - fromX) * 0.75 + randomBetween(-60, 60);
  const cp2y = fromY + (toY - fromY) * 0.75 + randomBetween(-60, 60);

  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const x = bezier(t, fromX, cp1x, cp2x, toX);
    const y = bezier(t, fromY, cp1y, cp2y, toY);
    await page.mouse.move(x, y);
    // Variable speed: faster in the middle, slower near target
    const speedFactor = i < steps * 0.8 ? randomBetween(2, 6) : randomBetween(6, 15);
    await delay(speedFactor);
  }
}

/** Read the last known mouse position tracked by the injected script. */
async function getMousePos(page) {
  try {
    return await page.evaluate(() => [
      window.__mouseX ?? 400,
      window.__mouseY ?? 300,
    ]);
  } catch {
    return [400, 300];
  }
}

/**
 * Click an element with a realistic mouse path and a random offset
 * from the element's centre so clicks never land at the exact same pixel.
 */
async function humanClick(page, element) {
  const box = await element.boundingBox();
  if (!box) throw new Error('Element not visible / has no bounding box');

  const targetX = box.x + box.width / 2 + randomBetween(-Math.min(5, box.width / 4), Math.min(5, box.width / 4));
  const targetY = box.y + box.height / 2 + randomBetween(-Math.min(3, box.height / 4), Math.min(3, box.height / 4));

  const [fromX, fromY] = await getMousePos(page);
  await moveMouse(page, fromX, fromY, targetX, targetY);
  await delay(randomBetween(40, 120));
  await page.mouse.click(targetX, targetY);
}

/**
 * Click a CSS selector with human mouse movement.
 * Scrolls the element into view first.
 */
async function humanClickSelector(page, selector, timeout = 15000) {
  const el = await page.waitForSelector(selector, { timeout });
  await el.scrollIntoViewIfNeeded();
  await humanDelay(200, 500);
  await humanClick(page, el);
}

// ── Typing ────────────────────────────────────────────────────────────────────

/**
 * Type text character-by-character with realistic timing jitter.
 * Introduces occasional typos (2% chance per char) followed by a backspace.
 */
async function humanType(page, text) {
  for (const char of text) {
    // 2% chance of a fat-finger typo
    if (Math.random() < 0.02) {
      const adjacent = String.fromCharCode(char.charCodeAt(0) + (Math.random() < 0.5 ? 1 : -1));
      await page.keyboard.type(adjacent);
      await delay(randomBetween(150, 350));
      await page.keyboard.press('Backspace');
      await delay(randomBetween(80, 180));
    }
    await page.keyboard.type(char);
    await delay(randomBetween(30, 90));
  }
}

// ── Scrolling ────────────────────────────────────────────────────────────────

/**
 * Scroll the page by deltaY in small randomised steps (natural feel).
 */
async function humanScroll(page, deltaY) {
  const steps = randomBetween(3, 8);
  const stepSize = deltaY / steps;
  for (let i = 0; i < steps; i++) {
    await page.mouse.wheel(0, stepSize + randomBetween(-10, 10));
    await delay(randomBetween(40, 120));
  }
}

module.exports = { moveMouse, humanClick, humanClickSelector, humanType, humanScroll };
