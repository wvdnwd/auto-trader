param (
    [string]$PiHost = ""
)

$ErrorActionPreference = "Stop"

function Invoke-Native {
    param (
        [Parameter(Mandatory = $true)][string]$Command,
        [Parameter(Mandatory = $true)][string[]]$Arguments,
        [Parameter(Mandatory = $true)][string]$Step
    )

    & $Command @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw "$Step failed with exit code $LASTEXITCODE."
    }
}

if (-not $PiHost) {
    Write-Host "Voer de gebruikersnaam en het IP-adres van je Raspberry Pi in." -ForegroundColor Cyan
    Write-Host "Bijvoorbeeld: wesleyvd23@192.168.1.91 of wesleyvd23@100.72.8.116" -ForegroundColor DarkGray
    $PiHost = Read-Host "Raspberry Pi host (druk op Enter voor wesleyvd23@192.168.1.91)"
    if (-not $PiHost) {
        $PiHost = "wesleyvd23@192.168.1.91"
    }
}

if ($PiHost -and $PiHost -notmatch '@') {
    if ($PiHost -match '^[0-9.]+$') {
        $PiHost = "wesleyvd23@$PiHost"
    } else {
        $PiHost = "${PiHost}@192.168.1.91"
    }
    Write-Host "Host automatisch aangevuld tot: $PiHost" -ForegroundColor Yellow
}

if (-not $PiHost -or $PiHost -notmatch '^[A-Za-z0-9._@:-]+$') {
    Write-Error "Ongeldige of ontbrekende host; verwacht bijvoorbeeld wesleyvd23@192.168.1.91."
    exit 1
}

$SourceDir = $PSScriptRoot
$Archive = Join-Path $env:TEMP "traderr-bundle.tar.gz"
$ArchiveList = Join-Path $env:TEMP "traderr-archive-allowlist.txt"
$AllowList = @(
    ".bitmap",
    "workspace.jsonc",
    "package.json",
    "pnpm-lock.yaml",
    "tsconfig.json",
    "auto-trader",
    "setup-pi.sh",
    "setup-pi5.sh",
    "start-traderr.sh",
    "ecosystem.config.cjs"
)

$RequiredFiles = @(
    ".bitmap",
    "workspace.jsonc",
    "package.json",
    "pnpm-lock.yaml",
    "tsconfig.json",
    "setup-pi.sh",
    "setup-pi5.sh",
    "start-traderr.sh",
    "ecosystem.config.cjs"
)

foreach ($Path in $RequiredFiles) {
    if (-not (Test-Path -LiteralPath (Join-Path $SourceDir $Path) -PathType Leaf)) {
        Write-Error "Required deployment source is missing: $Path"
        exit 1
    }
}
if (-not (Test-Path -LiteralPath (Join-Path $SourceDir "auto-trader") -PathType Container)) {
    Write-Error "Required source directory is missing: auto-trader"
    exit 1
}

$Succeeded = $false
try {
    Write-Host "[1/3] Alleen goedgekeurde bronbestanden inpakken..." -ForegroundColor Yellow
    if (Test-Path -LiteralPath $Archive) { Remove-Item -LiteralPath $Archive -Force }
    [System.IO.File]::WriteAllLines($ArchiveList, $AllowList, [System.Text.UTF8Encoding]::new($false))

    $TarArgs = @(
        "-czf", $Archive,
        "-C", $SourceDir,
        "--exclude=node_modules",
        "--exclude=.git",
        "--exclude=.bit",
        "--exclude=.env",
        "--exclude=.env.*",
        "--exclude=.ENV",
        "--exclude=.ENV.*",
        "--exclude=*.env",
        "--exclude=*.ENV",
        "--exclude=*credential*",
        "--exclude=*Credential*",
        "--exclude=*CREDENTIAL*",
        "--exclude=*secret*",
        "--exclude=*Secret*",
        "--exclude=*SECRET*",
        "--exclude=*token*",
        "--exclude=*Token*",
        "--exclude=*TOKEN*",
        "--exclude=data",
        "--exclude=logs",
        "--exclude=runtime",
        "--exclude=cache",
        "--exclude=.cache",
        "--exclude=.vite",
        "--exclude=coverage",
        "--exclude=dist",
        "--exclude=build",
        "--exclude=tmp",
        "--exclude=temp",
        "--exclude=*.db",
        "--exclude=*.sqlite*",
        "--exclude=*.jsonl",
        "--exclude=*.ndjson",
        "--exclude=*.log",
        "-T", $ArchiveList
    )
    Invoke-Native -Command "tar" -Arguments $TarArgs -Step "Archive creation"

    $ArchiveEntries = @(& tar -tzf $Archive)
    if ($LASTEXITCODE -ne 0) {
        throw "Archive verification failed with exit code $LASTEXITCODE."
    }
    $ForbiddenEntry = $ArchiveEntries | Where-Object {
        $_ -match '(?i)(^|/)(\.env($|\.)|[^/]*(credential|secret|token)[^/]*|data|logs|runtime|cache|coverage|dist|build|tmp|temp|node_modules|\.git|\.bit|\.vite)(/|$)|\.(log|db|sqlite\w*|jsonl|ndjson)$'
    } | Select-Object -First 1
    if ($ForbiddenEntry) {
        throw "Archive contains a forbidden path; deployment aborted."
    }

    Write-Host "[2/3] Bronbestanden veilig kopiëren naar Raspberry Pi..." -ForegroundColor Yellow
    Invoke-Native -Command "ssh" -Arguments @("-o", "StrictHostKeyChecking=accept-new", $PiHost, "mkdir -p ~/traderr") -Step "Remote directory creation"
    Invoke-Native -Command "scp" -Arguments @($Archive, "${PiHost}:~/traderr/bundle.tar.gz") -Step "Archive upload"

    Write-Host "[3/3] Installatie uitvoeren op de Raspberry Pi..." -ForegroundColor Yellow
    $RemoteInstall = "cd ~/traderr && tar -xzf bundle.tar.gz && rm -f bundle.tar.gz && chmod +x setup-pi.sh && ./setup-pi.sh"
    Invoke-Native -Command "ssh" -Arguments @("-t", $PiHost, $RemoteInstall) -Step "Remote installation"
    $Succeeded = $true
}
catch {
    Write-Error "Deployment failed: $($_.Exception.Message)"
    exit 1
}
finally {
    if (Test-Path -LiteralPath $Archive) { Remove-Item -LiteralPath $Archive -Force }
    if (Test-Path -LiteralPath $ArchiveList) { Remove-Item -LiteralPath $ArchiveList -Force }
}

if (-not $Succeeded) {
    Write-Error "Deployment did not complete successfully."
    exit 1
}

Write-Host ""
Write-Host "Installatie voltooid. De API luistert alleen op localhost; configureer een volledige HTTPS reverse proxy voordat je deze vanaf andere apparaten benadert." -ForegroundColor Green
