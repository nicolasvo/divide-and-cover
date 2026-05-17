#!/usr/bin/env bash
# Install / refresh the dac-tunnel systemd unit that keeps the SOCKS tunnel
# (ssh -D 1080 -> Raspberry Pi on Tailscale) alive across drops + reboots.
#
# Idempotent: re-running upgrades the unit in place and only restarts the
# service if the unit file actually changed.
#
# Usage:
#   sudo ./scripts/install-tunnel-service.sh                      # uses $SUDO_USER
#   sudo TUNNEL_USER=alex ./scripts/install-tunnel-service.sh     # explicit user
#   sudo TUNNEL_REMOTE=pi@100.99.37.26 ./scripts/install-tunnel-service.sh

set -euo pipefail

UNIT_NAME="dac-tunnel"
UNIT_PATH="/etc/systemd/system/${UNIT_NAME}.service"
TUNNEL_USER="${TUNNEL_USER:-${SUDO_USER:-}}"
TUNNEL_REMOTE="${TUNNEL_REMOTE:-pi@100.99.37.26}"
TUNNEL_BIND="${TUNNEL_BIND:-0.0.0.0:1080}"

if [[ $EUID -ne 0 ]]; then
  echo "must be run as root (use sudo)" >&2
  exit 1
fi

if [[ -z "$TUNNEL_USER" ]]; then
  echo "TUNNEL_USER not set and \$SUDO_USER is empty — pass TUNNEL_USER=<login>" >&2
  exit 1
fi

if ! id "$TUNNEL_USER" >/dev/null 2>&1; then
  echo "user '$TUNNEL_USER' does not exist" >&2
  exit 1
fi

SSH_BIN="$(command -v ssh)"
if [[ -z "$SSH_BIN" ]]; then
  echo "ssh not found in PATH" >&2
  exit 1
fi

TMP_UNIT="$(mktemp)"
trap 'rm -f "$TMP_UNIT"' EXIT

cat >"$TMP_UNIT" <<EOF
[Unit]
Description=SOCKS tunnel to Pi for yt-dlp (divide-and-cover)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=${TUNNEL_USER}
ExecStart=${SSH_BIN} -N -D ${TUNNEL_BIND} \\
  -o ServerAliveInterval=30 \\
  -o ServerAliveCountMax=3 \\
  -o ExitOnForwardFailure=yes \\
  -o StrictHostKeyChecking=no \\
  -o UserKnownHostsFile=/dev/null \\
  ${TUNNEL_REMOTE}
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF

changed=0
if [[ ! -f "$UNIT_PATH" ]] || ! cmp -s "$TMP_UNIT" "$UNIT_PATH"; then
  install -m 0644 "$TMP_UNIT" "$UNIT_PATH"
  systemctl daemon-reload
  changed=1
  echo "unit installed/updated at $UNIT_PATH"
else
  echo "unit unchanged at $UNIT_PATH"
fi

systemctl enable "${UNIT_NAME}.service" >/dev/null

if [[ $changed -eq 1 ]]; then
  systemctl restart "${UNIT_NAME}.service"
  echo "service restarted"
elif ! systemctl is-active --quiet "${UNIT_NAME}.service"; then
  systemctl start "${UNIT_NAME}.service"
  echo "service started"
else
  echo "service already running"
fi

echo
systemctl --no-pager --full status "${UNIT_NAME}.service" | head -n 15
echo
echo "logs:  journalctl -u ${UNIT_NAME} -f"
