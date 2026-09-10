# Removes a white studio background and produces a 640x640 transparent PNG,
# matching the format already used on the site.
#
#   cutout.ps1 -In photo.jpg -Out photo\name.png [-Size 640] [-Pad 24]
#              [-White 232] [-Soft 196] [-Neutral 20]
#
# White   : a pixel this bright (min channel) can belong to the background
# Soft    : below this brightness a pixel is definitely product
# Neutral : max spread between R,G,B for a pixel to count as grey/white
# Only background CONNECTED TO THE BORDER is erased, so white highlights
# inside the product survive.

param(
  [Parameter(Mandatory=$true)][string]$In,
  [Parameter(Mandatory=$true)][string]$Out,
  [int]$Size = 640,
  [int]$Pad = 24,
  [int]$White = 232,
  [int]$Soft = 196,
  [int]$Neutral = 20,
  [int]$Shadow = 140,
  [double]$Holes = 0.08,
  [int]$Erode = 3,
  [int]$WorkMax = 1400
)

Add-Type -AssemblyName System.Drawing

function New-Argb([System.Drawing.Image]$img, [int]$w, [int]$h) {
  $bmp = New-Object System.Drawing.Bitmap $w, $h, ([System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $g.PixelOffsetMode  = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
  $g.SmoothingMode    = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
  $g.Clear([System.Drawing.Color]::Transparent)
  $g.DrawImage($img, (New-Object System.Drawing.Rectangle 0, 0, $w, $h))
  $g.Dispose()
  return $bmp
}

# System.Drawing cannot open webp, and phones hand out webp all the time.
# Windows itself can decode it through WIC, so fall back to that and hand
# back a plain Bitmap the rest of the script already knows how to use.
function Read-AnyImage([string]$path) {
  try { return [System.Drawing.Image]::FromFile($path) } catch { }
  Add-Type -AssemblyName PresentationCore
  $dec = [System.Windows.Media.Imaging.BitmapDecoder]::Create(
           (New-Object System.Uri $path), 'None', 'OnLoad')
  $conv = New-Object System.Windows.Media.Imaging.FormatConvertedBitmap(
            $dec.Frames[0], [System.Windows.Media.PixelFormats]::Bgra32, $null, 0.0)
  $pw = $conv.PixelWidth; $ph = $conv.PixelHeight
  $srcStride = $pw * 4
  $buf = New-Object byte[] ($srcStride * $ph)
  $conv.CopyPixels($buf, $srcStride, 0)

  $bmp = New-Object System.Drawing.Bitmap $pw, $ph, ([System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $r = New-Object System.Drawing.Rectangle 0, 0, $pw, $ph
  $bd = $bmp.LockBits($r, [System.Drawing.Imaging.ImageLockMode]::WriteOnly,
                      [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  for ($yy = 0; $yy -lt $ph; $yy++) {
    [System.Runtime.InteropServices.Marshal]::Copy(
      $buf, $yy * $srcStride, [IntPtr]::Add($bd.Scan0, $yy * $bd.Stride), $srcStride)
  }
  $bmp.UnlockBits($bd)
  return $bmp
}

if (-not (Test-Path -LiteralPath $In)) { throw "No such file: $In" }
$src = Read-AnyImage $In

# work at a bounded size: output is 640 anyway, and per-pixel work in
# PowerShell gets slow fast
$scale = [Math]::Min(1.0, $WorkMax / [Math]::Max($src.Width, $src.Height))
$w = [int][Math]::Round($src.Width * $scale)
$h = [int][Math]::Round($src.Height * $scale)
$bmp = New-Argb $src $w $h
$src.Dispose()

# pull pixels into a byte array (BGRA order)
$rect = New-Object System.Drawing.Rectangle 0, 0, $w, $h
$data = $bmp.LockBits($rect, [System.Drawing.Imaging.ImageLockMode]::ReadWrite,
                      [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
$stride = $data.Stride
$bytes = New-Object byte[] ($stride * $h)
[System.Runtime.InteropServices.Marshal]::Copy($data.Scan0, $bytes, 0, $bytes.Length)

$n = $w * $h
$isBg = New-Object bool[] $n          # background, connected to the border
$bright = New-Object byte[] $n        # min channel, i.e. how white
$grey = New-Object bool[] $n          # near-neutral colour
$flat = New-Object bool[] $n          # strictly neutral: a soft shadow looks like this,
                                      # food almost never does

for ($y = 0; $y -lt $h; $y++) {
  $row = $y * $stride
  for ($x = 0; $x -lt $w; $x++) {
    $o = $row + $x * 4
    $b = $bytes[$o]; $g = $bytes[$o + 1]; $r = $bytes[$o + 2]
    $mn = [Math]::Min($b, [Math]::Min($g, $r))
    $mx = [Math]::Max($b, [Math]::Max($g, $r))
    $i = $y * $w + $x
    $bright[$i] = $mn
    $spread = $mx - $mn
    $grey[$i] = $spread -le $Neutral
    $flat[$i] = $spread -le [int]($Neutral / 2)
  }
}

# a pixel counts as background if it is pale grey (the backdrop) or a
# strictly neutral mid-grey (a soft shadow)
$bgLike = New-Object bool[] $n
for ($i = 0; $i -lt $n; $i++) {
  $bgLike[$i] = ($grey[$i] -and $bright[$i] -ge $Soft) -or ($flat[$i] -and $bright[$i] -ge $Shadow)
}

# flood fill from every border pixel
$stack = New-Object System.Collections.Generic.Stack[int]
for ($x = 0; $x -lt $w; $x++) {
  $stack.Push($x); $stack.Push(($h - 1) * $w + $x)
}
for ($y = 0; $y -lt $h; $y++) {
  $stack.Push($y * $w); $stack.Push($y * $w + $w - 1)
}
while ($stack.Count -gt 0) {
  $i = $stack.Pop()
  if ($isBg[$i]) { continue }
  if (-not $bgLike[$i]) { continue }
  $isBg[$i] = $true
  $x = $i % $w; $y = [int][Math]::Floor($i / $w)
  if ($x -gt 0)      { $stack.Push($i - 1) }
  if ($x -lt $w - 1) { $stack.Push($i + 1) }
  if ($y -gt 0)      { $stack.Push($i - $w) }
  if ($y -lt $h - 1) { $stack.Push($i + $w) }
}

# Enclosed background: the hole inside a sausage ring, the gap between
# two pieces. Such an area never touches the border, so the fill above
# leaves it opaque and a white blob stays in the middle of the picture.
# Erase any enclosed backdrop-coloured island that is big enough to be
# a real hole; small pale specks stay, they are highlights on the food.
$minHole = [int]($n * $Holes / 100.0)
if ($minHole -lt 40) { $minHole = 40 }
$seen = New-Object bool[] $n
$comp = New-Object System.Collections.Generic.List[int]
for ($s = 0; $s -lt $n; $s++) {
  if ($seen[$s] -or $isBg[$s] -or -not $bgLike[$s]) { continue }
  $comp.Clear()
  $stack.Push($s); $seen[$s] = $true
  while ($stack.Count -gt 0) {
    $i = $stack.Pop()
    $comp.Add($i)
    $x = $i % $w; $y = [int][Math]::Floor($i / $w)
    foreach ($j in ($i-1), ($i+1), ($i-$w), ($i+$w)) {
      if ($j -lt 0 -or $j -ge $n) { continue }
      if ($j -eq $i - 1 -and $x -eq 0) { continue }
      if ($j -eq $i + 1 -and $x -eq $w - 1) { continue }
      if ($seen[$j] -or $isBg[$j] -or -not $bgLike[$j]) { continue }
      $seen[$j] = $true; $stack.Push($j)
    }
  }
  if ($comp.Count -ge $minHole) { foreach ($i in $comp) { $isBg[$i] = $true } }
}

# The very rim of a shot on white is always lit by the backdrop: a pale
# halo one or two pixels wide. Left in place it glows against the dark
# site background. Eat that rim by growing the background inwards.
for ($pass = 0; $pass -lt $Erode; $pass++) {
  $grow = New-Object System.Collections.Generic.List[int]
  for ($y = 0; $y -lt $h; $y++) {
    for ($x = 0; $x -lt $w; $x++) {
      $i = $y * $w + $x
      if ($isBg[$i]) { continue }
      if (($x -gt 0 -and $isBg[$i-1]) -or ($x -lt $w-1 -and $isBg[$i+1]) -or
          ($y -gt 0 -and $isBg[$i-$w]) -or ($y -lt $h-1 -and $isBg[$i+$w])) { $grow.Add($i) }
    }
  }
  foreach ($i in $grow) { $isBg[$i] = $true }
}

# write alpha: background clear, edge pixels partly clear so the cut
# does not look like scissors work
$span = [double]($White - $Soft)
if ($span -lt 1) { $span = 1 }
for ($y = 0; $y -lt $h; $y++) {
  $row = $y * $stride
  for ($x = 0; $x -lt $w; $x++) {
    $i = $y * $w + $x
    $o = $row + $x * 4
    if ($isBg[$i]) { $bytes[$o + 3] = 0; continue }
    # near a cleared pixel and itself pale -> soften
    $touching = $false
    if ($x -gt 0      -and $isBg[$i - 1])  { $touching = $true }
    if ($x -lt $w - 1 -and $isBg[$i + 1])  { $touching = $true }
    if ($y -gt 0      -and $isBg[$i - $w]) { $touching = $true }
    if ($y -lt $h - 1 -and $isBg[$i + $w]) { $touching = $true }
    if ($touching -and $grey[$i] -and $bright[$i] -gt $Soft) {
      $a = 255 - [int](255 * (($bright[$i] - $Soft) / $span))
      if ($a -lt 0) { $a = 0 }
      if ($a -gt 255) { $a = 255 }
      $bytes[$o + 3] = [byte]$a
    } else {
      $bytes[$o + 3] = 255
    }
  }
}

[System.Runtime.InteropServices.Marshal]::Copy($bytes, 0, $data.Scan0, $bytes.Length)
$bmp.UnlockBits($data)

# crop to what is left
$minX = $w; $minY = $h; $maxX = -1; $maxY = -1
for ($y = 0; $y -lt $h; $y++) {
  for ($x = 0; $x -lt $w; $x++) {
    if ($bytes[$y * $stride + $x * 4 + 3] -gt 12) {
      if ($x -lt $minX) { $minX = $x }
      if ($x -gt $maxX) { $maxX = $x }
      if ($y -lt $minY) { $minY = $y }
      if ($y -gt $maxY) { $maxY = $y }
    }
  }
}
if ($maxX -lt 0) { throw "Nothing left after cutting: the picture looks all white" }

$cw = $maxX - $minX + 1
$ch = $maxY - $minY + 1
$crop = $bmp.Clone((New-Object System.Drawing.Rectangle $minX, $minY, $cw, $ch), $bmp.PixelFormat)
$bmp.Dispose()

# fit into a square canvas with a margin, centred
$box = $Size - 2 * $Pad
$k = [Math]::Min($box / [double]$cw, $box / [double]$ch)
$nw = [int][Math]::Round($cw * $k)
$nh = [int][Math]::Round($ch * $k)

$canvas = New-Object System.Drawing.Bitmap $Size, $Size, ([System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
$g2 = [System.Drawing.Graphics]::FromImage($canvas)
$g2.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
$g2.PixelOffsetMode  = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
$g2.Clear([System.Drawing.Color]::Transparent)
$g2.DrawImage($crop, (New-Object System.Drawing.Rectangle ([int](($Size - $nw) / 2)), ([int](($Size - $nh) / 2)), $nw, $nh))
$g2.Dispose()
$crop.Dispose()

$dir = Split-Path -Parent $Out
if ($dir -and -not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
$canvas.Save($Out, [System.Drawing.Imaging.ImageFormat]::Png)
$canvas.Dispose()

$kb = [math]::Round((Get-Item -LiteralPath $Out).Length / 1KB)
Write-Output "saved $Out : ${Size}x${Size}, ${kb} KB (content ${nw}x${nh})"
