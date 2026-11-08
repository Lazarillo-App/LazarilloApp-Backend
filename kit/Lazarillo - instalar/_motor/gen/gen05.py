import pandas as pd, numpy as np, warnings, openpyxl
from decimal import Decimal, ROUND_DOWN
from openpyxl.utils.dataframe import dataframe_to_rows
from gen11 import r2, D
from gen03 import semana_LaD
warnings.filterwarnings('ignore')

IVA = 1.21   # el informe pasa la venta a neto dividiendo por 1,21

def generar_05(B, desde=None, hasta=None, salida=None):
    if desde is None: desde, hasta = semana_LaD()
    it  = pd.read_csv(B+"22_ventas_items.tsv", sep="\t", dtype=str, keep_default_na=False)
    ar  = pd.read_csv(B+"09_articulos.tsv",    sep="\t", dtype=str, keep_default_na=False)
    ins = pd.read_csv(B+"10_insumos.tsv",      sep="\t", dtype=str, keep_default_na=False)
    # OJO: el orden de las filas de mxrec importa (es el id), no reordenar.
    rec = pd.read_csv(B+"18_recetas.tsv",      sep="\t", dtype=str, keep_default_na=False)
    rec = rec.reset_index().rename(columns={'index':'ord'})
    rec['insn'] = pd.to_numeric(rec.cod_ins, errors='coerce').fillna(0)
    rec['can']  = pd.to_numeric(rec.cantidad, errors='coerce').fillna(0)
    # las filas con cod_ins negativo o cantidad 0 no son insumos de receta
    rec = rec[(rec.insn > 0) & (rec.can > 0)]

    for c in ['cantidad','precio']: it[c] = pd.to_numeric(it[c], errors='coerce').fillna(0)
    it['f'] = pd.to_datetime(it['fecha'], errors='coerce')
    # Decision de Diego (24/09/2026): se incluyen TODAS las ventas, tambien las
    # de precio 0 (componentes de promos y combos). No se filtra por precio.
    w = it[(it.f >= str(desde)) & (it.f <= str(hasta))].copy()
    w['V'] = w.cantidad * w.precio
    un  = w.groupby('cod_art').cantidad.sum()
    rev = w.groupby('cod_art').V.sum()

    costo = dict(zip(ar.codigo, pd.to_numeric(ar.costo, errors='coerce').fillna(0)))
    nar   = dict(zip(ar.codigo, ar.nombre))
    nins  = dict(zip(ins.codigo, ins.nombre))
    rub   = dict(zip(ins.codigo, pd.to_numeric(ins.cod_rui, errors='coerce').fillna(0).astype(int)))
    med   = dict(zip(ins.codigo, ins.unidad_med))
    pins  = dict(zip(ins.codigo, pd.to_numeric(ins.precio, errors='coerce').fillna(0)))

    m = rec[rec.cod_art.isin(un.index)].copy()
    m['U'] = [un[a] for a in m.cod_art]
    m['T'] = m.U * m.can

    filas = []
    for k, g in m.groupby('insn'):
        ik = str(int(k))
        g = g.sort_values('ord')
        ult = g.iloc[-1]                       # el articulo que se muestra es el ULTIMO de la receta
        art = ult.cod_art
        R = rev.get(art, 0.0); U = un.get(art, 0.0); C = costo.get(art, 0.0)
        filas.append({
            'RUBRO'     : rub.get(ik, 0),
            'CODIGO'    : int(k),
            'NOMBRE'    : nins.get(ik,'')[:30].ljust(30),
            'MEDIDA'    : med.get(ik,'')[:5].ljust(5),
            'P_UNIT'    : round(pins.get(ik, 0.0), 2),
            'COD_ART'   : int(art),
            'NOMBRE_ART': nar.get(art,'')[:30].ljust(30),
            'CANXART'   : round(float(ult.can), 3),
            'VENTA'     : int(g.U.sum()),
            'TOTVTA'    : round(float(g['T'].sum()), 3),
            # PRECIOART viene con basura en el informe de MaxiRest (valores de
            # miles de millones); no se puede reproducir, va en cero.
            'PRECIOART' : 0.0,
            # OJO: la utilidad va TRUNCADA a dos decimales, no redondeada
            # (al reves que los importes del 11 y el 3, que redondean medio arriba).
            'UTILIDAD'  : float(Decimal(R/IVA - C*U).quantize(Decimal('0.01'), rounding=ROUND_DOWN)),
        })
    # Semana sin ventas (Diego, 25/09: "que no se baje"): no se escribe archivo.
    # Antes reventaba con KeyError 'RUBRO' al ordenar un DataFrame vacio.
    if not filas:
        return pd.DataFrame()
    out = pd.DataFrame(filas).sort_values(['RUBRO','CODIGO']).reset_index(drop=True)
    if salida:
        wb = openpyxl.Workbook(); ws = wb.active; ws.title = 'Hoja1'
        for fila in dataframe_to_rows(out, index=False, header=True): ws.append(fila)
        wb.save(salida)
    return out
