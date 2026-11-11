# -*- coding: utf-8 -*-
"""
Lazarillo - sube informes y maestros a la base Postgres de Render (Diego, 20/10/2026).

Va EN PARALELO a todo lo demas: los informes y maestros se siguen generando y
repartiendo igual. Si Render no responde, no se frena nada: queda un AVISO en el
log y un archivo de estado en el Drive.

ORGANIZACION = conjunto de PDV que comparten maestros. Un esquema por organizacion:

    container   Bar Ramos (BAR), Canchas Ramos (FCRAMOS), San Justo (FCSANJUSTO)
                maestros: los arma el admin
    comercio    Comercio / Nuñez (COMERCIO), arma sus propios maestros

Dentro de cada esquema (nombres: ver NOMBRES; en el Drive van los originales):
    informes: UNA TABLA POR AÑO, columna pdv, sin columna anio (Diego 21/10)
        i22_ventas_detalladas_<año>, i14_gastos_compras_detallado_<año>,
        i25_compras_detalle_de_compras_<año>, i80_compras_detalle_de_pagos_<año>,
        i11_compras_por_insumo_anual_<año>, i12_ventas_por_articulo_ranking_detallado_por_dia_<año>,
        i71_cta_por_comprobante_<año> (por año del comprobante)
        i27_mov_de_stock_detallado_por_remito_<año>, i28_mov_de_stock_resumido_por_remito_<año>
        (el 22 lleva además cod_dto y nom_dto: tipo de descuento de cada venta, solo en Render)
        i000_nomina  empleados, foto del dia (sin la columna 'clave' = contraseña de MaxiRest)
    maestros (uno por organizacion, sin pdv)
        m6_listado_de_articulos     (con rubro, subrubro, descripcion y discontinuado)
        m0_listado_de_insumos_con_discontinuados (con rubro, cod_cga del rubro y envases)
        m17_conceptos_de_caja       (con rubro y calc_rent del rubro)
        m00_listado_de_proovedores
    _cargas  una fila por pdv + tabla: cuantas filas, que años y cuando se cargo

COMO CARGA: cada corrida sube año anterior + actual. Cada PDV reemplaza SUS filas
de las tablas de ESOS años (DELETE ... WHERE pdv = X + INSERT) en una sola
transaccion: si algo falla queda lo del dia anterior entero, nunca a medias, y
los años viejos que ya no se suben QUEDAN (no se pierde historia).
Las tablas NO se borran, asi las vistas que se armen encima sobreviven.
Si un informe trae una columna nueva, se agrega (ALTER TABLE ADD COLUMN).
COPIA EN EL DRIVE: Informes Lazarillo\\<esquema>\\<PDV>\\<nombre original>_<año>.xlsx
y Informes Lazarillo\\<esquema>\\maestros\\<nombre original>.xlsx.

La conexion sale de _motor\\lz_coneccion_render.txt (host, puerto, basename,
usuario, clave, sslmode). La clave NO va en este archivo.
"""
import os, sys, io, re, time, datetime as dt, traceback, subprocess

AQUI = os.path.dirname(os.path.abspath(__file__))
MOTOR = os.path.dirname(AQUI)
sys.path.insert(0, AQUI)

# base de MaxiRest (lo que va antes de " - EQUIPO" en la carpeta de datos)
#   -> (esquema de la organizacion, referencia del PDV o None si solo maestros)
ORGS = {
    'mx_14536': ('container', 'BAR'),
    'mx_49794': ('container', 'FCRAMOS'),
    'mx_50340': ('container', 'FCSANJUSTO'),
    'mx_49893': ('container', None),        # admin: maestros de Container
    'buffet':   ('comercio',  'COMERCIO'),
}

ANUALES = [('22', 'inf_22'), ('14', 'inf_14'), ('25', 'inf_25'),
           ('80', 'inf_80'), ('11', 'inf_11'), ('12', 'inf_12'),
           # 27 y 28 (Diego, 08/11/2026: "hace el cambio de render 27-28"): movimientos de
           # stock por remito (detallado y resumido). Los usa el detalle de ventas del
           # celular (pestaña Revisar). Salen de gen27 igual que el Excel del MEGA.
           ('27', 'inf_27'), ('28', 'inf_28'),
           # 12T (Diego, 10/11/2026): el 12 por turno (Mañana / Noche), solo para Lazarillo.
           ('12T', 'inf_12t')]
CLAVE_NOMINA = 'clave'          # contraseña de MaxiRest de cada empleado: no se sube

# NOMBRES (Diego, 21/10): "quiero que uses los nombres originales que siempre use".
#   clave interna -> (nombre del archivo en el Drive, nombre de la tabla en Render)
# En el Drive van EXACTOS, como los usa Diego. En Render (Postgres) un nombre no
# puede empezar con numero sin comillas, asi que va letra + numero adelante
# (i = informe, m = maestro) y guion bajo en vez de espacios: eligio Diego.
# Si en un esquema ya existe la tabla con el nombre viejo (inf_22, articulos, ...)
# se RENOMBRA (no se borra): las vistas que haya encima la siguen.
NOMBRES = {
    'inf_22':  ('22 - ventas detalladas',                             'i22_ventas_detalladas'),
    'inf_14':  ('14 - gastos compras detallado',                      'i14_gastos_compras_detallado'),
    'inf_25':  ('25 - compras detalle de compras',                    'i25_compras_detalle_de_compras'),
    'inf_80':  ('80 - compras - detalle de pagos',                    'i80_compras_detalle_de_pagos'),
    'inf_11':  ('11 - COMPRAS POR INSUMO ANUAL',                      'i11_compras_por_insumo_anual'),
    'inf_12':  ('12 - ventas por articulo ranking detallado por dia', 'i12_ventas_por_articulo_ranking_detallado_por_dia'),
    'inf_12t': ('12T - ventas por articulo por turno',                'i12t_ventas_por_articulo_por_turno'),
    'inf_71':  ('71 - CTA POR COMPROBANTE',                           'i71_cta_por_comprobante'),
    'inf_27':  ('27 - MOV DE STOCK ANUAL - Detallado por remito',     'i27_mov_de_stock_detallado_por_remito'),
    'inf_28':  ('28 - MOV DE STOCK ANUAL - RESUMIDO POR REMITO',      'i28_mov_de_stock_resumido_por_remito'),
    'nomina':  ('000 - nomina',                                       'i000_nomina'),
    'articulos':           ('6 - listado de articulos',                 'm6_listado_de_articulos'),
    'insumos':             ('0 - LISTADO DE INSUMOS CON DISCONTINUADOS', 'm0_listado_de_insumos_con_discontinuados'),
    'conceptos_caja':      ('17 - conceptos de caja',                   'm17_conceptos_de_caja'),
    'proveedores':         ('00 - listado de proovedores',              'm00_listado_de_proovedores'),
}


# Tablas con los nombres de la primera version (20/10). Si estan, se borran una
# vez (las cargo este mismo script el 20-21/10, nadie las usa todavia: Diego no
# le aviso a Mairene hasta terminar). Si alguna no se puede borrar porque tiene
# una vista encima, se deja y se avisa. Los rubros/subrubros de articulos y los
# rubros de insumos y de conceptos ya no se suben (Diego, 21/10): su dato va
# adentro de articulos / insumos / conceptos.
VIEJAS = ['inf_22', 'inf_14', 'inf_25', 'inf_80', 'inf_11', 'inf_12', 'inf_71', 'nomina',
          'articulos', 'insumos', 'conceptos_caja', 'proveedores', 'rubros_articulos',
          'subrubros_articulos', 'rubros_insumos', 'rubros_conceptos',
          # 21/10 tarde: tablas de informes SIN año (version intermedia); ahora
          # va una tabla por año (i22_ventas_detalladas_2026)
          'i22_ventas_detalladas', 'i14_gastos_compras_detallado', 'i25_compras_detalle_de_compras',
          'i80_compras_detalle_de_pagos', 'i11_compras_por_insumo_anual',
          'i12_ventas_por_articulo_ranking_detallado_por_dia', 'i71_cta_por_comprobante']


def limpiar_viejas(conn, esq):
    lineas = []
    cur = conn.cursor()
    for t in VIEJAS:
        try:
            cur.execute("SELECT to_regclass(%s)", ('"%s"."%s"' % (esq, t),))
            if not cur.fetchone()[0]:
                continue
            cur.execute('DROP TABLE "%s"."%s"' % (esq, t))
            cur.execute("SELECT to_regclass(%s)", ('"%s"."_cargas"' % esq,))
            if cur.fetchone()[0]:
                cur.execute('DELETE FROM "%s"."_cargas" WHERE tabla=%%s' % esq, (t,))
            conn.commit()
        except Exception as e:
            conn.rollback()
            lineas.append('AVISO RENDER no pude sacar la tabla vieja %s.%s: %s' % (esq, t, str(e).strip()))
    return lineas


def nom_drive(k):
    return NOMBRES.get(k, (k, k))[0]


def nom_sql(k):
    return NOMBRES.get(k, (k, k))[1]


# ------------------------------------------------------------ identificacion
# referencia (7mo campo de rutas_informes.txt) -> esquema, para las que ya existen
REF_ESQ = {'BAR': 'container', 'FCRAMOS': 'container', 'FCSANJUSTO': 'container',
           'COMERCIO': 'comercio'}


def _org_por_rutas(carpeta):
    """Organizacion NUEVA sin tocar este archivo (MigaGO, 22/10): alcanza con su
    linea en rutas_informes.txt. Se busca la linea cuyo 1er campo es la carpeta
    de datos ("<base> - <EQUIPO>") y se usa su referencia (7mo campo):
    esquema = referencia en minusculas (MIGAGO -> migago), pdv = referencia.
    Organizacion con maestros propios (como Comercio): los maestros de esa PC
    van al mismo esquema."""
    try:
        with open(os.path.join(MOTOR, 'rutas_informes.txt'), encoding='utf-8-sig', errors='replace') as f:
            for l in f:
                if l.lstrip().startswith('#') or not l.strip():
                    continue
                p = [x.strip() for x in l.split('|')]
                if len(p) >= 7 and p[0].lower() == carpeta.lower() and p[6]:
                    ref = p[6].upper()
                    esq = REF_ESQ.get(ref) or re.sub(r'[^a-z0-9_]', '', ref.lower())
                    if esq and not esq[0].isdigit():
                        return esq, ref
    except Exception:
        pass
    return None


def organizacion(B):
    carpeta = os.path.basename(os.path.normpath(B)).strip()
    base = carpeta.split(' - ')[0].strip().lower()
    # primero la linea de rutas (manda el EQUIPO: dos PC con la misma base no se
    # mezclan); el admin no tiene linea y sale de ORGS.
    return base, _org_por_rutas(carpeta) or ORGS.get(base)


# ------------------------------------------------------------ conexion
def _leer_conexion():
    cands = [os.path.join(MOTOR, 'lz_coneccion_render.txt')]
    try:
        with open(os.path.join(MOTOR, 'destinos.txt'), encoding='utf-8-sig', errors='replace') as f:
            for l in f:
                if '=' in l:
                    k, v = l.split('=', 1)
                    if k.strip() == 'kit_drive':
                        cands.append(os.path.join(v.strip().rstrip('\\/'), '_motor', 'lz_coneccion_render.txt'))
    except Exception:
        pass
    for c in cands:
        if os.path.isfile(c):
            d = {}
            with open(c, encoding='utf-8-sig', errors='replace') as f:
                for l in f:
                    l = l.strip()
                    if l and not l.startswith('#') and '=' in l:
                        k, v = l.split('=', 1)
                        d[k.strip().lower()] = v.strip()
            falta = [k for k in ('host', 'puerto', 'basename', 'usuario', 'clave') if not d.get(k)]
            if falta:
                raise RuntimeError('a lz_coneccion_render.txt le falta: ' + ', '.join(falta))
            return d
    raise RuntimeError('no encuentro lz_coneccion_render.txt en _motor')


def _psycopg2():
    try:
        import psycopg2
        return psycopg2
    except ImportError:
        subprocess.run([sys.executable, '-m', 'pip', 'install', '--quiet',
                        '--disable-pip-version-check', 'psycopg2-binary'],
                       timeout=300, capture_output=True)
        import psycopg2
        return psycopg2


def conectar():
    # 07/11/2026: si la red se cae un momento (el DNS de Render fallo puntual en
    # varias PC), 3 intentos con 30 s de pausa antes de dar la subida por perdida.
    pg = _psycopg2()
    c = _leer_conexion()
    ultimo = None
    for intento in range(3):
        try:
            return pg.connect(host=c['host'], port=c['puerto'], dbname=c['basename'],
                              user=c['usuario'], password=c['clave'],
                              sslmode=c.get('sslmode', 'require'), connect_timeout=20,
                              options='-c statement_timeout=900000')
        except pg.OperationalError as e:
            ultimo = e
            if intento < 2:
                time.sleep(30)
    raise ultimo


# ------------------------------------------------------------ kit vinculado (sin Drive)
# Diego, 07-08/11/2026: "que lo que sube a Render no dependa del Drive". Una PC vinculada
# (instalador "VINCULAR ESTA PC": usuario y contraseña de dueño/admin una sola vez) tiene
# _motor\lz_vinculo.txt con la direccion de Lazarillo y la LLAVE de esa PC. Con ese archivo,
# los informes y maestros se suben por la API de Lazarillo (POST /api/kit/cargas) y no
# directo a la base: la PC no necesita lz_coneccion_render.txt ni el Drive. El servidor
# escribe igual que este archivo (pdv + fila, DELETE por pdv, maestros enteros, _cargas) y
# decide el esquema y el pdv por la llave, no por rutas_informes.txt.
# Sin lz_vinculo.txt todo sigue como antes (directo a Postgres).
VINCULO = 'lz_vinculo.txt'


def vinculo():
    ruta = os.path.join(MOTOR, VINCULO)
    if not os.path.isfile(ruta):
        return None
    d = {}
    try:
        with open(ruta, encoding='utf-8-sig', errors='replace') as f:
            for l in f:
                l = l.strip()
                if l and not l.startswith('#') and '=' in l:
                    k, v = l.split('=', 1)
                    d[k.strip().lower()] = v.strip()
    except Exception:
        return None
    if not d.get('url') or not d.get('llave', '').startswith('lzk_'):
        return None
    d['url'] = d['url'].rstrip('/')
    return d


def _motor_ver():
    try:
        with open(os.path.join(MOTOR, 'lz_lazarillo.ps1'), encoding='utf-8-sig', errors='replace') as f:
            for l in f:
                m = re.match(r'\s*\$MOTOR_VER\s*=\s*"([^"]+)"', l)
                if m:
                    return m.group(1)
    except Exception:
        pass
    return ''


def api(vin, metodo, ruta, cuerpo=None, timeout=300, intentos=3):
    """Llama a la API de Lazarillo con la llave de esta PC. Reintenta 3 veces (30 s) si no
    hay red o el servidor no responde (el de pruebas se duerme y tarda en despertar). Un
    rechazo del servidor (4xx) no se reintenta: se levanta con el motivo."""
    import json, gzip, urllib.request, urllib.error
    datos = None
    cab = {'Authorization': 'Kit ' + vin['llave'], 'Accept': 'application/json',
           'X-Lazarillo-Motor': _motor_ver(), 'User-Agent': 'lazarillo-kit'}
    if cuerpo is not None:
        datos = gzip.compress(json.dumps(cuerpo, ensure_ascii=False, separators=(',', ':')).encode('utf-8'))
        cab['Content-Type'] = 'application/json'
        cab['Content-Encoding'] = 'gzip'
    ultimo = None
    for intento in range(intentos):
        try:
            req = urllib.request.Request(vin['url'] + ruta, data=datos, headers=cab, method=metodo)
            with urllib.request.urlopen(req, timeout=timeout) as r:
                return json.loads(r.read().decode('utf-8') or '{}')
        except urllib.error.HTTPError as e:
            try:
                motivo = json.loads(e.read().decode('utf-8')).get('error', '')
            except Exception:
                motivo = ''
            if 400 <= e.code < 500:
                raise RuntimeError('Lazarillo rechazo %s (%d %s)' % (ruta, e.code, motivo))
            ultimo = RuntimeError('Lazarillo respondio %d en %s %s' % (e.code, ruta, motivo))
        except Exception as e:
            ultimo = e
        if intento < intentos - 1:
            time.sleep(30)
    raise ultimo


def _json(v, tipo):
    import decimal
    v = _a_python(v, tipo)
    if isinstance(v, (dt.datetime, dt.date)):
        return v.isoformat()
    if isinstance(v, decimal.Decimal):
        return float(v)
    if hasattr(v, 'item'):          # tipos de numpy
        return v.item()
    return v


def subir_api(vin, tipo, piezas):
    """piezas = [(tabla en Render, DataFrame)]. Devuelve [(tabla, filas)]."""
    hechas = []
    for tb, d in piezas:
        tipos = [_tipo_pg(d[c]) for c in d.columns]
        filas = [[_json(v, tipos[i]) for i, v in enumerate(r)] for r in d.itertuples(index=False, name=None)]
        r = api(vin, 'POST', '/api/kit/cargas', {
            'tabla': tb, 'tipo': tipo, 'numerar': tipo == 'informe' and COL_FILA not in d.columns,
            'columnas': [{'nombre': c, 'tipo': t} for c, t in zip(d.columns, tipos)], 'filas': filas})
        hechas.append((tb, r.get('filas', len(filas))))
    return hechas


def _informes_api(B, OUT, anio, generados, vin):
    lineas = []
    t0 = time.time()
    try:
        yo = api(vin, 'GET', '/api/kit/yo')
        esq, pdv = yo['esquema'], yo['pdv']
        datos, faltas = armar_informes(B, anio, generados or {}, os.path.join(OUT, '_render_tmp'))
        for f in faltas:
            lineas.append('AVISO RENDER no pude armar %s' % f)
        piezas = []
        for tabla, partes in datos.items():
            for a, d in partes:
                piezas.append((nom_sql(tabla) + ('_%d' % a if a is not None else ''), _limpiar_cols(d)))
        if carpeta_copia():   # la copia del Drive, solo si esta PC tiene Drive (es para Diego)
            lineas.extend(copiar_drive(esq, pdv, {
                nom_drive(t) + ('_%d' % a if a is not None else ''): _con_fijos(_limpiar_cols(d), [('pdv', pdv)])
                for t, partes in datos.items() for a, d in partes}, _vigente_informe))
        hechas = subir_api(vin, 'informe', piezas)
        lineas.append('RENDER  (por Lazarillo) %s.%s  %s  (%.0f s)' % (
            esq, pdv, ', '.join('%s %d' % h for h in hechas), time.time() - t0))
        return lineas, not faltas and not any(l.startswith('AVISO') for l in lineas)
    except Exception as e:
        lineas.append('AVISO RENDER no se pudo subir por Lazarillo: %s' % e)
        lineas.append('      ' + traceback.format_exc().replace('\n', '\n      '))
        return lineas, False


def _maestros_api(A, hechos, vin):
    lineas = []
    t0 = time.time()
    try:
        yo = api(vin, 'GET', '/api/kit/yo')
        if not yo.get('maestros'):
            return ['RENDER  esta PC no arma los maestros de %s (los arma otra PC): no se suben' % yo.get('esquema')], True
        datos = {k: _limpiar_cols(v) for k, v in armar_maestros(A, hechos).items()}
        if carpeta_copia():
            lineas.extend(copiar_drive(yo['esquema'], 'maestros', {nom_drive(k): v for k, v in datos.items()},
                                       lambda n: n in {nom_drive(k) for k in datos}))
        hechas = subir_api(vin, 'maestro', [(nom_sql(k), d) for k, d in datos.items()])
        lineas.append('RENDER  (por Lazarillo) %s maestros: %s  (%.0f s)' % (
            yo['esquema'], ', '.join('%s %d' % h for h in hechas), time.time() - t0))
        return lineas, not any(l.startswith('AVISO') for l in lineas)
    except Exception as e:
        lineas.append('AVISO RENDER no se pudieron subir los maestros por Lazarillo: %s' % e)
        lineas.append('      ' + traceback.format_exc().replace('\n', '\n      '))
        return lineas, False


# ------------------------------------------------------------ tipos
def _tipo_pg(s):
    import pandas as pd
    nn = s.dropna()
    if len(nn) == 0:
        return 'text'
    if pd.api.types.is_bool_dtype(s):
        return 'boolean'
    if pd.api.types.is_integer_dtype(s):
        return 'bigint'
    if pd.api.types.is_float_dtype(s):
        return 'numeric'
    if pd.api.types.is_datetime64_any_dtype(s):
        return 'timestamp'
    if all(isinstance(x, bool) for x in nn):
        return 'boolean'
    return 'text'


def _a_python(v, tipo):
    import pandas as pd, math
    if v is None:
        return None
    try:
        if pd.isna(v):
            return None
    except (TypeError, ValueError):
        pass
    if tipo in ('numeric', 'bigint', 'integer', 'smallint', 'double precision', 'real'):
        try:
            f = float(v)
        except (TypeError, ValueError):
            try:
                f = float(str(v).strip().replace(',', '.'))
            except ValueError:
                return None
        if math.isinf(f):
            return None
        if tipo in ('bigint', 'integer', 'smallint'):
            return int(round(f))
        return f
    if tipo.startswith('timestamp') or tipo == 'date':
        if isinstance(v, str):
            v = pd.to_datetime(v.strip(), errors='coerce')
            if pd.isna(v):
                return None
        try:
            return v.to_pydatetime()
        except AttributeError:
            return v
    if tipo == 'boolean':
        if isinstance(v, str):
            return v.strip().lower() in ('1', 'true', 't', 'si', 's', '\x01')
        return bool(v)
    # Postgres no acepta el caracter nulo (0x00) en un texto: se saca (07/11/2026).
    t = str(v).replace('\x00', '').strip()
    return t if t != '' else None


def _limpiar_cols(df):
    vistos, cols = {}, []
    for c in df.columns:
        n = ''.join(ch if ch.isalnum() else '_' for ch in str(c).strip().lower()).strip('_') or 'col'
        if n[0].isdigit():
            n = 'c_' + n
        if n in vistos:
            vistos[n] += 1; n = '%s_%d' % (n, vistos[n])
        else:
            vistos[n] = 0
        cols.append(n)
    df = df.copy(); df.columns = cols
    return df


# ------------------------------------------------------------ escritura
def _columnas(cur, esq, tabla):
    cur.execute("SELECT column_name, data_type FROM information_schema.columns "
                "WHERE table_schema=%s AND table_name=%s ORDER BY ordinal_position", (esq, tabla))
    return dict(cur.fetchall())


def preparar(conn, esq, tabla, df, extra, viejo=None):
    """DDL en su propia transaccion corta (crear tabla / agregar columnas), asi la
    carga de datos no toma locks exclusivos y no choca con otro PDV cargando.
    viejo = nombre anterior de la tabla: si existe y la nueva no, se renombra."""
    cur = conn.cursor()
    for intento in range(3):
        try:
            cur.execute('CREATE SCHEMA IF NOT EXISTS "%s"' % esq)
            tiene = _columnas(cur, esq, tabla)
            if not tiene and viejo and viejo != tabla and _columnas(cur, esq, viejo):
                cur.execute('ALTER TABLE "%s"."%s" RENAME TO "%s"' % (esq, viejo, tabla))
                cur.execute("SELECT to_regclass(%s)", ('"%s"."_cargas"' % esq,))
                if cur.fetchone()[0]:
                    cur.execute('UPDATE "%s"."_cargas" SET tabla=%%s WHERE tabla=%%s' % esq, (tabla, viejo))
                tiene = _columnas(cur, esq, tabla)
            defs = [(c, t) for c, t in extra] + [(c, _tipo_pg(df[c])) for c in df.columns]
            if not tiene:
                cur.execute('CREATE TABLE IF NOT EXISTS "%s"."%s" (%s)' % (
                    esq, tabla, ', '.join('"%s" %s' % ct for ct in defs)))
            else:
                for c, t in defs:
                    if c not in tiene:
                        cur.execute('ALTER TABLE "%s"."%s" ADD COLUMN IF NOT EXISTS "%s" %s' % (esq, tabla, c, t))
            conn.commit()
            return _columnas(cur, esq, tabla)
        except Exception:
            conn.rollback()
            if intento == 2:
                raise
            time.sleep(3)


# FILA (Diego, 26/10/2026): numero de fila del informe (1, 2, 3...) en el mismo
# orden que el Excel. Una tabla de Postgres no guarda el orden, y el Panel lo
# necesita para leer las ventas (22) de Render: los cobros partidos heredan
# turno/comprobante de la fila de arriba. Va en todos los informes (no en los
# maestros) y NO va a la copia del Drive.
COL_FILA = 'fila'


def insertar(cur, esq, tabla, df, tipos, fijos, numerar=False):
    """fijos = [(columna, valor)] que van adelante (pdv). numerar = agrega la
    columna fila (1..n, orden del informe) despues de los fijos."""
    from psycopg2.extras import execute_values
    numerar = numerar and COL_FILA not in df.columns
    cols = [c for c, _ in fijos] + ([COL_FILA] if numerar else []) + list(df.columns)
    tt = [tipos[c] for c in cols]
    vals_fijos = [_a_python(v, tipos[c]) for c, v in fijos]
    nf = len(fijos) + (1 if numerar else 0)
    filas = []
    for k, r in enumerate(df.itertuples(index=False, name=None), 1):
        filas.append(tuple(vals_fijos) + ((k,) if numerar else ()) +
                     tuple(_a_python(v, tt[nf + i]) for i, v in enumerate(r)))
    if filas:
        execute_values(cur, 'INSERT INTO "%s"."%s" (%s) VALUES %%s' % (
            esq, tabla, ', '.join('"%s"' % c for c in cols)), filas, page_size=1000)
    return len(filas)


def _asegurar_cargas(conn, esq):
    cur = conn.cursor()
    cur.execute('CREATE TABLE IF NOT EXISTS "%s"."_cargas" (pdv text, tabla text, filas bigint, '
                'detalle text, pc text, cargado timestamptz)' % esq)
    conn.commit()


def _anotar(cur, esq, pdv, tabla, filas, detalle):
    cur.execute('DELETE FROM "%s"."_cargas" WHERE pdv=%%s AND tabla=%%s' % esq, (pdv, tabla))
    cur.execute('INSERT INTO "%s"."_cargas" VALUES (%%s,%%s,%%s,%%s,%%s, now())' % esq,
                (pdv, tabla, filas, detalle, os.environ.get('COMPUTERNAME', '')))


def _leer_xlsx(ruta):
    import pandas as pd
    with open(ruta, 'rb') as f:
        return pd.read_excel(io.BytesIO(f.read()), engine='openpyxl')


# ------------------------------------------------------------ tipo de descuento en el 22
# Diego, 10/11/2026: «el 22 que sume la columna del código del tipo y el nombre del tipo a Render».
# SOLO para Render (y su copia en Informes Lazarillo): el Excel del 22 de MaxiRest no cambia.
# El código sale de la cabecera de cada venta (20_ventas_cab.tsv, cod_dto) y el nombre del maestro
# de descuentos (19_descuentos.tsv). Va en todas las filas de la venta (también las de pago partido);
# sin descuento cargado (código 0) las dos columnas quedan vacías.
_CPB22 = {'7': 'FCB', '9': 'NCB', 'B': 'TIC', '6': 'FCA', 'A': 'FCA', '8': 'NCA'}   # igual que inf22_pdv
_RE_CPB22 = re.compile(r'^\s*([A-Za-z_]{1,3})\s*(\d{3,4})\s*-\s*(\d+)\s*$')


def con_tipo_descuento(B, df):
    import pandas as pd
    if not B.endswith(('/', '\\')):
        B += os.sep
    rd = lambda f: pd.read_csv(B + f, sep='\t', dtype=str, keep_default_na=False)
    cab = rd('20_ventas_cab.tsv')
    try:
        dtos = rd('19_descuentos.tsv')
        nombres = {str(c).strip(): str(n).strip() for c, n in zip(dtos['codigo'], dtos['nombre'])}
    except Exception:
        nombres = {}
    cab = cab[cab['cod_suc'].str.strip() == '0'] if 'cod_suc' in cab.columns else cab
    tipo = {}
    for cc, pre, num, cd in zip(cab['cod_cpb'], cab['prefijo'], cab['numero'], cab['cod_dto']):
        try:
            k = (_CPB22.get(cc.strip(), cc.strip()).upper(), int(pre), int(num))
        except ValueError:
            continue
        if k not in tipo:                       # como el informe: el primero si se repite
            tipo[k] = cd.strip()
    cods, noms, actual = [], [], None
    for comp, turno, cobro in zip(df['COMPROBANT'], df['TURNO'], df['COD_COBRO']):
        m = _RE_CPB22.match(str(comp)) if isinstance(comp, str) else None
        if m:
            actual = tipo.get((m.group(1).upper(), int(m.group(2)), int(m.group(3))))
        elif isinstance(comp, str) and comp.strip():
            actual = None                        # «FECHA: …», «TOTALES …»
        elif not (str(turno).strip() or str(cobro).strip()):
            actual = None                        # fila en blanco
        c = actual if actual not in (None, '', '0') else None
        cods.append(c)
        noms.append(nombres.get(c) if c else None)
    df = df.copy()
    df['COD_DTO'] = cods
    df['NOM_DTO'] = noms
    return df


# ------------------------------------------------------------ informes de un PDV
def armar_informes(B, anio, generados, log_tmp):
    """Devuelve {tabla: [(anio_o_None, DataFrame)]}. 'generados' = {(cod, año): ruta}
    de lo que lz_informes ya armo en esta corrida; lo que falte se genera aca."""
    import pandas as pd, lz_informes
    tmp = log_tmp
    os.makedirs(tmp, exist_ok=True)
    out, faltas = {}, []
    anios = [anio - 1, anio]
    for cod, tabla in ANUALES:
        partes = []
        for a in anios:
            ruta = generados.get((cod, a))
            try:
                if not ruta or not os.path.exists(ruta):
                    ruta = os.path.join(tmp, 'r_%s_%d.xlsx' % (cod, a))
                    lz_informes._generar(cod, B, ruta, a)
                partes.append((a, _leer_xlsx(ruta)))
            except Exception as e:
                faltas.append('%s %d: %s' % (cod, a, e))
        if len(partes) == len(anios):
            if cod == '22':
                try:
                    partes = [(a, con_tipo_descuento(B, d)) for a, d in partes]
                except Exception as e:
                    faltas.append('22 tipo de descuento: %s' % e)
            out[tabla] = partes
    # 71: acumulativo, se corta a los ultimos 2 años (por fecha del comprobante o del cobro)
    try:
        ruta = generados.get(('71', anio))
        if not ruta or not os.path.exists(ruta):
            ruta = os.path.join(tmp, 'r_71.xlsx')
            lz_informes._generar('71', B, ruta, anio)
        d = _leer_xlsx(ruta)
        # UNO POR AÑO (Diego, 21/10), por el año del comprobante (FECHA); los
        # pagos a cuenta sin comprobante, por el año del cobro.
        f = pd.to_datetime(d['FECHA'], errors='coerce')
        if 'FECHACOB' in d:
            f = f.fillna(pd.to_datetime(d['FECHACOB'], errors='coerce'))
        out['inf_71'] = [(a, d[(f.dt.year == a).fillna(False)]) for a in anios]
    except Exception as e:
        faltas.append('71: %s' % e)
    # nomina: foto del dia, sin la contraseña de MaxiRest
    try:
        import gen_nomina
        d = gen_nomina.generar_nomina(B, os.path.join(tmp, 'r_nomina.xlsx'))
        d = d.drop(columns=[c for c in d.columns if c.lower() == CLAVE_NOMINA])
        d = d.replace(gen_nomina.FECHA_VACIA, None)
        for c in gen_nomina.FECHAS:
            if c in d:
                d[c] = pd.to_datetime(d[c], errors='coerce')
        out['nomina'] = [(None, d)]
    except Exception as e:
        faltas.append('nomina: %s' % e)
    return out, faltas


def subir_informes(B, OUT, anio, generados=None):
    """Devuelve (lineas_de_log, ok). Nunca levanta excepcion."""
    vin = vinculo()
    if vin:
        return _informes_api(B, OUT, anio, generados, vin)
    lineas = []
    base, org = organizacion(B)
    if not org or not org[1]:
        return ['RENDER  sin organizacion para la base "%s": no se sube' % base], True
    esq, pdv = org
    t0 = time.time()
    try:
        datos, faltas = armar_informes(B, anio, generados or {}, os.path.join(OUT, '_render_tmp'))
        for f in faltas:
            lineas.append('AVISO RENDER no pude armar %s' % f)
        # UNO POR AÑO, en el Drive Y en Render (Diego, 21/10: "si no, la informacion
        # vieja se va a ir perdiendo" / "si va a ser uno por año no tiene sentido la
        # columna de año"). Cada informe anual es un archivo y una tabla por año:
        #   Drive : "22 - ventas detalladas_2026.xlsx"
        #   Render: i22_ventas_detalladas_2026   (columnas: pdv + las del informe)
        # Cada corrida reescribe solo los años que sube (anterior + actual); los
        # años viejos quedan como estan. Sin columna anio en ningun lado.
        piezas = []   # (clave interna, año o None, DataFrame)
        for tabla, partes in datos.items():
            for a, d in partes:
                piezas.append((tabla, a, _limpiar_cols(d)))

        def con_anio(nombre, a):
            return nombre + ('_%d' % a if a is not None else '')

        copia = {con_anio(nom_drive(t), a): _con_fijos(d, [('pdv', pdv)]) for t, a, d in piezas}
        lc = copiar_drive(esq, pdv, copia, _vigente_informe)
        lineas.extend(lc)
        del copia
        conn = conectar()
        try:
            lineas.extend(limpiar_viejas(conn, esq))
            tipos = {}
            for t, a, d in piezas:
                tb = con_anio(nom_sql(t), a)
                tipos[tb] = preparar(conn, esq, tb, d, [('pdv', 'text')] + ([] if COL_FILA in d.columns else [(COL_FILA, 'integer')]))
            _asegurar_cargas(conn, esq)
            cur = conn.cursor()
            resumen = []
            for t, a, d in piezas:
                tb = con_anio(nom_sql(t), a)
                cur.execute('DELETE FROM "%s"."%s" WHERE pdv=%%s' % (esq, tb), (pdv,))
                n = insertar(cur, esq, tb, d, tipos[tb], [('pdv', pdv)], numerar=True)
                _anotar(cur, esq, pdv, tb, n, '')
                resumen.append('%s %d' % (tb, n))
            conn.commit()
        finally:
            conn.close()
        lineas.append('RENDER  %s.%s  %s  (%.0f s)' % (esq, pdv, ', '.join(resumen), time.time() - t0))
        return lineas, not faltas and not any(l.startswith('AVISO') for l in lineas)
    except Exception as e:
        lineas.append('AVISO RENDER no se pudo subir a Render: %s' % e)
        lineas.append('      ' + traceback.format_exc().replace('\n', '\n      '))
        return lineas, False


# ------------------------------------------------------------ maestros de una organizacion
def armar_maestros(A, hechos):
    """hechos = {numero: DataFrame} de maestros_todos (columnas como en el Excel)."""
    import pandas as pd
    from genmaestros import leer_tsv, desescapar

    def txt(s):
        return s.map(lambda x: x.strip() if isinstance(x, str) else x)

    def nombres(n):
        d = hechos[n]
        return dict(zip(pd.to_numeric(d['CODIGO'], errors='coerce'), txt(d['NOMBRE'])))

    if not A.endswith(('/', '\\')):
        A += os.sep
    out = {}
    # articulos con rubro y subrubro adentro + si esta discontinuado
    a = hechos['6'].copy()
    a.insert(1, 'RUBRO', pd.to_numeric(a['COD_RUA'], errors='coerce').map(nombres('7')))
    a.insert(3, 'SUBRUBRO', pd.to_numeric(a['COD_SUA'], errors='coerce').map(nombres('8')))
    try:
        t = leer_tsv(A + '09_articulos.tsv')
        disc = {int(float(c)): desescapar(v) == '\x01' for c, v in zip(t['codigo'], t['discont'])}
        a['DISCONTINUADO'] = pd.to_numeric(a['CODIGO'], errors='coerce').map(disc).fillna(False).astype(bool)
        # descripcion del articulo (mxart.descripc), pedido de Diego 21/10: va al
        # lado del nombre. Si la consulta todavia no la trae, la columna no se agrega.
        if 'descripc' in t.columns:
            desc = {int(float(c)): (desescapar(v) or '').strip() for c, v in zip(t['codigo'], t['descripc'])
                    if pd.notna(pd.to_numeric(c, errors='coerce'))}
            a.insert(a.columns.get_loc('NOMBRE') + 1, 'DESCRIPCION',
                     pd.to_numeric(a['CODIGO'], errors='coerce').map(desc))
    except Exception:
        pass
    out['articulos'] = a
    # insumos (todos, con discontinuados marcados) con su rubro
    i = hechos['0'].copy()
    i.insert(1, 'RUBRO', pd.to_numeric(i['COD_RUI'], errors='coerce').map(nombres('2')))
    # cod_cga del rubro de insumos (Diego, 21/10: asi no hace falta subir los rubros)
    r2 = hechos['2']
    if 'COD_CGA' in r2.columns:
        i.insert(2, 'COD_CGA', pd.to_numeric(i['COD_RUI'], errors='coerce').map(
            dict(zip(pd.to_numeric(r2['CODIGO'], errors='coerce'), pd.to_numeric(r2['COD_CGA'], errors='coerce')))))
    activos = set(pd.to_numeric(hechos['1']['CODIGO'], errors='coerce'))
    i['DISCONTINUADO'] = ~pd.to_numeric(i['CODIGO'], errors='coerce').isin(activos)
    # ENVASES (Diego, 21/10): MaxiRest guarda hasta 3 envases por insumo, cada uno
    # con su nombre (envaseN, ej. "Pack") y su contenido (netoN, ej. 12, en la
    # unidad del insumo). Va cada envase en su columna: envase1 / neto1, envase2 /
    # neto2, envase3 / neto3. Sin columna concatenada (Diego: "no me sirve").
    # Sin envase cargado, envase y neto van vacios (no 0).
    try:
        t = leer_tsv(A + '10_insumos.tsv')
        t = t[pd.to_numeric(t['codigo'], errors='coerce').notna()]
        cods = pd.to_numeric(t['codigo'], errors='coerce').astype(int)
        cod_i = pd.to_numeric(i['CODIGO'], errors='coerce')
        pos = i.columns.get_loc('UNIDAD_MED') + 1 if 'UNIDAD_MED' in i.columns else len(i.columns)
        for n in (1, 2, 3):
            ce, cn = 'envase%d' % n, 'neto%d' % n
            if ce not in t.columns:
                continue
            env = dict(zip(cods, t[ce].map(lambda x: (desescapar(x) or '').strip())))
            net = dict(zip(cods, pd.to_numeric(t.get(cn, 0), errors='coerce').fillna(0)))
            i.insert(pos, 'ENVASE%d' % n, cod_i.map({c: v for c, v in env.items() if v})); pos += 1
            i.insert(pos, 'NETO%d' % n, cod_i.map({c: v for c, v in net.items() if env.get(c)})); pos += 1
    except Exception:
        pass
    out['insumos'] = i
    # conceptos de caja con su rubro
    c = hechos['17'].copy()
    c.insert(c.columns.get_loc('COD_RGA') + 1, 'RUBRO', pd.to_numeric(c['COD_RGA'], errors='coerce').map(nombres('11')))
    # calc_rent del rubro de conceptos (Diego, 21/10: asi no hace falta subir los rubros)
    r11 = hechos['11']
    if 'CALC_RENT' in r11.columns:
        c.insert(c.columns.get_loc('RUBRO') + 1, 'CALC_RENT', pd.to_numeric(c['COD_RGA'], errors='coerce').map(
            dict(zip(pd.to_numeric(r11['CODIGO'], errors='coerce'), r11['CALC_RENT']))))
    out['conceptos_caja'] = c
    out['proveedores'] = hechos['00']
    # rubros y subrubros de articulos, rubros de insumos y de conceptos: NO se
    # suben (Diego, 21/10). Su nombre/dato ya va adentro de cada maestro.
    return out


def subir_maestros(A, hechos):
    vin = vinculo()
    if vin:
        return _maestros_api(A, hechos, vin)
    lineas = []
    base, org = organizacion(A)
    if not org:
        return ['RENDER  sin organizacion para la base "%s": no se suben maestros' % base], True
    esq = org[0]
    t0 = time.time()
    try:
        datos = {k: _limpiar_cols(v) for k, v in armar_maestros(A, hechos).items()}
        lc = copiar_drive(esq, 'maestros', {nom_drive(k): v for k, v in datos.items()},
                          lambda n: n in {nom_drive(k) for k in datos})
        lineas.extend(lc)
        conn = conectar()
        try:
            lineas.extend(limpiar_viejas(conn, esq))
            tipos = {t: preparar(conn, esq, nom_sql(t), d, [], viejo=t) for t, d in datos.items()}
            _asegurar_cargas(conn, esq)
            cur = conn.cursor()
            resumen = []
            for t, d in datos.items():
                cur.execute('DELETE FROM "%s"."%s"' % (esq, nom_sql(t)))
                n = insertar(cur, esq, nom_sql(t), d, tipos[t], [])
                _anotar(cur, esq, '(maestros)', nom_sql(t), n, '')
                resumen.append('%s %d' % (nom_sql(t), n))
            conn.commit()
        finally:
            conn.close()
        lineas.append('RENDER  %s maestros: %s  (%.0f s)' % (esq, ', '.join(resumen), time.time() - t0))
        return lineas, not any(l.startswith('AVISO') for l in lineas)
    except Exception as e:
        lineas.append('AVISO RENDER no se pudieron subir los maestros: %s' % e)
        lineas.append('      ' + traceback.format_exc().replace('\n', '\n      '))
        return lineas, False


# ------------------------------------------------------------ copia en el Drive
def carpeta_copia():
    """G:\\Mi unidad\\Informes Lazarillo (al lado de la carpeta Lazarillo). La creo
    Diego el 21/10; si no existe, no se hace la copia (no se inventa la carpeta)."""
    try:
        with open(os.path.join(MOTOR, 'destinos.txt'), encoding='utf-8-sig', errors='replace') as f:
            for l in f:
                if '=' in l:
                    k, v = l.split('=', 1)
                    if k.strip() == 'kit_drive':
                        kit = v.strip().rstrip('\\/')
                        c = os.path.join(os.path.dirname(os.path.dirname(kit)), 'Informes Lazarillo')
                        return c if os.path.isdir(c) else None
    except Exception:
        pass
    return None


def _xlsx(df, ruta):
    """Escribe el DataFrame tal cual va a Render (mismas columnas) a un .xlsx.
    Primero a un temporal y despues se reemplaza: el Drive nunca ve uno a medias."""
    import pandas as pd, re, openpyxl
    ilegal = re.compile(r'[\x00-\x08\x0b\x0c\x0e-\x1f]')
    wb = openpyxl.Workbook(write_only=True)
    ws = wb.create_sheet('datos')
    ws.freeze_panes = 'A2'
    ws.append(list(df.columns))
    for r in df.itertuples(index=False, name=None):
        fila = []
        for v in r:
            if v is None:
                fila.append(None); continue
            try:
                if pd.isna(v):
                    fila.append(None); continue
            except (TypeError, ValueError):
                pass
            if isinstance(v, str):
                v = ilegal.sub('', v).strip()
            elif hasattr(v, 'to_pydatetime'):
                v = v.to_pydatetime()
            fila.append(v)
        ws.append(fila)
    tmp = ruta + '.tmp.xlsx'
    wb.save(tmp)
    os.replace(tmp, ruta)


def _vigente_informe(nombre):
    """Archivo con nombre de esta version: "<informe>_<año>" o la nomina."""
    for k, (dn, _) in NOMBRES.items():
        if k == 'nomina':
            if nombre == dn:
                return True
        elif k.startswith('inf_') and re.fullmatch(re.escape(dn) + r'_\d{4}', nombre):
            return True
    return False


def copiar_drive(esq, sub, archivos, vigente):
    """archivos = {nombre del archivo sin .xlsx: DataFrame con las columnas de Render}.
    Deja Informes Lazarillo\\<esquema>\\<sub>\\<nombre>.xlsx. Cualquier otro .xlsx
    de esa carpeta que no sea de esta version (vigente(nombre) == False) se MUEVE a
    "_A BORRAR (Lazarillo)", no se borra (regla de Diego). Los años viejos de los
    informes son vigentes: quedan."""
    base = carpeta_copia()
    if not base:
        return ['AVISO RENDER no encuentro la carpeta "Informes Lazarillo" en el Drive: no hago la copia']
    dest = os.path.join(base, esq, sub)
    try:
        os.makedirs(dest, exist_ok=True)
        malos = []
        for nom, d in archivos.items():
            try:
                _xlsx(d, os.path.join(dest, nom + '.xlsx'))
            except Exception as e:
                malos.append('%s (%s)' % (nom, e))
        for f in os.listdir(dest):
            n, ext = os.path.splitext(f)
            if ext.lower() == '.xlsx' and not n.endswith('.tmp') and not vigente(n):
                try:
                    ab = os.path.join(base, '_A BORRAR (Lazarillo)', esq, sub)
                    os.makedirs(ab, exist_ok=True)
                    os.replace(os.path.join(dest, f), os.path.join(ab, f))
                except Exception:
                    pass
        l = ['DRIVE   copia en Informes Lazarillo\\%s\\%s: %d archivos' % (esq, sub, len(archivos) - len(malos))]
        if malos:
            l.append('AVISO RENDER no pude copiar al Drive: ' + ', '.join(malos))
        return l
    except Exception as e:
        return ['AVISO RENDER no pude copiar al Drive: %s' % e]


def _con_fijos(d, fijos):
    d = d.copy()
    for k, (c, v) in enumerate(fijos):
        d.insert(k, c, v)
    return d


# ------------------------------------------------------------ estado al Drive
def avisar_drive(que, lineas, ok):
    """Deja _LOGS Y CONTROLES\\_estado\\<PC> - render <que>.txt (primera linea:
    fecha + OK/ALERTA) para que el control diario lo vea sin bajar logs."""
    try:
        kit = None
        with open(os.path.join(MOTOR, 'destinos.txt'), encoding='utf-8-sig', errors='replace') as f:
            for l in f:
                if '=' in l:
                    k, v = l.split('=', 1)
                    if k.strip() == 'kit_drive':
                        kit = v.strip().rstrip('\\/')
        if not kit:
            return
        carpeta = os.path.join(os.path.dirname(kit), '_LOGS Y CONTROLES', '_estado')
        if not os.path.isdir(carpeta):
            return
        pc = os.environ.get('COMPUTERNAME', 'PC')
        cab = '%s  %s  render %s %s' % (dt.datetime.now().strftime('%Y-%m-%d %H:%M'),
                                        'OK' if ok else 'ALERTA', que, pc)
        with open(os.path.join(carpeta, '%s - render %s.txt' % (pc, que)), 'w', encoding='utf-8') as f:
            f.write('\n'.join([cab] + [l for l in lineas if not l.startswith('      ')]) + '\n')
    except Exception:
        pass


if __name__ == '__main__':
    # prueba a mano:  python lz_render.py <carpeta de datos del PDV> [año]
    B = sys.argv[1]
    anio = int(sys.argv[2]) if len(sys.argv) > 2 else dt.date.today().year
    l, ok = subir_informes(B, os.path.join(MOTOR, '..', 'out', '_render_manual'), anio)
    print('\n'.join(l))
