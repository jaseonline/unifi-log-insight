# MCP Client Setup &amp; Troubleshooting (Claude Desktop, Claude Code, etc.)

The MCP endpoint (`/api/mcp`) works reliably once connected, but getting an `npx`-based client config to connect *reliably* has a specific, non-obvious failure mode worth knowing about.

## The problem: `npx -y mcp-remote ...` has unpredictable cold-start latency

A config like this looks correct and often works:

```json
{
  "mcpServers": {
    "unifi-log-insight": {
      "command": "npx",
      "args": [
        "-y", "mcp-remote",
        "https://insights.<yourdomain>/api/mcp",
        "--header", "Authorization: Bearer <token>",
        "--header", "CF-Access-Client-Id: <id>.access",
        "--header", "CF-Access-Client-Secret: <secret>"
      ]
    }
  ]
}
```

The issue is `npx` itself, not `mcp-remote` or the server. Every time the client spawns this command, `npx` checks the npm registry to resolve the `mcp-remote` package (since no version is pinned) before it can even start the process. That lookup is usually fast (a few seconds) but is not bounded — on a slow network, a flaky registry response, or just bad luck, it can take 30+ seconds. If your MCP client enforces a timeout on the initial `initialize` handshake (Claude Desktop's internal timeout is roughly in the 60-second range), a slow `npx` resolution alone can blow through it — with symptoms that look exactly like a broken server: `Server started and connected successfully` followed by a long silence, then a cancelled connection.

**How to confirm this is what's happening to you**: time a cold invocation —

```powershell
Measure-Command { npx -y mcp-remote --version }
```

If this is inconsistent — sometimes a couple of seconds, sometimes 20–30+ — the registry round-trip is your problem, not the Insights Plus server. (You can sanity-check the server independently: if you have any other way to hit `/api/health` or `/api/mcp` and it responds quickly and consistently, the server itself is fine.)

## The fix: install `mcp-remote` as a real binary, skip `npx` entirely

```powershell
npm install -g mcp-remote@<pinned-version>
```

This installs an actual executable (on Windows, resolves to something like `%USERPROFILE%\.local\bin\mcp-remote.cmd`; find it with `where.exe mcp-remote` or `npm root -g`). Then point the client config straight at that binary instead of `npx`:

```json
{
  "mcpServers": {
    "unifi-log-insight": {
      "command": "C:\\Users\\<you>\\.local\\bin\\mcp-remote.cmd",
      "args": [
        "https://insights.<yourdomain>/api/mcp",
        "--header", "Authorization: Bearer <token>",
        "--header", "CF-Access-Client-Id: <id>.access",
        "--header", "CF-Access-Client-Secret: <secret>"
      ]
    }
  ]
}
```

No `npx`, no `-y`, no `mcp-remote` as an arg — just the URL and headers. This removes the npm-registry dependency from every single connection attempt; startup time becomes consistent (a few seconds, bounded by Node startup + TLS handshake, not network-dependent package resolution).

A bare `npm update -g mcp-remote` periodically keeps it current; pin a specific version if you want full reproducibility.

## Two related symptoms this also explains

- **"Couldn't start this server for Cowork and Code sessions ... Request timed out"** — a separate client spawn path (for shared/background sessions) hits the exact same `npx` resolution delay independently of the interactive chat connection. The fix above resolves both.
- **A connection that works, then drops mid-session** (`SSE stream disconnected: TypeError: terminated`) — this is a *different* issue (a transport-level disconnect after a successful handshake, not a spawn-latency problem) and isn't fixed by the above. If you see this, suspect an idle timeout somewhere in the path between client and origin (Cloudflare Tunnel / Access) or resource pressure on a small VM (see [Oracle-Cloud-Deployment](Oracle-Cloud-Deployment) if that's your topology) before assuming it's an app bug.

## Don't forget the Cloudflare Access headers if you're path-scoping the MCP endpoint

If your deployment uses a Service-Token-gated Access app scoped to just `/api/mcp` (see [Oracle-Cloud-Deployment](Oracle-Cloud-Deployment)), `mcp-remote` needs **all three** headers — the app's own `Authorization: Bearer`, plus `CF-Access-Client-Id` and `CF-Access-Client-Secret`. Missing either of the latter two gets you a 403 from Cloudflare before the request ever reaches the app; missing the first gets you a 401 from the app itself after Access lets it through. If you're debugging a 401/403, check which layer actually rejected the request (Cloudflare Access's own error page looks different from the app's JSON error) before assuming the wrong thing is broken.

## Credential hygiene while debugging

When pasting logs, configs, or curl commands into a chat session (with Claude or anyone else) for help debugging a connection issue, redact or placeholder any live token, secret, or key first. If a live credential does end up in a chat transcript, treat it as compromised and rotate it — don't rely on the chat being private as a substitute for rotation.
