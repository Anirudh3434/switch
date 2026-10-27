Add-Type -AssemblyName System.Drawing

function Create-Variant4($outputPath) {
    $bmp = New-Object System.Drawing.Bitmap 512, 512
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality

    # Dark background
    $rectPath = New-Object System.Drawing.Drawing2D.GraphicsPath
    $arcRadius = 112
    $d = $arcRadius * 2
    $rect = New-Object System.Drawing.RectangleF 16, 16, 480, 480
    $rectPath.AddArc($rect.X, $rect.Y, $d, $d, 180, 90)
    $rectPath.AddArc($rect.Right - $d, $rect.Y, $d, $d, 270, 90)
    $rectPath.AddArc($rect.Right - $d, $rect.Bottom - $d, $d, $d, 0, 90)
    $rectPath.AddArc($rect.X, $rect.Bottom - $d, $d, $d, 90, 90)
    $rectPath.CloseFigure()

    $bgBrush = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(11, 15, 23))
    $g.FillPath($bgBrush, $rectPath)
    $borderPen = New-Object System.Drawing.Pen ([System.Drawing.Color]::FromArgb(25, 255, 255, 255)), 2
    $g.DrawPath($borderPen, $rectPath)

    # Gradient for the continuous track
    $gradBrush = New-Object System.Drawing.Drawing2D.LinearGradientBrush (
        (New-Object System.Drawing.PointF 70, 256),
        (New-Object System.Drawing.PointF 442, 256),
        [System.Drawing.Color]::FromArgb(0, 242, 254),
        [System.Drawing.Color]::FromArgb(168, 85, 247)
    )
    $blend = New-Object System.Drawing.Drawing2D.ColorBlend 4
    $blend.Colors = @(
        [System.Drawing.Color]::FromArgb(0, 242, 254),
        [System.Drawing.Color]::FromArgb(14, 165, 233),
        [System.Drawing.Color]::FromArgb(99, 102, 241),
        [System.Drawing.Color]::FromArgb(168, 85, 247)
    )
    $blend.Positions = @(0.0, 0.32, 0.68, 1.0)
    $gradBrush.InterpolationColors = $blend

    # Draw the continuous infinity ribbon
    $ribbonPen = New-Object System.Drawing.Pen $gradBrush, 54
    $ribbonPen.LineJoin = [System.Drawing.Drawing2D.LineJoin]::Round
    $ribbonPen.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
    $ribbonPen.EndCap = [System.Drawing.Drawing2D.LineCap]::Round

    $path = New-Object System.Drawing.Drawing2D.GraphicsPath
    # Smooth round loop
    # From center (256, 256) up-left through (186, 172) around apex (110, 256)
    $path.AddBezier(256, 256, 206, 172, 110, 172, 110, 256)
    # Around bottom-left through (186, 340) back to center (256, 256)
    $path.AddBezier(110, 256, 110, 340, 206, 340, 256, 256)
    # Up-right through (326, 172) around right apex (402, 256)
    $path.AddBezier(256, 256, 306, 172, 402, 172, 402, 256)
    # Around bottom-right through (326, 340) back to center (256, 256)
    $path.AddBezier(402, 256, 402, 340, 306, 340, 256, 256)

    $g.DrawPath($ribbonPen, $path)

    # Solid Terminal Nodes (protruding slightly outward as distinct circular endpoints)
    $nodeCyan = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(0, 242, 254))
    $nodePurple = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(168, 85, 247))
    $g.FillEllipse($nodeCyan, (110 - 46), (256 - 46), 92, 92)
    $g.FillEllipse($nodePurple, (402 - 46), (256 - 46), 92, 92)

    $bmp.Save($outputPath, [System.Drawing.Imaging.ImageFormat]::Png)
    $bmp.Dispose()
    $g.Dispose()
}

Create-Variant4 "c:\Users\Anirudh Bhardwaj\Desktop\switch\scratch\v4.png"
Write-Output "v4 generated"
