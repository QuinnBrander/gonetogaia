param([string]$Src, [string]$OutFile)
$w = New-Object -ComObject Word.Application
$w.Visible = $false; $w.DisplayAlerts = 0; $w.AutomationSecurity = 3
try {
  $d = $w.Documents.Open($Src, $false, $true, $false, "", "", $false, "", "", 0, [Type]::Missing, $false, $false, 0, $true)
  $d.Repaginate()
  $lines = New-Object System.Collections.Generic.List[string]
  $prev = $null
  foreach ($p in $d.Paragraphs) {
    $t = $p.Range.Text.Trim()
    if ($t -match '^QUEST #\d+' -and $prev -ne $null) {
      # the last non-empty paragraph before this header: where the previous spread ends
      $lines.Add("$($prev.Range.Information(3))`tLAST $($prev.Range.Text.Trim().Substring(0, [Math]::Min(30, $prev.Range.Text.Trim().Length)))")
    }
    if ($t -match '^(QUEST #\d+|WAVE \d|\d{1,2}\.\d{1,2}a?$|_{10,}|END OF WAVE|IF ONE OR BOTH)') {
      $lines.Add("$($p.Range.Information(3))`t$($t.Substring(0, [Math]::Min(40, $t.Length)))")
    }
    if ($t.Length -gt 0) { $prev = $p }
  }
  $d.Close($false)
  [IO.File]::WriteAllLines($OutFile, $lines); "done"
} catch { "error: $($_.Exception.Message)" } finally { $w.Quit() }
