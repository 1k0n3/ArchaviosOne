<#
.SYNOPSIS
  Erzeugt assets\mtga-stats.ico (fünf Mana-Balken, deren Oberkanten ein M bilden) in 256/48/32/16 px.
#>
param([string]$Out = (Join-Path (Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)) "assets\mtga-stats.ico"))
Add-Type -AssemblyName System.Drawing

function Draw-Emblem([int]$size) {
  $bmp = New-Object System.Drawing.Bitmap $size, $size
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $g.Clear([System.Drawing.Color]::Transparent)
  $s = $size / 32.0

  # Plakette (abgerundetes Quadrat) mit Goldrand, fünf Mana-Balken, deren Oberkanten ein M bilden
  $path = New-Object System.Drawing.Drawing2D.GraphicsPath
  $r = 7.5 * $s; $x0 = 1 * $s; $y0 = 1 * $s; $w = 30 * $s
  $path.AddArc($x0, $y0, 2 * $r, 2 * $r, 180, 90); $path.AddArc($x0 + $w - 2 * $r, $y0, 2 * $r, 2 * $r, 270, 90)
  $path.AddArc($x0 + $w - 2 * $r, $y0 + $w - 2 * $r, 2 * $r, 2 * $r, 0, 90); $path.AddArc($x0, $y0 + $w - 2 * $r, 2 * $r, 2 * $r, 90, 90); $path.CloseFigure()
  $bgBrush = New-Object System.Drawing.Drawing2D.LinearGradientBrush (New-Object System.Drawing.PointF 0, 0), (New-Object System.Drawing.PointF 0, (32 * $s)), ([System.Drawing.Color]::FromArgb(26, 33, 64)), ([System.Drawing.Color]::FromArgb(11, 14, 24))
  $g.FillPath($bgBrush, $path)
  $g.DrawPath((New-Object System.Drawing.Pen ([System.Drawing.Color]::FromArgb(140, 242, 177, 52)), ([Math]::Max(0.8, 0.8 * $s))), $path)
  $cols = @(@(243, 233, 200), @(61, 127, 214), @(154, 143, 179), @(216, 72, 47), @(63, 154, 79))
  $hs = @(17, 12.5, 8.5, 12.5, 17)
  for ($i = 0; $i -lt 5; $i++) {
    $pen = New-Object System.Drawing.Pen ([System.Drawing.Color]::FromArgb($cols[$i][0], $cols[$i][1], $cols[$i][2])), ([Math]::Max(1.5, 3.5 * $s))
    $pen.StartCap = [System.Drawing.Drawing2D.LineCap]::Round; $pen.EndCap = [System.Drawing.Drawing2D.LineCap]::Round
    $x = (6 + $i * 5) * $s
    $g.DrawLine($pen, [single]$x, [single](25 * $s - 1.5 * $s), [single]$x, [single]((25 - $hs[$i]) * $s + 1.5 * $s))
  }
  $g.Dispose()
  return $bmp
}

$sizes = @(256, 48, 32, 16)
$pngs = @()
foreach ($sz in $sizes) {
  $bmp = Draw-Emblem $sz
  if ($sz -ge 256) {
    # 256 px als PNG (ab Windows Vista)
    $ms = New-Object System.IO.MemoryStream
    $bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
    $pngs += ,$ms.ToArray()
  } else {
    # kleinere Größen als klassisches 32-Bit-DIB mit AND-Maske (überall lesbar)
    $maskRow = [int](([Math]::Ceiling($sz / 32.0)) * 4)
    $dib = New-Object System.IO.MemoryStream
    $w = New-Object System.IO.BinaryWriter $dib
    $w.Write([int32]40); $w.Write([int32]$sz); $w.Write([int32]($sz * 2)); $w.Write([int16]1); $w.Write([int16]32)
    $w.Write([int32]0); $w.Write([int32]($sz * $sz * 4 + $maskRow * $sz)); $w.Write([int32]0); $w.Write([int32]0); $w.Write([int32]0); $w.Write([int32]0)
    for ($y = $sz - 1; $y -ge 0; $y--) { for ($x = 0; $x -lt $sz; $x++) { $c = $bmp.GetPixel($x, $y); $w.Write([byte]$c.B); $w.Write([byte]$c.G); $w.Write([byte]$c.R); $w.Write([byte]$c.A) } }
    for ($y = 0; $y -lt $sz; $y++) { for ($k = 0; $k -lt $maskRow; $k++) { $w.Write([byte]0) } }
    $w.Flush()
    $pngs += ,$dib.ToArray()
  }
  $bmp.Dispose()
}
# ICO: 256 px als PNG, kleinere als DIB
$ico = New-Object System.IO.MemoryStream
$bw = New-Object System.IO.BinaryWriter $ico
$bw.Write([uint16]0); $bw.Write([uint16]1); $bw.Write([uint16]$sizes.Count)
$offset = 6 + 16 * $sizes.Count
for ($i = 0; $i -lt $sizes.Count; $i++) {
  $sz = $sizes[$i]
  $bw.Write([byte]($(if ($sz -ge 256) { 0 } else { $sz })))
  $bw.Write([byte]($(if ($sz -ge 256) { 0 } else { $sz })))
  $bw.Write([byte]0); $bw.Write([byte]0); $bw.Write([uint16]1); $bw.Write([uint16]32)
  $bw.Write([uint32]$pngs[$i].Length); $bw.Write([uint32]$offset)
  $offset += $pngs[$i].Length
}
foreach ($p in $pngs) { $bw.Write($p) }
$bw.Flush()
New-Item -ItemType Directory -Force -Path (Split-Path -Parent $Out) | Out-Null
[System.IO.File]::WriteAllBytes($Out, $ico.ToArray())
Write-Host "Icon geschrieben: $Out ($($ico.Length) Bytes)"
# PNG-Icons für das Web-Manifest (App-Installation) und das App-Fenster
$assets = Split-Path -Parent $Out
foreach ($px in @(192, 512)) {
  $bmp = Draw-Emblem $px
  $bmp.Save((Join-Path $assets ("icon-{0}.png" -f $px)), [System.Drawing.Imaging.ImageFormat]::Png)
  $bmp.Dispose()
}
Write-Host "PNG-Icons geschrieben: icon-192.png, icon-512.png"
