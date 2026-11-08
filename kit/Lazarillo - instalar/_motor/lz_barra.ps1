# ============================================================
#  Lazarillo - barra de estado
#  Ventanita que muestra en que fase va la corrida. NO hace trabajo:
#  solo lee "_progreso.txt" (que el motor va escribiendo) y refresca.
#  Corre en su propio proceso, asi nunca aparece "no responde".
#  Se cierra sola cuando el motor llega al 100 o si el archivo se queda
#  quieto 20 minutos (la corrida murio).
# ============================================================
param([string]$arch)

try {
  Add-Type -AssemblyName System.Windows.Forms
  Add-Type -AssemblyName System.Drawing
} catch { exit }

$f = New-Object System.Windows.Forms.Form
$f.Text = "Lazarillo"
$f.Size = New-Object System.Drawing.Size(520,180)
$f.StartPosition = "CenterScreen"
$f.FormBorderStyle = "FixedDialog"
$f.MaximizeBox = $false
$f.MinimizeBox = $false
$f.TopMost = $true

$titulo = New-Object System.Windows.Forms.Label
$titulo.SetBounds(20, 16, 480, 26)
$titulo.Font = New-Object System.Drawing.Font("Segoe UI", 12, [System.Drawing.FontStyle]::Bold)
$titulo.Text = "Lazarillo esta trabajando..."

$lbl = New-Object System.Windows.Forms.Label
$lbl.SetBounds(20, 50, 480, 24)
$lbl.Font = New-Object System.Drawing.Font("Segoe UI", 10)
$lbl.Text = "Arrancando..."

$bar = New-Object System.Windows.Forms.ProgressBar
$bar.SetBounds(20, 84, 480, 26)
$bar.Minimum = 0
$bar.Maximum = 100
$bar.Value = 0
$bar.Style = "Continuous"

$pie = New-Object System.Windows.Forms.Label
$pie.SetBounds(20, 120, 480, 18)
$pie.Font = New-Object System.Drawing.Font("Segoe UI", 8)
$pie.ForeColor = [System.Drawing.Color]::Gray
$pie.Text = "No cierres esta ventana: se cierra sola al terminar."

$f.Controls.AddRange(@($titulo, $lbl, $bar, $pie))

$script:ultimo = ""
$script:quieto = 0

$t = New-Object System.Windows.Forms.Timer
$t.Interval = 400
$t.Add_Tick({
  try {
    if ($arch -and (Test-Path $arch)) {
      $l = Get-Content -LiteralPath $arch -Encoding UTF8 -TotalCount 1 -ErrorAction SilentlyContinue
      if ($l) {
        $partes = $l -split '\|', 2
        $pct = 0
        [void][int]::TryParse($partes[0].Trim(), [ref]$pct)
        $txt = if ($partes.Count -ge 2) { $partes[1] } else { $l }
        $lbl.Text = $txt
        if ($pct -ge 0 -and $pct -le 100) { $bar.Value = $pct }
        if ($pct -ge 100) { $t.Stop(); $f.Close(); return }
        if ($l -eq $script:ultimo) { $script:quieto += $t.Interval } else { $script:quieto = 0; $script:ultimo = $l }
      }
    }
    if ($script:quieto -gt 1200000) { $t.Stop(); $f.Close() }   # 20 min sin cambios
  } catch { }
})
$t.Start()

try { [System.Windows.Forms.Application]::Run($f) } catch { }
