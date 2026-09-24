#!/bin/bash
set -e

echo "=========================================="
echo "  Raspberry Pi 5 - Auto Trader Setup"
echo "=========================================="
echo ""

# 1. Update system packages
echo "[1/4] Systeempakketten bijwerken..."
sudo apt update && sudo apt upgrade -y
sudo apt install -y curl git build-essential

# 2. Install Node.js 22 LTS
echo "[2/4] Node.js 22 LTS controleren / installeren..."
if ! command -v node &> /dev/null || [[ $(node -v | cut -d'.' -f1 | tr -d 'v') -lt 20 ]]; then
  echo "Node.js 22 installeren via NodeSource..."
  curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
  sudo apt install -y nodejs
fi
echo "Node versie: $(node -v)"
echo "NPM versie:  $(npm -v)"

# 3. Install Bit CLI via BVM
echo "[3/4] Bit CLI installeren..."
if ! command -v bvm &> /dev/null; then
  sudo npm install -g @teambit/bvm
fi
bvm install
export PATH="$HOME/.bvm:$PATH"

# 4. Install PM2 for 24/7 background operation
echo "[4/4] PM2 installeren voor 24/7 achtergrond..."
if ! command -v pm2 &> /dev/null; then
  sudo npm install -g pm2
fi

echo ""
echo "=========================================="
echo "  Klaar voor gebruik op je Raspberry Pi 5!"
echo "=========================================="
echo ""
echo "Deze setup installeert alleen de vereisten. Gebruik de deployment setup die PM2 aan localhost bindt."
echo "Configureer een volledige HTTPS reverse proxy voordat dashboardtoegang vanaf andere apparaten wordt ingeschakeld."
echo "=========================================="
