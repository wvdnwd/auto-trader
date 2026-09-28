[CmdletBinding()]
param(
  [string]$Symbols = "BTC,ETH,SOL,DOGE,PEPE,SUI,NEAR,AVAX",
  [int]$Bars = 750,
  [double]$Balance = 100,
  [int]$Leverage = 5
)

Write-Host "==========================================================" -ForegroundColor Cyan
Write-Host "TRADERR STRATEGY BACKTESTER (PC REPLAY)" -ForegroundColor Cyan
Write-Host "==========================================================" -ForegroundColor Cyan
Write-Host "Parameters: Balans=`$$Balance | Leverage=${Leverage}x | Bars=$Bars" -ForegroundColor Yellow

$argsList = @("scripts/run-backtest.mjs", "--symbols", $Symbols, "--bars", "$Bars", "--balance", "$Balance", "--leverage", "$Leverage")
node @argsList
