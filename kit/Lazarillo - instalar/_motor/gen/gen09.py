import pandas as pd, numpy as np, warnings, openpyxl
from decimal import Decimal
from openpyxl.utils.dataframe import dataframe_to_rows
from gen11 import r2, D
from gen03 import semana_LaD
warnings.filterwarnings('ignore')

def generar_09(B, desde=None, hasta=None, salida=None):
    if desde is None: desde, hasta = semana_LaD()
    it = pd.read_csv(B+"22_ventas_items.tsv", sep="\t", dtype=str, keep_default_na=False)
    ar = pd.read_csv(B+"09_articulos.tsv",    sep="\t", dtype=str, keep_default_na=False)
    ru = pd.read_csv(B+"07_rubros.tsv",       sep="\t", dtype=str, keep_default_na=False)
    su = pd.read_csv(B+"08_subrubros.tsv",    sep="\t", dtype=str, keep_default_na=False)
    for c in ['cantidad','precio']: it[c+'_d'] = D(it[c])
    it['precion'] = pd.to_numeric(it['precio'], errors='coerce').fillna(0)
    it['f'] = pd.to_datetime(it['fecha'], errors='coerce')

    # Decision de Diego (24/09/2026): el ranking incluye TODAS las ventas,
    # tambien las lineas de precio 0 (componentes de promos y combos). No se
    # filtra por precio.
    w = it[(it.f >= str(desde)) & (it.f <= str(hasta))].copy()
    w['V'] = w.cantidad_d * w.precio_d

    rua = dict(zip(ar.codigo, pd.to_numeric(ar.cod_rua, errors='coerce').fillna(0).astype(int)))
    sua = dict(zip(ar.codigo, pd.to_numeric(ar.cod_sua, errors='coerce').fillna(0).astype(int)))
    nar = dict(zip(ar.codigo, ar.nombre))
    nru = dict(zip(ru.codigo, ru.nombre)); nsu = dict(zip(su.codigo, su.nombre))

    g = w.groupby('cod_art').agg(U=('cantidad_d','sum'), V=('V','sum')).reset_index()
    g['CODIGO']   = g.cod_art.astype(int)
    g['RUBRO']    = [rua.get(k, 0) for k in g.cod_art]
    g['SUBRUBRO'] = [sua.get(k, 0) for k in g.cod_art]
    g = g.sort_values(['RUBRO','SUBRUBRO','CODIGO']).reset_index(drop=True)

    out = pd.DataFrame({
        'RUBRO'   : g.RUBRO.values,
        'NOMRUB'  : [nru.get(str(r),'')[:30].ljust(30) for r in g.RUBRO],
        'SUBRUBRO': g.SUBRUBRO.values,
        'NOMSUB'  : [nsu.get(str(s),'')[:30].ljust(30) for s in g.SUBRUBRO],
        'CODIGO'  : g.CODIGO.values,
        # un cod_art que no esta en el maestro sale como "Art. Inexistente"
        'NOMBRE'  : [(nar.get(k) or 'Art. Inexistente')[:30].ljust(30) for k in g.cod_art],
        'UNIDADES': [int(u) for u in g.U],
        'PRECIO'  : 0,                      # MaxiRest la deja siempre en cero
        'VENTA'   : r2(g.V),
    })
    if salida:
        wb = openpyxl.Workbook(); ws = wb.active; ws.title = 'Hoja1'
        for fila in dataframe_to_rows(out, index=False, header=True): ws.append(fila)
        wb.save(salida)
    return out
