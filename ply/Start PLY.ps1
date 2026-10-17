$ErrorActionPreference = 'Stop'
try {
    $plyRoot = $PSScriptRoot
    $plyElectron = Join-Path $plyRoot 'node_modules\electron\dist\electron.exe'
    $plyInterface = Join-Path $plyRoot 'dist\index.html'
    if (-not (Test-Path -LiteralPath $plyElectron -PathType Leaf)) {
        throw 'PLY dependencies are missing. Open a terminal in this folder, run pnpm install and pnpm build, then launch PLY again.'
    }
    if (-not (Test-Path -LiteralPath $plyInterface -PathType Leaf)) {
        throw 'The PLY interface is not built. Open a terminal in this folder and run pnpm build, then launch PLY again.'
    }
    Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
    Start-Process -FilePath $plyElectron -ArgumentList '.' -WorkingDirectory $plyRoot -WindowStyle Normal
} catch {
    Add-Type -AssemblyName System.Windows.Forms
    [void][System.Windows.Forms.MessageBox]::Show($_.Exception.Message, 'PLY could not start', 'OK', 'Error')
    exit 1
}
