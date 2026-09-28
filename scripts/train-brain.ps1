[CmdletBinding()]
param(
  [string]$PiHost = "192.168.1.91:3000",
  [switch]$Sync,
  [string]$Symbols = "BTC,ETH,SOL,DOGE,CAKE,SUI,PEPE,AVAX,NEAR,LINK,BNB,XRP",
  [int]$Bars = 750
)

Write-Host "==========================================================" -ForegroundColor Cyan
Write-Host "🧠 TRADERR AI BRAIN TRAINER (PC -> Pi PIPELINE)" -ForegroundColor Cyan
Write-Host "==========================================================" -ForegroundColor Cyan

$pushArg = ""
if ($Sync) {
  $pushArg = "--push http://$PiHost"
  Write-Host "📡 Synchronisatie naar Pi ingeschakeld: http://$PiHost" -ForegroundColor Cyan
}

Write-Host "🚀 Starten van multi-timeframe backtests op PC..." -ForegroundColor Yellow
node scripts/train-brain.mjs --symbols $Symbols --bars $Bars $pushArg

if ($LASTEXITCODE -eq 0) {
  Write-Host "`n✅ Training succesvol voltooid!" -ForegroundColor Green
  if ($Sync) {
    Write-Host "📡 AI Kennis succesvol live gesynchroniseerd naar Pi ($PiHost)!" -ForegroundColor Green
  }
} else {
  Write-Host "`n❌ Fout opgetreden tijdens training." -ForegroundColor Red
}
