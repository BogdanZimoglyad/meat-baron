param([Parameter(Mandatory=$true)][string]$Dir, [string[]]$Names)

Add-Type -AssemblyName System.Drawing

$rows = @()
foreach ($n in $Names) {
  $p = Join-Path $Dir $n
  if (-not (Test-Path -LiteralPath $p)) { continue }
  $img = [System.Drawing.Image]::FromFile($p)
  $w = $img.Width; $h = $img.Height
  $bmp = New-Object System.Drawing.Bitmap $img
  $img.Dispose()

  $rect = New-Object System.Drawing.Rectangle 0, 0, $w, $h
  $d = $bmp.LockBits($rect, [System.Drawing.Imaging.ImageLockMode]::ReadOnly,
                     [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $stride = $d.Stride
  $bytes = New-Object byte[] ($stride * $h)
  [System.Runtime.InteropServices.Marshal]::Copy($d.Scan0, $bytes, 0, $bytes.Length)
  $bmp.UnlockBits($d)

  $opaque = 0; $pale = 0
  $minX = $w; $minY = $h; $maxX = -1; $maxY = -1
  for ($y = 0; $y -lt $h; $y++) {
    $row = $y * $stride
    for ($x = 0; $x -lt $w; $x++) {
      $o = $row + $x * 4
      if ($bytes[$o + 3] -gt 128) {
        $opaque++
        if ($x -lt $minX) { $minX = $x }; if ($x -gt $maxX) { $maxX = $x }
        if ($y -lt $minY) { $minY = $y }; if ($y -gt $maxY) { $maxY = $y }
        $mn = [Math]::Min($bytes[$o], [Math]::Min($bytes[$o+1], $bytes[$o+2]))
        $mx = [Math]::Max($bytes[$o], [Math]::Max($bytes[$o+1], $bytes[$o+2]))
        if ($mn -ge 228 -and ($mx - $mn) -le 14) { $pale++ }
      }
    }
  }
  $bmp.Dispose()
  $boxW = if ($maxX -ge 0) { $maxX - $minX + 1 } else { 0 }
  $boxH = if ($maxY -ge 0) { $maxY - $minY + 1 } else { 0 }
  $rows += [pscustomobject]@{
    File        = $n
    FillPct     = [math]::Round(100 * $opaque / ($w * $h), 1)
    BoxPct      = [math]::Round(100 * [Math]::Max($boxW, $boxH) / $w)
    PaleOfSolid = [math]::Round(100 * $pale / [Math]::Max($opaque,1), 2)
  }
}
$rows | Format-Table -AutoSize
