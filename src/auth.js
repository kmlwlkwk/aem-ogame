const fs   = require('fs');
const path = require('path');

const logger     = require('./utils/logger');
const { humanClick, humanType } = require('./utils/human');
const { thinkTime, humanDelay, delay } = require('./utils/delay');
const { goto, waitFor, BASE_URL }      = require('./utils/navigation');

const SESSION_FILE = process.env.SESSION_FILE || './session.json';

// ── Session persistence ───────────────────────────────────────────────────────

async function saveSession(context) {
  const cookies = await context.cookies();
  fs.writeFileSync(SESSION_FILE, JSON.stringify({ cookies, savedAt: new Date().toISOString() }, null, 2));
  logger.info('Session saved to disk');
}

async function loadSession(context) {
  if (!fs.existsSync(SESSION_FILE)) return false;
  try {
    const { cookies } = JSON.parse(fs.readFileSync(SESSION_FILE, 'utf8'));
    if (cookies?.length) {
      await context.addCookies(cookies);
      logger.info('Loaded session from disk');
      return true;
    }
  } catch (e) {
    logger.warn(`Could not load session: ${e.message}`);
  }
  return false;
}

// ── Cookie banner ─────────────────────────────────────────────────────────────

/**
 * Dismiss the Gameforge cookie consent banner if present.
 * The "Accept" button has class cookiebanner5 but NOT cookiebanner6
 * (cookiebanner6 is the settings button).
 */
async function dismissCookieBanner(page) {
  const COOKIE_SELECTORS = [
    'button.cookiebanner5:not(.cookiebanner6)',
    'button:text("Zaakceptuj cookie")',
    'button:text("Accept")',
  ];
  for (const sel of COOKIE_SELECTORS) {
    try {
      await page.click(sel, { timeout: 4000 });
      logger.info('Cookie banner dismissed');
      await humanDelay(200, 400);
      return;
    } catch { /* try next */ }
  }
}

// ── CAPTCHA detection & auto-solver ──────────────────────────────────────────

/**
 * Scan all frames for the Gameforge image-drop CAPTCHA iframe.
 * Returns { frame, challengeId, textUrl, iconsUrl, targetUrl } or null.
 */
async function findCaptchaFrame(page) {
  for (const frame of page.frames()) {
    try {
      const text = await frame.evaluate(() => document.body?.innerText || '');
      if (!text.includes('CZŁOWIEKIEM') && !text.includes('Odśwież')) continue;

      // Collect image URLs from the CAPTCHA iframe
      const imgs = await frame.evaluate(() =>
        [...document.querySelectorAll('img')].map(i => i.src)
      );
      const textUrl   = imgs.find(u => u.includes('/text?'));
      const iconsUrl  = imgs.find(u => u.includes('/drag-icons?'));
      const targetUrl = imgs.find(u => u.includes('/drop-target?'));

      const idMatch = (textUrl || '').match(/challenge\/([^/]+)\//);
      const challengeId = idMatch ? idMatch[1] : null;

      return { frame, challengeId, textUrl, iconsUrl, targetUrl };
    } catch { /* cross-origin or not ready */ }
  }
  return null;
}

/**
 * Poll until the CAPTCHA iframe appears or the timeout expires.
 */
async function waitForCaptchaFrame(page, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const info = await findCaptchaFrame(page);
    if (info) return info;
    await delay(500);
  }
  return null;
}

/**
 * Attempt to auto-solve the CAPTCHA using OCR on the text instruction image.
 *
 * The instruction is always: "Przeciągnij <ITEM> na <TARGET>."
 * The drag-icons image is a 240×60 sprite with 4 equally-spaced 60×60 icons.
 * We OCR the text image → extract the ITEM word → find its index in the sprite
 * by matching the icon images against a vocabulary set (not needed — index is
 * determined by order).
 *
 * Fallback: drag each icon to the target in turn until one succeeds.
 */
async function autoSolveCaptcha(page, captchaInfo) {
  const { frame, textUrl, iconsUrl, targetUrl } = captchaInfo;
  if (!textUrl || !iconsUrl || !targetUrl) return false;

  logger.info('[CAPTCHA] Attempting auto-solve via OCR …');

  try {
    const { createWorker } = require('tesseract.js');

    // Screenshot the instruction image element directly from the iframe — this
    // avoids any HTTP fetch entirely (the image is already rendered in the DOM).
    const textImgEl = await frame.$('img[src*="/text?"]');
    if (!textImgEl) {
      logger.warn('[CAPTCHA] Instruction image element not found in iframe');
      return false;
    }
    const imgBuffer = await textImgEl.screenshot();
    logger.info(`[CAPTCHA] Instruction image captured: ${imgBuffer.length} bytes`);

    // OCR the PNG buffer (Polish language)
    const worker = await createWorker('pol');
    const { data: { text: rawText } } = await worker.recognize(imgBuffer);
    await worker.terminate();

    const instruction = rawText.replace(/\s+/g, ' ').trim();
    logger.info(`[CAPTCHA] Instruction OCR: "${instruction}"`);

    // Parse: "Przeciągnij <ITEM> na <TARGET>."
    const match = instruction.match(/Przeci[aą]gnij\s+(\S+)\s+na\s+(\S+)/i);
    if (!match) {
      logger.warn('[CAPTCHA] Could not parse instruction — will try brute-force drag');
    }
    const itemWord = match ? match[1].toLowerCase().replace(/[.,!]/g, '') : null;
    logger.info(`[CAPTCHA] Item to drag: "${itemWord}"`);

    // Get bounding boxes of the 4 drag-icon elements in the iframe
    const iconBoxes = await frame.evaluate(() => {
      const imgs = [...document.querySelectorAll('img')].filter(i =>
        i.src.includes('drag-icons')
      );
      return imgs.map(i => {
        const r = i.getBoundingClientRect();
        return { x: r.left, y: r.top, w: r.width, h: r.height };
      });
    });

    // Get the drop target bounding box
    const targetBox = await frame.evaluate(() => {
      const img = document.querySelector('img[src*="drop-target"]');
      if (!img) return null;
      const r = img.getBoundingClientRect();
      return { x: r.left, y: r.top, w: r.width, h: r.height };
    });

    if (!targetBox || !iconBoxes.length) {
      logger.warn('[CAPTCHA] Could not locate icon/target bounding boxes');
      return false;
    }

    const targetCX = targetBox.x + targetBox.w / 2;
    const targetCY = targetBox.y + targetBox.h / 2;

    // Build iframe offset to convert frame-local coords to page coords
    // Find the correct iframe by checking which one contains the CAPTCHA
    let frameOffset  = { x: 0, y: 0 };
    const iframeEls  = await page.$$('iframe');
    for (const ifEl of iframeEls) {
      try {
        const box = await ifEl.boundingBox();
        if (box) { frameOffset = { x: box.x, y: box.y }; }
        // Check if this iframe contains the CAPTCHA by peeking at its content
        const src = await ifEl.evaluate(n => n.contentDocument?.body?.innerText || '');
        if (src.includes('CZŁOWIEKIEM')) { frameOffset = { x: box.x, y: box.y }; break; }
      } catch { /* skip */ }
    }

    logger.info(`[CAPTCHA] Frame offset: ${JSON.stringify(frameOffset)}, target: ${JSON.stringify(targetBox)}, icons: ${iconBoxes.length}`);

    // Try each icon in order (brute-force if OCR failed, or try best-match first)
    const tryOrder = Array.from({ length: iconBoxes.length }, (_, i) => i);

    for (const idx of tryOrder) {
      const icon = iconBoxes[idx];
      const fromX = frameOffset.x + icon.x + icon.w / 2;
      const fromY = frameOffset.y + icon.y + icon.h / 2;
      const toX   = frameOffset.x + targetCX;
      const toY   = frameOffset.y + targetCY;

      logger.info(`[CAPTCHA] Trying icon #${idx}: dragging from (${fromX.toFixed(0)},${fromY.toFixed(0)}) to (${toX.toFixed(0)},${toY.toFixed(0)})`);

      await page.mouse.move(fromX, fromY);
      await delay(300);
      await page.mouse.down();
      await delay(200);
      // Smooth drag in steps
      const steps = 15;
      for (let s = 1; s <= steps; s++) {
        await page.mouse.move(
          fromX + (toX - fromX) * (s / steps),
          fromY + (toY - fromY) * (s / steps)
        );
        await delay(30);
      }
      await page.mouse.up();
      await delay(1200);

      // Check if CAPTCHA is gone
      if (!(await findCaptchaFrame(page))) {
        logger.info(`[CAPTCHA] Auto-solve succeeded with icon #${idx} ✓`);
        return true;
      }
      if (await isLoggedIn(page)) return true;
    }

    logger.warn('[CAPTCHA] All icons tried — auto-solve did not succeed');
    return false;
  } catch (err) {
    logger.warn(`[CAPTCHA] Auto-solve error: ${err.message}`);
    return false;
  }
}

/**
 * Wait for the CAPTCHA to be solved (manual or auto), up to timeoutMs.
 */
async function waitForCaptchaSolved(page, captchaInfo, timeoutMs = 120_000) {
  // Try auto-solve first
  const solved = await autoSolveCaptcha(page, captchaInfo);
  if (solved) return;

  // Fall back to waiting for human (headed mode)
  logger.warn('[Auth] 🧩 Auto-solve failed. Please solve the CAPTCHA in the browser window (120s) …');
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await delay(1500);
    if (!(await findCaptchaFrame(page))) { logger.info('[Auth] CAPTCHA resolved ✓'); return; }
    if (await isLoggedIn(page)) return;
  }
  throw new Error('CAPTCHA not solved within 120 seconds');
}



/**
 * Returns true if the current page shows the in-game resource bar.
 * Uses multiple selector strategies + URL heuristic.
 */
async function isLoggedIn(page) {
  try {
    // Fast URL check — if we're on the game server (not lobby), we're in
    const url = page.url();
    if (url.includes(BASE_URL) && url.includes('index.php') && !url.includes('lobby')) {
      // Confirm the page actually rendered (not a redirect loop)
      const hasContent = await page.evaluate(() =>
        !!(document.querySelector('#resources_metal, #metal_box, #resourcesbar, ' +
           '.resourceIcon, #planetList, #topBar, #bar, .content-box-c, #inhalt'))
      ).catch(() => false);
      if (hasContent) return true;
    }

    // Wait up to 5 s for any known in-game element
    await page.waitForSelector(
      '#resources_metal, #metal_box, #resourcesbar, .resourceIcon, ' +
      '#planetList, #topBar, #bar, .content-box-c, #inhalt, ' +
      '[id*="resources"], .resource-icon',
      { timeout: 5000 }
    );
    return true;
  } catch {
    return false;
  }
}

// ── Post-login lobby ──────────────────────────────────────────────────────────

/**
 * After Gameforge SSO succeeds the lobby shows a server/account list.
 * Step 1: click "Graj" → navigates to /pl_PL/accounts
 * Step 2: on the accounts page, click the server-specific play link
 *         (a[href*="ogame.gameforge.com"])
 */
async function clickPlayButton(page) {
  if (await isLoggedIn(page)) return;

  logger.info('[Auth] Looking for "Graj" (Play) button in lobby …');

  // Step 1 — main lobby "Graj" button
  const STEP1_SELECTORS = [
    'a[href*="/accounts"] button.button-primary',
    'button:has-text("Graj")',
    'a:has-text("Graj")',
    'button:has-text("Zagraj")',
    'a:has-text("Zagraj")',
    'button:has-text("Play")',
    '.play-button',
  ];

  let clicked = false;
  const deadline = Date.now() + 15_000;
  while (!clicked && Date.now() < deadline) {
    for (const sel of STEP1_SELECTORS) {
      try {
        const el = await page.$(sel);
        if (el && await el.isVisible()) {
          logger.info(`[Auth] Clicking lobby button (${sel}) …`);
          await humanDelay(200, 500);
          await humanClick(page, el);
          await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {});
          clicked = true;
          break;
        }
      } catch { /* not yet visible */ }
    }
    if (!clicked) await delay(800);
  }

  if (!clicked) {
    logger.warn('[Auth] "Graj" button not found within 15 s — proceeding anyway');
    return;
  }

  // Step 2 — accounts page: click the play button for our server.
  // The button opens the game in a NEW TAB — we must intercept it, navigate
  // the original page there, and close the extra tabs.
  if (await isLoggedIn(page)) return;

  logger.info('[Auth] On accounts page — waiting for #accountlist …');
  await page.waitForSelector('#accountlist', { timeout: 12_000 }).catch(() => {});

  const context = page.context();

  // Arm new-tab listener BEFORE the click
  const newPagePromise = context.waitForEvent('page', { timeout: 15_000 }).catch(() => null);

  // Click the first button inside #accountlist (our server)
  const didClick = await page.evaluate(() => {
    const btn = document.querySelector('#accountlist button');
    if (btn) { btn.click(); return true; }
    return false;
  });

  if (!didClick) {
    logger.warn('[Auth] No button found in #accountlist — proceeding anyway');
    return;
  }

  logger.info('[Auth] Waiting for game tab to open …');
  const newTab = await newPagePromise;

  if (newTab) {
    await newTab.waitForLoadState('networkidle', { timeout: 20_000 }).catch(() => {});
    const gameUrl = newTab.url();
    logger.info(`[Auth] Game opened in new tab: ${gameUrl}`);
    await newTab.close().catch(() => {});
    // Navigate original page to the game URL (keeps our single-page context)
    await page.goto(gameUrl, { waitUntil: 'networkidle', timeout: 30_000 });
  } else {
    // Some configs navigate in the same tab — just wait
    await page.waitForLoadState('networkidle', { timeout: 20_000 }).catch(() => {});
  }

  logger.warn('[Auth] Server play button not found within 15 s — proceeding anyway');
}

// ── Gameforge SSO login ───────────────────────────────────────────────────────

/**
 * Handle login on the CURRENT page (already landed after redirect from game URL).
 * Does NOT navigate — works wherever the server redirected us.
 */
async function login(page, context) {
  const email    = process.env.OGAME_EMAIL;
  const password = process.env.OGAME_PASSWORD;

  if (!email || !password) {
    throw new Error('OGAME_EMAIL and OGAME_PASSWORD must be set in .env');
  }

  // Already in the game? (could happen if session restored mid-redirect)
  if (await isLoggedIn(page)) {
    logger.info('Already inside the game — skipping login');
    await saveSession(context);
    return;
  }

  await thinkTime();

  // 1. Dismiss cookie banner (it blocks all clicks if not dismissed)
  await dismissCookieBanner(page);

  // 2. Switch to Login tab — page defaults to Registration tab.
  //    Try several selectors; if none work the email field may already be visible.
  logger.info('Clicking Login tab …');
  const LOGIN_TAB_SELECTORS = [
    '.tabsList li >> text=Login',
    'li[class*="login"] a',
    'a:has-text("Login")',
    '[data-tab="login"]',
  ];
  for (const sel of LOGIN_TAB_SELECTORS) {
    try {
      await page.click(sel, { force: true, timeout: 3000 });
      logger.info(`Login tab clicked (${sel})`);
      await humanDelay(100, 250);
      break;
    } catch { /* try next */ }
  }

  // 3. Wait for email input — try multiple selectors, short timeout each
  const EMAIL_SELECTORS = [
    'input[name="email"]',
    'input[type="email"]',
    '#usernameOrEmail',
    '#email',
    'input[autocomplete="email"]',
  ];

  let emailField = null;
  for (const sel of EMAIL_SELECTORS) {
    try {
      emailField = await page.waitForSelector(sel, { timeout: 4000 });
      if (emailField) { logger.info(`Email field found: ${sel}`); break; }
    } catch { /* try next */ }
  }

  // Still no form? Could be lobby accounts page or game already loaded
  if (!emailField) {
    // Try clicking "Graj" in case we're already past SSO
    await clickPlayButton(page);
    if (await isLoggedIn(page)) {
      logger.info('Already inside the game after Play button — skipping credentials');
      await saveSession(context);
      return;
    }
    throw new Error('Login form not found — the page structure may have changed');
  }

  await humanClick(page, emailField);
  await humanDelay(100, 300);
  await humanType(page, email);

  await humanDelay(200, 500);

  const passwordField = await page.$('input[type="password"]');
  if (!passwordField) throw new Error('Password field not found');
  await humanClick(page, passwordField);
  await humanDelay(100, 250);
  await humanType(page, password);

  await humanDelay(300, 600);

  // 4. Submit — the login submit button has text "Login" and class button-primary
  const submitBtn = await page.$('button[type="submit"].button-primary, button[type="submit"]:has-text("Login")');
  if (submitBtn) {
    await humanClick(page, submitBtn);
  } else {
    await page.keyboard.press('Enter');
  }

  logger.info('Credentials submitted — polling for CAPTCHA or game load …');

  // Poll up to 10 s for CAPTCHA or successful game load
  let captchaInfo = null;
  const pollDeadline = Date.now() + 10_000;
  while (Date.now() < pollDeadline) {
    if (await isLoggedIn(page)) break;
    captchaInfo = await findCaptchaFrame(page);
    if (captchaInfo) break;
    await delay(600);
  }

  if (captchaInfo) {
    logger.warn('[Auth] 🧩 CAPTCHA detected — attempting auto-solve …');
    await waitForCaptchaSolved(page, captchaInfo);
  }

  // After CAPTCHA / SSO the lobby shows an account list — click "Zagraj" (Play)
  await clickPlayButton(page);

  await page.waitForLoadState('networkidle', { timeout: 30_000 });
  await thinkTime();

  if (!(await isLoggedIn(page))) {
    // Dump screenshot for debugging
    await page.screenshot({ path: 'login-failed.png' });
    throw new Error('Login failed — screenshot saved to login-failed.png');
  }

  logger.info('Login successful ✓');
  await saveSession(context);
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Ensure we are logged in.
 *
 * Always starts by navigating to the game URL — the server either:
 *   a) serves the game directly (session valid)        → done
 *   b) redirects to the lobby login page               → handle login
 *   c) redirects to lobby accounts page (SSO complete) → click Play
 *
 * This mirrors real user behaviour: open bookmark → land wherever → react.
 */
async function ensureLoggedIn(page, context) {
  // Load saved cookies so the game URL redirect is more likely to succeed
  await loadSession(context);

  logger.info(`Navigating to game URL: ${BASE_URL}/game/index.php`);
  await page.goto(`${BASE_URL}/game/index.php`, { waitUntil: 'networkidle', timeout: 30_000 });

  const landedUrl = page.url();
  logger.info(`Landed on: ${landedUrl}`);

  // Case a: already in the game
  if (await isLoggedIn(page)) {
    logger.info('Session still valid ✓');
    await saveSession(context); // refresh saved cookies
    return;
  }

  // Case c: landed on the accounts selection page (SSO already done)
  if (landedUrl.includes('/accounts') || landedUrl.includes('lobby.ogame')) {
    logger.info('On lobby/accounts page — attempting Play button …');
    await clickPlayButton(page);
    if (await isLoggedIn(page)) {
      logger.info('Login successful via Play button ✓');
      await saveSession(context);
      return;
    }
  }

  // Case b: need to fill credentials on whatever page we landed on
  logger.info('Handling login form …');
  await login(page, context);
}

module.exports = { ensureLoggedIn, saveSession, isLoggedIn };
