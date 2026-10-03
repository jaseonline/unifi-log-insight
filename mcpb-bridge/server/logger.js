/**
 * Minimal stderr logger.
 *
 * MCP servers speak the protocol over stdout/stdin — anything written to
 * stdout that isn't a JSON-RPC message will corrupt the stream and break
 * the host connection. All logging in this bundle MUST go to stderr.
 *
 * This logger also actively redacts known-sensitive values (tokens,
 * secrets) from anything passed to it, as a defense-in-depth measure in
 * case a caller accidentally includes one in a log line.
 */

const LEVELS = ["error", "warn", "info", "debug"];

export function createLogger({ verbose = false, secrets = [] } = {}) {
  const minLevelIndex = verbose ? LEVELS.indexOf("debug") : LEVELS.indexOf("info");
  const redactionList = secrets.filter(Boolean);

  function redact(value) {
    if (typeof value !== "string") return value;
    let out = value;
    for (const secret of redactionList) {
      if (secret && secret.length >= 4) {
        out = out.split(secret).join("[REDACTED]");
      }
    }
    return out;
  }

  function write(level, message, meta) {
    const levelIndex = LEVELS.indexOf(level);
    if (levelIndex === -1 || levelIndex > minLevelIndex) return;

    const timestamp = new Date().toISOString();
    const safeMessage = redact(message);
    let line = `[${timestamp}] [${level.toUpperCase()}] [insights-plus-mcp-bridge] ${safeMessage}`;

    if (meta !== undefined) {
      try {
        const safeMeta = redact(JSON.stringify(meta));
        line += ` ${safeMeta}`;
      } catch {
        line += " [unserializable metadata omitted]";
      }
    }

    process.stderr.write(line + "\n");
  }

  return {
    error: (message, meta) => write("error", message, meta),
    warn: (message, meta) => write("warn", message, meta),
    info: (message, meta) => write("info", message, meta),
    debug: (message, meta) => write("debug", message, meta),
  };
}
