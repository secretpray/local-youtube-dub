<#
.SYNOPSIS
Puts the native host in bin\, writes bin\config.json and registers the host
with Chromium browsers on Windows.

.DESCRIPTION
    powershell -ExecutionPolicy Bypass -File scripts\install-host.ps1
    powershell -ExecutionPolicy Bypass -File scripts\install-host.ps1 -Uninstall

The host is built with cargo when Rust is installed (winget install
Rustlang.Rustup, plus Visual Studio Build Tools with the C++ workload);
otherwise the build for this version and processor is downloaded from the
project's GitHub release and checked against the SHA-256 GitHub reports for it.

On Windows, Chrome, Edge, Brave and Chromium find native messaging hosts only
through the registry (HKCU\Software\<browser>\NativeMessagingHosts\<name>,
whose default value is the manifest's path), never through a folder in the
profile as on macOS and Linux. The host is registered for all four: a key for
a browser that is not installed does nothing, and one installed later just
works. The extension ID comes from the "key" in manifest.json, so it is the
same on every machine. Run again after moving the folder: the registration
holds an absolute path.

This file stays ASCII: Windows PowerShell 5.1 reads a script without a byte
order mark in the ANSI code page.
#>
[CmdletBinding()]
param(
    [switch]$Uninstall
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$Project = Split-Path -Parent $PSScriptRoot
$HostName = 'org.local_youtube_dub.host'
$Repository = 'secretpray/local-youtube-dub'
$Browsers = [ordered]@{
    chrome = 'Software\Google\Chrome'
    edge = 'Software\Microsoft\Edge'
    brave = 'Software\BraveSoftware\Brave-Browser'
    chromium = 'Software\Chromium'
}

function Stop-Install([string]$Message) {
    Write-Host $Message -ForegroundColor Red
    exit 2
}

if ($Uninstall) {
    foreach ($name in $Browsers.Keys) {
        $key = "HKCU:\$($Browsers[$name])\NativeMessagingHosts\$HostName"
        if (Test-Path $key) {
            Remove-Item -Path $key -Recurse
            Write-Host "Unregistered: $name"
        }
    }
    exit 0
}

$bin = Join-Path $Project 'bin'
$python = Join-Path $Project '.venv\Scripts\python.exe'
if (-not (Test-Path $python)) { Stop-Install 'Run scripts\setup.ps1 first' }
New-Item -ItemType Directory -Force -Path $bin | Out-Null

$cpu = (Get-CimInstance Win32_Processor | Select-Object -First 1).Architecture
switch ($cpu) {
    12 { $Arch = 'arm64'; $Target = 'aarch64-pc-windows-msvc' }
    9 { $Arch = 'x64'; $Target = 'x86_64-pc-windows-msvc' }
    default { Stop-Install "Unsupported processor architecture ($cpu)" }
}

# The new executable is copied next to the old one and swapped in by renames:
# Windows refuses to overwrite a running program, which the host is whenever
# a browser has a dubbing session open, but lets it be renamed.
function Install-Executable([string]$Source) {
    $final = Join-Path $bin 'local-youtube-dub-host.exe'
    $new = Join-Path $bin '.local-youtube-dub-host.new.exe'
    $old = Join-Path $bin '.local-youtube-dub-host.old.exe'
    Copy-Item -Force $Source $new
    Remove-Item -Force $old -ErrorAction SilentlyContinue
    if (Test-Path $final) { Move-Item -Force $final $old }
    Move-Item -Force $new $final
    # Still running from an open session: removed on the next install.
    Remove-Item -Force $old -ErrorAction SilentlyContinue
}

$cargo = Get-Command cargo.exe -ErrorAction SilentlyContinue
if (-not $cargo) {
    $userCargo = Join-Path $env:USERPROFILE '.cargo\bin\cargo.exe'
    if (Test-Path $userCargo) { $cargo = Get-Command $userCargo }
}
# Under 'Stop', Windows PowerShell 5.1 turns every line cargo writes to stderr
# (its progress included) into a terminating error; the exit code decides.
# Its output goes to the screen: a function returns everything its commands
# print, which would make the exit code an array of lines.
function Invoke-Cargo {
    $ErrorActionPreference = 'Continue'
    & $cargo.Source build --release --quiet --manifest-path (Join-Path $Project 'Cargo.toml') | Out-Host
    return $LASTEXITCODE
}

if ($cargo) {
    Write-Host 'Building the host with cargo'
    $exitCode = Invoke-Cargo
    if ($exitCode -ne 0) { Stop-Install "cargo build failed (exit code $exitCode)" }
    Install-Executable (Join-Path $Project 'target\release\local-youtube-dub-host.exe')
} else {
    $version = (Select-String -Path (Join-Path $Project 'Cargo.toml') -Pattern '^version = "(.+)"').Matches[0].Groups[1].Value
    $asset = "local-youtube-dub-host-$version-$Target.exe"
    Write-Host "Rust is not installed; downloading $asset"
    try {
        $release = Invoke-RestMethod "https://api.github.com/repos/$Repository/releases/tags/v$version"
    } catch {
        Stop-Install ("No release v$version to download the host from. Install Rust to build it:`n" +
            "  winget install Rustlang.Rustup`n  winget install Microsoft.VisualStudio.2022.BuildTools " +
            "--override `"--quiet --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended`"")
    }
    $entry = $release.assets | Where-Object { $_.name -eq $asset } | Select-Object -First 1
    if (-not $entry -or -not $entry.digest) { Stop-Install "Release v$version has no $asset" }
    $download = Join-Path $bin '.download.exe'
    Invoke-WebRequest -UseBasicParsing -Uri $entry.browser_download_url -OutFile $download
    $actual = 'sha256:' + (Get-FileHash -Algorithm SHA256 $download).Hash.ToLowerInvariant()
    if ($actual -ne $entry.digest) {
        Remove-Item -Force $download
        Stop-Install "Checksum mismatch for $asset"
    }
    Install-Executable $download
    Remove-Item -Force $download
}

# Settings a user changed survive a reinstall. Values that only make sense on
# macOS or Linux, carried here in a moved folder, are dropped for the Windows
# defaults: the Unix path to Python, and engines Windows has no packages for.
$configPath = Join-Path $bin 'config.json'
$config = [ordered]@{}
if (Test-Path $configPath) {
    $parsed = Get-Content -Raw -Encoding UTF8 $configPath | ConvertFrom-Json
    foreach ($property in $parsed.PSObject.Properties) { $config[$property.Name] = $property.Value }
}
if ($config['python'] -eq '.venv/bin/python') { $config.Remove('python') }
if ($config['translator'] -in @('mlx', 'llama')) { $config.Remove('translator') }
if ($config['asr'] -in @('mlx', 'faster-whisper')) { $config.Remove('asr') }
if ($config['voice_engine'] -eq 'piper') { $config.Remove('voice_engine') }
if (-not $config['python']) { $config['python'] = '.venv/Scripts/python.exe' }
$voices = [ordered]@{ ru = 'voices/ru_RU-dmitri-medium.onnx'; uk = 'voices/uk_UA-ukrainian_tts-medium.onnx' }
if ($config['voices']) {
    foreach ($property in $config['voices'].PSObject.Properties) { $voices[$property.Name] = $property.Value }
}
$config['voices'] = $voices
$speakers = [ordered]@{ uk = 'mykyta' }
if ($config['voice_speakers']) {
    foreach ($property in $config['voice_speakers'].PSObject.Properties) { $speakers[$property.Name] = $property.Value }
}
$config['voice_speakers'] = $speakers
# UTF-8 without a byte order mark: the host's JSON parser rejects one, and
# Windows PowerShell's Set-Content -Encoding UTF8 always writes it.
$utf8 = New-Object System.Text.UTF8Encoding $false
[System.IO.File]::WriteAllText($configPath, ($config | ConvertTo-Json -Depth 5) + "`n", $utf8)

# The ID Chrome gives an unpacked extension: the first 32 hex digits of the
# SHA-256 of its public key, each digit 0-f written as a letter a-p.
$key = (Get-Content -Raw -Encoding UTF8 (Join-Path $Project 'extension\manifest.json') | ConvertFrom-Json).key
$sha = [System.Security.Cryptography.SHA256]::Create()
$digest = -join ($sha.ComputeHash([Convert]::FromBase64String($key)) | ForEach-Object { $_.ToString('x2') })
$extensionId = -join ($digest.Substring(0, 32).ToCharArray() | ForEach-Object {
    [char]([int][char]'a' + [Convert]::ToInt32([string]$_, 16))
})

$manifestPath = Join-Path $bin "$HostName.json"
$manifest = [ordered]@{
    name = $HostName
    description = 'YouTube Translate: local translation and voice-over'
    path = Join-Path $bin 'local-youtube-dub-host.exe'
    type = 'stdio'
    allowed_origins = @("chrome-extension://$extensionId/")
}
[System.IO.File]::WriteAllText($manifestPath, ($manifest | ConvertTo-Json -Depth 5) + "`n", $utf8)

foreach ($name in $Browsers.Keys) {
    $key = "HKCU:\$($Browsers[$name])\NativeMessagingHosts\$HostName"
    New-Item -Path $key -Force | Out-Null
    Set-ItemProperty -Path $key -Name '(Default)' -Value $manifestPath
    Write-Host "Registered: $name"
}
Write-Host "Extension ID: $extensionId"
Write-Host 'Done. Load the extension folder as an unpacked extension and restart the browser.' -ForegroundColor Green
