import pandas as pd, numpy as np, warnings, openpyxl, re
from openpyxl.utils.dataframe import dataframe_to_rows
from gen11 import r2
warnings.filterwarnings('ignore')

# El 27 y el 28 salen de la misma tabla (mxmvs) pero NO con las mismas reglas:
#   27 (detallado) -> una fila por remito y articulo: se DEDUPLICA por
#      (remito, codigo) quedandose con el primero, y se descarta el codigo 0.
#   28 (resumido)  -> una fila por remito, y el importe suma TODAS las lineas,
#      sin deduplicar y SIN descartar el codigo 0.
# En los dos casos van solo los movimientos de ARTICULOS (artins = 'A').

TURNOS = {'1':'Mañana', '2':'Noche', '3':'Tarde'}
ILEGAL = re.compile(r'[\x00-\x08\x0b\x0c\x0e-\x1f]')

def esc(x):
    # MaxiRest escapa los caracteres de control como _x00NN_; openpyxl no los admite
    return ILEGAL.sub(lambda m: '_x%04X_' % ord(m.group()), x) if isinstance(x, str) else x

def _cargar(B, anio, hasta=None):
    m   = pd.read_csv(B+"31_mov_stock.tsv",     sep="\t", dtype=str, keep_default_na=False)
    cmo = pd.read_csv(B+"32_conceptos_mov.tsv", sep="\t", dtype=str, keep_default_na=False)
    ar  = pd.read_csv(B+"09_articulos.tsv",     sep="\t", dtype=str, keep_default_na=False)
    emp = pd.read_csv(B+"04_empleados.tsv",     sep="\t", dtype=str, keep_default_na=False)
    try:    obs = pd.read_csv(B+"33_mov_observ.tsv", sep="\t", dtype=str, keep_default_na=False)
    except Exception: obs = pd.DataFrame(columns=['remito','cod_suc','observac'])
    m['f']    = pd.to_datetime(m['fecha'], errors='coerce')
    m['idn']  = pd.to_numeric(m['id'], errors='coerce').fillna(0)
    m['cant'] = pd.to_numeric(m['cantidad'], errors='coerce').fillna(0)
    m['pre']  = pd.to_numeric(m['precio'], errors='coerce').fillna(0)
    w = m[(m.f >= f"{anio}-01-01") & (m.f < f"{anio+1}-01-01") & (m.artins == 'A')]
    if hasta is not None: w = w[w.f <= str(hasta)]
    w = w.sort_values('idn', kind='stable').copy()
    w['REMITO'] = pd.to_numeric(w.remito, errors='coerce').fillna(0).astype(int)
    w['P'] = w.cant * w.pre
    maps = dict(
        con = dict(zip(cmo.codigo, cmo.nombre)),
        nom = dict(zip(ar.codigo, ar.nombre)),
        pre = dict(zip(ar.codigo, pd.to_numeric(ar.precio1, errors='coerce').fillna(0))),
        emp = dict(zip(emp.codigo, (emp.nombre.str.strip()+' '+emp.apellido.str.strip()).str.strip())),
        obs = dict(zip(obs.remito, obs.observac)) if len(obs) else {},
    )
    return w, maps

def _armar(d, maps, resumen):
    z = lambda n: ' ' * n
    out = pd.DataFrame({
        'FECHA'     : d.f.values,
        'TURNO'     : [TURNOS.get(t,'')[:10].ljust(10) for t in d.turno],
        'REMITO'    : d.REMITO.values,
        'CONCEPTO'  : [maps['con'].get(c,'')[:20].ljust(20) for c in d.cod_cmo],
        # OJO: en el informe de MaxiRest el DETALLE es " Mesa <mesa> - <obs>".
        # La MESA no esta en ninguna tabla de la base (se pierde al cerrarla),
        # asi que va solo la observacion del remito, que si esta en mxmvsobs.
        'DETALLE'   : [esc((' ' + maps['obs'].get(str(r),''))[:20].ljust(20)) for r in d.REMITO],
        'OBSERVAC'  : z(50),
        'CANTIDAD'  : 0 if resumen else d.cant.values,
        'CODIGO'    : 0 if resumen else pd.to_numeric(d.codigo, errors='coerce').fillna(0).astype(int).values,
        'MEDIDA'    : z(6),
        'NOMBRE'    : z(35) if resumen else [esc(maps['nom'].get(c,'')[:35].ljust(35)) for c in d.codigo],
        'PRECIO'    : r2(d.P),
        'MESA'      : z(4),
        'COD_EMP'   : pd.to_numeric(d.cod_emp, errors='coerce').fillna(0).astype(int).values,
        'EMP_NOM'   : [esc(maps['emp'].get(str(c),'')[:50].ljust(50)) for c in d.cod_emp],
        'SUCURSAL'  : z(50),
        'PRECIOUNIT': 0 if resumen else [maps['pre'].get(c, 0) for c in d.codigo],
    })
    return out

def generar_27(B, anio, salida=None, hasta=None):
    w, maps = _cargar(B, anio, hasta)
    d = w[w.codigo != '0']
    d = d[~d.duplicated(subset=['remito','codigo'], keep='first')]
    d = d.sort_values(['f','REMITO','idn'], kind='stable').reset_index(drop=True)
    return _guardar(_armar(d, maps, False), salida)

def generar_28(B, anio, salida=None, hasta=None):
    w, maps = _cargar(B, anio, hasta)
    g = w.groupby(['f','REMITO'], as_index=False).agg(
        P=('P','sum'), turno=('turno','first'), cod_cmo=('cod_cmo','first'),
        cod_emp=('cod_emp','first'), idn=('idn','first'), codigo=('codigo','first'))
    g = g.sort_values(['f','REMITO'], kind='stable').reset_index(drop=True)
    return _guardar(_armar(g, maps, True), salida)

def _guardar(out, salida):
    if salida:
        wb = openpyxl.Workbook(); ws = wb.active; ws.title = 'Hoja1'
        for fila in dataframe_to_rows(out, index=False, header=True): ws.append(fila)
        for c in ws['A'][1:]: c.number_format = 'mm-dd-yy'
        wb.save(salida)
    return out
