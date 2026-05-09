const winston = require('winston');
const { Writable } = require('stream');

// ── Winston instance ─────────────────────────────────────────────────────────

const plainFormat = winston.format.combine(
  winston.format.timestamp({ format: 'HH:mm:ss' }),
  winston.format.colorize(),
  winston.format.printf(({ timestamp, level, message }) =>
    `${timestamp} [${level}] ${message}`
  )
);

const fileFormat = winston.format.combine(
  winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
  winston.format.uncolorize(),
  winston.format.printf(({ timestamp, level, message }) =>
    `${timestamp} [${level}] ${message}`
  )
);

const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  transports: [
    new winston.transports.Console({ format: plainFormat }),
    new winston.transports.File({ filename: 'ogame-agent.log', format: fileFormat }),
  ],
});

// ── TUI bridge ───────────────────────────────────────────────────────────────
// When the TUI is active, intercept all log output and route it to the TUI
// log panel instead of stdout. The file transport always writes regardless.

let _tui = null;

function attachTUI(tui) {
  _tui = tui;

  // Silence the console transport (TUI takes over stdout)
  logger.transports.forEach(t => {
    if (t instanceof winston.transports.Console) t.silent = true;
  });

  // Add a proper transport that writes plain (uncolorized) text to the TUI.
  // Uses winston.transports.Stream writing to a simple Writable that forwards
  // each formatted line to tui.log().
  const tuiStream = new Writable({
    write(chunk, _enc, cb) {
      // chunk is a formatted line string (with a trailing newline)
      const line = chunk.toString().replace(/\r?\n$/, '');
      if (line) _tui.log(line);
      cb();
    },
  });
  tuiStream.on('error', () => {}); // suppress EPIPE

  logger.add(new winston.transports.Stream({
    stream: tuiStream,
    level:  process.env.LOG_LEVEL || 'info',
    format: winston.format.combine(
      winston.format.timestamp({ format: 'HH:mm:ss' }),
      winston.format.printf(({ timestamp, level, message }) =>
        `${timestamp} [${level}] ${message}`
      )
    ),
  }));
}

logger.attachTUI = attachTUI;

module.exports = logger;
