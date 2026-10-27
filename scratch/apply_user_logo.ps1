Add-Type -AssemblyName System.Drawing

$sourcePath = "C:\Users\Anirudh Bhardwaj\.gemini\antigravity-ide\brain\a71c1e63-90fc-4028-835b-f0dfddea0912\.user_uploaded\media_1792560594146.jpg"
$destDir = "c:\Users\Anirudh Bhardwaj\Desktop\switch\src\assets"

if (!(Test-Path $sourcePath)) {
    Write-Error "Source file does not exist: $sourcePath"
    exit 1
}

$sourceImg = [System.Drawing.Image]::FromFile($sourcePath)

# 1. Save master high-res logo
$masterPath = Join-Path $destDir "logo.png"
$sourceImg.Save($masterPath, [System.Drawing.Imaging.ImageFormat]::Png)
Write-Output "Saved master logo: $masterPath"

# 2. Function to resize and save crisp icon
function Resize-Image($img, $size, $outputPath) {
    $bmp = New-Object System.Drawing.Bitmap $size, $size
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    
    $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
    $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
    $g.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::HighQuality

    $destRect = New-Object System.Drawing.Rectangle 0, 0, $size, $size
    $g.DrawImage($img, $destRect, 0, 0, $img.Width, $img.Height, [System.Drawing.GraphicsUnit]::Pixel)

    $bmp.Save($outputPath, [System.Drawing.Imaging.ImageFormat]::Png)
    $g.Dispose()
    $bmp.Dispose()
    Write-Output "Generated icon: $outputPath ($($size)x$($size))"
}

# Generate Chrome Extension Manifest standard sizes
Resize-Image $sourceImg 512 (Join-Path $destDir "icon-512.png")
Resize-Image $sourceImg 128 (Join-Path $destDir "icon-128.png")
Resize-Image $sourceImg 48  (Join-Path $destDir "icon-48.png")
Resize-Image $sourceImg 32  (Join-Path $destDir "icon-32.png")
Resize-Image $sourceImg 16  (Join-Path $destDir "icon-16.png")

$sourceImg.Dispose()
Write-Output "All icons successfully created!"
