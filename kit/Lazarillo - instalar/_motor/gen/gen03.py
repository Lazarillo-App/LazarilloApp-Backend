import pandas as pd, numpy as np, warnings, openpyxl, datetime as dt
from decimal import Decimal
from openpyxl.utils.dataframe import dataframe_to_rows
from gen11 import r2, D
warnings.filterwarnings('ignore')

def semana_LaD(hoy=None):
    """Ultima semana COMPLETA lunes a domingo cerrada antes de hoy."""
    hoy = hoy or dt.date.today()
    dom = hoy - dt.timedelta(days=(hoy.weekday() + 1) % 7 or 7)   # ultimo domingo anterior
    return dom - dt.timedelta(days=6), dom

def generar_03(B, desde=None, hasta=None, salida=None):
    if desde is None: desde, hasta = semana_LaD()
    det = pd.read_csv(B+"23_compras_detalle.tsv", sep="\t", dtype=str, keep_default_na=False)
    ins = pd.read_csv(B+"10_insumos.tsv",         sep="\t", dtype=str, keep_default_na=False)
    for c in ['cantidad','neto','precio']: det[c+'_d'] = D(det[c])
    det['insn'] = pd.to_numeric(det['cod_ins'], errors='coerce').fillna(0)
    det['idn']  = pd.to_numeric(det['id'], errors='coerce').fillna(0)
    det['f']    = pd.to_datetime(det['fecha'], errors='coerce')
    d = det[(det.insn > 0) & (det.f >= str(desde)) & (det.f <= str(hasta))].copy()
    d['k'] = d.insn.astype(int).astype(str)
    d['N'] = d.cantidad_d * d.precio_d          # neto, sin IVA
    d['C'] = d.cantidad_d * d.neto_d            # cantidad en unidad de stock

    rub = dict(zip(ins.codigo, pd.to_numeric(ins.cod_rui, errors='coerce').fillna(0).astype(int)))
    nom = dict(zip(ins.codigo, ins.nombre)); med = dict(zip(ins.codigo, ins.unidad_med))
    civ = dict(zip(ins.codigo, ins.cod_iva))

    g = d.groupby('k').agg(N=('N','sum'), C=('C','sum'))
    # OJO: aca la tasa NO sale de la linea (como en el 11) sino del MAESTRO de
    # insumos: cod_iva = '1' -> 10,5%; cualquier otra cosa -> 21%.
    g['tasa'] = [Decimal('10.5') if civ.get(x) == '1' else Decimal('21') for x in g.index]
    g['I']    = g.N * (1 + g.tasa/Decimal(100))
    g['RUBRO'] = [rub.get(x,0) for x in g.index]
    g['CODIGO'] = [int(x) for x in g.index]
    g = g.sort_values(['RUBRO','CODIGO']).reset_index()

    # el proveedor que se muestra es el de la PRIMERA compra del insumo en la
    # semana, con el mismo criterio de orden que el 11 (fecha y comprobante)
    from gen11 import ETQ
    d['COMPROB'] = [ETQ.get(t,t)+"%04d-%08d" % (int(a), int(b))
                    for t,a,b in zip(d.cod_cpb, d.numero1, d.numero2)]
    pri = d.sort_values(['f','COMPROB']).groupby('k').head(1).set_index('k')['cod_pro']
    # los porcentajes se calculan sobre el NETO (sin IVA), no sobre el importe
    tot = g.N.sum(); rt = g.groupby('RUBRO')['N'].transform('sum')

    out = pd.DataFrame({
        'RUBRO'   : g.RUBRO.values,
        'CODIGO'  : g.CODIGO.values,
        'NOMBRE'  : [nom.get(x,'')[:30].ljust(30) for x in g.k],
        'MEDIDA'  : [med.get(x,'')[:5].ljust(5)  for x in g.k],
        'P_PROM'  : r2([i/c if c else Decimal(0) for i,c in zip(g.I, g.C)]),
        'CANTIDAD': r2(g.C, 3),
        'IMPORTE' : r2(g.I),
        'COD_PRO' : [abs(int(pri.get(x,0))) for x in g.k],
        # un rubro (o la semana) con neto 0 no se divide: va 0 (Canchas Ramos
        # 27/09: DivisionUndefined, 0/0 en Decimal).
        'P_RUBRO' : r2([n/r*100 if r else Decimal(0) for n, r in zip(g.N, rt)]),
        'P_TOTAL' : r2([n/tot*100 if tot else Decimal(0) for n in g.N]),
    })
    if salida:
        wb = openpyxl.Workbook(); ws = wb.active; ws.title = 'Hoja1'
        for fila in dataframe_to_rows(out, index=False, header=True): ws.append(fila)
        wb.save(salida)
    return out
