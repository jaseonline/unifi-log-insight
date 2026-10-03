# Deploying on an Oracle Cloud Always-Free VM, Behind Cloudflare Tunnel

This page documents a specific, verified-working deployment: Insights Plus running on an Oracle Cloud "Always Free" VM, exposed through a dedicated Cloudflare Tunnel, with two layers of auth and no inbound ports open except SSH. It differs from a plain single-host Docker Compose setup in a few ways that are each worth understanding before you copy it, because they were each the fix for a real failure, not a stylistic choice.

If your UniFi gateway and the VM are on different networks and your home connection is behind CGNAT, read [CGNAT-Relay-Setup](CGNAT-Relay-Setup) first — that's how syslog actually reaches the VM in this topology.

## The shape, end to end

```
UniFi Gateway → (CGNAT relay, see CGNAT-Relay-Setup) → Cloud VM:
                                                           ├─ docker-compose: unifi-log-insight container
                                                           │    127.0.0.1:514/udp  ← syslog
                                                           │    127.0.0.1:8090     ← web/API
                                                           ├─ cloudflared (dedicated tunnel, systemd)
                                                           │    insights.<yourdomain> → http://127.0.0.1:8090
                                                           └─ Cloudflare Access (two apps — see below)
```

## VM sizing: the free-tier E2.1.Micro is tight, not broken

Oracle's `VM.Standard.E2.1.Micro` (x86_64, 1 OCPU, ~954MB RAM + swap) was a fallback after their ARM `A1.Flex` shapes (which have much more headroom) were out of capacity in this region at build time. It runs this stack fine — PostgreSQL, the receiver, and the API all fit — but there's much less slack than the README's "4GB RAM" baseline assumes. If you're on this shape:

- Watch `free -h` and `docker stats` periodically, especially after retention/log-volume grows.
- If you ever see the app or MCP endpoint becoming slow or unresponsive under load, memory pressure on this shape is the first thing to rule out — not a bug in the app.
- If an A1.Flex (or any shape with more RAM) becomes available in your region, it's worth migrating to.

## Why a dedicated Cloudflare Tunnel, not a connector on an existing one

If you already run `cloudflared` elsewhere (e.g. for other self-hosted services on your home LAN), the tempting shortcut is to add the cloud VM as another connector replica on that same tunnel. **Don't** — Cloudflare's edge load-balances requests for *any* hostname on a tunnel across *any* healthy connector, and a connector can only actually reach origins on its own network. A connector on your home LAN can't reach `127.0.0.1:8090` on the cloud VM, and vice versa — so you'd get intermittent failures depending on which connector happened to get picked for a given request.

The fix is a **separate tunnel**, running `cloudflared` as its own systemd service on the VM, with an ingress config scoped to just this one hostname. One tunnel per distinct network your origins live on.

## Two Cloudflare Access apps, not one

A single Access app gating the whole hostname works fine for the human-facing web UI — a browser can do an interactive login. It does **not** work well for an MCP client, which needs to authenticate non-interactively on every connection.

The solution used here: two Access applications on the same hostname, scoped by path.

1. **Whole-hostname app** (e.g. `insights.<yourdomain>` → `/*`) — policy is identity-based (email allow-list and/or IP/device posture). This is what a human hits in a browser.
2. **Path-scoped app** for just the MCP endpoint (e.g. `insights.<yourdomain>/api/mcp`) — policy is a **Service Token** (non-identity). An MCP client authenticates by sending `CF-Access-Client-Id` and `CF-Access-Client-Secret` headers instead of doing an interactive login.

Cloudflare evaluates the more specific (longer path) app first, so the MCP path gets the Service Token policy and everything else falls through to the identity policy.

**On the MCP client side**, you need all three credentials together, since Access and the app each authenticate independently:

```
--header "CF-Access-Client-Id: <service-token-client-id>.access"
--header "CF-Access-Client-Secret: <service-token-secret>"
--header "Authorization: Bearer <app's own MCP token, from Settings → MCP in the UI>"
```

See [MCP-Client-Troubleshooting](MCP-Client-Troubleshooting) for getting this working reliably in Claude Desktop specifically.

## The database-ownership trap with embedded Postgres

If you ever find migrations failing with `must be owner of table X` after enabling `AUTH_ENABLED=true`, check table ownership before assuming it's an app bug:

```sql
SELECT tablename, tableowner FROM pg_tables WHERE schemaname = 'public';
```

Tables created outside the app's normal migration path (for example, if you ever ran `psql` manually as the `postgres` superuser to create or alter something) can end up owned by `postgres` instead of the app's own `unifi` role. Every later migration touching that table then fails, because the migration runs as `unifi` and Postgres enforces ownership for `ALTER TABLE`. The tables most likely to be affected in an auth-enabled setup are `users`, `roles`, `sessions`, `api_tokens`, `audit_log`, and `threat_backfill_queue` — but re-run the query above rather than assuming it's only those six, especially after any restore from a stale volume or manual DB surgery.

**Fix**, per affected table:

```sql
ALTER TABLE <table_name> OWNER TO unifi;
```

A blanket `REASSIGN OWNED BY postgres TO unifi;` looks like the obvious one-liner but Postgres will refuse it — some of what `postgres` owns is schema/system-level and can't be reassigned that way. Go table-by-table for anything flagged by the ownership query.

## Reference files

- [`docs/examples/docker-compose.oracle-vm.yml`](../examples/docker-compose.oracle-vm.yml) — the compose shape actually used here: `env_file` instead of inline secrets, both ports bound to `127.0.0.1`, `AUTH_ENABLED=true`.
- [`docs/examples/cloudflared/oracle-vm-tunnel-config.yml`](../examples/cloudflared/oracle-vm-tunnel-config.yml) — the dedicated tunnel's ingress config.
- [`docs/examples/systemd/`](../examples/systemd/) — unit files for the relay and the VM-side `cloudflared` service.

## Verification checklist (run this after any change to this stack)

- [ ] Reboot the VM unattended; confirm Docker, the relay socat service, and `cloudflared` all come back without manual intervention.
- [ ] Confirm the dashboard shows fresh log entries and UniFi polling data (client/device counts) after the reboot.
- [ ] From a genuinely external network (e.g. your phone on mobile data — **not** a cloud sandbox or dev box, which may route through its own proxy and give false positives), port-scan the VM's public IP. Only `22/tcp` should be open; `80`, `443`, `514`, and your relay port should all read closed — Cloudflare Tunnel is outbound-only from the VM's side, so it never needs an inbound listener.
- [ ] Confirm the MCP endpoint works end-to-end with a real MCP client (not just `curl` against the SSE endpoint) — `curl` proves the HTTP handshake works, but a real client is the only way to confirm `initialize`/`tools/list` actually complete.

## Operational note: credential hygiene

Treat any credential that ever appears in a chat transcript, log paste, or screenshot as compromised and rotate it — the MCP bearer token, the Cloudflare Access Service Token pair, `SECRET_KEY`/`POSTGRES_PASSWORD`, and SSH keys alike. This isn't paranoia about this specific project; it's the standing rule for anything typed into or pasted alongside an AI assistant, screen-shared, or included in a support ticket. When asking for debugging help, prefer referencing a secrets manager record (Keeper, 1Password, etc.) by name/ID over pasting the live value.
