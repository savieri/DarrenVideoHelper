param(
  [string]$ProjectRoot = $PSScriptRoot
)

$ErrorActionPreference = "Stop"

$HostSource = Join-Path $ProjectRoot "native\host.py"
$DistDir = Join-Path $ProjectRoot "native"
$BuildDir = Join-Path $ProjectRoot "build\pyinstaller-windows"
$SpecDir = Join-Path $ProjectRoot "build\pyinstaller-windows-spec"

if (-not (Get-Command python -ErrorAction SilentlyContinue)) {
  throw "Python is required only for building host.exe. Users do not need Python after host.exe is built."
}

python -m pip install --upgrade pip pyinstaller
python -m PyInstaller --clean --onefile --name host --distpath $DistDir --workpath $BuildDir --specpath $SpecDir $HostSource

$HostExe = Join-Path $DistDir "host.exe"
if (-not (Test-Path $HostExe)) {
  throw "PyInstaller did not create native\host.exe"
}

& $HostExe --self-test
Write-Host "Built $HostExe"
