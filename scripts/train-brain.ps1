[CmdletBinding()]
param(
  [string]$PiHost = "192.168.1.91:5001",
  [switch]$Sync,
  [switch]$All161,
  [int]$Years = 4,
  [string]$Symbols = "BTC,ETH,SOL,DOGE,CAKE,SUI,PEPE,AVAX,NEAR,LINK,BNB,XRP"
)

Write-Host "==========================================================" -ForegroundColor Cyan
Write-Host "TRADERR AI BRAIN TRAINER (PC -> Pi PIPELINE)" -ForegroundColor Cyan
Write-Host "==========================================================" -ForegroundColor Cyan

$argsList = @("scripts/train-brain.mjs")

if ($All161) {
  $argsList += "--all161"
  Write-Host "Universum: Alle 161 munten geselecteerd" -ForegroundColor Yellow
} else {
  $argsList += @("--symbols", $Symbols)
  Write-Host "Universum: $Symbols" -ForegroundColor Yellow
}

if ($Years -gt 0) {
  $argsList += @("--years", "$Years")
  Write-Host "Periode  : $Years jaar historische data" -ForegroundColor Yellow
}

if ($Sync) {
  $argsList += @("--push", "http://$PiHost")
  Write-Host "Synchronisatie naar Pi ingeschakeld: http://$PiHost" -ForegroundColor Cyan
}

Write-Host "Starten van training op PC..." -ForegroundColor Green
node @argsList

if ($LASTEXITCODE -eq 0) {
  Write-Host ""
  Write-Host "Training succesvol voltooid!" -ForegroundColor Green
  if ($Sync) {
    Write-Host "AI Kennis succesvol live gesynchroniseerd naar Pi ($PiHost)!" -ForegroundColor Green
  }
} else {
  Write-Host ""
  Write-Host "Fout opgetreden tijdens training." -ForegroundColor Red
}
