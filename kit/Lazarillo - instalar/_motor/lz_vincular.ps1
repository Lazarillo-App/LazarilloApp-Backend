# ============================================================
#  LAZARILLO - VINCULAR ESTA PC (Diego, 07-08/11/2026)
#
#  Una sola vez por PC: entrás con tu usuario de Lazarillo (dueño o administrador),
#  elegís qué local es esta PC y listo. La PC queda con SU llave en
#  _motor\lz_vinculo.txt y desde ahí el kit sube los datos por Lazarillo: sin Drive y
#  sin la clave de la base en la PC.
#    - La contraseña NO se guarda: se usa para pedir la llave y se olvida.
#    - Un local que ya tiene PC se ve en gris; tomarlo es "Reemplazar esa PC..." (corta
#      la llave de la otra).
#    - Si esta misma PC ya estaba vinculada, la vuelve a vincular sin duplicar.
#    - Se desvincula desde la app: Configuración > Conexiones.
#  Sistema: solo MaxiRest por ahora.
# ============================================================
param([switch]$SoloFunciones)

$ErrorActionPreference = 'Stop'
$aqui = Split-Path -Parent $MyInvocation.MyCommand.Path
if ((Split-Path -Leaf $aqui) -eq "_motor") { $motor = $aqui } else { $motor = Join-Path $aqui "_motor" }
$archivoVinculo = Join-Path $motor "lz_vinculo.txt"
$API_POR_DEFECTO = "https://lazarillo-backend-testing.onrender.com"

function Leer-Api {
  $f = Join-Path $motor "lz_api.txt"
  if (Test-Path $f) {
    foreach ($l in (Get-Content $f -Encoding UTF8 -ErrorAction SilentlyContinue)) {
      $t = $l.Trim()
      if ($t -match '^https?://') { return $t.TrimEnd('/') }
    }
  }
  return $API_POR_DEFECTO
}

# Huella de la PC: sha256 del MachineGuid de Windows (no se manda el dato crudo). Sirve para
# reconocer la misma PC si se reinstala.
function Huella-Pc {
  $g = $null
  try { $g = (Get-ItemProperty -Path 'HKLM:\SOFTWARE\Microsoft\Cryptography' -Name MachineGuid -ErrorAction Stop).MachineGuid } catch { }
  if (-not $g) { $g = "$env:COMPUTERNAME|$env:USERNAME" }
  $sha = [System.Security.Cryptography.SHA256]::Create()
  $b = $sha.ComputeHash([System.Text.Encoding]::UTF8.GetBytes([string]$g))
  return -join ($b | ForEach-Object { $_.ToString('x2') })
}

# POST con JSON. Devuelve @{ Status; Datos } sin tirar excepción en 4xx/5xx.
function Api-Post($url, $ruta, $cuerpo) {
  try { [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12 } catch { }
  $json = $cuerpo | ConvertTo-Json -Depth 6 -Compress
  $bytes = [System.Text.Encoding]::UTF8.GetBytes($json)
  $req = [System.Net.HttpWebRequest]::Create($url + $ruta)
  $req.Method = 'POST'
  $req.ContentType = 'application/json; charset=utf-8'
  $req.UserAgent = 'lazarillo-kit-instalador'
  $req.Timeout = 120000
  $req.ReadWriteTimeout = 120000
  $req.ContentLength = $bytes.Length
  try {
    $s = $req.GetRequestStream(); $s.Write($bytes, 0, $bytes.Length); $s.Close()
    $resp = $req.GetResponse()
  } catch [System.Net.WebException] {
    $resp = $_.Exception.Response
    if (-not $resp) { return @{ Status = 0; Datos = $null; Error = $_.Exception.Message } }
  }
  $code = [int]$resp.StatusCode
  $rd = New-Object System.IO.StreamReader($resp.GetResponseStream(), [System.Text.Encoding]::UTF8)
  $txt = $rd.ReadToEnd(); $rd.Close(); $resp.Close()
  $datos = $null
  try { if ($txt) { $datos = $txt | ConvertFrom-Json } } catch { }
  return @{ Status = $code; Datos = $datos; Error = $null }
}

function Mensaje-Error($r) {
  if ($r.Status -eq 0) { return "No hay conexión con Lazarillo. Revisá internet y probá de nuevo.`n(" + $r.Error + ")" }
  if ($r.Status -eq 401) { return "Usuario o contraseña incorrectos." }
  if ($r.Status -eq 429) { return "Demasiados intentos. Esperá 15 minutos y probá de nuevo." }
  if ($r.Status -eq 403) { return "Tu usuario no es dueño ni administrador de ese local." }
  $e = ""
  if ($r.Datos -and $r.Datos.error) { $e = [string]$r.Datos.error }
  return ("Lazarillo respondió " + $r.Status + " " + $e).Trim()
}

function Pedir-Locales($url, $email, $clave) {
  return Api-Post $url "/api/kit/locales" @{ email = $email; password = $clave }
}

function Pedir-Vinculo($url, $email, $clave, $local, $maestros, $reemplazar) {
  $cuerpo = @{ email = $email; password = $clave; businessId = $local.businessId; branchId = $local.branchId
               pc = $env:COMPUTERNAME; huella = (Huella-Pc); maestros = [bool]$maestros; reemplazar = [bool]$reemplazar }
  return Api-Post $url "/api/kit/vincular" $cuerpo
}

# Escribe _motor\lz_vinculo.txt (lo lee gen\lz_render.py) y lo deja legible solo para este
# usuario, SYSTEM y los administradores.
function Guardar-Vinculo($url, $d) {
  $lineas = @(
    "# Lazarillo - esta PC esta vinculada. No compartir este archivo: tiene la llave de la PC.",
    "# Para cortarla: Lazarillo > Configuracion > Conexiones > Desvincular.",
    ("url = " + $url),
    ("llave = " + $d.llave),
    ("pc = " + $env:COMPUTERNAME),
    ("negocio = " + $d.negocio),
    ("sucursal = " + $(if ($d.sucursal) { $d.sucursal } else { "" })),
    ("esquema = " + $d.esquema),
    ("pdv = " + $d.pdv),
    ("maestros = " + $(if ($d.maestros) { "si" } else { "no" })),
    ("vinculada = " + (Get-Date -Format 'yyyy-MM-dd HH:mm'))
  )
  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $archivoVinculo) | Out-Null
  $tmp = $archivoVinculo + ".nuevo"
  [System.IO.File]::WriteAllLines($tmp, [string[]]$lineas, (New-Object System.Text.UTF8Encoding($false)))
  Move-Item -LiteralPath $tmp -Destination $archivoVinculo -Force
  try {
    if ($env:OS -eq 'Windows_NT') {
      & icacls.exe $archivoVinculo /inheritance:r /grant:r ("{0}:(M)" -f $env:USERNAME) "*S-1-5-18:(F)" "*S-1-5-32-544:(F)" | Out-Null
    }
  } catch { }
}

function Nombre-Local($l) {
  if ($l.sucursal) { return ($l.nombre + " · " + $l.sucursal) }
  return [string]$l.nombre
}

if ($SoloFunciones) { return }

# La llave va SOLO en el kit instalado de esta PC (C:\Lazarillo\_motor), nunca en el kit del
# Drive: desde ahi viajaria a todas las PC. El kit del Drive no tiene destinos.txt.
if (-not (Test-Path (Join-Path $motor "destinos.txt"))) {
  if (Test-Path "C:\Lazarillo\_motor\destinos.txt") {
    $motor = "C:\Lazarillo\_motor"; $archivoVinculo = Join-Path $motor "lz_vinculo.txt"
  } else {
    Add-Type -AssemblyName System.Windows.Forms
    [void][System.Windows.Forms.MessageBox]::Show("Primero hay que instalar el kit en esta PC (INSTALAR EN ESTA PC.bat). Después se vincula.", "Lazarillo", 'OK', 'Information')
    exit 1
  }
}

# ============================================================ ventana
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
[System.Windows.Forms.Application]::EnableVisualStyles()

$url = Leer-Api
$celeste = [System.Drawing.Color]::FromArgb(36, 146, 200)
$tinta = [System.Drawing.Color]::FromArgb(22, 50, 74)
$gris = [System.Drawing.Color]::FromArgb(107, 124, 140)
$fuente = New-Object System.Drawing.Font("Segoe UI", 10)
$fuenteTit = New-Object System.Drawing.Font("Segoe UI Semibold", 13)

$form = New-Object System.Windows.Forms.Form
$form.Text = "Lazarillo - Vincular esta PC"
$form.StartPosition = 'CenterScreen'
$form.FormBorderStyle = 'FixedDialog'
$form.MaximizeBox = $false
$form.ClientSize = New-Object System.Drawing.Size(440, 470)
$form.BackColor = [System.Drawing.Color]::White
$form.Font = $fuente

function Nuevo($tipo, $x, $y, $w, $h, $texto) {
  $c = New-Object ("System.Windows.Forms." + $tipo)
  $c.Location = New-Object System.Drawing.Point($x, $y)
  $c.Size = New-Object System.Drawing.Size($w, $h)
  if ($texto) { $c.Text = $texto }
  return $c
}
function Boton($x, $y, $w, $texto) {
  $b = Nuevo "Button" $x $y $w 36 $texto
  $b.FlatStyle = 'Flat'; $b.FlatAppearance.BorderSize = 0
  $b.BackColor = $celeste; $b.ForeColor = [System.Drawing.Color]::White
  $b.Font = New-Object System.Drawing.Font("Segoe UI Semibold", 10)
  return $b
}

$paso = Nuevo "Label" 24 18 392 20 "1 · ENTRAR"; $paso.ForeColor = $gris
$tit = Nuevo "Label" 24 40 392 30 "Vincular esta PC a Lazarillo"; $tit.Font = $fuenteTit; $tit.ForeColor = $tinta
$form.Controls.AddRange(@($paso, $tit))

# --- paso 1
$p1 = New-Object System.Windows.Forms.Panel; $p1.Location = New-Object System.Drawing.Point(0, 80); $p1.Size = New-Object System.Drawing.Size(440, 390)
$lEmail = Nuevo "Label" 24 4 392 20 "Usuario (email) de Lazarillo"
$tEmail = Nuevo "TextBox" 24 26 392 28 ""
$lClave = Nuevo "Label" 24 64 392 20 "Contraseña"
$tClave = Nuevo "TextBox" 24 86 392 28 ""; $tClave.UseSystemPasswordChar = $true
$bEntrar = Boton 24 128 392 "Entrar"
$nota1 = Nuevo "Label" 24 176 392 60 "Solo dueño o administrador del negocio. La contraseña no queda guardada en esta PC."; $nota1.ForeColor = $gris
$err1 = Nuevo "Label" 24 240 392 60 ""; $err1.ForeColor = [System.Drawing.Color]::FromArgb(220, 38, 38)
$p1.Controls.AddRange(@($lEmail, $tEmail, $lClave, $tClave, $bEntrar, $nota1, $err1))
$form.Controls.Add($p1)
$form.AcceptButton = $bEntrar

# --- paso 2
$p2 = New-Object System.Windows.Forms.Panel; $p2.Location = New-Object System.Drawing.Point(0, 80); $p2.Size = New-Object System.Drawing.Size(440, 390); $p2.Visible = $false
$lista = New-Object System.Windows.Forms.FlowLayoutPanel
$lista.Location = New-Object System.Drawing.Point(24, 4); $lista.Size = New-Object System.Drawing.Size(392, 230)
$lista.FlowDirection = 'TopDown'; $lista.WrapContents = $false; $lista.AutoScroll = $true
$chkMae = Nuevo "CheckBox" 24 244 392 24 "Esta PC arma los maestros de la organización"; $chkMae.Checked = $true
$bVincular = Boton 24 280 392 "Vincular"; $bVincular.Enabled = $false
$err2 = Nuevo "Label" 24 324 392 56 ""; $err2.ForeColor = [System.Drawing.Color]::FromArgb(220, 38, 38)
$p2.Controls.AddRange(@($lista, $chkMae, $bVincular, $err2))
$form.Controls.Add($p2)

# --- paso 3
$p3 = New-Object System.Windows.Forms.Panel; $p3.Location = New-Object System.Drawing.Point(0, 80); $p3.Size = New-Object System.Drawing.Size(440, 390); $p3.Visible = $false
$ok3 = Nuevo "Label" 24 4 392 56 ""; $ok3.Font = $fuenteTit; $ok3.ForeColor = [System.Drawing.Color]::FromArgb(5, 150, 105)
$nota3 = Nuevo "Label" 24 64 392 150 ""; $nota3.ForeColor = $gris
$bCerrar = Boton 24 228 392 "Cerrar"
$p3.Controls.AddRange(@($ok3, $nota3, $bCerrar))
$form.Controls.Add($p3)

$script:elegido = $null
$script:reemplazar = $false
$script:email = ""
$script:clave = ""

$bEntrar.Add_Click({
  $err1.Text = ""
  if (-not $tEmail.Text.Trim() -or -not $tClave.Text) { $err1.Text = "Completá usuario y contraseña."; return }
  $form.Cursor = 'WaitCursor'; $bEntrar.Enabled = $false; $bEntrar.Text = "Entrando... (la primera vez puede tardar un minuto)"
  [System.Windows.Forms.Application]::DoEvents()
  $r = Pedir-Locales $url $tEmail.Text.Trim() $tClave.Text
  $form.Cursor = 'Default'; $bEntrar.Enabled = $true; $bEntrar.Text = "Entrar"
  if ($r.Status -ne 200) { $err1.Text = Mensaje-Error $r; return }
  $locales = @($r.Datos.locales)
  if ($locales.Count -eq 0) { $err1.Text = "Tu usuario no es dueño ni administrador de ningún negocio."; return }
  $script:email = $tEmail.Text.Trim(); $script:clave = $tClave.Text
  $lista.Controls.Clear()
  foreach ($l in $locales) {
    $item = New-Object System.Windows.Forms.Panel; $item.Size = New-Object System.Drawing.Size(366, 58); $item.Margin = New-Object System.Windows.Forms.Padding(0, 0, 0, 6)
    $rb = Nuevo "RadioButton" 6 4 354 24 (Nombre-Local $l); $rb.Tag = $l
    $det = Nuevo "Label" 24 28 336 20 ""; $det.ForeColor = $gris
    if ($l.ocupado) {
      $rb.Enabled = $false
      $det.Text = "ya tiene PC: " + $l.ocupado.pc
      $lk = New-Object System.Windows.Forms.LinkLabel; $lk.Text = "Reemplazar esa PC..."; $lk.Location = New-Object System.Drawing.Point(200, 28); $lk.Size = New-Object System.Drawing.Size(160, 20); $lk.Tag = $rb
      $lk.Add_LinkClicked({
        param($s, $e)
        $rbx = $s.Tag; $lx = $rbx.Tag
        $q = [System.Windows.Forms.MessageBox]::Show(("" + (Nombre-Local $lx) + " ya sube los datos desde " + $lx.ocupado.pc + ".`n`nSi seguís, esa PC deja de subir y esta pasa a ser la del local. ¿Reemplazarla?"), "Reemplazar PC", 'YesNo', 'Warning')
        if ($q -eq 'Yes') { $rbx.Enabled = $true; $rbx.Checked = $true; $script:reemplazar = $true }
      })
      $item.Controls.Add($lk)
    } else {
      $det.Text = "MaxiRest · sin PC"
    }
    $rb.Add_CheckedChanged({
      param($s, $e)
      if ($s.Checked) {
        $script:elegido = $s.Tag
        if (-not $s.Tag.ocupado) { $script:reemplazar = $false }
        $bVincular.Enabled = $true
      }
    })
    $item.Controls.AddRange(@($rb, $det))
    $lista.Controls.Add($item)
  }
  $p1.Visible = $false; $p2.Visible = $true; $paso.Text = "2 · ¿QUÉ LOCAL ES ESTA PC?"; $tit.Text = "Elegí el local"
  $form.AcceptButton = $bVincular
})

$bVincular.Add_Click({
  $err2.Text = ""
  if (-not $script:elegido) { return }
  $form.Cursor = 'WaitCursor'; $bVincular.Enabled = $false; $bVincular.Text = "Vinculando..."
  [System.Windows.Forms.Application]::DoEvents()
  $r = Pedir-Vinculo $url $script:email $script:clave $script:elegido $chkMae.Checked $script:reemplazar
  $form.Cursor = 'Default'; $bVincular.Enabled = $true; $bVincular.Text = "Vincular"
  if ($r.Status -eq 409) {
    $pcOtra = ""
    if ($r.Datos.ocupado -and $r.Datos.ocupado.pc) { $pcOtra = " (" + $r.Datos.ocupado.pc + ")" }
    $err2.Text = "Ese local ya tiene otra PC" + $pcOtra + ". Usá 'Reemplazar esa PC...' si querés pasarlo a esta."
    return
  }
  if ($r.Status -ne 201) { $err2.Text = Mensaje-Error $r; return }
  try { Guardar-Vinculo $url $r.Datos } catch { $err2.Text = "Se vinculó pero no pude guardar la llave en esta PC: " + $_.Exception.Message; return }
  $script:clave = ""; $tClave.Text = ""
  $ok3.Text = "✓ PC vinculada a " + (Nombre-Local @{ nombre = $r.Datos.negocio; sucursal = $r.Datos.sucursal })
  $t = "Desde ahora el kit sube los datos de este local por Lazarillo, sin Drive. Corre solo a las 08:00 y al prender."
  if ($r.Datos.maestros) { $t += "`n`nEsta PC también arma los maestros." }
  elseif ($r.Datos.avisoMaestros) { $t += "`n`n" + $r.Datos.avisoMaestros + "." }
  if ($r.Datos.reemplazo) { $t += "`n`nReemplazó a " + $r.Datos.reemplazo + ", que ya no sube datos." }
  $t += "`n`nLa contraseña no quedó guardada. Para cortar esta PC: Lazarillo > Configuración > Conexiones."
  $nota3.Text = $t
  $p2.Visible = $false; $p3.Visible = $true; $paso.Text = "3 · LISTO"; $tit.Text = "Listo"
  $form.AcceptButton = $bCerrar
})

$bCerrar.Add_Click({ $form.Close() })

if (Test-Path $archivoVinculo) {
  $ya = (Get-Content $archivoVinculo -Encoding UTF8 | Where-Object { $_ -match '^negocio\s*=' }) -replace '^negocio\s*=\s*', ''
  if ($ya) { $nota1.Text = "Esta PC ya está vinculada a " + $ya + ". Si seguís, se vuelve a vincular (sin duplicar)." }
}

[void]$form.ShowDialog()
