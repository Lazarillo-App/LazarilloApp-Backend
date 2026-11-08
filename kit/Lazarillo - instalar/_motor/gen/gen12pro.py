import pandas as pd, numpy as np, warnings, openpyxl
from openpyxl.utils.dataframe import dataframe_to_rows
from gen11 import r2
from gen12 import generar_12
from gen27 import _cargar
warnings.filterwarnings('ignore')

# 12PRO = el 12 (ranking por dia, misma base y columnas) + lo que el 27 ve como
# SALIDA de stock que el 12 no ve porque no paso por caja (mermas, consumos
# internos, bajas, etc). Pedido de Diego (08/10/2026):
#   - cruce por CODIGO + FECHA.
#   - solo se le suma a UNIDADES (no se toca IMPORTE/COSTO/P_TOTAL/NETO).
#   - del 27 interesan SOLO las salidas (mxmvs.cantidad < 0), en VALOR ABSOLUTO.
#   - si el articulo+fecha no tenia fila en el 12 (no vendio nada ese dia), se
#     AGREGA una fila nueva solo con esa salida; al reves (vendio y no tuvo
#     salida de stock) no se toca nada.
# Misma deduplicacion que el 27 (no el 28): por (remito, codigo), se queda con
# el primero, y descarta el codigo 0 (no es un articulo real).

def _salidas_stock(B, anio, hasta=None):
    w, maps = _cargar(B, anio, hasta)
    d = w[w.codigo != '0']
    d = d[~d.duplicated(subset=['remito', 'codigo'], keep='first')]
    d = d[d.cant < 0].copy()
    g = d.groupby(['codigo', 'f'], as_index=False)['cant'].sum()
    g['UNIDADES'] = (-g['cant']).round(3)
    g['CODIGO'] = pd.to_numeric(g.codigo, errors='coerce').fillna(0).astype(int)
    g['FECHA'] = g['f']
    g['NOMBRE'] = [(maps['nom'].get(c) or 'ARTICULOS INEXISTENTES')[:30].ljust(30) for c in g.codigo]
    return g[['CODIGO', 'FECHA', 'UNIDADES', 'NOMBRE']]

def generar_12pro(B, anio, salida=None, hasta=None):
    base = generar_12(B, anio, salida=None, hasta=hasta, variante='12').copy()
    sal = _salidas_stock(B, anio, hasta)

    pos = {(c, f): i for i, (c, f) in enumerate(zip(base.CODIGO, base.FECHA))}
    extra = [0.0] * len(base)
    nuevas = []
    for _, r in sal.iterrows():
        k = (r.CODIGO, r.FECHA)
        if k in pos:
            extra[pos[k]] += r.UNIDADES
        else:
            nuevas.append({
                'CODIGO': r.CODIGO, 'NOMBRE': r.NOMBRE, 'UNIDADES': r.UNIDADES,
                'IMPORTE': 0, 'COSTO': 0, 'P_TOTAL': 0, 'NETO': 0, 'TIPO_IVA': ' ',
                'FECHA': r.FECHA,
            })
    base['UNIDADES'] = [round(u + e, 3) for u, e in zip(base['UNIDADES'], extra)]
    if nuevas:
        base = pd.concat([base, pd.DataFrame(nuevas)], ignore_index=True)
    out = base.sort_values(['CODIGO', 'FECHA'], kind='stable').reset_index(drop=True)

    if salida:
        wb = openpyxl.Workbook(); ws = wb.active; ws.title = 'Hoja1'
        for fila in dataframe_to_rows(out, index=False, header=True): ws.append(fila)
        for c in ws['I'][1:]: c.number_format = 'mm-dd-yy'
        wb.save(salida)
    return out
