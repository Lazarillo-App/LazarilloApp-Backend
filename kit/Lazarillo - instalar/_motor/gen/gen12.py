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
