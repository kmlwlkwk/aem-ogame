const { chromium } = require('./stealth');
const logger = require('./utils/logger');

// ── Fingerprint constants ─────────────────────────────────────────────────────
// Source: AmIUnique scan – macOS / Chrome 147 / Apple M1 Pro / Warsaw / pl

const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36';

const ACCEPT_LANGUAGE = 'pl,en-US;q=0.9,en;q=0.8';

// Physical display reported by the real machine
const SCREEN_WIDTH  = 1920;
const SCREEN_HEIGHT = 1080;
const SCREEN_AVAIL_TOP    = 30;    // macOS menu-bar height
const SCREEN_AVAIL_LEFT   = 0;
const SCREEN_AVAIL_HEIGHT = SCREEN_HEIGHT - SCREEN_AVAIL_TOP;  // 1050
const SCREEN_AVAIL_WIDTH  = SCREEN_WIDTH;                       // 1920

// ─────────────────────────────────────────────────────────────────────────────

/**
 * Launch a stealth Chromium instance and return { browser, context, page }.
 *
 * Fingerprint tuned to match the user's real AmIUnique profile exactly:
 *  – User-Agent: macOS / Intel Mac OS X 10_15_7 / Chrome 147
 *  – Referer: https://www.google.com/
 *  – Accept-Language: pl,en-US;q=0.9,en;q=0.8
 *  – Timezone: Europe/Warsaw (UTC+01:00)  Locale: pl
 *  – Screen: 1920×1080, avail 1920×1050 (top=30)
 *  – Platform: MacIntel   Concurrency: 8   DeviceMemory: 16
 *  – WebGL: Google Inc. (Apple) / ANGLE Metal Renderer Apple M1 Pro
 *  – Plugins: 5 PDF-viewer entries matching real Chrome on macOS
 *  – Canvas pixel-noise, navigator.webdriver hidden, chrome object injected
 */
async function launchBrowser() {
  const headless = process.env.HEADLESS !== 'false';
  logger.info(`Launching browser  headless=${headless}`);

  const browser = await chromium.launch({
    headless,
    args: [
      '--disable-blink-features=AutomationControlled',
      '--disable-infobars',
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--no-first-run',
      '--no-zygote',
      '--lang=pl',
      '--disable-features=IsolateOrigins,site-per-process',
    ],
  });

  const context = await browser.newContext({
    userAgent: USER_AGENT,
    // Logical viewport (browser window size, separate from physical screen)
    viewport: { width: 1512, height: 982 },
    // Physical screen reported by window.screen — matches real monitor
    screen: { width: SCREEN_WIDTH, height: SCREEN_HEIGHT },
    deviceScaleFactor: 2,   // Retina / HiDPI (Apple M1 Pro)
    locale: 'pl',
    timezoneId: 'Europe/Warsaw',
    colorScheme: 'light',
    extraHTTPHeaders: {
      'Accept-Language': ACCEPT_LANGUAGE,
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7',
      'Accept-Encoding': 'gzip, deflate, br',
      'Upgrade-Insecure-Requests': '1',
    },
  });

  await context.addInitScript(({
    screenWidth, screenHeight,
    availTop, availLeft, availHeight, availWidth,
  }) => {
    // ── navigator ──────────────────────────────────────────────────────────────
    const def = (obj, prop, value) =>
      Object.defineProperty(obj, prop, { get: () => value, configurable: true });

    def(navigator, 'webdriver',            undefined);
    def(navigator, 'platform',             'MacIntel');
    def(navigator, 'languages',            ['pl', 'en-US', 'en']);
    def(navigator, 'hardwareConcurrency',  8);
    def(navigator, 'deviceMemory',         16);
    def(navigator, 'vendor',               'Google Inc.');
    def(navigator, 'productSub',           '20030107');
    def(navigator, 'doNotTrack',           null);   // not set in fingerprint

    // ── plugins — 5 PDF-viewer entries matching real Chrome 147 / macOS ───────
    const makeMimeType = (type, desc, suffixes, plugin) => {
      const mt = Object.create(MimeType.prototype);
      Object.defineProperties(mt, {
        type:        { value: type },
        description: { value: desc },
        suffixes:    { value: suffixes },
        enabledPlugin: { value: plugin },
      });
      return mt;
    };
    const makePlugin = (name, desc, filename, mimeTypes) => {
      const p = Object.create(Plugin.prototype);
      Object.defineProperties(p, {
        name:        { value: name },
        description: { value: desc },
        filename:    { value: filename },
        length:      { value: mimeTypes.length },
      });
      mimeTypes.forEach((mt, i) => { p[i] = mt; });
      return p;
    };

    const pluginDefs = [
      { name: 'PDF Viewer',             desc: 'Portable Document Format', filename: 'internal-pdf-viewer' },
      { name: 'Chrome PDF Viewer',      desc: 'Portable Document Format', filename: 'internal-pdf-viewer' },
      { name: 'Chromium PDF Viewer',    desc: 'Portable Document Format', filename: 'internal-pdf-viewer' },
      { name: 'Microsoft Edge PDF Viewer', desc: 'Portable Document Format', filename: 'internal-pdf-viewer' },
      { name: 'WebKit built-in PDF',    desc: 'Portable Document Format', filename: 'internal-pdf-viewer' },
    ];
    const plugins = pluginDefs.map(pd => {
      const plugin = makePlugin(pd.name, pd.desc, pd.filename, []);
      const mt = makeMimeType('application/pdf', pd.desc, 'pdf', plugin);
      plugin[0] = mt;
      Object.defineProperty(plugin, 'length', { value: 1 });
      return plugin;
    });
    const pluginArray = Object.assign(plugins, { length: plugins.length });
    def(navigator, 'plugins', pluginArray);

    // ── screen ─────────────────────────────────────────────────────────────────
    def(screen, 'width',       screenWidth);
    def(screen, 'height',      screenHeight);
    def(screen, 'availTop',    availTop);
    def(screen, 'availLeft',   availLeft);
    def(screen, 'availHeight', availHeight);
    def(screen, 'availWidth',  availWidth);
    def(screen, 'colorDepth',  24);
    def(screen, 'pixelDepth',  24);

    // ── WebGL — Apple M1 Pro via ANGLE Metal ──────────────────────────────────
    const patchWebGL = (ctx) => {
      const orig = ctx.prototype.getParameter;
      ctx.prototype.getParameter = function (param) {
        if (param === 37445) return 'Google Inc. (Apple)';
        if (param === 37446) return 'ANGLE (Apple, ANGLE Metal Renderer: Apple M1 Pro, Unspecified Version)';
        return orig.call(this, param);
      };
    };
    patchWebGL(WebGLRenderingContext);
    if (typeof WebGL2RenderingContext !== 'undefined') patchWebGL(WebGL2RenderingContext);

    // ── Canvas fingerprint noise — unique per session ─────────────────────────
    const origToDataURL = HTMLCanvasElement.prototype.toDataURL;
    HTMLCanvasElement.prototype.toDataURL = function (type, quality) {
      const ctx2d = this.getContext('2d');
      if (ctx2d && this.width > 0 && this.height > 0) {
        const imgData = ctx2d.getImageData(0, 0, this.width, this.height);
        for (let i = 0; i < imgData.data.length; i += 4) {
          imgData.data[i]     = Math.min(255, imgData.data[i]     + (Math.random() < 0.5 ? 1 : 0));
          imgData.data[i + 1] = Math.min(255, imgData.data[i + 1] + (Math.random() < 0.5 ? 1 : 0));
        }
        ctx2d.putImageData(imgData, 0, 0);
      }
      return origToDataURL.call(this, type, quality);
    };

    // ── chrome runtime object ─────────────────────────────────────────────────
    window.chrome = {
      runtime:   {},
      loadTimes: () => ({}),
      csi:       () => ({}),
      app:       {},
    };

    // ── mouse tracking for Bézier movement helper ─────────────────────────────
    document.addEventListener('mousemove', e => {
      window.__mouseX = e.clientX;
      window.__mouseY = e.clientY;
    });
  }, {
    screenWidth:   SCREEN_WIDTH,
    screenHeight:  SCREEN_HEIGHT,
    availTop:      SCREEN_AVAIL_TOP,
    availLeft:     SCREEN_AVAIL_LEFT,
    availHeight:   SCREEN_AVAIL_HEIGHT,
    availWidth:    SCREEN_AVAIL_WIDTH,
  });

  const page = await context.newPage();
  logger.info('Browser ready');
  return { browser, context, page };
}

module.exports = { launchBrowser };
