# One persistent worker per backend. Drawing is loaded once, then requests use JSON lines.
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
Add-Type -AssemblyName System.Drawing

function Invoke-SwitchRequest($action, $requestPath) {
    if ($action -eq 'ping') { return @{ready=$true} }
    if ($action -eq 'printers') {
        $items = @(Get-CimInstance Win32_Printer | ForEach-Object {
            @{name=$_.Name; driver=$_.DriverName; port=$_.PortName;
              offline=[bool]$_.WorkOffline; status=[int]$_.PrinterStatus;
              virtual=[bool]($_.Name -match 'PDF|XPS|OneNote|Fax')}
        })
        return ,$items
    }
    if ($action -ne 'print') { throw '알 수 없는 인쇄 요청이에요.' }
    $r = Get-Content -LiteralPath $requestPath -Raw -Encoding UTF8 | ConvertFrom-Json
    $image = [System.Drawing.Image]::FromFile($r.imagePath)
    $document = New-Object System.Drawing.Printing.PrintDocument
    try {
        $document.PrintController = New-Object System.Drawing.Printing.StandardPrintController
        $document.PrinterSettings.PrinterName = $r.printerName
        $document.PrinterSettings.Copies = 1
        if (!$document.PrinterSettings.IsValid) { throw '선택한 프린터를 Windows에서 찾을 수 없어요.' }
        $document.DocumentName = 'SWitch-' + $r.jobId
        $heightMm = $image.Height / 203.0 * 25.4 + 2
        $document.DefaultPageSettings.PaperSize = New-Object System.Drawing.Printing.PaperSize('SWitch 80mm',315,[int][Math]::Ceiling($heightMm/25.4*100))
        $document.DefaultPageSettings.Margins = New-Object System.Drawing.Printing.Margins(0,0,0,0)
        $document.DefaultPageSettings.Color = $false
        $document.OriginAtMargins = $false
        $handler = {
            param($sender,$e)
            if ($e.PageBounds.Height + 3 -lt $heightMm / 25.4 * 100) {
                $e.Cancel = $true
                throw '프린터 드라이버가 영수증 길이를 지원하지 않아요. 80mm 롤 용지 설정을 확인해 주세요.'
            }
            $e.Graphics.PageUnit = [System.Drawing.GraphicsUnit]::Inch
            $e.Graphics.TranslateTransform(-$e.PageSettings.HardMarginX/100.0,-$e.PageSettings.HardMarginY/100.0)
            $x = (4.0 + [double]$r.offsetXmm) / 25.4
            $rect = New-Object System.Drawing.RectangleF([single]$x,0,[single](72.0/25.4),[single]($image.Height/203.0))
            $e.Graphics.DrawImage($image,$rect)
            $e.HasMorePages = $false
        }.GetNewClosure()
        $document.add_PrintPage($handler)
        $document.Print()
    } finally {
        $document.Dispose()
        $image.Dispose()
    }
    return @{state='queued'}
}

while ($null -ne ($line = [Console]::In.ReadLine())) {
    $request = $null
    try {
        $request = ConvertFrom-Json -InputObject $line
        $result = Invoke-SwitchRequest $request.action $request.request
        $reply = @{id=$request.id; result=$result}
    } catch {
        $reply = @{id=$request.id; error=$_.Exception.Message}
    }
    [Console]::Out.WriteLine((ConvertTo-Json -InputObject $reply -Depth 6 -Compress))
}
