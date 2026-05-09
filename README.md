# ⚔ OGame Commander by Camillo

> Autonomous empire management agent for [OGame](https://ogame.gameforge.com) with an interactive terminal UI, AI-powered strategy, and full commander control.

---

## Features

- **Interactive TUI** — split-screen terminal with animated commander, live empire stats, scrollable mission log and command input bar
- **Empire scanner** — reads all planets in one pass via the Empire overview page; falls back to per-planet scan automatically
- **AI strategy** — uses an OpenAI-compatible LLM to generate a strategic plan every N cycles (token-efficient caching)
- **Slash commands** — immediate structured control: `/attack`, `/defend`, `/eco`, `/pause`, `/force`, and more
- **Natural-language directives** — type anything and the agent interprets your intent; you're always the highest authority
- **Human behaviour** — randomised timing, scroll patterns, mouse variance, realistic browser fingerprint
- **Safety gate** — AI blocks destructive player commands and explains why; override with `/force` when you mean it
- **Economics engine** — automatic mine upgrades, energy management, solar satellite deployment, storage scaling
- **Defense builder** — builds shield domes, plasma turrets, ion cannons, rocket launchers per planet
- **Attacker** — espionage-report-driven raids on inactive planets; fleet safety checks before launch
- **Session resilience** — detects logout, bans, and maintenance; re-authenticates or sleeps as appropriate

---

## Requirements

- Node.js 18+
- An OGame account
- An OpenAI-compatible API key (tested with OVHcloud AI Endpoints — Qwen2.5-VL-72B-Instruct)

---

## Installation

### macOS / Linux

```bash
git clone https://github.com/you/ogame-commander.git
cd ogame-commander
npm install
npx playwright install chromium
```

### Windows

1. Install [Node.js 18+](https://nodejs.org) (LTS recommended — includes npm)
2. Install [Git for Windows](https://git-scm.com/download/win)
3. Open **PowerShell** or **Windows Terminal** and run:

```powershell
git clone https://github.com/you/ogame-commander.git
cd ogame-commander
npm install
npx playwright install chromium
```

> **Note:** The interactive TUI requires a proper terminal. Use **Windows Terminal** (available free from the Microsoft Store) — the old `cmd.exe` doesn't render it correctly. If you can't use Windows Terminal, add `NO_TUI=true` to your `.env` to fall back to plain console output.

### CAPTCHA support (optional)

The agent can solve drag-slider CAPTCHAs using Tesseract OCR. Download the Polish language data if your server uses it:

```bash
# macOS
brew install tesseract

# Windows — download the installer from:
# https://github.com/UB-Mannheim/tesseract/wiki
# During install, check the language pack for your server language (e.g. Polish)
```

Then download the `.traineddata` file for your language from [tessdata](https://github.com/tesseract-ocr/tessdata) and place it in the project root (already in `.gitignore`).

---

## Configuration

```bash
cp .env.example .env
# Edit .env with your credentials and server URL
```

Key settings in `.env`:

| Variable | Default | Description |
|---|---|---|
| `OGAME_EMAIL` | — | Your OGame login email |
| `OGAME_PASSWORD` | — | Your OGame password |
| `OGAME_SERVER` | — | Full server URL, e.g. `https://s261-pl.ogame.gameforge.com` |
| `HEADLESS` | `true` | Set `false` to watch the browser |
| `CYCLE_INTERVAL_MS` | `300000` | Cycle length in ms (5 min) |
| `ACTIVE_TACTICS` | `economics,defense,collector,attacker` | Tactic order |
| `ACTIVE_HOURS_START` | `7` | Active window start (Warsaw time) |
| `ACTIVE_HOURS_END` | `3` | Active window end (next day 03:00) |
| `OPENAI_API_KEY` | — | API key for LLM strategy |
| `OPENAI_BASE_URL` | — | OpenAI-compatible endpoint URL |
| `OPENAI_MODEL` | — | Model name (must support JSON mode) |
| `AI_REFRESH_CYCLES` | `3` | Cycles between AI strategy refreshes |
| `NO_TUI` | unset | Set `true` to disable TUI (plain console) |

---

## Running

```bash
# With interactive TUI (default when in a real terminal)
npm start

# Watch the browser too
npm run start:headed

# Plain console output (no TUI — for piping/logging, or Windows cmd.exe)
NO_TUI=true npm start        # macOS / Linux
$env:NO_TUI="true"; npm start   # Windows PowerShell
```

---

## TUI — Commander Console

```
┌─ ⚔ OGame Commander by Camillo  v1.1.0  ──────────── 09.05.2026 12:34:07 Warsaw ┐
├─ CMD ──────────┬─ Empire Status ──────────────────────────────────────────────────┤
│  ╭─────╮      │  Cycle: #7   Next: 142s   Worlds: 11                             │
│  │ o_o │      │  M:142.1M  C:88.3M  D:31.4M                                     │
│  ╰─────╯      │  ⚡ DEFICIT on 1:8:5                                              │
│  ╔═══╗        │  Tactics: economics → defense → attacker                         │
│  ║ ✦ ║        │  🎯 "attack close inactive planets"                              │
│  ╚═╤═╝        │  HQ: Focus mines — lagging behind ratio target                   │
│ /  │  \       │                                                                   │
├───────────────┴───────────────────────────────────────────────────────────────────┤
│ Mission Log                                                                        │
│  12:34 [Intel] ✅ Survey complete — 11 worlds via Empire overview (single pass)   │
│  12:34 [1:8:5] ⚡ ENERGY CRISIS  deficit=-11000 → deploying 35× Solar Satellite  │
│  12:34 [Command] ✅ Order acknowledged — raiding nearby inactive planets          │
├───────────────────────────────────────────────────────────────────────────────────┤
│ Commander > _                                                                      │
└───────────────────────────────────────────────────────────────────────────────────┘
```

### Slash Commands

| Command | Description |
|---|---|
| `/help` | Show command reference |
| `/status` | Active directive + agent state |
| `/attack [target]` | Set attack/raid directive |
| `/defend` | Focus on defense |
| `/eco` | Focus on economics |
| `/collect` | Debris + inactive looting |
| `/research [topic]` | Tech focus |
| `/clear` | Cancel active directive |
| `/force <text>` | Execute directive, skip safety gate |
| `/pause` | Pause agent after current cycle |
| `/resume` | Resume paused agent |
| `/version` | Show version |

You can also type freely — `"let's grab some loot from inactives"` works just as well as `/attack`.  
Use `force: <text>` or `/force <text>` to override the AI safety gate.

---

## Architecture

```
index.js          — entry point, TUI init, shutdown
src/
  agent.js        — main cycle: scan → strategize → execute
  scanner.js      — Empire page scanner + per-planet fallback
  commander.js    — directive state management
  commands/
    slash.js      — /slash command handler + pause state
  tactics/
    economics.js  — mine upgrades, energy, storage
    defense.js    — shield domes, turrets, cannons
    attacker.js   — espionage-driven raiding
    collector.js  — debris field harvesting
  ai/
    strategist.js — periodic LLM strategic plan
    director.js   — one-shot directive interpretation + safety check
  ui/
    tui.js        — blessed split-screen TUI
  utils/
    logger.js     — Winston logger with TUI bridge
    briefing.js   — commander-style narrative log messages
    navigation.js — page navigation helpers, session health
    delay.js      — human-like timing helpers
    human.js      — mouse/scroll humanisation
  db/
    index.js      — SQLite persistence (snapshots, decisions, directives)
  auth.js         — login, session restore, CAPTCHA solver
  browser.js      — Playwright launch with stealth plugins
```

---

## Disclaimer

This project is for **educational and personal research purposes only**.  
Automated gameplay may violate OGame's Terms of Service. Use at your own risk.

---

## License

MIT
