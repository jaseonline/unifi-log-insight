# Deployment Examples

Reference configs for the Oracle Cloud / Cloudflare Tunnel / CGNAT-relay deployment described in the wiki:

- [`docker-compose.oracle-vm.yml`](docker-compose.oracle-vm.yml) — the compose file shape used on the cloud VM.
- [`cloudflared/oracle-vm-tunnel-config.yml`](cloudflared/oracle-vm-tunnel-config.yml) — the dedicated tunnel's ingress config.
- [`systemd/`](systemd/) — unit files for the SSH/socat relay that gets syslog from a CGNAT'd home network to the VM:
  - `relay-socat-home.service` (home LAN side, UDP→TCP)
  - `relay-tunnel.service` (home LAN side, the SSH carrier)
  - `relay-socat-vm.service` (VM side, TCP→UDP)

Every file here has placeholders (`<your-...>`) — none of it is meant to be used verbatim. Read the corresponding wiki page first:

- [Oracle-Cloud-Deployment](../wiki/Oracle-Cloud-Deployment.md)
- [CGNAT-Relay-Setup](../wiki/CGNAT-Relay-Setup.md)
- [MCP-Client-Troubleshooting](../wiki/MCP-Client-Troubleshooting.md)

**Never commit a filled-in version of any of these with real IPs, hostnames, keys, or secrets substituted in** — keep the real values in `.env` (gitignored) or your secrets manager, and only ever commit the placeholder form.
