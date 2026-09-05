param(
  [Parameter(Mandatory = $false)]
  [string]$ArtifactDirectory = "artifacts"
)

$resolved = Resolve-Path -LiteralPath $ArtifactDirectory
$files = Get-ChildItem -LiteralPath $resolved -File -Recurse | Where-Object { $_.Extension -in '.exe', '.apk', '.AppImage' -or $_.Name -eq 'scratchwall' }
$lines = foreach ($file in $files) {
  $hash = (Get-FileHash -Algorithm SHA256 -LiteralPath $file.FullName).Hash.ToLowerInvariant()
  $relative = [System.IO.Path]::GetRelativePath($resolved, $file.FullName).Replace('\', '/')
  "$hash  $relative"
}
$lines | Set-Content -LiteralPath (Join-Path $resolved 'SHA256SUMS.txt') -Encoding utf8NoBOM
