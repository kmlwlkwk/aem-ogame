/**
 * OGame Commander by Camillo — TUI
 *
 * Split-screen terminal interface:
 *
 *  ┌─ header: title + live clock ──────────────────────────────────┐
 *  ├─ commander panel ──────┬─ empire stats ────────────────────────┤
 *  │  ASCII animation       │  planets / resources / directive      │
 *  ├────────────────────────┴───────────────────────────────────────┤
 *  │  Mission log (scrollable, auto-tail)                          │
 *  ├────────────────────────────────────────────────────────────────┤
 *  │  Commander > [input]                                          │
 *  └────────────────────────────────────────────────────────────────┘
 */

'use strict';

const blessed = require('blessed');
const { version } = require('../../package.json');

// ── Commander ASCII animation ─────────────────────────────────────────────────

const FRAMES = {
  idle: [
    [
      ' ╭─────╮ ',
      ' │ o_o │ ',
      ' ╰─────╯ ',
      '  ╔═══╗  ',
      '  ║ ✦ ║  ',
      '  ╚═╤═╝  ',
      '    │    ',
      ' ───┼─── ',
      ' /  │  \\ ',
    ],
    [
      ' ╭─────╮ ',
      ' │ -_- │ ',
      ' ╰─────╯ ',
      '  ╔═══╗  ',
      '  ║ ✦ ║  ',
      '  ╚═╤═╝  ',
      '    │    ',
      ' ───┼─── ',
      ' /  │  \\ ',
    ],
    [
      ' ╭─────╮ ',
      ' │ o_o │ ',
      ' ╰─────╯ ',
      '  ╔═══╗  ',
      '  ║ ✦ ║  ',
      '  ╚═╤═╝  ',
      '    │    ',
      ' ───┼─── ',
      ' /  │  \\ ',
    ],
    [
      ' ╭─────╮ ',
      ' │ ^_^ │ ',
      ' ╰─────╯ ',
      '  ╔═══╗  ',
      '  ║ ✦ ║  ',
      '  ╚═╤═╝  ',
      ' \\  │  / ',
      ' ───┼─── ',
      ' /  │  \\ ',
    ],
  ],
  working: [
    [
      ' ╭─────╮ ',
      ' │ >_< │ ',
      ' ╰─────╯ ',
      '  ╔═══╗  ',
      '  ║ ⚙ ║  ',
      '  ╚═╤═╝  ',
      ' \\  │  / ',
      ' ───┼─── ',
      ' /  │  \\ ',
    ],
    [
      ' ╭─────╮ ',
      ' │ >_> │ ',
      ' ╰─────╯ ',
      '  ╔═══╗  ',
      '  ║ ⚙ ║  ',
      '  ╚═╤═╝  ',
      '  \\ │ /  ',
      ' ───┼─── ',
      ' /  │  \\ ',
    ],
  ],
  alert: [
    [
      ' ╭─────╮ ',
      ' │ O_O │!',
      ' ╰─────╯ ',
      '  ╔═══╗  ',
      '  ║ ! ║  ',
      '  ╚═╤═╝  ',
      '    │    ',
      ' ───┼─── ',
      ' /  │  \\ ',
    ],
    [
      ' ╭─────╮ ',
      ' │ O.O │ ',
      ' ╰─────╯ ',
      '  ╔═══╗  ',
      '  ║   ║  ',
      '  ╚═╤═╝  ',
      '    │    ',
      ' ───┼─── ',
      ' /  │  \\ ',
    ],
  ],
};

// ── TUI state ─────────────────────────────────────────────────────────────────

let screen, headerBox, commanderBox, statsBox, logBox, inputBox;
let animTimer, clockTimer;
let currentMode   = 'idle';
let currentFrame  = 0;
let logBuffer     = [];
let onCommandCb   = null;
let statsData     = {};
let isActive      = false;

// ── Screen setup ──────────────────────────────────────────────────────────────

function init(onCommand) {
  onCommandCb = onCommand;

  screen = blessed.screen({
    smartCSR:     true,
    title:        `OGame Commander by Camillo v${version}`,
    fullUnicode:  true,
    dockBorders:  true,
    autoPadding:  true,
  });

  // ── Header ───────────────────────────────────────────────────────────────
  headerBox = blessed.box({
    parent: screen,
    top:    0,
    left:   0,
    width:  '100%',
    height: 3,
    tags:   true,
    border: { type: 'line' },
    style: {
      border: { fg: 'cyan' },
      bg: 'black',
    },
    content: `{center}{bold}{cyan-fg}⚔  OGame Commander by Camillo  ⚔{/bold}{/cyan-fg}{/center}`,
  });

  // ── Commander panel (left) ────────────────────────────────────────────────
  commanderBox = blessed.box({
    parent: screen,
    top:    3,
    left:   0,
    width:  14,
    height: 13,
    tags:   true,
    border: { type: 'line' },
    style: {
      border: { fg: 'yellow' },
      bg: 'black',
    },
    label: ' {yellow-fg}CMD{/yellow-fg} ',
  });

  // ── Stats panel (right of commander) ─────────────────────────────────────
  statsBox = blessed.box({
    parent: screen,
    top:    3,
    left:   14,
    width:  '100%-14',
    height: 13,
    tags:   true,
    border: { type: 'line' },
    style: {
      border: { fg: 'green' },
      bg: 'black',
    },
    label: ' {green-fg}Empire Status{/green-fg} ',
    content: '{gray-fg}Awaiting first scan …{/gray-fg}',
  });

  // ── Log panel ─────────────────────────────────────────────────────────────
  logBox = blessed.log({
    parent:       screen,
    top:          16,
    left:         0,
    width:        '100%',
    height:       '100%-19',
    tags:         true,
    scrollable:   true,
    alwaysScroll: true,
    scrollbar:    { ch: '│', style: { fg: 'cyan' } },
    border:       { type: 'line' },
    style: {
      border: { fg: 'blue' },
      bg: 'black',
    },
    label: ' {blue-fg}Mission Log{/blue-fg} ',
  });

  // ── Input bar ─────────────────────────────────────────────────────────────
  inputBox = blessed.textbox({
    parent:       screen,
    bottom:       0,
    left:         0,
    width:        '100%',
    height:       3,
    inputOnFocus: true,
    tags:         true,
    border:       { type: 'line' },
    style: {
      border:  { fg: 'magenta' },
      bg:      'black',
      focus:   { border: { fg: 'white' } },
    },
    label: ' {magenta-fg}Commander >{/magenta-fg} ',
  });

  // Submit command on Enter
  inputBox.key('enter', () => {
    const val = inputBox.getValue().trim();
    inputBox.clearValue();
    screen.render();
    if (val && onCommandCb) {
      log(`{magenta-fg}> ${val}{/magenta-fg}`);
      onCommandCb(val);
    }
    inputBox.focus();
  });

  // Ctrl-C triggers graceful shutdown (browser.close etc.) via index.js handler
  screen.key('C-c', () => process.emit('SIGINT'));

  // Escape refocuses input
  screen.key('escape', () => inputBox.focus());

  // Scroll log with arrow keys when not typing
  screen.key(['pageup'],   () => { logBox.scroll(-logBox.height); screen.render(); });
  screen.key(['pagedown'], () => { logBox.scroll(logBox.height);  screen.render(); });

  inputBox.focus();
  isActive = true;

  // Start animation + clock
  _startAnimation();
  _startClock();

  // Replay buffered logs
  for (const entry of logBuffer) logBox.log(entry);
  logBuffer = [];

  screen.render();
}

// ── Animation ─────────────────────────────────────────────────────────────────

function _startAnimation() {
  animTimer = setInterval(() => {
    if (!screen || !commanderBox) return;
    const frames = FRAMES[currentMode] ?? FRAMES.idle;
    currentFrame = (currentFrame + 1) % frames.length;
    const f = frames[currentFrame];
    const modeColors = { idle: 'cyan', working: 'yellow', alert: 'red' };
    const color = modeColors[currentMode] ?? 'cyan';
    commanderBox.setContent(
      `{${color}-fg}${f.join('\n')}{/${color}-fg}`
    );
    screen.render();
  }, 600);
}

function setMode(mode) {
  if (currentMode !== mode) {
    currentMode = mode;
    currentFrame = 0;
  }
}

// ── Clock ─────────────────────────────────────────────────────────────────────

function _startClock() {
  function tick() {
    if (!screen || !headerBox) return;
    const now  = new Date();
    const time = now.toLocaleTimeString('pl-PL', { timeZone: 'Europe/Warsaw', hour12: false });
    const date = now.toLocaleDateString('pl-PL', { timeZone: 'Europe/Warsaw' });
    headerBox.setContent(
      `{center}{bold}{cyan-fg}⚔  OGame Commander by Camillo  v${version}  ⚔{/bold}   {gray-fg}${date} ${time} Warsaw{/gray-fg}{/center}`
    );
    screen.render();
  }
  tick();
  clockTimer = setInterval(tick, 1000);
}

// ── Stats panel ───────────────────────────────────────────────────────────────

const fmt = (n) => {
  if (n == null || isNaN(n)) return '?';
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000)     return `${(n / 1_000).toFixed(0)}k`;
  return String(n);
};

function updateStats(data) {
  statsData = { ...statsData, ...data };

  if (!statsBox) return;

  const d  = statsData;
  const nl = '\n';

  const cycleStr  = d.cycle    ? `{bold}#{d.cycle}{/bold}` : '—';
  const nextStr   = d.nextIn   ? `${d.nextIn}s` : '—';
  const tacticsStr = (d.tactics ?? []).join(' {gray-fg}→{/gray-fg} ') || '—';

  const metalStr  = `{yellow-fg}M:{/yellow-fg}${fmt(d.totalMetal)}`;
  const crysStr   = `{cyan-fg}C:{/cyan-fg}${fmt(d.totalCrystal)}`;
  const deutStr   = `{blue-fg}D:{/blue-fg}${fmt(d.totalDeuterium)}`;

  const energyIssues = (d.energyAlerts ?? []);
  const energyStr = energyIssues.length > 0
    ? `{red-fg}⚡ DEFICIT on ${energyIssues.join(', ')}{/red-fg}`
    : '{green-fg}⚡ stable{/green-fg}';

  const directiveStr = d.directive
    ? `{magenta-fg}🎯 "${d.directive}"{/magenta-fg}`
    : '{gray-fg}No active directive{/gray-fg}';

  const aiStr = d.aiPlan
    ? `{gray-fg}${d.aiPlan.slice(0, 60)}${d.aiPlan.length > 60 ? '…' : ''}{/gray-fg}`
    : '{gray-fg}—{/gray-fg}';

  const lines = [
    ` {bold}Cycle:{/bold} ${d.cycle ? `#${d.cycle}` : '—'}   {bold}Next:{/bold} ${nextStr}   {bold}Worlds:{/bold} ${d.planets ?? '—'}`,
    ` ${metalStr}  ${crysStr}  ${deutStr}`,
    ` ${energyStr}`,
    ` {bold}Tactics:{/bold} ${tacticsStr}`,
    ` ${directiveStr}`,
    ` {bold}HQ:{/bold} ${aiStr}`,
    d.lastAction ? ` {bold}Last:{/bold} {green-fg}${d.lastAction}{/green-fg}` : '',
  ].filter(Boolean);

  statsBox.setContent(lines.join('\n'));
  if (screen) screen.render();
}

// ── Log output ────────────────────────────────────────────────────────────────

/**
 * Colour-map log levels and emit to the log box (or buffer if TUI not yet up).
 */
function log(message) {
  // Strip winston colour codes (they use chalk/ansi internally)
  const clean = message.replace(/\x1b\[[0-9;]*m/g, '');

  // Apply TUI colour tags based on keywords
  let coloured = clean;
  if (/\[error\]|\[Error\]/i.test(clean) || /🚨|⛔|CRISIS|SUSPENDED|banned/.test(clean)) {
    coloured = `{red-fg}${clean}{/red-fg}`;
  } else if (/\[warn\]|\[Warn\]/i.test(clean) || /⚡|⚠|DEFICIT|FORCED|Alert/.test(clean)) {
    coloured = `{yellow-fg}${clean}{/yellow-fg}`;
  } else if (/✅|✓|queued|Commissioning|🏗️|⛏️|💎|🧪|🚀|🔬|☀️/.test(clean)) {
    coloured = `{green-fg}${clean}{/green-fg}`;
  } else if (/🎯|Commander|directive|order/i.test(clean)) {
    coloured = `{magenta-fg}${clean}{/magenta-fg}`;
  } else if (/\[HQ\]|strategic|assessment/i.test(clean)) {
    coloured = `{cyan-fg}${clean}{/cyan-fg}`;
  } else if (/\[Intel\]|Survey|scan/i.test(clean)) {
    coloured = `{blue-fg}${clean}{/blue-fg}`;
  } else if (/\[Attacker\]|Strike|raid|target/i.test(clean)) {
    coloured = `{red-fg}${clean}{/red-fg}`;
  }

  if (logBox) {
    logBox.log(coloured);
    screen?.render();
  } else {
    logBuffer.push(coloured);
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

function isReady() { return isActive; }

function destroy() {
  clearInterval(animTimer);
  clearInterval(clockTimer);
  if (screen) { screen.destroy(); screen = null; }
  isActive = false;
}

module.exports = { init, log, updateStats, setMode, isReady, destroy };
