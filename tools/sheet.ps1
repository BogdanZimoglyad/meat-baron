# Contact sheet: tiles a folder of photos into numbered pages, so a whole
# batch can be named in one go instead of opening files one by one.
#
#   sheet.ps1 -Dir "C:\...\photos" -Out "C:\...\sheet" [-Cols 5] [-Rows 4] [-Cell 320]
#
# Writes sheet-1.png, sheet-2.png ... and prints which file sits in which
# numbered cell.

param(
  [Parameter(Mandatory=$true)][string]$Dir,
  [Parameter(Mandatory=$true)][string]$Out,
  [int]$Cols = 5,
  [int]$Rows = 4,
  [int]$Cell = 320,
  [int]$Label = 34
)

Add-Type -AssemblyName System.Drawing

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
  $b = New-Object System.Drawing.Bitmap $pw, $ph, ([System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $r = New-Object System.Drawing.Rectangle 0, 0, $pw, $ph
  $bd = $b.LockBits($r, [System.Drawing.Imaging.ImageLockMode]::WriteOnly,
                    [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  for ($yy = 0; $yy -lt $ph; $yy++) {
    [System.Runtime.InteropServices.Marshal]::Copy(
      $buf, $yy * $srcStride, [IntPtr]::Add($bd.Scan0, $yy * $bd.Stride), $srcStride)
  }
  $b.UnlockBits($bd)
  return $b
}

$files = Get-ChildItem -LiteralPath $Dir -File |
         Where-Object { $_.Extension -match 'png|jpg|jpeg|webp' } |
         Sort-Object { [int](($_.BaseName -replace '\D', '')) }, Name

if (-not $files) { throw "No pictures in $Dir" }

$perPage = $Cols * $Rows
$pages = [Math]::Ceiling($files.Count / $perPage)
$W = $Cols * $Cell
$H = $Rows * ($Cell + $Label)

$font = New-Object System.Drawing.Font('Segoe UI', 17, [System.Drawing.FontStyle]::Bold)
$ink = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(255, 20, 20, 20))
$paper = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(255, 246, 246, 248))

$map = @()
for ($p = 0; $p -lt $pages; $p++) {
  $page = New-Object System.Drawing.Bitmap $W, $H, ([System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $gr = [System.Drawing.Graphics]::FromImage($page)
  $gr.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $gr.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
  $gr.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::ClearTypeGridFit
  $gr.FillRectangle($paper, 0, 0, $W, $H)

  for ($k = 0; $k -lt $perPage; $k++) {
    $idx = $p * $perPage + $k
    if ($idx -ge $files.Count) { break }
    $f = $files[$idx]
    $img = Read-AnyImage $f.FullName
    $col = $k % $Cols; $row = [int][Math]::Floor($k / $Cols)
    $x0 = $col * $Cell; $y0 = $row * ($Cell + $Label)

    $k2 = [Math]::Min(($Cell - 12) / [double]$img.Width, ($Cell - 12) / [double]$img.Height)
    $nw = [int]($img.Width * $k2); $nh = [int]($img.Height * $k2)
    $gr.DrawImage($img, ($x0 + [int](($Cell - $nw) / 2)), ($y0 + [int](($Cell - $nh) / 2)), $nw, $nh)
    $img.Dispose()

    $num = $idx + 1
    $gr.DrawString("$num", $font, $ink, [single]($x0 + 10), [single]($y0 + $Cell + 4))
    $map += [pscustomobject]@{ N = $num; Page = $p + 1; File = $f.Name }
  }
  $gr.Dispose()
  $path = "$Out-$($p + 1).png"
  $page.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
  $page.Dispose()
  Write-Output "sheet: $path"
}
$font.Dispose(); $ink.Dispose(); $paper.Dispose()
$map | Format-Table -AutoSize
