import pandas as pd, numpy as np, warnings, openpyxl
from decimal import Decimal, ROUND_HALF_UP
from openpyxl.utils.dataframe import dataframe_to_rows
warnings.filterwarnings('ignore')

ETQ = {'A':'A  ','Z':'Tic ','C':'C  ','+':'NC  ','E':'','G':''}

def r2(x, n=2):
    # MaxiRest redondea medio para arriba y calcula en decimal. Hacerlo en float
    # deja diferencias de un centavo (round() de Python ademas redondea al par).
    q = Decimal(1).scaleb(-n)
    return [float(Decimal(v).quantize(q, rounding=ROUND_HALF_UP)) for v in x]

def D(s):
    return pd.Series([Decimal(str(v).strip() or '0') for v in s], index=s.index)

def generar_11(B, anio, salida=None, hasta=None):
    det = pd.read_csv(B+"23_compras_detalle.tsv", sep="\t", dtype=str, keep_default_na=False)
    ins = pd.read_csv(B+"10_insumos.tsv",         sep="\t", dtype=str, keep_default_na=False)
    pro = pd.read_csv(B+"13_proveedores.tsv",     sep="\t", dtype=str, keep_default_na=False)
    emp = pd.read_csv(B+"04_empleados.tsv",       sep="\t", dtype=str, keep_default_na=False)
    for c in ['cantidad','neto','precio','tasa','imp_int','imp_inttot']:
        det[c+'_d'] = D(det[c])
        det[c] = pd.to_numeric(det[c], errors='coerce').fillna(0)
    det['insn'] = pd.to_numeric(det['cod_ins'], errors='coerce').fillna(0)
    det['f']    = pd.to_datetime(det['fecha'], errors='coerce')

    # Igual que el 25: el periodo se filtra por la fecha del DETALLE.
    d = det[(det.insn > 0) & (det.f >= f"{anio}-01-01") & (det.f < f"{anio+1}-01-01")]
    if hasta: d = d[d.f <= hasta]
    d = d.copy()

    rub = dict(zip(ins.codigo, pd.to_numeric(ins.cod_rui, errors='coerce').fillna(0).astype(int)))
    nom = dict(zip(ins.codigo, ins.nombre))
    med = dict(zip(ins.codigo, ins.unidad_med))
    nom_pro = dict(zip(pro.codigo, pro.nombre))
    nom_emp = dict(zip(emp.codigo, (emp.nombre.str.strip()+' '+emp.apellido.str.strip()).str.strip()))
    def quien(c):
        c = int(c)
        return nom_emp.get(str(abs(c)), '') if c < 0 else nom_pro.get(str(c), '')

    k = d.insn.astype(int).astype(str)
    d['RUBRO']   = [rub.get(x, 0) for x in k]
    d['CODIGO']  = d.insn.astype(int)
    d['COMPROB'] = [ETQ.get(t, t) + "%04d-%08d" % (int(a), int(b))
                    for t, a, b in zip(d.cod_cpb, d.numero1, d.numero2)]
    # Orden: rubro, insumo, fecha y — para desempatar — el propio comprobante.
    d = d.sort_values(['RUBRO','CODIGO','f','COMPROB'], kind='stable').reset_index(drop=True)
    k = d.insn.astype(int).astype(str)

    # CANTIDAD va en la unidad de STOCK del insumo: cantidad comprada x contenido
    # de la presentacion. Por eso MEDIDA es siempre unidad_med, nunca el envase.
    C = d.cantidad_d * d.neto_d
    # IMPORTE se recalcula CON IVA desde precio y tasa sin redondeos intermedios
    # (no sirve preciotot + ivatot: esos ya vienen redondeados y dan centavos de mas).
    # Los impuestos internos NO se recalculan: se toma el imp_inttot guardado
    # (cantidad x imp_int da un centavo de diferencia).
    I = d.cantidad_d * d.precio_d * (1 + d.tasa_d/Decimal(100)) + d.imp_inttot_d
    cp = pd.to_numeric(d.cod_pro, errors='coerce').fillna(0).astype(int)

    out = pd.DataFrame({
        'RUBRO'    : d.RUBRO.values,
        'CODIGO'   : d.CODIGO.values,
        'NOMBRE'   : [nom.get(x,'')[:30].ljust(30) for x in k],
        'MEDIDA'   : [med.get(x,'')[:5].ljust(5)  for x in k],
        # P_PROM es el precio con IVA por unidad de STOCK (no el importe sobre la
        # cantidad: eso arrastra el redondeo del importe y falla medio centavo).
        'P_PROM'   : r2([ (p*(1+t/Decimal(100)) + ii) / n if n else Decimal(0)
                          for p, t, ii, n in zip(d.precio_d, d.tasa_d, d.imp_int_d, d.neto_d) ]),
        'CANTIDAD' : r2(C, 3),
        'IMPORTE'  : r2(I),
        'COD_PRO'  : cp.abs().values,
        'PROVEEDOR': [quien(c)[:30].ljust(30) for c in d.cod_pro],
        'COMPROB'  : [c[:17].ljust(17) for c in d.COMPROB],
        'FECHA'    : d.f.values,
    })
    if salida:
        wb = openpyxl.Workbook(); ws = wb.active; ws.title = 'Hoja1'
        for fila in dataframe_to_rows(out, index=False, header=True): ws.append(fila)
        for c in ws['K'][1:]: c.number_format = 'mm-dd-yy'
        wb.save(salida)
    return out
