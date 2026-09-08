$ErrorActionPreference = 'Stop'
try {
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    $machineArch = if ($env:PROCESSOR_ARCHITEW6432) { $env:PROCESSOR_ARCHITEW6432 } else { $env:PROCESSOR_ARCHITECTURE }
    switch ($machineArch.ToUpperInvariant()) {
        'AMD64' { $target = 'x86_64-pc-windows-msvc' }
        'ARM64' { $target = 'aarch64-pc-windows-msvc' }
        default { throw 'Only Windows x64 and ARM64 are supported.' }
    }
    $cache = if ($env:LAUNCHPAD_HELPER_CACHE) { $env:LAUNCHPAD_HELPER_CACHE } else { Join-Path $env:LOCALAPPDATA 'ESP-Launchpad-Enhanced' }
    New-Item -ItemType Directory -Force -Path $cache | Out-Null
    $env:UV_CACHE_DIR = Join-Path $cache 'uv-cache'
    $env:UV_PYTHON_INSTALL_DIR = Join-Path $cache 'python'
    $env:UV_PYTHON_INSTALL_BIN = '0'
    $env:UV_NO_CONFIG = '1'
    $env:PYTHONUTF8 = '1'
    $env:PYTHONNOUSERSITE = '1'
    Remove-Item Env:PYTHONHOME, Env:PYTHONPATH, Env:UV_PYTHON_PREFERENCE -ErrorAction SilentlyContinue
    $version = '0.12.10'
    $asset = Import-Csv -LiteralPath (Join-Path $PSScriptRoot 'uv-assets.tsv') -Delimiter "`t" -Header target,archive,sha256 | Where-Object { $_.target -eq $target }
    if (-not $asset) { throw "No verified download for $target" }
    $archive = Join-Path $cache "uv-$version-$target.zip"
    if (-not (Test-Path -LiteralPath $archive) -or (Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash.ToLowerInvariant() -ne $asset.sha256) {
        Write-Host "Preparing USB helper for $target (first launch requires internet)..."
        $partial = Join-Path $cache ([Guid]::NewGuid().ToString() + '.download')
        try {
            Invoke-WebRequest -UseBasicParsing -TimeoutSec 300 -Uri "https://github.com/astral-sh/uv/releases/download/$version/$($asset.archive)" -OutFile $partial
            if ((Get-FileHash -LiteralPath $partial -Algorithm SHA256).Hash.ToLowerInvariant() -ne $asset.sha256) { throw 'Download SHA256 mismatch.' }
            Move-Item -LiteralPath $partial -Destination $archive -Force
        } finally { Remove-Item -LiteralPath $partial -Force -ErrorAction SilentlyContinue }
    }
    $uvDir = Join-Path $cache "uv-$version-$target"
    $uv = Join-Path $uvDir 'uv.exe'
    if (-not (Test-Path -LiteralPath $uv)) {
        Expand-Archive -LiteralPath $archive -DestinationPath $uvDir -Force
    }
    $env:LAUNCHPAD_HELPER_CACHE = $cache
    $env:LAUNCHPAD_UV = $uv
    & $uv run --no-project --no-config --managed-python --python 3.12.12 (Join-Path $PSScriptRoot 'bootstrap_env.py') @args
    exit $LASTEXITCODE
} catch {
    Write-Host "USB helper failed: $($_.Exception.Message)" -ForegroundColor Red
    exit 1
}
