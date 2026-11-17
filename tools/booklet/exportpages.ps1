# Export a page range of a .docx to PDF with Word (fast: only those pages).
param([string]$Src, [int]$From, [int]$To, [string]$Out)
$w = New-Object -ComObject Word.Application
$w.Visible = $false; $w.DisplayAlerts = 0; $w.AutomationSecurity = 3
try {
  $d = $w.Documents.Open($Src, $false, $true, $false, "", "", $false, "", "", 0, [Type]::Missing, $false, $false, 0, $true)
  # ExportAsFixedFormat(Out, wdExportFormatPDF=17, OpenAfter, OptimizeFor=0, Range=wdExportFromTo(3), From, To)
  $d.ExportAsFixedFormat($Out, 17, $false, 0, 3, $From, $To)
  $d.Close($false); "exported $From-$To"
} catch { "error: $($_.Exception.Message)" } finally { $w.Quit() }
