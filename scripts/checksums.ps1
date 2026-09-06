param(
  [Parameter(Mandatory = $false)]
  [string]$ArtifactDirectory = "artifacts"
)

$ErrorActionPreference = 'Stop'
$resolved = Resolve-Path -LiteralPath $ArtifactDirectory
$files = Get-ChildItem -LiteralPath $resolved -File | Where-Object {
  $_.Extension -in '.exe', '.apk', '.AppImage' -or $_.Name -eq 'scratchwall'
} | Sort-Object Name
if (-not $files) { throw "No release files found in $resolved" }
$lines = foreach ($file in $files) {
  $hash = (Get-FileHash -Algorithm SHA256 -LiteralPath $file.FullName).Hash.ToLowerInvariant()
  "$hash  $($file.Name)"
}
$lines | Set-Content -LiteralPath (Join-Path $resolved 'SHA256SUMS.txt') -Encoding utf8NoBOM
