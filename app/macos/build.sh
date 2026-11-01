#!/bin/bash
# Monta o "Quadro de Tarefas.app": compila o app (Swift Package), desenha o ícone, escreve o Info.plist
# e assina localmente. Precisa das ferramentas de linha de comando do Xcode.
#   app/macos/build.sh             monta em app/macos/build/
#   app/macos/build.sh --install   também instala em ~/Applications (aparece no Launchpad e no Spotlight)
# CLAUDE_TASKS_URL (ou CLAUDE_TASKS_PORT) muda o endereço do painel; NODE, o Node do serviço.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"
NAME="Quadro de Tarefas"
EXEC="QuadroDeTarefas"
APP="$HERE/build/$NAME.app"
URL="${CLAUDE_TASKS_URL:-http://localhost:${CLAUDE_TASKS_PORT:-4317}}"
NODE_BIN="${NODE:-$(command -v node || true)}"
VERSION="$(sed -n 's/^ *"version": *"\([^"]*\)".*/\1/p' "$REPO/package.json" | head -1)"

# Escapa o texto para dentro do XML do Info.plist.
xml() { printf '%s' "$1" | sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g'; }

echo "Compilando…"
swift build -c release --package-path "$HERE"
BIN="$(swift build -c release --package-path "$HERE" --show-bin-path)/$EXEC"

rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp "$BIN" "$APP/Contents/MacOS/$EXEC"

echo "Desenhando o ícone…"
ICONSET="$HERE/build/AppIcon.iconset"
rm -rf "$ICONSET"
swift "$HERE/Icone/gerar-icone.swift" "$ICONSET"
iconutil -c icns "$ICONSET" -o "$APP/Contents/Resources/AppIcon.icns"

cat > "$APP/Contents/Info.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>$NAME</string>
  <key>CFBundleDisplayName</key><string>$NAME</string>
  <key>CFBundleIdentifier</key><string>com.claude-tasks.app</string>
  <key>CFBundleExecutable</key><string>$EXEC</string>
  <key>CFBundleIconFile</key><string>AppIcon</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>$(xml "$VERSION")</string>
  <key>CFBundleVersion</key><string>$(xml "$VERSION")</string>
  <key>CFBundleDevelopmentRegion</key><string>pt-BR</string>
  <key>LSMinimumSystemVersion</key><string>13.0</string>
  <key>LSApplicationCategoryType</key><string>public.app-category.productivity</string>
  <key>NSHighResolutionCapable</key><true/>
  <key>NSHumanReadableCopyright</key><string>claude-tasks · licença MIT</string>
  <key>NSAppTransportSecurity</key>
  <dict><key>NSAllowsLocalNetworking</key><true/></dict>
  <key>ClaudeTasksURL</key><string>$(xml "$URL")</string>
  <key>ClaudeTasksRepo</key><string>$(xml "$REPO")</string>
  <key>ClaudeTasksNode</key><string>$(xml "$NODE_BIN")</string>
</dict>
</plist>
EOF

# Assinatura local (ad hoc): o macOS abre o app sem reclamar neste computador.
codesign --force --deep --sign - "$APP" >/dev/null 2>&1
echo "Pronto: $APP"

if [ "${1:-}" = "--install" ]; then
  DEST="$HOME/Applications/$NAME.app"
  pkill -x "$EXEC" 2>/dev/null || true
  mkdir -p "$HOME/Applications"
  rm -rf "$DEST"
  cp -R "$APP" "$DEST"
  # Avisa o Launchpad e o Spotlight sem esperar a próxima indexação.
  /System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister -f "$DEST" 2>/dev/null || true
  echo "Instalado em $DEST"
fi
