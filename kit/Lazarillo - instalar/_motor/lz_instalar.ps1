
# ============================================================
#  LAZARILLO - instalador para un punto de venta
#
#  Se corre UNA vez desde el kit del Drive. Hace:
#   1. Busca solo donde esta el Drive y donde esta el MEGA en esta PC
#   2. Copia el kit a C:\Lazarillo (de ahi en mas trabaja local)
#   3. Escribe destinos.txt con las rutas que encontro
#   4. Corre el kit completo (relevar + extraer + programar)
#
#  Con -Probar no copia ni instala nada: solo informa que encontro.
# ============================================================
param([switch]$Probar, [switch]$SinAviso)

$origen = Split-Path -Parent $MyInvocation.MyCommand.Path      # ..\_motor del kit del Drive
$kitDrive = Split-Path -Parent $origen                          # raiz del kit en el Drive
$destino = "C:\Lazarillo"

$L = New-Object System.Collections.ArrayList
function W($m) { [void]$L.Add($m) }
function Aviso($t,$x,$i) { if ($SinAviso) { return }
  try { (New-Object -ComObject WScript.Shell).Popup($x,0,$t,$i) | Out-Null } catch { } }

# ------------------------------------------------------------
#  MODO SIN DRIVE (kit vinculado, Diego 08/11/2026). El zip "Lazarillo - instalar" trae
#  _motor\lz_api.txt: esta PC no usa el Drive para nada. Se copia el kit a C:\Lazarillo,
#  se VINCULA la PC a la cuenta del negocio (usuario y contrasena de dueno/admin, una sola
#  vez) y recien ahi corre el kit. Los datos suben por Lazarillo con la llave de la PC.
#  El modo de siempre (kit del Drive) sigue abajo, sin cambios.
#  (Este bloque va en ASCII a proposito: este archivo no tiene BOM.)
# ------------------------------------------------------------
#  (08/11, Diego: "me abrio powershell y quedo ahi, la pantalla en negro"): lo arranca
#  INSTALAR EN ESTA PC.bat escondido (conhost), y este bloque muestra una ventanita de progreso propia que se
#  sigue moviendo mientras copia o instala Python (nunca "no responde"). Si una PC ya tiene
#  el kit del Drive, no lo pisa. Lo que va pasando queda en %TEMP%\lazarillo_instalacion.txt.
$script:prog = $null
function Progreso($txt) {
  if ($SinAviso) { return }
  try {
    if (-not $script:prog) {
      Add-Type -AssemblyName System.Windows.Forms
      Add-Type -AssemblyName System.Drawing
      [System.Windows.Forms.Application]::EnableVisualStyles()
      $f = New-Object System.Windows.Forms.Form
      $f.Text = "Lazarillo - instalando"
      $f.StartPosition = 'CenterScreen'; $f.FormBorderStyle = 'FixedDialog'
      $f.MaximizeBox = $false; $f.MinimizeBox = $false; $f.ControlBox = $false; $f.TopMost = $true
      $f.ClientSize = New-Object System.Drawing.Size(420, 112)
      $f.BackColor = [System.Drawing.Color]::White
      $l = New-Object System.Windows.Forms.Label
      $l.Location = New-Object System.Drawing.Point(20, 18); $l.Size = New-Object System.Drawing.Size(380, 44)
      $l.Font = New-Object System.Drawing.Font("Segoe UI", 10)
      $l.ForeColor = [System.Drawing.Color]::FromArgb(22, 50, 74)
      $b = New-Object System.Windows.Forms.ProgressBar
      $b.Style = 'Marquee'; $b.MarqueeAnimationSpeed = 30
      $b.Location = New-Object System.Drawing.Point(20, 74); $b.Size = New-Object System.Drawing.Size(380, 14)
      $f.Controls.Add($l); $f.Controls.Add($b)
      $f.Show(); $f.Activate()
      $script:prog = $f; $script:progL = $l
    }
    $script:progL.Text = $txt
    [System.Windows.Forms.Application]::DoEvents()
  } catch { }
}
function Refrescar { try { if ($script:prog) { [System.Windows.Forms.Application]::DoEvents() } } catch { } }
function CerrarProgreso { try { if ($script:prog) { $script:prog.Close(); $script:prog.Dispose(); $script:prog = $null } } catch { } }
$logTmp = Join-Path $env:TEMP "lazarillo_instalacion.txt"
function Paso($m) { W $m; try { $L | Set-Content -Path $logTmp -Encoding UTF8 } catch { } }

if (Test-Path (Join-Path $origen "lz_api.txt")) {
  Progreso "Preparando la instalacion..."
  # Esta PC ya tiene el kit del Drive: no se pisa (perderia el Drive, el MEGA y los maestros).
  $destPrevio = Join-Path $destino "_motor\destinos.txt"
  if ((Test-Path $destPrevio) -and -not (Select-String -Path $destPrevio -Pattern '^\s*modo\s*=\s*vinculado' -Quiet)) {
    CerrarProgreso
    Aviso "Lazarillo" ("Esta PC ya tiene Lazarillo instalado con Google Drive (" + $destino + ").`n`nNo hace falta instalar de nuevo. Si queres pasarla al modo sin Drive, avisale a Lazarillo.") 48
    exit 1
  }
  W "INSTALADOR LAZARILLO (sin Drive)"
  W "equipo  = $env:COMPUTERNAME"
  W "fecha   = $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')"
  W "kit origen = $kitDrive"
  if ($Probar) { W "MODO PRUEBA: no copio ni instalo nada"; $L | ForEach-Object { Write-Output $_ }; exit 0 }
  Progreso "Copiando el kit a C:\Lazarillo..."
  try {
    New-Item -ItemType Directory -Force -Path (Join-Path $destino "_motor") | Out-Null
    # LAZARILLO.bat y VINCULAR ESTA PC.bat vienen en _motor\raiz (asi la carpeta descargada
    # muestra un solo .bat para hacer doble clic) y van a la raiz de C:\Lazarillo.
    foreach ($b in @("LAZARILLO.bat", "LEEME.txt", "VINCULAR ESTA PC.bat")) {
      foreach ($f in @((Join-Path (Join-Path $origen "raiz") $b), (Join-Path $kitDrive $b))) {
        if (Test-Path -LiteralPath $f) { Copy-Item -LiteralPath $f -Destination $destino -Force; break }
      }
    }
    # archivo por archivo (Copy-Item carpeta\* -Recurse anida si la subcarpeta ya existe)
    foreach ($f in (Get-ChildItem -LiteralPath $origen -Recurse -File)) {
      Refrescar
      $rel = $f.FullName.Substring($origen.Length).TrimStart('\')
      if ($rel -ieq "destinos.txt" -or $rel -ieq "lz_vinculo.txt" -or $rel -like "raiz\*") { continue }
      $dst = Join-Path (Join-Path $destino "_motor") $rel
      New-Item -ItemType Directory -Force -Path (Split-Path -Parent $dst) | Out-Null
      Copy-Item -LiteralPath $f.FullName -Destination $dst -Force
    }
    Paso "  kit copiado a $destino"
  } catch {
    Paso "  ERROR copiando el kit: $($_.Exception.Message)"
    CerrarProgreso
    Aviso "Lazarillo - error" ("No pude copiar el kit a " + $destino + ":`n" + $_.Exception.Message) 16
    exit 1
  }
  # destinos.txt minimo (sin kit_drive ni Drive: nada de esta PC pasa por el Drive)
  $dest = Join-Path $destino "_motor\destinos.txt"
  $previo = @()
  if (Test-Path $dest) { $previo = @(Get-Content $dest -ErrorAction SilentlyContinue) }
  $cfg = @("# Rutas de esta PC (kit sin Drive). Las escribio el instalador.", "modo = vinculado")
  foreach ($l in $previo) { if ($l -match '^\s*(maxirest|mega_informes|maestros_informes)\s*=') { $cfg += $l } }
  $cfg | Set-Content -Path $dest -Encoding UTF8
  W "  destinos.txt escrito"

  # Python: lo usan los informes. Si no esta, se intenta instalar con winget (sin admin).
  $hayPy = $false
  $g = Get-Command python.exe -ErrorAction SilentlyContinue
  if ($g -and ($g.Source -notlike "*WindowsApps*")) { $hayPy = $true }
  if (-not $hayPy) {
    foreach ($d in (Get-ChildItem -Path (Join-Path $env:LOCALAPPDATA "Programs\Python") -Directory -ErrorAction SilentlyContinue)) {
      if (Test-Path (Join-Path $d.FullName "python.exe")) { $hayPy = $true }
    }
  }
  if (-not $hayPy) {
    Paso "  Python: no esta, intento instalarlo con winget"
    Progreso "Instalando Python (lo usan los informes). Puede tardar unos minutos..."
    try {
      $wg = Get-Command winget.exe -ErrorAction Stop
      # en otro proceso y esperando con la ventanita viva (si no, Windows la marca "no responde")
      $pw = Start-Process -FilePath $wg.Source -WindowStyle Hidden -PassThru -ArgumentList @(
        "install", "-e", "--id", "Python.Python.3.12", "--scope", "user", "--silent",
        "--accept-package-agreements", "--accept-source-agreements")
      $t0 = Get-Date
      while (-not $pw.HasExited -and ((Get-Date) - $t0).TotalMinutes -lt 15) { Refrescar; Start-Sleep -Milliseconds 200 }
      if (-not $pw.HasExited) { Paso "  Python: winget no termino en 15 minutos" } else { Paso "  Python: winget termino (codigo $($pw.ExitCode))" }
    } catch {
      Paso "  Python: no pude instalarlo solo ($($_.Exception.Message))"
      CerrarProgreso
      Aviso "Lazarillo - falta Python" "Esta PC no tiene Python y no lo pude instalar solo.`n`nInstalalo desde python.org (marcando 'Add python.exe to PATH') y volve a correr INSTALAR EN ESTA PC." 48
    }
  } else { Paso "  Python: ok" }

  # Vincular (ventana). Espera a que la cierren.
  $vinc = Join-Path $destino "_motor\lz_vincular.ps1"
  $archVin = Join-Path $destino "_motor\lz_vinculo.txt"
  # Reinstalar = actualizar (Diego 08/11: "cuando es la misma PC no se da cuenta"): si esta
  # PC ya esta vinculada y la llave sigue valiendo (GET /api/kit/yo), no se abre la ventana.
  # Solo si Lazarillo dice que la llave ya no vale (401: la desvincularon) se vuelve a vincular.
  # Sin conexion no se puede confirmar: se deja como esta (la corrida lo vuelve a intentar).
  # Para pasarla a otro local: C:\Lazarillo\VINCULAR ESTA PC.bat.
  $yaVinculada = $false
  if (Test-Path $archVin) {
    $vUrl = $null; $vLlave = $null
    foreach ($l in (Get-Content $archVin -Encoding UTF8 -ErrorAction SilentlyContinue)) {
      if ($l -match '^\s*url\s*=\s*(\S+)\s*$') { $vUrl = $matches[1].TrimEnd('/') }
      if ($l -match '^\s*llave\s*=\s*(\S+)\s*$') { $vLlave = $matches[1] }
    }
    if ($vUrl -and $vLlave) {
      Progreso "Esta PC ya esta vinculada: lo confirmo con Lazarillo (la primera vez puede tardar un minuto)..."
      try { [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12 } catch { }
      $yaVinculada = $true
      $job = Start-Job -ScriptBlock {
        param($u, $k)
        try { $y = Invoke-RestMethod -Uri ($u + "/api/kit/yo") -Headers @{ Authorization = ("Kit " + $k) } -TimeoutSec 100 -DisableKeepAlive; return ("ok|" + $y.negocio) }
        catch { $sc = 0; try { $sc = [int]$_.Exception.Response.StatusCode } catch { }; return ("error|" + $sc) }
      } -ArgumentList $vUrl, $vLlave
      while ($job.State -eq 'Running') { Refrescar; Start-Sleep -Milliseconds 200 }
      $resp = [string](Receive-Job $job -ErrorAction SilentlyContinue); Remove-Job $job -Force -ErrorAction SilentlyContinue
      if ($resp -like "ok|*") { Paso ("  ya vinculada a " + $resp.Substring(3) + ": no abro la ventana de vincular") }
      elseif ($resp -eq "error|401") { $yaVinculada = $false; Paso "  la vinculacion anterior ya no vale (la cortaron en Lazarillo): abro la ventana" }
      else { Paso ("  no pude confirmar la vinculacion con Lazarillo (" + $resp + "): la dejo como esta") }
    }
  }
  CerrarProgreso
  if ((-not $yaVinculada) -and (Test-Path $vinc)) {
    Paso "  abro la ventana de vincular"
    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $vinc -DesdeInstalador
  }
  $repDir = Join-Path (Join-Path $destino "out") $env:COMPUTERNAME
  New-Item -ItemType Directory -Force -Path $repDir | Out-Null
  if (-not (Test-Path $archVin)) {
    W "  la PC NO quedo vinculada (se cerro la ventana sin vincular)"
    $L | Set-Content -Path (Join-Path $repDir "_instalacion.txt") -Encoding UTF8
    Aviso "Lazarillo" ("El kit quedo instalado pero la PC no esta vinculada.`n`nPara terminar: doble clic en " + (Join-Path $destino "VINCULAR ESTA PC.bat")) 48
    exit 1
  }
  # la PC que arma los maestros lo dice la vinculacion
  $esMae = @(Get-Content $archVin -Encoding UTF8 | Where-Object { $_ -match '^\s*maestros\s*=\s*si\s*$' }).Count -gt 0
  if ($esMae) { Add-Content -Path $dest -Value "maestros = si" -Encoding UTF8 }
  W ("  vinculada" + $(if ($esMae) { " (arma los maestros)" } else { "" }))
  $L | Set-Content -Path (Join-Path $repDir "_instalacion.txt") -Encoding UTF8
  $ps1 = Join-Path $destino "_motor\lz_lazarillo.ps1"
  & powershell.exe -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File $ps1
  exit 0
}

W "INSTALADOR LAZARILLO"
W "equipo  = $env:COMPUTERNAME"
W "usuario = $env:USERNAME"
W "fecha   = $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')"
W "kit origen = $kitDrive"
if ($Probar) { W "MODO PRUEBA: no copio ni instalo nada" }
W ""

# ------------------------------------------------------------
#  1. La carpeta de trabajo de Lazarillo en el Drive.
#
#  Es SIEMPRE la carpeta que contiene a "_KIT Lazarillo", o sea el padre
#  del kit desde donde se esta corriendo este instalador. Se deduce sola,
#  asi que la carpeta se puede renombrar o mover de lugar sin romper nada:
#  alcanza con volver a correr este instalador desde la ubicacion nueva.
#  Ahi adentro van _DATOS y _INFORMES (la maquinaria); los informes
#  terminados van a las carpetas que dice rutas_informes.txt.
# ------------------------------------------------------------
W "== CARPETA DE TRABAJO EN EL DRIVE =="
$driveERP = Split-Path -Parent $kitDrive
if ($driveERP -and (Test-Path $driveERP)) {
  W "  -> $driveERP  (deducida del kit)"
} else {
  # si el kit quedo suelto en la raiz, se busca por nombre como antes
  $driveERP = $null
  $posibles = New-Object System.Collections.ArrayList
  foreach ($d in (Get-PSDrive -PSProvider FileSystem -ErrorAction SilentlyContinue | Where-Object { $_.Used -ne $null })) {
    foreach ($n in @("Mi unidad","My Drive")) {
      $p = Join-Path $d.Root $n
      if (Test-Path $p) { [void]$posibles.Add($p) }
    }
  }
  foreach ($n in @("Google Drive\Mi unidad","Google Drive\My Drive","Google Drive")) {
    $p = Join-Path $env:USERPROFILE $n
    if (Test-Path $p) { [void]$posibles.Add($p) }
  }
  foreach ($p in ($posibles | Select-Object -Unique)) {
    W "  unidad de Drive: $p"
    foreach ($n in @("Lazarillo","Informes ERP")) {
      $try = Join-Path $p $n
      if ((-not $driveERP) -and (Test-Path $try)) { $driveERP = $try }
    }
  }
  if ($driveERP) { W "  -> $driveERP  (encontrada por nombre)" }
  else { W "  -> NO encontre la carpeta de trabajo" }
}
W ""

# ------------------------------------------------------------
#  2. Donde esta el MEGA (la carpeta "Base de datos CONTAINER")
# ------------------------------------------------------------
W "== MEGA =="
$megaRaiz = $null
$raices = @("$env:USERPROFILE\Documents", "$env:USERPROFILE", "C:\", "D:\")
foreach ($r in $raices) {
  if ($megaRaiz) { break }
  if (-not (Test-Path $r)) { continue }
  try {
    $hit = Get-ChildItem -Path $r -Directory -Recurse -Depth 3 -Filter "Base de datos CONTAINER" -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($hit) { $megaRaiz = $hit.FullName }
  } catch { }
}
$megaInformes = @()
if ($megaRaiz) {
  W "  base de datos CONTAINER: $megaRaiz"
  try {
    $megaInformes = @(Get-ChildItem -Path $megaRaiz -Directory -Recurse -Depth 3 -Filter "Informes del Sistema" -ErrorAction SilentlyContinue | ForEach-Object { $_.FullName })
  } catch { }
  if ($megaInformes.Count -eq 0) { W "  (no encontre ninguna carpeta 'Informes del Sistema')" }
  foreach ($m in $megaInformes) { W "  carpeta de informes: $m" }
} else { W "  NO encontre la carpeta 'Base de datos CONTAINER' en esta PC" }
W ""

# ------------------------------------------------------------
#  3. Que base es esta PC (para saber a que carpeta del MEGA va)
# ------------------------------------------------------------
W "== BASE DE ESTA PC =="
$baseNom = $null
foreach ($c in @("C:\MaxiREST_sincronizado","C:\MaxiREST_Admin","C:\maxirest","C:\MaxiRest")) {
  $p = Join-Path $c "DatosMysql.txt"
  if (Test-Path $p) {
    try {
      $ln = @(Get-Content $p -ErrorAction SilentlyContinue | ForEach-Object { $_.Trim() } | Where-Object { $_ -ne "" })
      if ($ln.Count -ge 5) { $baseNom = $ln[3]; W "  base = $baseNom  (de $p)"; break }
    } catch { }
  }
}
if (-not $baseNom) { W "  (no la pude determinar todavia; la resuelve el kit al correr)" }
W ""

# ------------------------------------------------------------
#  3b. A que carpeta del MEGA le toca a esta PC
#      Bar Ramos (mx_14536) -> COMPRAS\RESTO
#      Canchas (Ramos y San Justo) -> COMPRAS\CANCHAS (comparten carpeta;
#      los archivos se distinguen por el sufijo RAMOS / SJ en el nombre)
#      BALANCE nunca es destino de un punto de venta.
# ------------------------------------------------------------
W "== CARPETA DEL MEGA PARA ESTA PC =="
$megaElegido = $null
$quiere = if ($baseNom -eq "mx_14536") { "\RESTO\" } else { "\CANCHAS\" }
foreach ($m in $megaInformes) { if ((-not $megaElegido) -and ($m -like "*$quiere*")) { $megaElegido = $m } }
if ($megaElegido) { W "  elegida ($quiere) -> $megaElegido" }
elseif ($megaInformes.Count -gt 0) { W "  NO pude elegir sola. Opciones encontradas abajo; hay que fijarla a mano en destinos.txt" }
else { W "  (no hay carpetas de informes para elegir)" }
W ""

# ------------------------------------------------------------
#  3c. Quien genera los MAESTROS de esta organizacion.
#  Diego (24/09) pidio que el instalador PREGUNTE: en Container los maestros
#  salen del ADMIN; en Comercio (Nuñez), que no tiene admin, del propio PDV.
#  Si esta PC ya tenia maestros=si en un destinos.txt anterior, se respeta.
# ------------------------------------------------------------
W "== MAESTROS =="
$esMaestro = $false
$maestrosDrive = $null
# 1) respetar lo que ya estaba configurado (para re-instalaciones y modo -SinAviso)
$destinosViejo = Join-Path $destino "_motor\destinos.txt"
if (Test-Path $destinosViejo) {
  try {
    $mv = Get-Content $destinosViejo -ErrorAction SilentlyContinue | Where-Object { $_ -match '^\s*maestros\s*=' }
    if ($mv -and ($mv -match '=\s*(?i:si|s|1|true)\s*$')) { $esMaestro = $true }
  } catch { }
}
# 2) si no, preguntar (salvo modo silencioso)
if ((-not $esMaestro) -and (-not $SinAviso)) {
  try {
    $r = (New-Object -ComObject WScript.Shell).Popup(
      ("Los MAESTROS (proveedores, articulos, rubros, conceptos de caja) de esta organizacion:" + "`n`n" +
       "   SI = los genera ESTA PC (es la PC maestra)" + "`n" +
       "   NO = los trae el ADMIN (esta PC no los genera)" + "`n`n" +
       "Si esta es la PC del punto de venta de Comercio / Nuñez o de MigaGO, la respuesta es SI."),
      0, "Lazarillo - Maestros", (4 + 32))   # 4 = botones Si/No, 32 = icono de pregunta
    if ($r -eq 6) { $esMaestro = $true }
  } catch { }
}
if ($esMaestro) {
  # carpeta de Maestros en el Drive. En Comercio es "Maestros COMERCIO";
  # en Container (el admin) es "Maestros" a secas. Cuelgan de "Informes ERP",
  # que es hermana de la carpeta Lazarillo bajo "Mi unidad".
  #  MigaGO (22/10): con mas de una organizacion con maestros propios ya no se
  #  puede elegir "la primera que exista" (MigaGO caia en Maestros COMERCIO).
  #  Orden: 1) la que ya tenia esta PC en su destinos.txt; 2) si hay una sola
  #  carpeta "Maestros*", esa; 3) si hay varias, se PREGUNTA cual (numero).
  $miUnidad = if ($driveERP) { Split-Path -Parent $driveERP } else { $null }
  if ((Test-Path $destinosViejo)) {
    try {
      $mdv = Get-Content $destinosViejo -ErrorAction SilentlyContinue | Where-Object { $_ -match '^\s*maestros_drive\s*=' } | Select-Object -First 1
      if ($mdv) { $v = ($mdv -split '=', 2)[1].Trim(); if ($v -and (Test-Path $v)) { $maestrosDrive = $v; W "  (se respeta la de la instalacion anterior)" } }
    } catch { }
  }
  if ((-not $maestrosDrive) -and $miUnidad) {
    $erp = Join-Path $miUnidad "Informes ERP"
    $cands = @(Get-ChildItem -LiteralPath $erp -Directory -ErrorAction SilentlyContinue | Where-Object { $_.Name -like "Maestros*" } | Sort-Object Name | ForEach-Object { $_.FullName })
    if ($cands.Count -eq 1) { $maestrosDrive = $cands[0] }
    elseif ($cands.Count -gt 1) {
      if ($SinAviso) { W "  hay varias carpetas de Maestros y estoy en modo silencioso: no elijo ninguna" }
      else {
        $txt = "De que ORGANIZACION son los maestros de esta PC?" + "`n`n"
        for ($i = 0; $i -lt $cands.Count; $i++) {
          $nn = Split-Path -Leaf $cands[$i]
          $acl = if ($nn -eq "Maestros") { "   (Container - la usa el ADMIN)" } else { "" }
          $txt += "   " + ($i + 1) + " = " + $nn + $acl + "`n"
        }
        $txt += "`n" + "Escribi el numero y Aceptar."
        try {
          Add-Type -AssemblyName Microsoft.VisualBasic
          $resp = [Microsoft.VisualBasic.Interaction]::InputBox($txt, "Lazarillo - Maestros", "")
          $num = 0
          if ([int]::TryParse(("" + $resp).Trim(), [ref]$num) -and $num -ge 1 -and $num -le $cands.Count) { $maestrosDrive = $cands[$num - 1] }
          else { W "  respuesta '$resp' no valida: no elijo ninguna" }
        } catch { W "  no pude preguntar la carpeta de Maestros: $($_.Exception.Message)" }
      }
    }
  }
  W "  esta PC ES la fuente de maestros"
  if ($maestrosDrive) { W "  maestros_drive = $maestrosDrive" }
  else { W "  (no encontre la carpeta de Maestros en el Drive; ponerla a mano en destinos.txt)" }
} else {
  W "  los maestros los trae el admin (esta PC no los genera)"
}
W ""

# ------------------------------------------------------------
#  4. Copiar el kit e instalar
# ------------------------------------------------------------
W "== INSTALACION =="
W "  destino = $destino"
if ($Probar) {
  W "  (modo prueba: no copio)"
  W ""
  W "Lo que HARIA:"
  W "  copiar  $kitDrive\*  ->  $destino"
  W "  datos al Drive ->  $driveERP\_DATOS\<base> - $env:COMPUTERNAME"
  W "  informes del Drive -> $driveERP\_INFORMES\$env:COMPUTERNAME"
  if ($megaElegido) { W "  y de ahi al MEGA -> $megaElegido" }
} else {
  try {
    New-Item -ItemType Directory -Force -Path $destino | Out-Null
    New-Item -ItemType Directory -Force -Path (Join-Path $destino "_motor") | Out-Null
    Copy-Item -Path (Join-Path $kitDrive "LAZARILLO.bat") -Destination $destino -Force -ErrorAction SilentlyContinue
    Copy-Item -Path (Join-Path $kitDrive "LEEME.txt")     -Destination $destino -Force -ErrorAction SilentlyContinue
    Copy-Item -Path (Join-Path $origen "*") -Destination (Join-Path $destino "_motor") -Recurse -Force -ErrorAction SilentlyContinue
    W "  kit copiado"
  } catch {
    W "  ERROR copiando el kit: $($_.Exception.Message)"
  }

  # destinos.txt: lo lee el kit para saber a donde mandar las cosas
  $cfg = New-Object System.Collections.ArrayList
  [void]$cfg.Add("# Rutas de esta PC. Las escribio el instalador; se pueden corregir a mano.")
  [void]$cfg.Add("kit_drive      = $kitDrive")
  if ($driveERP) {
    [void]$cfg.Add("datos_drive    = $driveERP\_DATOS")
    [void]$cfg.Add("informes_drive = $driveERP\_INFORMES\$env:COMPUTERNAME")
  }
  if ($megaElegido) { [void]$cfg.Add("mega_informes  = $megaElegido") }
  if ($esMaestro) {
    [void]$cfg.Add("maestros       = si")
    if ($maestrosDrive) { [void]$cfg.Add("maestros_drive = $maestrosDrive") }
    if ($megaElegido)   { [void]$cfg.Add("maestros_informes = $megaElegido") }
  }
  foreach ($m in $megaInformes) { [void]$cfg.Add("# opcion MEGA: $m") }
  $cfg | Set-Content -Path (Join-Path $destino "_motor\destinos.txt") -Encoding UTF8
  W "  destinos.txt escrito"
}

# ------------------------------------------------------------
#  5. Dejar el informe y arrancar el kit
# ------------------------------------------------------------
$repDir = Join-Path (Join-Path $(if ($Probar) { $kitDrive } else { $destino }) "out") $env:COMPUTERNAME
New-Item -ItemType Directory -Force -Path $repDir | Out-Null
$L | Set-Content -Path (Join-Path $repDir "_instalacion.txt") -Encoding UTF8

if ($Probar) {
  Aviso "Lazarillo - prueba de instalacion" ("No instale nada (modo prueba).`n`nEl informe quedo en:`n" + (Join-Path $repDir "_instalacion.txt")) 64
  exit 0
}

$ps1 = Join-Path $destino "_motor\lz_lazarillo.ps1"
if (Test-Path $ps1) {
  & powershell.exe -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File $ps1
} else {
  Aviso "Lazarillo - error" "Copie el kit pero no encuentro lz_lazarillo.ps1 en $destino\_motor" 16
  exit 1
}
