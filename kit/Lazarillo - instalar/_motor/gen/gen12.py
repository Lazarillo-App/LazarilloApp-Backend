import pandas as pd, numpy as np, warnings, openpyxl
from openpyxl.utils.dataframe import dataframe_to_rows
from gen11 import r2, D
warnings.filterwarnings('ignore')

# El 12 tiene tres variantes. Decision de Diego (24/09/2026): el informe muestra
# TODO, sin filtros -> aparecen TODOS los articulos (esten o no discontinuados) y
# TODAS las lineas (incluidas las de precio 0). Antes el 12 sacaba los
# discontinuados y las lineas de precio 0 para calcar a MaxiRest; ya no.
#   12   -> todos los turnos.
#   12M  -> turnos '1' (Mañana) y '' (sin turno).
#   12N  -> turno '2' (Noche).
# Los que no estan en el maestro salen "ARTICULOS INEXISTENTES".
VARIANTES = {
    '12' : dict(turnos=None,      filtrar=False),
    '12M': dict(turnos=['1',''],  filtrar=False),
    '12N': dict(turnos=['2'],     filtrar=False),
}

def generar_12(B, anio, salida=None, hasta=None, variante='12'):
    cfg = VARIANTES[variante]
    it = pd.read_csv(B+"22_ventas_items.tsv", sep="\t", dtype=str, keep_default_na=False)
    ar = pd.read_csv(B+"09_articulos.tsv",    sep="\t", dtype=str, keep_default_na=False)
    for c in ['cantidad','precio']: it[c+'_d'] = D(it[c])
    it['precion'] = pd.to_numeric(it['precio'], errors='coerce').fillna(0)
    it['f'] = pd.to_datetime(it['fecha'], errors='coerce')

    w = it[(it.f >= f"{anio}-01-01") & (it.f < f"{anio+1}-01-01")]
    if hasta is not None:  w = w[w.f <= str(hasta)]
    if cfg['turnos'] is not None: w = w[w.turno.isin(cfg['turnos'])]
    if cfg['filtrar']:
        ok = set(ar[ar.discont != '\x01'].codigo)
        w = w[(w.precion != 0) & (w.cod_art.isin(ok))]
    # 28/09 (Diego): "de los transaccionales no dejamos nada afuera". Antes se
    # sacaban las lineas con cantidad 0 (MaxiRest no las imprime); ahora van
    # todas, igual que los discontinuados y los de precio 0.
    w = w.copy()
    w['V'] = w.cantidad_d * w.precio_d

    g = w.groupby(['cod_art','f'], as_index=False).agg(U=('cantidad_d','sum'), V=('V','sum'))
    g['CODIGO'] = g.cod_art.astype(int)
    g = g.sort_values(['CODIGO','f']).reset_index(drop=True)
    nom = dict(zip(ar.codigo, ar.nombre))

    out = pd.DataFrame({
        'CODIGO'  : g.CODIGO.values,
        'NOMBRE'  : [(nom.get(k) or 'ARTICULOS INEXISTENTES')[:30].ljust(30) for k in g.cod_art],
        'UNIDADES': r2(g.U, 3),
        'IMPORTE' : r2(g.V),
        'COSTO'   : 0, 'P_TOTAL': 0, 'NETO': 0, 'TIPO_IVA': ' ',
        'FECHA'   : g.f.values,
    })
    if salida:
        wb = openpyxl.Workbook(); ws = wb.active; ws.title = 'Hoja1'
        for fila in dataframe_to_rows(out, index=False, header=True): ws.append(fila)
        for c in ws['I'][1:]: c.number_format = 'mm-dd-yy'
        wb.save(salida)
    return out


# 12T (Diego, 10/11/2026: "no se pueden extraer filtradas por turno también? así le damos esa
# info a Lazarillo"). El 12 partido por turno, SOLO para Lazarillo (sube a Render como
# i12t_ventas_por_articulo_por_turno_<año>; no va al MEGA ni a Transaccionales). Una fila por
# artículo + día + turno, con las mismas líneas que el 12 (todo, sin filtros): la suma de los
# turnos da exactamente el 12. Turno '1' = Mañana, '2' = Noche. Las líneas SIN turno no son
# tickets de salón: son facturas manuales (los movimientos de stock de BigBox que se cierran por
# stock y se facturan juntos) y van a Noche "por el momento, después vemos" (Diego, 10/11).
# Un turno distinto de 1/2 (no apareció en el Bar) sale como "Turno <n>".
TURNOS_12T = {'1': 'Mañana', '2': 'Noche', '': 'Noche'}

def generar_12t(B, anio, salida=None, hasta=None):
    it = pd.read_csv(B+"22_ventas_items.tsv", sep="\t", dtype=str, keep_default_na=False)
    ar = pd.read_csv(B+"09_articulos.tsv",    sep="\t", dtype=str, keep_default_na=False)
    for c in ['cantidad','precio']: it[c+'_d'] = D(it[c])
    it['f'] = pd.to_datetime(it['fecha'], errors='coerce')
    w = it[(it.f >= f"{anio}-01-01") & (it.f < f"{anio+1}-01-01")]
    if hasta is not None:  w = w[w.f <= str(hasta)]
    w = w.copy()
    w['V'] = w.cantidad_d * w.precio_d
    t = w.turno.astype(str).str.strip()
    w['TURNO'] = [TURNOS_12T.get(x, 'Turno ' + x) for x in t]

    g = w.groupby(['cod_art','f','TURNO'], as_index=False).agg(U=('cantidad_d','sum'), V=('V','sum'))
    g['CODIGO'] = g.cod_art.astype(int)
    g = g.sort_values(['CODIGO','f','TURNO']).reset_index(drop=True)
    nom = dict(zip(ar.codigo, ar.nombre))

    out = pd.DataFrame({
        'CODIGO'  : g.CODIGO.values,
        'NOMBRE'  : [(nom.get(k) or 'ARTICULOS INEXISTENTES')[:30].ljust(30) for k in g.cod_art],
        'TURNO'   : g.TURNO.values,
        'UNIDADES': r2(g.U, 3),
        'IMPORTE' : r2(g.V),
        'FECHA'   : g.f.values,
    })
    if salida:
        wb = openpyxl.Workbook(); ws = wb.active; ws.title = 'Hoja1'
        for fila in dataframe_to_rows(out, index=False, header=True): ws.append(fila)
        for c in ws['F'][1:]: c.number_format = 'mm-dd-yy'
        wb.save(salida)
    return out
