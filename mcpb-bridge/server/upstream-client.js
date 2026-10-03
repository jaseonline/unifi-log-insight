/**
 * Manages the connection to the remote Insights Plus MCP endpoint.
 *
 * Design notes (why it's built this way):
 *
 * 1. LAZY CONNECTION — the upstream HTTP connection is only opened on the
 *    first real request (listTools/callTool/etc.), not when this process
 *    starts. This is the direct fix for a real failure mode seen in
 *    production: a client config that resolves/spawns a package on every
 *    launch (e.g. `npx -y mcp-remote`) can intermittently blow past the
 *    host's handshake timeout before the server even starts. Here, the
 *    local stdio server answers the host's `initialize` immediately,
 *    with zero network dependency — only the first tool call pays any
 *    upstream connection cost, and that cost is bounded by the
 *    configured request timeout rather than an open-ended registry
 *    lookup.
 *
 * 2. SELF-HEALING RECONNECT — if the upstream SSE/HTTP stream drops mid
 *    session (observed in practice behind tunnels/proxies with idle
 *    timeouts), the next call transparently reconnects rather than
 *    failing forever until the host is restarted.
 *
 * 3. SINGLE IN-FLIGHT CONNECT — concurrent calls arriving while a
 *    connection attempt is already in progress reuse that same attempt
 *    instead of racing multiple connections.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";

const CLIENT_INFO = {
  name: "insights-plus-mcp-bridge",
  version: "1.0.0",
};

export class UpstreamConnectionError extends Error {
  constructor(message, { cause } = {}) {
    super(message);
    this.name = "UpstreamConnectionError";
    if (cause) this.cause = cause;
  }
}

export class UpstreamTimeoutError extends Error {
  constructor(message) {
    super(message);
    this.name = "UpstreamTimeoutError";
  }
}

export function createUpstream({ config, logger }) {
  /** @type {Client | null} */
  let client = null;
  /** @type {Promise<Client> | null} */
  let connecting = null;

  function buildHeaders() {
    const headers = {
      Authorization: `Bearer ${config.bearerToken}`,
    };
    if (config.cfAccessClientId && config.cfAccessClientSecret) {
      headers["CF-Access-Client-Id"] = config.cfAccessClientId;
      headers["CF-Access-Client-Secret"] = config.cfAccessClientSecret;
    }
    return headers;
  }

  async function connectOnce() {
    const url = new URL(config.mcpUrl);
    const headers = buildHeaders();
    const newClient = new Client(CLIENT_INFO, { capabilities: {} });

    // Prefer the modern Streamable HTTP transport (what Insights Plus's
    // /api/mcp endpoint speaks). Fall back to plain SSE for older or
    // differently-configured remote servers rather than failing outright.
    try {
      logger.debug("Connecting to upstream via Streamable HTTP transport");
      const transport = new StreamableHTTPClientTransport(url, {
        requestInit: { headers },
      });
      await newClient.connect(transport);
      logger.info("Connected to upstream MCP server (Streamable HTTP)");
      return newClient;
    } catch (streamableError) {
      logger.warn(
        "Streamable HTTP connection failed, falling back to SSE transport",
        { error: String(streamableError?.message || streamableError) },
      );
      try {
        const fallbackClient = new Client(CLIENT_INFO, { capabilities: {} });
        const sseTransport = new SSEClientTransport(url, {
          requestInit: { headers },
          eventSourceInit: {
            fetch: (input, init) =>
              fetch(input, { ...init, headers: { ...(init?.headers || {}), ...headers } }),
          },
        });
        await fallbackClient.connect(sseTransport);
        logger.info("Connected to upstream MCP server (SSE fallback)");
        return fallbackClient;
      } catch (sseError) {
        throw new UpstreamConnectionError(
          `Could not connect to the remote MCP endpoint at ${url.origin}${url.pathname}. ` +
            `Streamable HTTP error: ${streamableError?.message || streamableError}. ` +
            `SSE fallback error: ${sseError?.message || sseError}.`,
          { cause: sseError },
        );
      }
    }
  }

  async function getClient() {
    if (client) return client;
    if (connecting) return connecting;

    connecting = connectOnce()
      .then((connected) => {
        client = connected;
        connecting = null;

        // If the transport reports the connection died, drop our
        // reference so the NEXT call reconnects instead of reusing a
        // dead client forever.
        connected.onclose = () => {
          logger.warn("Upstream connection closed; will reconnect on next request");
          if (client === connected) client = null;
        };
        connected.onerror = (error) => {
          logger.warn("Upstream connection reported an error", {
            error: String(error?.message || error),
          });
          if (client === connected) client = null;
        };

        return connected;
      })
      .catch((error) => {
        connecting = null; // allow the next call to retry, not loop forever on one broken promise
        throw error;
      });

    return connecting;
  }

  function withTimeout(promise, label) {
    const timeoutMs = config.requestTimeoutMs;
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => {
        reject(
          new UpstreamTimeoutError(
            `Request to remote MCP endpoint timed out after ${timeoutMs}ms (${label}).`,
          ),
        );
      }, timeoutMs);
    });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
  }

  /**
   * Runs `fn(client)` against a connected upstream client, with a single
   * automatic retry if the connection turns out to be stale (the most
   * common real-world failure: a long-idle connection that the remote
   * end, a proxy, or a tunnel silently dropped).
   */
  async function withUpstream(label, fn) {
    const activeClient = await withTimeout(getClient(), `connecting (${label})`);
    try {
      return await withTimeout(fn(activeClient), label);
    } catch (error) {
      const looksStale =
        error?.name !== "UpstreamTimeoutError" &&
        (error?.code === "ECONNRESET" ||
          error?.code === "EPIPE" ||
          /closed|disconnected|socket hang up/i.test(String(error?.message || "")));

      if (!looksStale) throw error;

      logger.warn(`Upstream call failed (${label}), retrying once after reconnect`, {
        error: String(error?.message || error),
      });
      client = null; // force a fresh connection
      const freshClient = await withTimeout(getClient(), `reconnecting (${label})`);
      return await withTimeout(fn(freshClient), `${label} (retry)`);
    }
  }

  async function close() {
    if (client) {
      try {
        await client.close();
      } catch (error) {
        logger.debug("Error while closing upstream client", {
          error: String(error?.message || error),
        });
      }
      client = null;
    }
  }

  return { withUpstream, close };
}
