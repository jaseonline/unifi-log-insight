#!/usr/bin/env node
/**
 * Smoke test: spawns the actual bundle entry point as a real child
 * process (exactly like the host application would), sends a real
 * MCP `initialize` request over stdio, and checks for a fast, valid
 * response WITHOUT needing any real upstream Insights Plus server or
 * network access.
 *
 * This specifically verifies the lazy-connection design: the local
 * server must answer `initialize` on its own, instantly, never
 * touching the (here, intentionally bogus/unreachable) upstream URL.
 *
 * Run with: node server/smoke-test.js
 */

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const entryPoint = path.join(__dirname, "index.js");

function send(child, message) {
  child.stdin.write(JSON.stringify(message) + "\n");
}

async function main() {
  const child = spawn(process.execPath, [entryPoint], {
    env: {
      ...process.env,
      IPMB_MCP_URL: "https://127.0.0.1.invalid/api/mcp", // deliberately unreachable
      IPMB_BEARER_TOKEN: "smoke-test-token",
      IPMB_VERBOSE_LOGGING: "true",
      IPMB_REQUEST_TIMEOUT_SECONDS: "5",
    },
    stdio: ["pipe", "pipe", "pipe"],
  });

  let stderrBuf = "";
  child.stderr.on("data", (chunk) => {
    stderrBuf += chunk.toString();
  });

  let stdoutBuf = "";
  const responses = [];
  child.stdout.on("data", (chunk) => {
    stdoutBuf += chunk.toString();
    const lines = stdoutBuf.split("\n");
    stdoutBuf = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        responses.push(JSON.parse(line));
      } catch {
        console.error("FAIL: stdout contained a non-JSON line (protocol corruption):", line);
        process.exitCode = 1;
      }
    }
  });

  const startedAt = Date.now();

  await new Promise((resolve) => setTimeout(resolve, 300)); // let it boot

  send(child, {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "smoke-test", version: "0.0.0" },
    },
  });
  send(child, { jsonrpc: "2.0", method: "notifications/initialized" });
  send(child, { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });

  await new Promise((resolve) => setTimeout(resolve, 1500));

  const elapsedMs = Date.now() - startedAt;
  child.kill();

  const initResponse = responses.find((r) => r.id === 1);
  const toolsListResponse = responses.find((r) => r.id === 2);

  console.log(`Elapsed: ${elapsedMs}ms`);
  console.log(`initialize response received: ${Boolean(initResponse)}`);
  console.log(`tools/list response received (should error, upstream unreachable): ${Boolean(toolsListResponse)}`);

  let ok = true;

  if (!initResponse || !initResponse.result || !initResponse.result.serverInfo) {
    console.error("FAIL: did not get a valid initialize response.");
    ok = false;
  } else {
    console.log(`  serverInfo: ${JSON.stringify(initResponse.result.serverInfo)}`);
  }

  // The key assertion: initialize must come back fast, well under the
  // 5s configured request timeout, PROVING it never tried to touch the
  // (unreachable) upstream URL to answer the host's handshake.
  if (elapsedMs > 3000) {
    console.error(`FAIL: initialize took too long (${elapsedMs}ms) — lazy-connect may be broken.`);
    ok = false;
  }

  if (!toolsListResponse || !toolsListResponse.error) {
    console.error("FAIL: expected tools/list to fail gracefully with a structured JSON-RPC error (upstream is unreachable by design in this test), got:", JSON.stringify(toolsListResponse));
    ok = false;
  } else {
    console.log(`  tools/list error (expected): ${toolsListResponse.error.message}`);
  }

  if (process.exitCode === 1) ok = false; // stdout corruption flagged above

  console.log(ok ? "\nSMOKE TEST PASSED" : "\nSMOKE TEST FAILED");
  if (!ok) {
    console.log("\n--- stderr log for debugging ---");
    console.log(stderrBuf);
  }
  process.exit(ok ? 0 : 1);
}

main();
