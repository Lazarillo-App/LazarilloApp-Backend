# -*- coding: utf-8 -*-
"""
Lazarillo - genera de una sola vez todos los informes de un PDV.

    python lz_informes.py <carpeta _DATOS del PDV> <carpeta de salida> [año]

Deja dos subcarpetas listas para copiar:
    <salida>/mega/    nombres tal cual los usa MaxiRest (van al MEGA)
    <salida>/drive/   nombres con _<año> V7 (van al Drive, por año)
y un _informes.txt con el resultado de cada uno.

Los generadores viven al lado de este archivo (gen03, gen04, ...).
"""
import sys, os, shutil, traceback, datetime as dt

AQUI = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, AQUI)


# 07/11/2026 (Diego: "un caracter no puede jugarnos en contra"). MaxiRest a veces
# guarda caracteres de control en textos libres (un telefono de Canchas Ramos
# traia un 0x02) y openpyxl, en vez de escribir la celda, corta el informe
# entero (IllegalCharacterError). Red para TODOS los generadores de este
# proceso: el caracter se saca y el informe sale igual.
def _texto_seguro():
    try:
        from openpyxl.cell import cell as _celda
        if getattr(_celda.Cell, '_lz_seguro', False):
            return
        _orig = _celda.Cell.check_string
        _ilegal = _celda.ILLEGAL_CHARACTERS_RE

        def check_string(self, value):
            if isinstance(value, str):
                value = _ilegal.sub('', value)
            return _orig(self, value)
        _celda.Cell.check_string = check_string
        _celda.Cell._lz_seguro = True
    except Exception:
        pass


_texto_seguro()

# OJO (Diego, 12/10): antes acá se importaban TODOS los generadores juntos
# (gen03, gen04, ..., gen80, gen70, gen71) arriba del archivo. El problema:
# si a UN PC le falta o le quedó a medio sincronizar UN SOLO gen*.py (pasó
# con gen25 el 12/10, justo al desplegar el cambio de columnas), el import
# de arriba explota y se cae la generación de los 14 informes, no solo el
# que tenía el problema. Ahora cada informe importa su propio módulo recién
# cuando le toca generarse, adentro de _generar(): si falta uno, el
# try/except de main() lo loguea como ERROR de ESE informe nomás y los
# demás se generan igual.

# nombre en el MEGA, carpeta del Drive, nombre en el Drive (sin el año)
# OJO (Diego, 24/09): en el Drive, dentro de Transaccionales\<PDV>, van SOLO
# las carpetas originales: Ventas (22), Compras (14) y Detalle Compras (25)
# (y el 80 en San Justo, que todavia no generamos). Todo el resto va SOLO al
# MEGA. Las carpetas "Compras por Insumo (11)", "Ranking por Dia (12)" y
# "Mov de Stock (27-28)" que se habian creado en el Drive hay que sacarlas.
INFORMES = [
    ('22', '22 - ventas detalladas.xls',                                 'Ventas (22)',          '22 - ventas detalladas'),
    ('14', '14 - gastos compras detallado.xls',                          'Compras (14)',         '14 - GASTOS COMPRAS DETALLADO'),
    ('25', '25 - compras detalle de compras.xls',                        'Detalle Compras (25)', '25 - compras detalle de compras'),
    # el 80 va SOLO al Drive: en el MEGA no hay ninguno, no le meto un
    # archivo que Diego no puso ahi (nom_mega = None).
    ('80', None,                                                          'Fecha de pagos (80)',  '80 - COMPRAS - DETALLE DE PAGOS PAGOS'),
    # anuales que van SOLO al MEGA
    ('11',    '11 - COMPRAS POR INSUMO ANUAL.XLSX',                       None, None),
    ('12',    '12 - ventas por articulo ranking detallado por dia.xls',   None, None),
    # 12PRO: pedido de Diego (08/10/2026) - el 12 (mismas columnas) + lo que
    # el 27 ve como SALIDA de stock que el 12 no ve. Anual, SOLO AL MEGA,
    # igual que el 12. Logica en gen12pro.py.
    ('12PRO', '12PRO - ventas por articulo ranking detallado por dia.xls',None, None),
    ('12M','12M - VENTAS POR ARTICULO RANKING DETALLADO POR DIA.XLSX',    None, None),
    ('12N','12N - VENTAS POR ARTICULO RANKING DETALLADO POR DIA.xls',     None, None),
    ('27', '27 - MOV DE STOCK ANUAL - Detallado por remito.xls',          None, None),
    ('28', '28 - MOV DE STOCK ANUAL - RESUMIDO POR REMITO.XLSX',          None, None),
    # semanales: no llevan año, van solo al MEGA
    ('3',  '3 - Compras por Insumo ultima semana (L a D).xls',  None, None),
    ('4',  '4 - Ventas resumidas ultima semana (L a D).xls',    None, None),
    ('5',  '5 - ventas por insumo (l a d).xls',                 None, None),
    ('9',  '9 - ventas por articulo ranking (l a d).xls',       None, None),
    ('71', '71 - CTA POR COMPROBANTE.XLSX',     None, None),
]

# EXTRAS: solo los PDV que los piden en el 8vo campo de rutas_informes.txt
# (hoy San Justo: "70,71"). Van solo al MEGA, con el sufijo del PDV, y son
# acumulativos (todo el historico). Diego, 25/09: "terminalo" (071).
# 15/10: el 71 (cta por comprobante) pasa a INFORMES (se baja en TODOS los
# PDV, pedido explicito de Diego 15/10); aca queda solo el 70.
EXTRAS = [
    ('70', '70 - DETALLE DE PAGOS SALDos.XLSX', None, None),
]

# Semanales que, si la semana vino vacia, NO se bajan (Diego, 25/09: "que no
# se baje"). Mejor no tener el archivo que tener uno vacio o un error.
SEMANALES_SIN_VACIOS = ('3', '5', '9')

# Generadores que faltan en ESTA PC (Diego, 06/11/2026). Pasó en Canchas Ramos desde el
# 23/10: "No module named 'gen14'" todos los días, y el 14 de esa PC dejó de llegar a
# Render, al Drive y al MEGA. Cuando se reemplaza un .py en el Drive creando uno nuevo,
# Drive para escritorio a veces lo baja como "gen14 (1).py" y el import no lo encuentra.
# _gen(): importa normal; si no está, busca "<nombre> (N).py" acá y en el kit del Drive,
# lo copia como "<nombre>.py" y lo usa. Si no aparece en ningún lado, deja en el log qué
# generadores hay en cada lugar para poder diagnosticarlo desde el control diario.
def _kit_gen_drive():
    try:
        with open(os.path.join(os.path.dirname(AQUI), 'destinos.txt'), encoding='utf-8-sig', errors='replace') as f:
            for l in f:
                if '=' in l:
                    k, v = l.split('=', 1)
                    if k.strip() == 'kit_drive':
                        return os.path.join(v.strip().rstrip('\\/'), '_motor', 'gen')
    except Exception:
        pass
    return None


def _gen(nombre):
    import importlib, importlib.util, glob, re as _re
    try:
        return importlib.import_module(nombre)
    except ModuleNotFoundError as e:
        if getattr(e, 'name', nombre) != nombre:
            raise
    lugares = [AQUI] + [d for d in [_kit_gen_drive()] if d and os.path.isdir(d)]
    patron = _re.compile(r'^' + _re.escape(nombre) + r' \(\d+\)\.py$', _re.I)
    candidatos = []
    for d in lugares:
        exacto = os.path.join(d, nombre + '.py')
        if d != AQUI and os.path.isfile(exacto):
            candidatos.append(exacto)
        for f in glob.glob(os.path.join(d, nombre + '*.py')):
            if patron.match(os.path.basename(f)):
                candidatos.append(f)
    if candidatos:
        origen = max(candidatos, key=os.path.getmtime)
        destino = os.path.join(AQUI, nombre + '.py')
        try:
            shutil.copy2(origen, destino)
            print('  AVISO falta %s.py en esta PC: lo traje de "%s"' % (nombre, origen))
            importlib.invalidate_caches()
            return importlib.import_module(nombre)
        except Exception as e2:
            print('  AVISO no pude copiar "%s" como %s.py (%s): lo cargo directo' % (origen, nombre, e2))
            spec = importlib.util.spec_from_file_location(nombre, origen)
            mod = importlib.util.module_from_spec(spec)
            sys.modules[nombre] = mod
            spec.loader.exec_module(mod)
            return mod
    for d in lugares:
        try:
            hay = sorted(x for x in os.listdir(d) if x.lower().startswith('gen') and x.lower().endswith('.py'))
        except Exception as e3:
            hay = ['(no pude listar: %s)' % e3]
        print('  DIAG %s no está. Generadores en %s: %s' % (nombre, d, ', '.join(hay) or '(ninguno)'))
    raise ModuleNotFoundError("No module named '%s'" % nombre, name=nombre)

def _generar(cod, B, destino, anio):
    if cod == '22':
        import inf22_pdv, esc22
        inf22_pdv.base(B)
        df = inf22_pdv.generar('0', desde=f"{anio}-01-01", hasta=f"{anio}-12-31")
        esc22.escribir(df, destino); return len(df)
    if cod == '14':
        gen14 = _gen('gen14')
        return len(gen14.generar_14(B, anio, destino))
    if cod == '25':
        gen25 = _gen('gen25')
        return len(gen25.generar_25(B, anio, destino))
    if cod == '80':
        gen80 = _gen('gen80')
        return len(gen80.generar_80(B, anio, destino))
    if cod == '11':
        gen11 = _gen('gen11')
        return len(gen11.generar_11(B, anio, destino))
    if cod in ('12','12M','12N'):
        gen12 = _gen('gen12')
        return len(gen12.generar_12(B, anio, salida=destino, variante=cod))
    if cod == '12PRO':
        gen12pro = _gen('gen12pro')
        return len(gen12pro.generar_12pro(B, anio, destino))
    if cod == '27':
        gen27 = _gen('gen27')
        return len(gen27.generar_27(B, anio, destino))
    if cod == '28':
        gen27 = _gen('gen27')
        return len(gen27.generar_28(B, anio, destino))
    if cod == '3':
        gen03 = _gen('gen03')
        return len(gen03.generar_03(B, salida=destino))
    if cod == '4':
        gen04 = _gen('gen04')
        return len(gen04.generar_04(B, salida=destino))
    if cod == '5':
        gen05 = _gen('gen05')
        return len(gen05.generar_05(B, salida=destino))
    if cod == '9':
        gen09 = _gen('gen09')
        return len(gen09.generar_09(B, salida=destino))
    if cod == '70':
        gen70 = _gen('gen70')
        return len(gen70.generar_70(B, destino))
    if cod == '71':
        gen71 = _gen('gen71')
        return len(gen71.generar_71(B, destino))
    raise ValueError(cod)

# Los informes que van al Drive se generan para TODOS los años desde este,
# no solo el corriente: Diego necesita el 2025 del bar y lo va a seguir
# necesitando el año que viane (Diego, 24/09). Los del MEGA son siempre del
# año corriente, que es como los baja MaxiRest.
DESDE = 2025

def con_sufijo(nombre, sufijo):
    # Mete el sufijo del PDV ANTES de la extension:
    #      "22 - ventas detalladas.xls" + " SJ" -> "22 - ventas detalladas SJ.xls"
    # Hace falta porque hay carpetas del MEGA COMPARTIDAS entre dos puntos de
    # venta (Canchas Ramos y San Justo comparten una) y, con el nombre generico
    # de MaxiRest, el segundo que corre le pisa los archivos al primero. Diego
    # los venia distinguiendo a mano con sufijos irregulares (12MR vs 12M,
    # "VENTA DETALLADA RAMOS" vs "VENTAS DETALLADAS SJ"); el 24/09 acepto
    # normalizarlos todos a " RAMOS" / " SJ" y borrar los viejos.
    if not sufijo:
        return nombre
    base, ext = os.path.splitext(nombre)
    return base + sufijo + ext


# ------------------------------------------------------------
#  VENTAS DEL MES (Diego, 15/10/2026). En el MEGA de cada PDV, dentro de
#  "Informes del Sistema", hay una carpeta "Ventas" con UN archivo por mes:
#      "9 - ventas por articulo ranking 01.xls" ... "12.xls"
#  Es el 9 (ranking por articulo) pero del MES CALENDARIO COMPLETO y con la
#  columna ID adelante (7 espacios). Cuando cambia el ano, el del mismo mes
#  pisa al del ano anterior (asi lo maneja Diego).
#  Se genera el MES ANTERIOR. Validado contra el "01" del Bar (enero
#  2026): 381/381 articulos con UNIDADES y VENTA identicas, total $66.914.361,25.
#  Incluye TODO (articulos en cero, discontinuados e inexistentes), una fila
#  por articulo con las unidades vendidas.
#  Lleva el sufijo del PDV (" RAMOS"/" SJ") porque Canchas Ramos y San Justo
#  comparten la carpeta del MEGA.
#  UNA VEZ POR MES (Diego, 15/10: "con que se haga una vez al mes es
#  suficiente"): se arma en la primera corrida del mes (si la PC estaba
#  apagada el 1, en la primera que prenda), nunca antes de las 06:00 del dia 1
#  (las ventas de madrugada quedan con fecha del ultimo dia). La marca de
#  "ya hecho" queda en <salida>/_ventas_mes.txt.
#  SUMA (Diego, 15/10): donde dos PDV comparten carpeta del MEGA (canchas =
#  RAMOS + SJ) va un tercer archivo con la suma de los dos ("... 09 R+SJ.xls").
#  Lo arma el PDV que corre cuando ya estan los dos del mes en el puente del
#  Drive (Informes MEGA\<destino>\Ventas); si falta alguno, lo reintenta en la
#  corrida siguiente. Tambien una sola vez por mes.
# ------------------------------------------------------------
NOM_MES = '9 - ventas por articulo ranking %02d.xls'

def mes_anterior(hoy=None):
    hoy = hoy or dt.date.today()
    fin = hoy.replace(day=1) - dt.timedelta(days=1)
    return fin.replace(day=1), fin

def generar_mensual(B, destino, desde, hasta):
    import gen09
    out = gen09.generar_09(B, desde=desde, hasta=hasta)
    if len(out) == 0:
        return 0
    out.insert(0, 'ID', ' ' * 7)
    _escribir_mes(out, destino)
    return len(out)


MARCA_MES = '_ventas_mes.txt'
COLS_MES = ['ID','RUBRO','NOMRUB','SUBRUBRO','NOMSUB','CODIGO','NOMBRE','UNIDADES','PRECIO','VENTA']

def _marcas(OUT):
    try:
        with open(os.path.join(OUT, MARCA_MES), encoding='utf-8') as f:
            return set(l.strip() for l in f if l.strip())
    except Exception:
        return set()

def _marcar(OUT, clave):
    with open(os.path.join(OUT, MARCA_MES), 'a', encoding='utf-8') as f:
        f.write(clave + '\n')

def _escribir_mes(out, destino):
    import openpyxl
    from openpyxl.utils.dataframe import dataframe_to_rows
    wb = openpyxl.Workbook(); ws = wb.active; ws.title = 'Hoja1'
    for fila in dataframe_to_rows(out[COLS_MES], index=False, header=True): ws.append(fila)
    wb.save(destino)

def _leer_mes(ruta):
    # .xls con contenido xlsx (como MaxiRest): openpyxl rechaza la extension
    # si se le pasa la ruta, por eso se lee desde memoria.
    import io, pandas as pd
    with open(ruta, 'rb') as f:
        return pd.read_excel(io.BytesIO(f.read()), engine='openpyxl')

def _hermanos(B):
    """Lee rutas_informes.txt y destinos.txt del _motor (al lado de gen/).
    Devuelve (destino, [sufijos de los PDV con ese destino], carpeta puente)
    o None si no se puede saber."""
    motor = os.path.dirname(AQUI)
    yo = os.path.basename(os.path.normpath(B))
    lineas = []
    try:
        with open(os.path.join(motor, 'rutas_informes.txt'), encoding='utf-8-sig', errors='replace') as f:
            for l in f:
                if not l.strip() or l.strip().startswith('#'): continue
                p = [x.strip() for x in l.split('|')]
                if len(p) >= 6: lineas.append(p)
    except Exception:
        return None
    mia = [p for p in lineas if p[0] == yo]
    if not mia: return None
    destino = mia[0][5]
    hermanos = [p[4] for p in lineas if p[5] == destino]
    kit = None
    try:
        with open(os.path.join(motor, 'destinos.txt'), encoding='utf-8-sig', errors='replace') as f:
            for l in f:
                if '=' in l:
                    k, v = l.split('=', 1)
                    if k.strip() == 'kit_drive': kit = v.strip().rstrip('\\/')
    except Exception:
        pass
    puente = os.path.join(os.path.dirname(os.path.dirname(kit)), 'Informes MEGA', destino) if kit else None
    return destino, hermanos, puente

def nombre_suma(sufijos):
    s = sorted(x.strip().upper() for x in sufijos)
    if s == ['RAMOS', 'SJ']: return ' R+SJ'
    return ' ' + '+'.join(s)

def armar_suma(B, d, sufijo, propio, destino_dir):
    """Devuelve (filas, nombre) si armo la suma; (None, motivo) si no;
    (None, None) si este PDV no comparte carpeta con nadie."""
    info = _hermanos(B)
    if not info: return None, None
    destino, hermanos, puente = info
    if len(hermanos) < 2: return None, None
    if not puente or not os.path.isdir(puente):
        return None, 'no veo la carpeta puente del Drive (%s)' % puente
    hoy = dt.date.today()
    corte = dt.datetime(hoy.year, hoy.month, 1).timestamp()
    archivos = []
    for s in hermanos:
        nom = con_sufijo(NOM_MES % d.month, (' ' + s) if s else '')
        cand = []
        if s.strip().upper() == sufijo.strip().upper() and propio and os.path.exists(propio):
            cand.append(propio)
        cand.append(os.path.join(puente, 'Ventas', nom))
        buenos = [c for c in cand if os.path.exists(c) and os.path.getmtime(c) >= corte]
        if not buenos:
            return None, 'todavia no esta "%s" de este mes en el puente' % nom
        archivos.append(buenos[0])
    import pandas as pd
    t = pd.concat([_leer_mes(a) for a in archivos], ignore_index=True)
    for c in ('UNIDADES', 'VENTA'):
        t[c] = pd.to_numeric(t[c], errors='coerce').fillna(0)
    for c in ('NOMRUB', 'NOMSUB', 'NOMBRE'):
        t[c] = t[c].fillna('').astype(str)
    g = t.groupby('CODIGO', as_index=False, sort=False).agg(
        RUBRO=('RUBRO', 'first'), NOMRUB=('NOMRUB', 'first'), SUBRUBRO=('SUBRUBRO', 'first'),
        NOMSUB=('NOMSUB', 'first'), NOMBRE=('NOMBRE', 'first'),
        UNIDADES=('UNIDADES', 'sum'), VENTA=('VENTA', 'sum'))
    g = g.sort_values(['RUBRO', 'SUBRUBRO', 'CODIGO'], kind='stable').reset_index(drop=True)
    g['ID'] = ' ' * 7; g['PRECIO'] = 0
    g['UNIDADES'] = [int(round(u)) for u in g.UNIDADES]
    g['VENTA'] = g.VENTA.round(2)
    nom = con_sufijo(NOM_MES % d.month, nombre_suma(hermanos))
    _escribir_mes(g, os.path.join(destino_dir, nom))
    return len(g), nom


def main(B, OUT, anio, sufijo='', extras=(), solo=None):
    if not B.endswith(os.sep) and not B.endswith('/'): B += '/'
    mega  = os.path.join(OUT, 'mega');  os.makedirs(mega,  exist_ok=True)
    drive = os.path.join(OUT, 'drive'); os.makedirs(drive, exist_ok=True)
    tmp   = os.path.join(OUT, '_tmp');  os.makedirs(tmp,   exist_ok=True)
    log = ['LAZARILLO - informes generados ' + dt.datetime.now().strftime('%Y-%m-%d %H:%M:%S'),
           'datos : ' + B, 'año   : %d  (al Drive, desde %d)' % (anio, DESDE),
           'sufijo: ' + (sufijo if sufijo else '(ninguno)'),
           'extras: ' + (', '.join(extras) if extras else '(ninguno)'), '']
    ok = mal = vacios = 0
    generados = {}   # (codigo, año) -> archivo armado en esta corrida (lo usa lz_render)
    lista = INFORMES + [e for e in EXTRAS if e[0] in extras]
    # V46 (14/10, Diego: "que se autogestione"): el wrapper PS1 puede pedir que
    # se generen SOLO ciertos codigos (reintento corto de los que dieron error
    # por un gen*.py que llego tarde via el sync de Drive de esta PC), sin
    # repetir todo lo que ya salio bien.
    if solo:
        lista = [e for e in lista if e[0] in solo]
    for cod, nom_mega, carpeta, nom_drive in lista:
        # los que van al Drive se repiten por año; los del MEGA, solo el corriente
        anios = list(range(min(DESDE, anio), anio + 1)) if carpeta else [anio]
        for a in anios:
            al_mega = (a == anio) and nom_mega is not None
            nom_m = con_sufijo(nom_mega, sufijo) if nom_mega else None
            destino = os.path.join(mega, nom_m) if al_mega else os.path.join(tmp, '%s_%d.xlsx' % (cod, a))
            try:
                n = _generar(cod, B, destino, a)
                if n == 0 and cod in SEMANALES_SIN_VACIOS:
                    if os.path.exists(destino):
                        os.remove(destino)
                    log.append('VACIO %-4s %d  la semana no tiene movimientos: no se baja' % (cod, a))
                    vacios += 1
                    continue
                if carpeta:
                    # En el Drive TODOS llevan .XLSX, aunque en el MEGA el mismo
                    # informe se llame .xls (MaxiRest guarda xlsx con extension
                    # .xls). Si se respetara la del MEGA quedarian dos archivos
                    # del mismo informe en la carpeta del año.
                    sub = os.path.join(drive, carpeta); os.makedirs(sub, exist_ok=True)
                    # el sufijo va ANTES del _<año>, igual que en los archivos
                    # que Diego ya tenia: "22 - ... canchas_2025 V7.XLSX"
                    shutil.copy(destino, os.path.join(sub, '%s%s_%d V7.XLSX' % (nom_drive, sufijo, a)))
                log.append('OK    %-4s %d  %6d filas  %s' % (cod, a, n, nom_m or '(solo Drive)')); ok += 1
                generados[(cod, a)] = destino
            except Exception as e:
                log.append('ERROR %-4s %d  %s' % (cod, a, e))
                log.append('      ' + traceback.format_exc().replace('\n', '\n      '))
                mal += 1
    # ventas del mes anterior -> <mega>/Ventas/ (ver VENTAS DEL MES arriba)
    if (not solo) or ('9MES' in solo):
        ahora = dt.datetime.now()
        d, h = mes_anterior(ahora.date())
        clave = d.strftime('%Y-%m')
        marcas = _marcas(OUT)
        carp_v = os.path.join(mega, 'Ventas')
        dest_v = None
        if ahora.day == 1 and ahora.hour < 6:
            log.append('ESPERA 9MES %s  el mes recien cerro: se arma despues de las 06:00' % d.strftime('%m/%Y'))
        else:
            if ('propio ' + clave) in marcas:
                log.append('YA    9MES %s  ya se armo este mes (va una vez por mes)' % d.strftime('%m/%Y'))
            else:
                os.makedirs(carp_v, exist_ok=True)
                nom_v = con_sufijo(NOM_MES % d.month, sufijo)
                dest_v = os.path.join(carp_v, nom_v)
                try:
                    n = generar_mensual(B, dest_v, d, h)
                    if n == 0:
                        if os.path.exists(dest_v): os.remove(dest_v)
                        dest_v = None
                        log.append('VACIO 9MES %s  el mes no tiene ventas: no se baja' % d.strftime('%m/%Y')); vacios += 1
                    else:
                        log.append('OK    9MES %s  %6d filas  Ventas/%s' % (d.strftime('%m/%Y'), n, nom_v)); ok += 1
                    _marcar(OUT, 'propio ' + clave)
                except Exception as e:
                    dest_v = None
                    log.append('ERROR 9MES %d  %s' % (d.year, e))
                    log.append('      ' + traceback.format_exc().replace('\n', '\n      '))
                    mal += 1
            if ('suma ' + clave) not in marcas:
                try:
                    os.makedirs(carp_v, exist_ok=True)
                    n, nom_s = armar_suma(B, d, sufijo, dest_v, carp_v)
                    if n:
                        log.append('OK    9MES %s  %6d filas  Ventas/%s (suma)' % (d.strftime('%m/%Y'), n, nom_s)); ok += 1
                        _marcar(OUT, 'suma ' + clave)
                    elif nom_s:
                        log.append('SUMA  9MES %s  todavia no: %s (se reintenta en la proxima corrida)' % (d.strftime('%m/%Y'), nom_s))
                except Exception as e:
                    log.append('AVISO 9MES %s  no pude armar la suma: %s' % (d.strftime('%m/%Y'), e))
    # RENDER (Diego, 20/10/2026): sube a la base Postgres de Render los informes
    # 22, 14, 25, 80, 11, 12 (año anterior + actual), el 71 y la nomina de este PDV.
    # Va en paralelo: si falla no cambia nada de lo de arriba (queda un AVISO y el
    # archivo "<PC> - render informes.txt" en _LOGS Y CONTROLES\_estado).
    # En el reintento corto (solo=...) no se sube: se sube en la corrida completa.
    if not solo:
        try:
            import lz_render
            lr, okr = lz_render.subir_informes(B, OUT, anio, generados)
            log.extend(lr)
            lz_render.avisar_drive('informes', lr, okr)
        except Exception as e:
            log.append('AVISO RENDER no pude correr la subida a Render: %s' % e)
        shutil.rmtree(os.path.join(OUT, '_render_tmp'), ignore_errors=True)
    shutil.rmtree(tmp, ignore_errors=True)
    log.append(''); log.append('%d informes OK, %d con error, %d vacios (!no se bajan)' % (ok, mal, vacios))
    with open(os.path.join(OUT, '_informes.txt'), 'w', encoding='utf-8') as f:
        f.write('\n'.join(log))
    print('\n'.join(log))
    return mal

if __name__ == '__main__':
    B    = sys.argv[1]
    OUT  = sys.argv[2]
    anio = int(sys.argv[3]) if len(sys.argv) > 3 else dt.date.today().year
    # 4to argumento: sufijo del PDV (" SJ", " RAMOS"). Sin el, nombres genericos.
    # OJO: PowerShell 5.1 NO pasa un argumento vacio, asi que si el sufijo
    # viene vacio el 4to argumento puede ser el "extras=". Se reconoce por nombre.
    resto = sys.argv[4:]
    extras = ()
    solo = None
    for x in list(resto):
        if x.lower().startswith('extras='):
            extras = tuple(e.strip() for e in x.split('=', 1)[1].split(',') if e.strip())
            resto.remove(x)
        elif x.lower().startswith('solo='):
            solo = tuple(e.strip() for e in x.split('=', 1)[1].split(',') if e.strip())
            resto.remove(x)
    suf  = resto[0] if resto else ''
    sys.exit(1 if main(B, OUT, anio, suf, extras, solo) else 0)
