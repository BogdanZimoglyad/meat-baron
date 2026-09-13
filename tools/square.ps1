param(
  [Parameter(Mandatory=$true)][string]$In,
  [Parameter(Mandatory=$true)][string]$Out,
  [int]$Size = 640,
  [int]$Quality = 85
)
# Square a product photo WITHOUT removing its background.
# The canvas is extended to a square with the photo's own background
# colour (averaged from the four corners), so nothing of the product is
# cropped, then scaled to $Size x $Size and saved as JPEG.
# No Cyrillic in this file: PowerShell 5.1 reads .ps1 as ANSI.

Add-Type -AssemblyName System.Drawing

$src = [System.Drawing.Image]::FromFile((Resolve-Path -LiteralPath $In))
$bmp = New-Object System.Drawing.Bitmap $src
$w = $bmp.Width
$h = $bmp.Height

# background colour: average of small patches in the four corners
$r = 0; $g = 0; $b = 0; $n = 0
$patch = 8
$xs = @(0, ($w - $patch))
$ys = @(0, ($h - $patch))
foreach ($x0 in $xs) {
  foreach ($y0 in $ys) {
    for ($dx = 0; $dx -lt $patch; $dx++) {
      for ($dy = 0; $dy -lt $patch; $dy++) {
        $p = $bmp.GetPixel($x0 + $dx, $y0 + $dy)
        $r += $p.R; $g += $p.G; $b += $p.B; $n++
      }
    }
  }
}
$fill = [System.Drawing.Color]::FromArgb([int]($r / $n), [int]($g / $n), [int]($b / $n))

$side = [Math]::Max($w, $h)
$dst = New-Object System.Drawing.Bitmap $Size, $Size
$gr = [System.Drawing.Graphics]::FromImage($dst)
$gr.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
$gr.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
$gr.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
$gr.Clear($fill)

$scale = $Size / $side
$dw = [int][Math]::Round($w * $scale)
$dh = [int][Math]::Round($h * $scale)
$dx0 = [int](($Size - $dw) / 2)
$dy0 = [int](($Size - $dh) / 2)
$gr.DrawImage($bmp, $dx0, $dy0, $dw, $dh)
$gr.Dispose()

$codec = [System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() | Where-Object { $_.MimeType -eq 'image/jpeg' }
$ep = New-Object System.Drawing.Imaging.EncoderParameters 1
$ep.Param[0] = New-Object System.Drawing.Imaging.EncoderParameter ([System.Drawing.Imaging.Encoder]::Quality), ([long]$Quality)
$dst.Save($Out, $codec, $ep)

$dst.Dispose(); $bmp.Dispose(); $src.Dispose()
$kb = [int]((Get-Item -LiteralPath $Out).Length / 1KB)
"{0}x{1} -> {2}x{2}, fill rgb({3},{4},{5}), {6} KB" -f $w, $h, $Size, $fill.R, $fill.G, $fill.B, $kb
