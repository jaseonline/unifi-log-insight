# Running the Syslog Receiver Behind CGNAT (SSH + socat Relay)

This guide covers a deployment shape the main README doesn't: **your UniFi gateway and your Insights Plus container are on different networks, and your home ISP connection sits behind Carrier-Grade NAT (CGNAT)** — so you can't just port-forward UDP 514 to a cloud box, and WireGuard (or any scheme relying on unsolicited inbound UDP to your home WAN IP) won't work either.

## Why WireGuard (or any inbound-UDP scheme) fails here

CGNAT means your router's WAN address is *not* a real public IP — it's inside the shared carrier range (RFC 6598, `100.64.0.0/10`). Symptoms that confirm this is what you're dealing with:

- Outbound UDP from your LAN reaches your router's WAN interface fine, but the far end never sees it, for *any* UDP traffic to a non-standard port — not just WireGuard specifically.
- `curl ifconfig.me` or similar from inside your LAN returns an address different from what shows up on an external port scan of "your" IP, or the address itself falls in `100.64.0.0/10`–`100.127.255.255/10`.
- Port forwarding a UDP port in your router's UI has no effect — because the forward is being applied on an address that isn't actually the internet-facing one; the ISP's own NAT layer, upstream of your router, is what's actually facing the internet.

Under CGNAT, outbound-*initiated* TCP (SSH, HTTPS) works completely normally — your router's connection tracking state lets replies back in. What doesn't work is anything that depends on an *unsolicited* inbound packet reaching you, which is exactly what WireGuard, a UDP port-forward, or a reverse DNS/STUN-less P2P scheme all need.

## The fix: tunnel everything over one outbound SSH session

Instead of trying to get packets *in*, push them *out* over a connection your home network initiates and keeps alive. `socat` bridges the UDP syslog traffic to TCP on each end, and `autossh` carries that TCP stream over SSH to the cloud VM, auto-reconnecting if the link drops.

```
UniFi Gateway                 Home LAN host (Pi/NAS/etc.)              Cloud VM
──────────────                ────────────────────────────             ────────
syslog UDP:514  ──UDP──>  socat UDP-LISTEN:514                          
                           → TCP:127.0.0.1:5514   ──┐
                                                     │ autossh -L 5514:127.0.0.1:5514
                                                     │ (single outbound TCP:22 session,
                                                     │  survives CGNAT — it's the home
                                                     │  side that dials out)
                                                     └──>  sshd:22  ──>  socat TCP-LISTEN:5514
                                                                          → UDP-SENDTO:127.0.0.1:514
                                                                                │
                                                                                ▼
                                                                   Insights Plus container
                                                                   (UDP 514, 127.0.0.1-bound)
```

Three services, two ends:

| Where | Service | What it does |
|---|---|---|
| Home LAN host | `relay-socat-home.service` | `socat UDP4-LISTEN:514,fork,reuseaddr TCP4:127.0.0.1:5514` — turns incoming syslog UDP into a local TCP stream |
| Home LAN host | `relay-tunnel.service` | `autossh` with `-L 5514:127.0.0.1:5514` — carries that TCP stream to the VM over the outbound SSH session |
| Cloud VM | `relay-socat-vm.service` | `socat TCP4-LISTEN:5514,fork,reuseaddr UDP4-SENDTO:127.0.0.1:514` — turns the TCP stream back into UDP, feeding the container |

Ready-to-adapt unit files: [`docs/examples/systemd/`](../examples/systemd/).

## SSH key setup (restricted, forwarding-only)

Use a **dedicated key**, not your general admin key, and restrict what it can do in the VM's `authorized_keys`:

```
command="/bin/false",permitopen="127.0.0.1:5514",no-agent-forwarding,no-X11-forwarding,no-pty ssh-ed25519 AAAA... pi-relay-key
```

`command="/bin/false"` means the key can't open an interactive shell even if it's ever used outside the intended `-L` forward — all it can do is what `permitopen` allows. If you also need a reverse forward (e.g. to reach the UniFi controller's HTTPS/API from the VM), add `permitlisten="0.0.0.0:<port>"` entries for each reverse port you open.

## A failure mode to watch for: reverse forwards can silently stop listening

If you add a `-R` reverse forward (e.g. `-R 0.0.0.0:6443:<controller-ip>:443`) alongside the `-L` forward above, be aware of this specific `ssh`/`autossh` behavior: if the remote `sshd` rejects the bind at negotiation time (port already in use, `GatewayPorts` misconfigured, `permitlisten` typo, etc.), **the SSH session itself does not die** — it just silently drops that one forward while everything else (including your `-L` syslog forward) keeps working fine. `autossh` has nothing to reconnect because, from its point of view, the session is healthy.

**Symptom**: the thing depending on the reverse forward (e.g. UniFi API polling) stops getting data, but syslog keeps flowing and the tunnel service reports "active" the whole time.

**Check**: `sudo ss -tlnp | grep <port>` on the VM. If your expected port isn't listed despite the SSH session being up, restart the tunnel service on the home-LAN side — that forces a fresh negotiation.

This is a known quirk of OpenSSH's forward handling, not a bug in this setup — it's worth a monitoring check (or at least muscle memory) if you depend on a reverse forward for anything you'd notice being broken.

## Defense in depth: bind sockets to localhost only

Both `socat` instances above should bind to `127.0.0.1`, not `0.0.0.0`, unless you have a specific reason otherwise — there's no reason either end of this relay needs to accept connections from anywhere except the SSH tunnel's own loopback forward. Combined with a cloud firewall/security-list that only allows inbound `22/tcp`, this means even a config mistake elsewhere doesn't expose the relay to the open internet.

## Verifying it actually survives a reboot

Before considering this done, reboot *both* ends unattended and confirm:

1. All three systemd services come back (`systemctl is-enabled` + `is-active` on each).
2. Syslog data resumes flowing (check the Insights Plus dashboard/log stream for fresh entries).
3. If you have a reverse forward, re-check it specifically per the failure mode above — don't assume it came back just because the tunnel service shows active.
4. Scan the VM's public IP from a genuinely external vantage point (a different network — e.g. your phone on mobile data, not Wi-Fi) to confirm only SSH (and whatever's intentionally public, like a Cloudflare Tunnel's HTTPS endpoint) is reachable. Scanning from inside a cloud sandbox or dev environment that routes through its own outbound HTTP proxy can give **false positives** — if a scan claims 80/443 are open but nothing is actually listening there, suspect the scanning environment before the VM.
