#!/usr/bin/env node
/**
 * insights-plus-mcp-bridge
 *
 * A local MCP server (stdio transport, as required for an MCPB bundle)
 * that transparently bridges Claude to a remote, self-hosted UniFi
 * Insights Plus instance's MCP endpoint over HTTPS.
 *
 * It forwards tools/prompts/resources requests to the upstream server
 * and relays the results back unchanged, while handling:
 *   - Bearer-token auth for the Insights Plus app itself
 *   - Optional Cloudflare Access service-token headers
 *   - Lazy upstream connection (fast local handshake, see upstream-client.js)
 *   - Automatic reconnect on a stale/dropped upstream connection
 *   - Per-request timeouts with clear, actionable error messages
 *
 * All logging goes to stderr — stdout is reserved for MCP protocol
 * messages (see logger.js).
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListPromptsRequestSchema,
  GetPromptRequestSchema,
  ListResourcesRequestSchema,
  ListResourceTemplatesRequestSchema,
  ReadResourceRequestSchema,
  McpError,
  ErrorCode,
} from "@modelcontextprotocol/sdk/types.js";

import { loadConfig, ConfigError } from "./config.js";
import { createLogger } from "./logger.js";
import { createUpstream, UpstreamTimeoutError, UpstreamConnectionError } from "./upstream-client.js";

const SERVER_INFO = {
  name: "insights-plus-mcp-bridge",
  version: "1.0.0",
};

/**
 * Converts any error we might throw or receive from the upstream call
 * into a well-formed MCP error, so the host always sees a protocol-
 * compliant response instead of a raw/opaque exception.
 */
function toMcpError(error, context) {
  if (error instanceof McpError) return error;

  if (error instanceof UpstreamTimeoutError) {
    return new McpError(
      ErrorCode.RequestTimeout,
      `${context}: ${error.message} If your Insights Plus instance or network ` +
        `is just slow, try raising "Request Timeout" in this extension's settings.`,
    );
  }

  if (error instanceof UpstreamConnectionError) {
    return new McpError(
      ErrorCode.ConnectionClosed,
      `${context}: ${error.message} Check that the MCP Endpoint URL is correct, ` +
        `the Insights Plus instance is reachable, and (if applicable) your ` +
        `Cloudflare Access credentials are current.`,
    );
  }

  // Treat HTTP-auth-shaped failures distinctly so the message tells the
  // user which layer rejected the request, rather than a generic 401.
  const message = String(error?.message || error);
  if (/\b401\b/.test(message)) {
    return new McpError(
      ErrorCode.InvalidRequest,
      `${context}: the remote server rejected the request as unauthorized (401). ` +
        `Check the MCP Bearer Token in this extension's settings.`,
    );
  }
  if (/\b403\b/.test(message)) {
    return new McpError(
      ErrorCode.InvalidRequest,
      `${context}: the request was forbidden (403). If this endpoint sits behind ` +
        `Cloudflare Access, check the Client ID/Secret in this extension's settings.`,
    );
  }

  return new McpError(ErrorCode.InternalError, `${context}: ${message}`);
}

async function main() {
  let config;
  // A logger that doesn't yet know which strings to redact — used only
  // for the startup-configuration-error path, before we have the secrets
  // in hand to redact. It never logs secret VALUES because none exist yet.
  const bootLogger = createLogger({ verbose: true });

  try {
    config = loadConfig();
  } catch (error) {
    if (error instanceof ConfigError) {
      bootLogger.error(`Configuration error: ${error.message}`);
      process.exit(1);
    }
    bootLogger.error("Unexpected error while loading configuration", {
      error: String(error?.message || error),
    });
    process.exit(1);
  }

  const logger = createLogger({
    verbose: config.verboseLogging,
    secrets: [config.bearerToken, config.cfAccessClientId, config.cfAccessClientSecret],
  });

  if (config.insecureHttpWarning) {
    logger.warn(
      "MCP Endpoint URL uses plain http:// to a non-local host. Your bearer " +
        "token will be sent unencrypted. Use https:// unless you fully trust " +
        "this network path.",
    );
  }

  const upstream = createUpstream({ config, logger });

  const server = new Server(SERVER_INFO, {
    capabilities: {
      tools: {},
      prompts: {},
      resources: {},
    },
  });

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    try {
      return await upstream.withUpstream("tools/list", (client) => client.listTools());
    } catch (error) {
      logger.error("tools/list failed", { error: String(error?.message || error) });
      throw toMcpError(error, "Listing tools from Insights Plus failed");
    }
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const toolName = request?.params?.name ?? "(unknown)";
    try {
      logger.debug(`Forwarding tool call: ${toolName}`);
      return await upstream.withUpstream(`tools/call:${toolName}`, (client) =>
        client.callTool(request.params),
      );
    } catch (error) {
      logger.error(`tools/call failed for "${toolName}"`, {
        error: String(error?.message || error),
      });
      // Prefer returning a structured tool-error result over throwing,
      // so the model sees an actionable message instead of a bare
      // protocol-level failure, matching how well-behaved MCP tools
      // report their own runtime errors.
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: toMcpError(error, `Calling tool "${toolName}" on Insights Plus failed`).message,
          },
        ],
      };
    }
  });

  // Prompts and resources are optional on the remote side. If the
  // upstream Insights Plus server doesn't implement them, we translate
  // that into an empty list / MethodNotFound rather than a crash, since
  // not every MCP provides every capability.
  server.setRequestHandler(ListPromptsRequestSchema, async () => {
    try {
      return await upstream.withUpstream("prompts/list", (client) => client.listPrompts());
    } catch (error) {
      logger.debug("prompts/list not available upstream", {
        error: String(error?.message || error),
      });
      return { prompts: [] };
    }
  });

  server.setRequestHandler(GetPromptRequestSchema, async (request) => {
    try {
      return await upstream.withUpstream("prompts/get", (client) =>
        client.getPrompt(request.params),
      );
    } catch (error) {
      throw toMcpError(error, `Getting prompt "${request?.params?.name}" failed`);
    }
  });

  server.setRequestHandler(ListResourcesRequestSchema, async () => {
    try {
      return await upstream.withUpstream("resources/list", (client) => client.listResources());
    } catch (error) {
      logger.debug("resources/list not available upstream", {
        error: String(error?.message || error),
      });
      return { resources: [] };
    }
  });

  server.setRequestHandler(ListResourceTemplatesRequestSchema, async () => {
    try {
      return await upstream.withUpstream("resources/templates/list", (client) =>
        client.listResourceTemplates(),
      );
    } catch (error) {
      logger.debug("resources/templates/list not available upstream", {
        error: String(error?.message || error),
      });
      return { resourceTemplates: [] };
    }
  });

  server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    try {
      return await upstream.withUpstream("resources/read", (client) =>
        client.readResource(request.params),
      );
    } catch (error) {
      throw toMcpError(error, `Reading resource "${request?.params?.uri}" failed`);
    }
  });

  async function shutdown(signal) {
    logger.info(`Received ${signal}, shutting down`);
    try {
      await upstream.close();
    } catch {
      // best-effort cleanup only
    }
    process.exit(0);
  }
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("uncaughtException", (error) => {
    logger.error("Uncaught exception", { error: String(error?.stack || error) });
  });
  process.on("unhandledRejection", (error) => {
    logger.error("Unhandled promise rejection", { error: String(error?.stack || error) });
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
  logger.info(
    `insights-plus-mcp-bridge ready (upstream: ${new URL(config.mcpUrl).origin}, ` +
      `timeout: ${config.requestTimeoutMs}ms). Upstream connection is lazy — ` +
      `it will be established on the first tool call.`,
  );
}

main().catch((error) => {
  process.stderr.write(
    `[FATAL] insights-plus-mcp-bridge failed to start: ${String(error?.stack || error)}\n`,
  );
  process.exit(1);
});
