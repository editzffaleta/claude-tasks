#!/bin/bash
# Mantém o painel rodando em segundo plano e iniciando sozinho no login (launchd).
#   bin/service.sh install     instala e inicia
#   bin/service.sh uninstall   para e remove
set -euo pipefail

LABEL="com.claude-tasks.dashboard"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
DIR="$(cd "$(dirname "$0")/.." && pwd)"
NODE="${NODE:-$(command -v node)}"
DOMAIN="gui/$(id -u)"

case "${1:-}" in
  install)
    mkdir -p "$HOME/Library/LaunchAgents" "$DIR/data"
    # Libera a porta caso o painel esteja rodando à mão.
    lsof -tiTCP:"${CLAUDE_TASKS_PORT:-4317}" -sTCP:LISTEN | xargs kill 2>/dev/null || true
    cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$NODE</string>
    <string>--no-warnings</string>
    <string>$DIR/src/server.js</string>
  </array>
  <key>WorkingDirectory</key><string>$DIR</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>30</integer>
  <key>StandardOutPath</key><string>$DIR/data/server.log</string>
  <key>StandardErrorPath</key><string>$DIR/data/server.log</string>
</dict>
</plist>
EOF
    launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
    launchctl bootstrap "$DOMAIN" "$PLIST"
    echo "Painel rodando em http://localhost:${CLAUDE_TASKS_PORT:-4317} (inicia sozinho no login)."
    ;;
  uninstall)
    launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
    rm -f "$PLIST"
    echo "Serviço removido."
    ;;
  *)
    echo "uso: $0 install|uninstall" >&2
    exit 1
    ;;
esac
