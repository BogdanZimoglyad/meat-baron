# Measures the outline: opaque pixels that sit next to a transparent one.
# A white halo shows up here as a high mean brightness and a large
# share of pale pixels.
param([Parameter(Mandatory=$true)][string]$Dir, [string[]]$Names)

Add-Type -AssemblyName System.Drawing
$rows = @()
foreach ($nm in $Names) {
  $p = Join-Path $Dir $nm
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
  $bmp.UnlockBits($d); $bmp.Dispose()

  $alphaAt = { param($x, $y) if ($x -lt 0 -or $y -lt 0 -or $x -ge $w -or $y -ge $h) { 0 } else { $bytes[$y * $stride + $x * 4 + 3] } }

  $cnt = 0; $sum = 0.0; $pale = 0; $veryPale = 0
  for ($y = 0; $y -lt $h; $y++) {
    for ($x = 0; $x -lt $w; $x++) {
      $o = $y * $stride + $x * 4
      if ($bytes[$o + 3] -le 200) { continue }
      $near = (& $alphaAt ($x-1) $y) -le 24 -or (& $alphaAt ($x+1) $y) -le 24 -or
              (& $alphaAt $x ($y-1)) -le 24 -or (& $alphaAt $x ($y+1)) -le 24
      if (-not $near) { continue }
      $b = $bytes[$o]; $g = $bytes[$o+1]; $r = $bytes[$o+2]
      $mn = [Math]::Min($b, [Math]::Min($g, $r))
      $cnt++; $sum += $mn
      if ($mn -ge 200) { $pale++ }
      if ($mn -ge 228) { $veryPale++ }
    }
  }
  $rows += [pscustomobject]@{
    File          = $nm
    OutlinePx     = $cnt
    MeanBright    = if ($cnt) { [math]::Round($sum / $cnt) } else { 0 }
    PalePct       = if ($cnt) { [math]::Round(100 * $pale / $cnt, 1) } else { 0 }
    VeryPalePct   = if ($cnt) { [math]::Round(100 * $veryPale / $cnt, 1) } else { 0 }
  }
}
$rows | Format-Table -AutoSize
