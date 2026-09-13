param([ValidateSet('bootstrap','build','test','run')][string]$Action = 'build')
$ErrorActionPreference = 'Stop'
$nativeRepoRoot = Split-Path $PSScriptRoot -Parent
$nativeTools = Join-Path $nativeRepoRoot '.tools'
$nativeSdk = Join-Path $nativeTools 'dotnet/dotnet.exe'
$env:DOTNET_CLI_HOME = Join-Path $nativeTools 'dotnet-home'
$env:NUGET_PACKAGES = Join-Path $nativeTools 'nuget'
$env:DOTNET_CLI_TELEMETRY_OPTOUT = '1'
$env:DOTNET_GENERATE_ASPNET_CERTIFICATE = 'false'
$env:DOTNET_ADD_GLOBAL_TO_PATH = 'false'

if ($Action -eq 'bootstrap') {
    if (Test-Path -LiteralPath $nativeSdk) { & $nativeSdk --version; exit $LASTEXITCODE }
    New-Item -ItemType Directory -Force -Path $nativeTools | Out-Null
    $nativeArchive = Join-Path $nativeTools 'dotnet-sdk.zip'
    & curl.exe -fsSL --retry 2 --max-time 600 'https://builds.dotnet.microsoft.com/dotnet/Sdk/10.0.401/dotnet-sdk-10.0.401-win-x64.zip' -o $nativeArchive
    if ($LASTEXITCODE -ne 0) { throw 'SDK download failed.' }
    $nativeExpectedHash = '24b670ad3d923bfcf47df6c3b034152398b42f6dbc388e10d783aee1cfb5e5817d399fc0ae2a12cfa822a55e61d34830ccb15c50ef6efee437ab874bb7c79430'
    if ((Get-FileHash -LiteralPath $nativeArchive -Algorithm SHA512).Hash -ne $nativeExpectedHash) { throw 'SDK checksum mismatch.' }
    $nativeSdkDirectory = Join-Path $nativeTools 'dotnet'
    New-Item -ItemType Directory -Force -Path $nativeSdkDirectory | Out-Null
    & tar.exe -xf $nativeArchive -C $nativeSdkDirectory
    if ($LASTEXITCODE -ne 0) { throw 'SDK extraction failed.' }
    & $nativeSdk --version
    exit $LASTEXITCODE
}
if (-not (Test-Path -LiteralPath $nativeSdk)) {
    $nativeSdk = (Get-Command dotnet -ErrorAction Stop).Source
}
Push-Location (Join-Path $nativeRepoRoot 'native')
try {
    if ($Action -in @('build','test')) {
        & $nativeSdk restore FnMusic.sln --configfile NuGet.Config --locked-mode --nologo
        if ($LASTEXITCODE -ne 0) { throw 'Dependency restore failed.' }
    }
    if ($Action -eq 'build') {
        & $nativeSdk build src/FnMusic.App/FnMusic.App.csproj -c Release --no-restore --nologo
        if ($LASTEXITCODE -ne 0) { throw 'Native build failed.' }
    } elseif ($Action -eq 'test') {
        & $nativeSdk run --project tests/FnMusic.Tests/FnMusic.Tests.csproj --no-restore -- (Join-Path $nativeRepoRoot '.review-audit/native-tests')
        if ($LASTEXITCODE -ne 0) { throw 'Native checks failed.' }
    } elseif ($Action -eq 'run') {
        $nativeExe = Join-Path (Get-Location).Path 'src/FnMusic.App/bin/Release/net10.0-windows10.0.26100.0/win-x64/FnMusic.App.exe'
        if (-not (Test-Path -LiteralPath $nativeExe)) { throw 'Run the build action first.' }
        Start-Process -FilePath $nativeExe
    }
} finally { Pop-Location }
