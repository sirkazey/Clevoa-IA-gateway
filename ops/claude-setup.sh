#!/usr/bin/env bash
# Préparation d'une session Claude Code dans le cloud (environnement « MCP-Finance ») : Node 24 et dépendances des suites
# de tests. Lancé par le script de configuration de l'environnement (docs/developer/reprise-claude-code.md § 1) ;
# sans effet sur le produit livré. Relançable : ne retélécharge pas Node s'il est déjà à la bonne version.
set -euo pipefail
NODE_VERSION="${NODE_VERSION:-24.22.1}"   # même Node 24 que l'image figée du hub (hub/Dockerfile)
REPO="$(cd "$(dirname "$0")/.." && pwd)"

# Node 24 : l'image cloud fournit Node 22 (/opt/node22). ~/.local/bin passe avant /opt/node22/bin dans le PATH.
if ! /opt/node24/bin/node --version 2>/dev/null | grep -qx "v$NODE_VERSION"; then
  rm -rf /opt/node24 && mkdir -p /opt/node24
  curl -sSfL "https://nodejs.org/dist/v$NODE_VERSION/node-v$NODE_VERSION-linux-x64.tar.xz" | tar -xJ -C /opt/node24 --strip-components=1
fi
mkdir -p "$HOME/.local/bin"
for b in node npm npx; do ln -sf "/opt/node24/bin/$b" "$HOME/.local/bin/$b"; done

# Dépendances verrouillées de chaque suite (npm ci : exactement le package-lock.json).
for d in hub clevoa-mcp-stub clevoa-console clevoa-backend; do
  [ -f "$REPO/$d/package-lock.json" ] && (cd "$REPO/$d" && /opt/node24/bin/npm ci --no-audit --no-fund --loglevel=error)
done
echo "claude-setup : Node $(/opt/node24/bin/node --version), dépendances installées dans $REPO"
