#!/usr/bin/env bash
set -e

echo "========================================================="
echo "   🚀 Trader Platform - Raspberry Pi 24/7 Auto-Setup"
echo "========================================================="

# 1. Systeempakketten bijwerken en vereisten installeren
echo "📦 [1/6] Systeempakketten bijwerken en benodigdheden installeren..."
sudo apt-get update -y
sudo apt-get install -y curl git build-essential ca-certificates

# 2. Node.js LTS (v20) controleren / installeren
echo "🟢 [2/6] Node.js 20 LTS controleren..."
NEED_NODE=true
if command -v node >/dev/null 2>&1; then
  NODE_VER=$(node -v | cut -d'v' -f2 | cut -d'.' -f1)
  if [ "$NODE_VER" -ge 20 ]; then
    echo "   Node.js $(node -v) is al geïnstalleerd."
    NEED_NODE=false
  fi
fi

if [ "$NEED_NODE" = true ]; then
  echo "   Node.js 20 LTS installeren via NodeSource..."
  curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
  sudo apt-get install -y nodejs
  echo "   Node.js $(node -v) succesvol geïnstalleerd!"
fi

# 3. PM2 installeren
echo "⚙️ [3/6] PM2 procesmanager installeren..."
if ! command -v pm2 >/dev/null 2>&1; then
  sudo npm install -g pm2
fi

# 4. Bit (BVM) installeren
echo "🧩 [4/6] Bit development tools installeren..."
export PATH="$HOME/bin:$HOME/.bvm/bin:/usr/local/bin:$PATH"
if ! command -v bit >/dev/null 2>&1; then
  echo "   BVM installeren..."
  sudo npm install -g @teambit/bvm
  bvm install
  
  # Voeg BVM toe aan ~/.bashrc indien nog niet aanwezig
  if ! grep -q ".bvm/bin" "$HOME/.bashrc"; then
    echo 'export PATH="$HOME/bin:$HOME/.bvm/bin:$PATH"' >> "$HOME/.bashrc"
  fi
fi

# 5. Project initialiseren en compileren
echo "🔨 [5/6] Afhankelijkheden installeren en compileren..."
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

chmod +x start-traderr.sh
mkdir -p logs

echo "   Bit packages installeren (dit kan enkele minuten duren bij de eerste keer)..."
bit install

echo "   Trading-service compileren..."
bit compile auto-trader/trading-service

# 6. PM2 configureren voor automatisch opstarten bij boot
echo "🔄 [6/6] 24/7 Automatisch opstarten configureren via PM2..."
pm2 delete traderr 2>/dev/null || true
pm2 start ecosystem.config.cjs
pm2 save

# Genereer en activeer de systemd opstart-service
STARTUP_CMD=$(pm2 startup systemd -u "$USER" --hp "$HOME" | grep "sudo env" || true)
if [ -n "$STARTUP_CMD" ]; then
  eval "$STARTUP_CMD"
fi
pm2 save

# Haal lokaal IP-adres op voor de gebruiker
LOCAL_IP=$(hostname -I | awk '{print $1}')

echo ""
echo "========================================================="
echo "   ✅ INSTALLATIE VOLTOOID & BOT ACTIEF!"
echo "========================================================="
echo "De bot draait nu 24/7 op de achtergrond en zal direct"
echo "automatisch opstarten zodra de Raspberry Pi stroom krijgt."
echo ""
echo "📱 Open het dashboard op je telefoon of PC:"
echo "   http://${LOCAL_IP}:3000"
echo ""
echo "Handige commando's op de Pi:"
echo "   pm2 status          -> Bekijk status van de bot"
echo "   pm2 logs traderr    -> Bekijk live logs van het traden"
echo "   pm2 restart traderr -> Herstart de bot"
echo "   pm2 stop traderr    -> Stop de bot tijdelijk"
echo "========================================================="
