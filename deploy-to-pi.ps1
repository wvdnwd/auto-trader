param (
    [string]$PiHost = ""
)

if (-not $PiHost) {
    Write-Host "Voer de gebruikersnaam en het IP-adres van je Raspberry Pi in." -ForegroundColor Cyan
    Write-Host "Bijvoorbeeld: pi@192.168.1.150 of pi@raspberrypi.local" -ForegroundColor DarkGray
    $PiHost = Read-Host "Raspberry Pi host"
}

if (-not $PiHost) {
    Write-Host "Geen host opgegeven. Geannuleerd." -ForegroundColor Red
    exit 1
}

Write-Host ""
Write-Host "=========================================================" -ForegroundColor Green
Write-Host "  🚀 Deploying Trader Platform naar Raspberry Pi ($PiHost)" -ForegroundColor Green
Write-Host "=========================================================" -ForegroundColor Green

$SourceDir = $PSScriptRoot
$Archive = "$env:TEMP\traderr-bundle.tar.gz"

Write-Host "[1/3] Project inpakken..." -ForegroundColor Yellow
if (Test-Path $Archive) { Remove-Item $Archive -Force }

tar -czf $Archive -C $SourceDir --exclude="node_modules" --exclude=".git" --exclude="logs" --exclude="*.log" .

Write-Host "[2/3] Bestanden kopiëren naar Raspberry Pi..." -ForegroundColor Yellow
ssh -o StrictHostKeyChecking=accept-new $PiHost "mkdir -p ~/traderr"
scp $Archive "${PiHost}:~/traderr/bundle.tar.gz"

Write-Host "⚙️ [3/3] Installatie en 24/7 auto-boot service starten op de Pi..." -ForegroundColor Yellow
ssh -t $PiHost "cd ~/traderr && tar -xzf bundle.tar.gz && rm -f bundle.tar.gz && chmod +x setup-pi.sh && ./setup-pi.sh"

if (Test-Path $Archive) { Remove-Item $Archive -Force }

Write-Host ""
Write-Host "✅ Klaar! De bot draait nu 24/7 op je Raspberry Pi en start automatisch op bij stroom." -ForegroundColor Green
