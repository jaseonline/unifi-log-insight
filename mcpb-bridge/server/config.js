/**
 * Reads and validates this bundle's configuration from environment
 * variables. The host application populates these from the
 * `user_config` values declared in manifest.json (see mcp_config.env).
 *
 * Keeping validation in one place means every failure mode produces a
 * single, clear, actionable error message instead of a confusing crash
 * somewhere deep in the transport code.
 */

class ConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = "ConfigError";
  }
}

function truthy(value) {
  if (value === undefined || value === null || value === "") return false;
  const normalized = String(value).trim().toLowerCase();
  return normalized === "true" || normalized === "1" || normalized === "yes";
}

function parsePositiveInt(value, fallback, { min, max, label }) {
  if (value === undefined || value === null || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new ConfigError(
      `${label} must be a positive number; received "${value}".`,
    );
  }
  if (min !== undefined && parsed < min) {
    throw new ConfigError(`${label} must be at least ${min}; received ${parsed}.`);
  }
  if (max !== undefined && parsed > max) {
    throw new ConfigError(`${label} must be at most ${max}; received ${parsed}.`);
  }
  return parsed;
}

export function loadConfig(env = process.env) {
  const mcpUrl = (env.IPMB_MCP_URL || "").trim();
  const bearerToken = (env.IPMB_BEARER_TOKEN || "").trim();
  const cfAccessClientId = (env.IPMB_CF_ACCESS_CLIENT_ID || "").trim();
  const cfAccessClientSecret = (env.IPMB_CF_ACCESS_CLIENT_SECRET || "").trim();
  const verboseLogging = truthy(env.IPMB_VERBOSE_LOGGING);

  if (!mcpUrl) {
    throw new ConfigError(
      "No MCP Endpoint URL configured. Set it in this extension's settings " +
        "(e.g. https://insights.example.com/api/mcp).",
    );
  }

  let parsedUrl;
  try {
    parsedUrl = new URL(mcpUrl);
  } catch {
    throw new ConfigError(
      `MCP Endpoint URL is not a valid URL: "${mcpUrl}". Expected something ` +
        `like https://insights.example.com/api/mcp.`,
    );
  }
  if (parsedUrl.protocol !== "https:" && parsedUrl.protocol !== "http:") {
    throw new ConfigError(
      `MCP Endpoint URL must use http or https, got "${parsedUrl.protocol}".`,
    );
  }
  if (parsedUrl.protocol === "http:" && parsedUrl.hostname !== "localhost" && parsedUrl.hostname !== "127.0.0.1") {
    // Not fatal — some users genuinely run plain HTTP behind a trusted
    // private network — but worth a loud warning since bearer tokens
    // would otherwise cross the network in the clear.
    // (Logged by the caller, which has access to the logger.)
    parsedUrl._insecureHttpWarning = true;
  }

  if (!bearerToken) {
    throw new ConfigError(
      "No MCP Bearer Token configured. Generate one from Settings → MCP " +
        "inside your Insights Plus instance and set it in this extension's settings.",
    );
  }

  const hasClientId = Boolean(cfAccessClientId);
  const hasClientSecret = Boolean(cfAccessClientSecret);
  if (hasClientId !== hasClientSecret) {
    throw new ConfigError(
      "Cloudflare Access Client ID and Client Secret must both be set, or " +
        "both left empty. Only one was provided.",
    );
  }

  const requestTimeoutSeconds = parsePositiveInt(
    env.IPMB_REQUEST_TIMEOUT_SECONDS,
    30,
    { min: 5, max: 300, label: "Request Timeout ( seconds)" },
  );

  return {
    mcpUrl,
    bearerToken,
    cfAccessClientId: hasClientId ? cfAccessClientId : undefined,
    cfAccessClientSecret: hasClientSecret ? cfAccessClientSecret : undefined,
    requestTimeoutMs: requestTimeoutSeconds * 1000,
    verboseLogging,
    insecureHttpWarning: Boolean(parsedUrl._insecureHttpWarning),
  };
}

export { ConfigError };
