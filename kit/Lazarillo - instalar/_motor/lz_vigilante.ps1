
# ============================================================
#  Lazarillo - vigilante de ordenes
#  Mira cada minuto si apareció una orden, en dos lugares:
#
#   a) en la raiz del kit local:   _correr.flag / _todo.flag
#   b) en el kit del Drive, pero SOLO con el nombre de esta PC:
#      _correr.<EQUIPO>.flag / _todo.<EQUIPO>.flag
#
#  Lo de (b) permite pedirle algo a UN punto de venta sin que se
#  disparen los otros tres, porque todos miran la misma carpeta.
# ============================================================
$aqui = Split-Path -Parent $MyInvocation.MyCommand.Path
if ((Split-Path -Leaf $aqui) -eq "_motor") { $motor = $aqui; $base = Split-Path -Parent $aqui }
else { $motor = $aqui; $base = $aqui }

$outDir = Join-Path (Join-Path $base "out") $env:COMPUTERNAME
New-Item -ItemType Directory -Force -Path $outDir | Out-Null
$hist = Join-Path $outDir "_vigilante.txt"
function Reg($m) { Add-Content -Path $hist -Value ("{0}  {1}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $m) -Encoding UTF8 }

$script = Join-Path $base "_motor\lz_lazarillo.ps1"
if (-not (Test-Path $script)) { $script = Join-Path $motor "lz_lazarillo.ps1" }

# carpetas donde buscar ordenes
$lugares = @(@{ dir = $base; sufijo = "" })
$cfgDest = Join-Path $motor "destinos.txt"
if (Test-Path $cfgDest) {
  foreach ($l in (Get-Content $cfgDest -ErrorAction SilentlyContinue)) {
    if ($l -match '^\s*kit_drive\s*=\s*(.+?)\s*$') {
      $kd = $matches[1]
      if ((Test-Path $kd) -and ($kd -ne $base)) { $lugares += @{ dir = $kd; sufijo = "." + $env:COMPUTERNAME } }
    }
  }
}

$instalador = Join-Path $motor "lz_instalar.ps1"

# REPARTO RAPIDO AL MEGA (25/09, Diego: "que cuando haya cambios en el drive lo
# pase automaticamente y que no espere a la barrida de las 8"). Solo en la PC que
# reparte (reparte_mega = si en destinos.txt, hoy el admin). El motor con
# -SoloRepartir mira "Informes MEGA" del Drive y copia al MEGA SOLO lo que sea
# mas nuevo; si no hay nada nuevo, no escribe nada. De paso se autoactualiza.
$reparte = $false
if (Test-Path $cfgDest) {
  foreach ($l in (Get-Content $cfgDest -ErrorAction SilentlyContinue)) {
    if ($l -match '^\s*reparte_mega\s*=\s*(?i:si|s|1|true)\s*$') { $reparte = $true }
  }
}
if ($reparte -and (Test-Path $script)) {
  try {
    $ar = @('-NoProfile','-ExecutionPolicy','Bypass','-File', $script, '-SoloRepartir', '-SinAviso')
    Start-Process -FilePath powershell.exe -ArgumentList $ar -WindowStyle Hidden -Wait
  } catch { Reg "ERROR en reparto rapido: $($_.Exception.Message)" }
}

$ordenes = @(
  @{ flag = "_correr"; ps1 = $script;      args = @("-SoloExtraer","-SinAviso"); nombre = "extraer" },
  @{ flag = "_todo";   ps1 = $script;      args = @("-SinAviso");                nombre = "relevar + extraer + reprogramar" },
  @{ flag = "_probar"; ps1 = $instalador;  args = @("-Probar","-SinAviso");      nombre = "probar deteccion de rutas (no instala nada)" }
)

foreach ($lugar in $lugares) {
  foreach ($o in $ordenes) {
    $flag = Join-Path $lugar.dir ($o.flag + $lugar.sufijo + ".flag")
    if (-not (Test-Path $flag)) { continue }
    # borro el flag PRIMERO, asi una orden nunca se ejecuta dos veces
    try { Remove-Item $flag -Force -ErrorAction Stop } catch { Reg "no pude borrar $flag, salgo"; continue }
    Reg "orden recibida en $($lugar.dir) -> $($o.nombre)"
    if (-not (Test-Path $o.ps1)) { Reg "no encuentro $($o.ps1), salteo"; continue }
    try {
      # OJO: llamar a powershell.exe con "&" abre una consola igual (el
      # -WindowStyle Hidden se lee DESPUES de crear la ventana, asi que
      # parpadea). Start-Process -WindowStyle Hidden la crea ya oculta.
      $ar = @('-NoProfile','-ExecutionPolicy','Bypass','-File', $o.ps1) + @($o.args)
      Start-Process -FilePath powershell.exe -ArgumentList $ar -WindowStyle Hidden -Wait
      Reg "$($o.nombre): terminado"
    } catch {
      Reg "ERROR en $($o.nombre): $($_.Exception.Message)"
    }
  }
}
