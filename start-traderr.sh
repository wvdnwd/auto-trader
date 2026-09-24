#!/usr/bin/env bash
set -e

# Zorg dat alle paden (Node, BVM, Bit) geladen zijn in de non-interactive shell van PM2
export PATH="$HOME/bin:$HOME/.bvm/bin:/usr/local/bin:$PATH"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

# Laad .env indien aanwezig zodat omgevingsvariabelen direct beschikbaar zijn
if [ -f .env ]; then
  set -a
  source .env
  set +a
fi

mkdir -p logs

echo "[$(date -Iseconds)] Starten van Trader Platform via Bit..."
exec bit run trader-platform
