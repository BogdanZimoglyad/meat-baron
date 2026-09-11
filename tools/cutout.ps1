# Removes a plain studio background and produces a 640x640 transparent PNG,
# matching the format already used on the site. White backdrop by default,
# black with -Dark.
#
#   cutout.ps1 -In photo.jpg -Out photo\name.png
#   cutout.ps1 -In duck.jpg  -Out photo\kachka.png -Dark
#
# White    : a pixel this bright (min channel) can belong to the backdrop
# Soft     : below this brightness a pixel is definitely product
# Neutral  : max spread between R,G,B for a pixel to count as neutral
# Shadow   : a strictly neutral pixel this bright is a soft shadow
# Dark     : cut a black backdrop instead of a white one
# Keep     : background already removed elsewhere, only reframe to 640x640
# CropBot  : cut this percent off the bottom before anything else, to
#            drop a mirror reflection that touches the product
# DarkMax  : on black, a pixel this dark (max channel) can be backdrop
# DarkSoft : on black, above this brightness a pixel is definitely product
#
# Only background CONNECTED TO THE BORDER is erased, so highlights inside
# the product survive. Enclosed islands of backdrop colour are erased too,
# but only when they are large enough to be a real hole.

param(
  [Parameter(Mandatory=$true)][string]$In,
  [Parameter(Mandatory=$true)][string]$Out,
  [int]$Size = 640,
  [int]$Pad = 24,
  [int]$White = 232,
  [int]$Soft = 196,
  [int]$Neutral = 20,
  [int]$Shadow = 140,
  [switch]$Dark,
  [switch]$Keep,
  [int]$DarkMax = 46,
  [int]$DarkSoft = 96,
  [double]$Holes = 0.08,
  [double]$Specks = 0.05,
  [int]$CropBottom = 0,
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

# A mirror reflection on a glossy table touches the product itself, so no
# island rule can tell them apart. Cutting the bottom of the frame before
# anything else is the only sure way.
if ($CropBottom -gt 0) {
  $keepH = [int]($src.Height * (100 - $CropBottom) / 100.0)
  if ($keepH -lt 10) { throw "CropBottom is too big: nothing left" }
  $cut = New-Object System.Drawing.Bitmap $src.Width, $keepH, ([System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $gc = [System.Drawing.Graphics]::FromImage($cut)
  $gc.DrawImage($src, (New-Object System.Drawing.Rectangle 0, 0, $src.Width, $keepH),
                      (New-Object System.Drawing.Rectangle 0, 0, $src.Width, $keepH),
                      [System.Drawing.GraphicsUnit]::Pixel)
  $gc.Dispose(); $src.Dispose()
  $src = $cut
}

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

# -Keep: the picture already has a transparent background, cut elsewhere.
# Touch nothing but the framing: otherwise we would hunt for a backdrop
# that is not there and eat the product instead.
if (-not $Keep) {

$isBg = New-Object bool[] $n          # background, connected to the border
$bright = New-Object byte[] $n        # min channel, i.e. how white
$dimm = New-Object byte[] $n          # max channel, i.e. how far from black
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
    $dimm[$i] = $mx
    $spread = $mx - $mn
    $grey[$i] = $spread -le $Neutral
    $flat[$i] = $spread -le [int]($Neutral / 2)
  }
}

# What counts as background.
# On white: a pale grey pixel (the backdrop) or a strictly neutral
# mid-grey one (a soft shadow under the product).
# On black: a neutral pixel dark enough that no food looks like it.
# Judged by the brightest channel, so a deep red glaze is not mistaken
# for backdrop.
$bgLike = New-Object bool[] $n
for ($i = 0; $i -lt $n; $i++) {
  if ($Dark) {
    $bgLike[$i] = $grey[$i] -and $dimm[$i] -le $DarkMax
  } else {
    $bgLike[$i] = ($grey[$i] -and $bright[$i] -ge $Soft) -or ($flat[$i] -and $bright[$i] -ge $Shadow)
  }
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

# Loose specks: a reflection on a glossy table, crumbs beside the dish,
# a stray highlight. They survive the fill because they are not backdrop
# colour, and on the site they read as dirt floating under the product.
# Drop every island of kept pixels that is too small to be the dish.
$minSpeck = [int]($n * $Specks / 100.0)
if ($minSpeck -gt 0) {
  $seenK = New-Object bool[] $n
  $isle = New-Object System.Collections.Generic.List[int]
  for ($s = 0; $s -lt $n; $s++) {
    if ($seenK[$s] -or $isBg[$s]) { continue }
    $isle.Clear()
    $stack.Push($s); $seenK[$s] = $true
    while ($stack.Count -gt 0) {
      $i = $stack.Pop()
      $isle.Add($i)
      $x = $i % $w; $y = [int][Math]::Floor($i / $w)
      foreach ($j in ($i-1), ($i+1), ($i-$w), ($i+$w)) {
        if ($j -lt 0 -or $j -ge $n) { continue }
        if ($j -eq $i - 1 -and $x -eq 0) { continue }
        if ($j -eq $i + 1 -and $x -eq $w - 1) { continue }
        if ($seenK[$j] -or $isBg[$j]) { continue }
        $seenK[$j] = $true; $stack.Push($j)
      }
    }
    if ($isle.Count -lt $minSpeck) { foreach ($i in $isle) { $isBg[$i] = $true } }
  }
}

# write alpha: background clear, edge pixels partly clear so the cut
# does not look like scissors work
$span = [double]($White - $Soft)
if ($span -lt 1) { $span = 1 }
$darkSpan = [double]($DarkSoft - $DarkMax)
if ($darkSpan -lt 1) { $darkSpan = 1 }
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
    $a = 255
    if ($touching -and $grey[$i]) {
      if ($Dark) {
        # the darker the pixel, the more of the backdrop is in it
        if ($dimm[$i] -lt $DarkSoft) { $a = [int](255 * (($dimm[$i] - $DarkMax) / $darkSpan)) }
      } elseif ($bright[$i] -gt $Soft) {
        $a = 255 - [int](255 * (($bright[$i] - $Soft) / $span))
      }
      if ($a -lt 0) { $a = 0 }
      if ($a -gt 255) { $a = 255 }
    }
    $bytes[$o + 3] = [byte]$a
  }
}

}  # end of -Keep guard

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
