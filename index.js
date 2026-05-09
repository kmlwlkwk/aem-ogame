require('dotenv').config();

const logger            = require('./src/utils/logger');
const tui               = require('./src/ui/tui');
const { launchBrowser } = require('./src/browser');
const { ensureLoggedIn } = require('./src/auth');
const { start }          = require('./src/agent');
const { startCommandInterface, setDirective } = require('./src/commander');
const { saveDirective, loadActiveDirective } = require('./src/db/index');
const { handleSlash }    = require('./src/commands/slash');

// TUI is always enabled when running in a real terminal
const USE_TUI = process.stdout.isTTY !== false && process.env.NO_TUI !== 'true';

async function main() {
  const { browser, context, page } = await launchBrowser();

  if (USE_TUI) {
    // Start TUI — it takes over stdout, so do this before any log output
    tui.init((commandText) => {
      // Vim-style quit shortcuts (:q  :quit  :exit)
      if (/^:q(uit)?$|^:exit$/i.test(commandText.trim())) {
        tui.log('{red-fg}[Commander] ⚔  Standing down… farewell, Commander. o7{/red-fg}');
        setTimeout(() => process.emit('SIGINT'), 300);
        return;
      }

      // Slash commands are consumed immediately — no directive system involved
      if (handleSlash(commandText, tui)) return;

      // Natural-language directive (player is highest authority)
      setDirective(commandText);
      if (commandText.toLowerCase() === 'clear' || commandText.toLowerCase() === 'reset') {
        const { clearDirective } = require('./src/commander');
        clearDirective();
      }
    });
    // Route all logger output through the TUI
    logger.attachTUI(tui);
    logger.info('[TUI] Commander console online — type directives below');
  } else {
    // Fallback: readline-based input
    startCommandInterface(saveDirective, loadActiveDirective);
  }

  // Graceful shutdown
  const shutdown = async (signal) => {
    logger.info(`[Main] ${signal} received — shutting down`);
    tui.destroy();
    await browser.close();
    process.exit(0);
  };
  process.on('SIGINT',  () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  try {
    await ensureLoggedIn(page, context);
    const reAuth = () => ensureLoggedIn(page, context);
    await start(page, reAuth);
  } catch (err) {
    logger.error(`[Main] Fatal error: ${err.message}`);
    await page.screenshot({ path: 'error.png' }).catch(() => {});
    tui.destroy();
    await browser.close();
    process.exit(1);
  }
}

main();
