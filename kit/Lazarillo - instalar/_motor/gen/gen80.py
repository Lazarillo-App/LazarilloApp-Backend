# -*- coding: utf-8 -*-
"""
Informe 80 - COMPRAS - DETALLE DE PAGOS.

Una fila por PAGO hecho con una ORDEN DE PAGO, con los datos del comprobante de
compra que cancela. El año corta por la fecha de la ORDEN, no por la del
comprobante: por eso en el archivo de 2026 aparecen comprobantes de 2025 que se
terminaron de pagar este año.

Todo esto se dedujo comparando contra el 80 real de San Justo de 2026
(424 filas, $103.077.963,94), usando la base del admin, que consolida los PDV.

    FECHA .................. mxgas.fecha      (fecha del comprobante)
    COD_CPB/PREFIJO/NUMERO . cod_cpb, numero1, numero2
    COD_PRO/NOM_PRO ........ mxpro
    TOTAL .................. mxgas.total
    COD_CGA/NOM_CGA ........ mxgas.cod_cga -> mxcga
    COD_RGA/NOM_RGA ........ mxcga.cod_rga -> mxrga
    COD_CTG/NOM_CTG ........ mxgas.cod_ctg -> mxctg
    PAGO ................... mxpag.tipo  (ver abajo)
    IMPORTE ................ mxpag.importe, salvo pago unico (ver abajo)
    FECHA_PAGO ............. mxpag.fecha_ord
    ORDEN .................. mxpag.orden
    FECHA_VAL..IMP_VAL ..... el cheque con que se pago; MaxiRest los deja en
                             cero en todos los archivos que vimos.
"""
import pandas as pd, numpy as np, warnings, openpyxl
from openpyxl.utils.dataframe import dataframe_to_rows
warnings.filterwarnings('ignore')

# ------------------------------------------------------------
#  mxpag.tipo NO es una letra ni un codigo de banco: es de donde salio la plata.
#      '2' -> CAJA MAYOR      '3' -> BANCOS
#  Verificado fila por fila contra el 80 de San Justo: 288 CAJA / 136 BANCOS,
#  sin un solo cruce.
#  Los otros valores NO entran en este informe:
#      ''      pago contado al cargar el comprobante (no tiene orden de pago)
#      '1'     gasto de caja (cod_pro = 0, comprobante 'G')
#      'A','A7'  nota de credito aplicada (van de a pares +x / -x)
#      'X'     descuento
#  Los rotulos "CAJA MAYOR" y "BANCOS" estan escritos en el programa de MaxiRest,
#  no salen de ninguna tabla (se busco en mxvar y no estan).
# ------------------------------------------------------------
PAGO_DE = {'2': 'CAJA MAYOR', '3': 'BANCOS'}


def generar_80(B, anio, salida, cod_suc=None):
    pag = pd.read_csv(B + "38_compras_pagos.tsv",  sep="\t", dtype=str, keep_default_na=False)
    cab = pd.read_csv(B + "24_compras_cab.tsv",    sep="\t", dtype=str, keep_default_na=False)
    pro = pd.read_csv(B + "13_proveedores.tsv",    sep="\t", dtype=str, keep_default_na=False)
    con = pd.read_csv(B + "12_conceptos_caja.tsv", sep="\t", dtype=str, keep_default_na=False)
    rga = pd.read_csv(B + "11_rubros_caja.tsv",    sep="\t", dtype=str, keep_default_na=False)
    try:
        ctg = pd.read_csv(B + "40_categorias_gasto.tsv", sep="\t", dtype=str, keep_default_na=False)
    except Exception:
        ctg = pd.DataFrame({'codigo': [], 'nombre': []})

    K = ['cod_pro', 'cod_suc', 'cod_cpb', 'numero1', 'numero2']

    pag['imp'] = pd.to_numeric(pag['importe'], errors='coerce').fillna(0)
    pag['fo']  = pd.to_datetime(pag['fecha_ord'].replace('0000-00-00', ''), errors='coerce')
    cab['tot'] = pd.to_numeric(cab['total'], errors='coerce').fillna(0)
    cab['f']   = pd.to_datetime(cab['fecha'].replace('0000-00-00', ''), errors='coerce')

    p = pag[pag['tipo'].isin(PAGO_DE)].copy()
    if cod_suc is not None:
        p = p[p['cod_suc'] == str(cod_suc)]
    p = p[(p['fo'] >= f"{anio}-01-01") & (p['fo'] < f"{anio+1}-01-01")]

    # cuantos pagos tiene cada comprobante EN TOTAL (no solo los de este año):
    # si es uno solo y cancela todo, MaxiRest muestra el total del comprobante
    npagos = pag.groupby(K)['imp'].size().rename('npagos')
    p = p.merge(cab[K + ['tot', 'f', 'cod_cga', 'cod_ctg']], on=K, how='left')
    p = p.merge(npagos, on=K, how='left')

    # ------------------------------------------------------------
    #  IMPORTE va tal cual lo guarda mxpag.
    #  OJO: contra el 80 que exporta MaxiRest aparecen diferencias de hasta SEIS
    #  CENTAVOS en algunas filas, para los dos lados. No es redondeo nuestro: la
    #  base guarda mxgas.total con TRES decimales (1194126.625) y el informe de
    #  MaxiRest imprime otra cosa (1194126.67), asi que el numero "lindo" lo
    #  fabrica el propio MaxiRest al recalcular. Sobre San Justo 2026 el desvio
    #  total fue de menos de un peso sobre $103.077.963. Se deja el dato de la
    #  base, que es el que se puede defender.
    p['IMP'] = p['imp']

    nom_pro = dict(zip(pro['codigo'], pro['nombre']))
    nom_cga = dict(zip(con['codigo'], con['nombre']))
    rga_de  = dict(zip(con['codigo'], con['cod_rga']))
    nom_rga = dict(zip(rga['codigo'], rga['nombre']))
    nom_ctg = dict(zip(ctg['codigo'], ctg['nombre'])) if len(ctg) else {}

    cga  = p['cod_cga'].fillna('0').replace('', '0')
    crga = cga.map(lambda c: rga_de.get(c, '0')).fillna('0').replace('', '0')
    ctgc = p['cod_ctg'].fillna('0').replace('', '0')

    def p30(s):
        return pd.Series(list(s), index=p.index).fillna('').astype(str).str[:30].str.ljust(30)

    def ent(s):
        return pd.to_numeric(s, errors='coerce').fillna(0).astype(int)

    out = pd.DataFrame({
        'FECHA'     : p['f'],
        'COD_CPB'   : p['cod_cpb'],
        'PREFIJO'   : ent(p['numero1']),
        'NUMERO'    : ent(p['numero2']),
        'COD_PRO'   : ent(p['cod_pro']),
        'NOM_PRO'   : p30([nom_pro.get(c, '') for c in p['cod_pro']]),
        'TOTAL'     : p['tot'].round(2),
        'COD_CGA'   : ent(cga),
        'NOM_CGA'   : p30([nom_cga.get(c, '') for c in cga]),
        'COD_RGA'   : ent(crga),
        'NOM_RGA'   : p30([nom_rga.get(c, '') for c in crga]),
        'COD_CTG'   : ent(ctgc),
        'NOM_CTG'   : p30([nom_ctg.get(c, '') for c in ctgc]),
        'PAGO'      : p30([PAGO_DE.get(t, '') for t in p['tipo']]),
        'IMPORTE'   : p['IMP'].round(2),
        'FECHA_PAGO': p['fo'],
        'ORDEN'     : ent(p['orden']),
        'FECHA_VAL' : pd.NaT,
        'NUMERO_VAL': 0,
        'COD_BAN'   : 0,
        'NOM_BAN'   : ' ' * 30,
        'IMP_VAL'   : 0,
    })
    out = out.sort_values(['FECHA', 'COD_PRO', 'NUMERO'], kind='stable').reset_index(drop=True)

    wb = openpyxl.Workbook(); ws = wb.active; ws.title = 'Hoja1'
    for fila in dataframe_to_rows(out, index=False, header=True): ws.append(fila)
    for c in ws['A'][1:]: c.number_format = 'mm-dd-yy'   # FECHA
    for c in ws['P'][1:]: c.number_format = 'mm-dd-yy'   # FECHA_PAGO
    wb.save(salida)
    return out


if __name__ == '__main__':
    import sys
    B    = sys.argv[1]
    anio = int(sys.argv[2]) if len(sys.argv) > 2 else 2026
    suc  = sys.argv[3] if len(sys.argv) > 3 else None
    o = generar_80(B, anio, "/mnt/user-data/outputs/80 - COMPRAS - DETALLE DE PAGOS PAGOS_%d V7.XLSX" % anio, suc)
    print("filas: {}   IMPORTE {:,.2f}".format(len(o), o['IMPORTE'].sum()))
