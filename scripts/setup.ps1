<#
.SYNOPSIS
One-time setup on Windows: Python environment, translation engine, models
and voices, all inside this folder.

.DESCRIPTION
Run from the project folder:

    powershell -ExecutionPolicy Bypass -File scripts\setup.ps1 [-Gpu vulkan]

-ExecutionPolicy Bypass applies to this one run; the system policy is left
alone. Safe to repeat: only what is missing is downloaded, and yt-dlp is
upgraded every time, since YouTube breaks old releases.

Needs Python 3.11 to 3.14 built for this machine's processor (x64 or ARM64).
Nothing is compiled: Python packages come as wheels, llama-server and Deno as
official release builds (scripts\fetch.py checks each against a pinned
SHA-256). -Gpu vulkan takes llama.cpp's Vulkan build instead of the CPU one
(x64 only).

This file stays ASCII: Windows PowerShell 5.1 reads a script without a byte
order mark in the ANSI code page.
#>
[CmdletBinding()]
param(
    [ValidateSet('vulkan')]
    [string]$Gpu
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$Project = Split-Path -Parent $PSScriptRoot
Set-Location $Project

function Stop-Setup([string]$Message) {
    Write-Host $Message -ForegroundColor Red
    exit 2
}

# Runs a native command and stops on failure, judged by its exit code only.
# Under 'Stop', Windows PowerShell 5.1 turns anything a native program writes
# to stderr into a terminating error, even pip's "new version" notice, and
# even with 2>$null; so the preference is relaxed inside, and exit codes,
# which it ignores, are checked instead.
function Invoke-Checked([string]$What, [scriptblock]$Command) {
    $ErrorActionPreference = 'Continue'
    & $Command
    if ($LASTEXITCODE -ne 0) { Stop-Setup "$What failed (exit code $LASTEXITCODE)" }
}

# The same, returning the exit code instead of stopping. The output goes to
# the screen: a PowerShell function returns everything its commands print,
# which would make the "exit code" an array of lines.
function Invoke-Native([scriptblock]$Command) {
    $ErrorActionPreference = 'Continue'
    & $Command | Out-Host
    return $LASTEXITCODE
}

# The machine's processor, not this PowerShell's: an x64 PowerShell emulated
# on ARM reports AMD64 in PROCESSOR_ARCHITECTURE.
$cpu = (Get-CimInstance Win32_Processor | Select-Object -First 1).Architecture
switch ($cpu) {
    12 { $Arch = 'arm64'; $PythonMachine = 'ARM64' }
    9 { $Arch = 'x64'; $PythonMachine = 'AMD64' }
    default { Stop-Setup "Unsupported processor architecture ($cpu); x64 and ARM64 are supported" }
}
if ($Gpu -and $Arch -ne 'x64') { Stop-Setup 'llama.cpp publishes its Vulkan build for x64 Windows only' }

# A Python of the same architecture: an x64 Python emulated on ARM runs, but
# several times slower, and the wheels it gets are x64 ones. The py launcher
# comes with every python.org install; python.exe on PATH may instead be the
# Microsoft Store stub, which fails the check below and is skipped.
function Find-Python {
    $candidates = @()
    if (Get-Command py.exe -ErrorAction SilentlyContinue) {
        foreach ($version in '3.14', '3.13', '3.12', '3.11') {
            $candidates += , @('py.exe', "-$version-$Arch")
            $candidates += , @('py.exe', "-$version")
        }
    }
    if (Get-Command python.exe -ErrorAction SilentlyContinue) { $candidates += , @('python.exe') }
    $ErrorActionPreference = 'Continue'  # see Invoke-Checked
    $probe = 'import platform, sys; print(platform.machine(), sys.version_info[:2] >= (3, 11) and sys.version_info[:2] <= (3, 14))'
    foreach ($candidate in $candidates) {
        $answer = & $candidate[0] $candidate[1..9] -c $probe 2>$null
        if ($LASTEXITCODE -eq 0 -and $answer -eq "$PythonMachine True") { return , $candidate }
    }
    return $null
}

$venvPython = Join-Path $Project '.venv\Scripts\python.exe'
if (-not (Test-Path $venvPython)) {
    $python = Find-Python
    if (-not $python) {
        Stop-Setup ("Python 3.11 to 3.14 for $Arch was not found. Install it with:`n" +
            "  winget install Python.Python.3.13`nthen open a new terminal and run this script again.")
    }
    Write-Host "Creating .venv with $($python -join ' ')"
    Invoke-Checked 'Creating the Python environment' { & $python[0] $python[1..9] -m venv .venv }
}

Invoke-Checked 'Upgrading pip' { & $venvPython -m pip install --quiet --upgrade pip }
Write-Host 'Installing Python packages'
Invoke-Checked 'Installing Python packages' {
    & $venvPython -m pip install --quiet --prefer-binary -r requirements-windows.txt
}
# YouTube changes often and old yt-dlp releases stop working: always the
# latest, with the exact yt-dlp-ejs (its YouTube JavaScript solver) it pins.
Invoke-Checked 'Upgrading yt-dlp' { & $venvPython -m pip install --quiet --upgrade yt-dlp }
$ejs = & $venvPython -c "import importlib.metadata as m; print(next(r.split(';')[0].replace(' ', '') for r in m.requires('yt-dlp') if r.startswith('yt-dlp-ejs')))"
Invoke-Checked 'Installing yt-dlp-ejs' { & $venvPython -m pip install --quiet --prefer-binary $ejs }

# Windows Defender reads a new program or library in full the first time it
# is loaded: PyAV's FFmpeg libraries took 118 s to import once and 0.2 s from
# then on, and the first video's speech recognition sat through that wait.
# Loading everything once here moves the wait into setup.
Write-Host 'Loading the engines once (Windows Defender checks new libraries on first use)'
Invoke-Checked 'Loading the Python engines' { & $venvPython -c 'import av, numpy, onnx, sherpa_onnx' }

$fetch = @('scripts\fetch.py', '--arch', $Arch)
if ($Gpu) { $fetch += @('--gpu', $Gpu) }
# A download that fails (fetch.py says which and why) still leaves the rest
# installed and loaded once below; the script fails at the very end.
$fetched = Invoke-Native { & $venvPython @fetch }
foreach ($program in 'tools\deno\deno.exe', 'tools\llama\llama-server.exe') {
    if (Test-Path $program) { Invoke-Checked "Starting $program" { & $program --version *> $null } }
}

# A project downloaded as a zip through a browser carries the "downloaded from
# the internet" mark on every file, and SmartScreen then stops the programs
# the browser starts on its own. The downloads above carry no mark; these do.
Get-ChildItem -Path tools, bin -Recurse -Include *.exe, *.dll -ErrorAction SilentlyContinue |
    Unblock-File
if ($fetched -ne 0) { Stop-Setup 'Setup is not complete: see the message above, then run this script again.' }

Write-Host 'Done. Next: powershell -ExecutionPolicy Bypass -File scripts\install-host.ps1' -ForegroundColor Green
