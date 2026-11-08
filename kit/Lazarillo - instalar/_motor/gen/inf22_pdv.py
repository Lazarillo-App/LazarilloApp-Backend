# -*- coding: utf-8 -*-
"""Genera el informe 22 (ventas detalladas) de MaxiRest desde la base."""
import pandas as pd, datetime as dt, re

RE_CPB = re.compile(r'^[A-Z]{3}\s*\d{3,4}\s*-\s*\d+$')

OUT = "/mnt/user-data/uploads/Informes ERP/_DATOS/mx_14536 - SERVIDOR-RAMOS/"   # se puede cambiar con base()

def base(ruta):
    """Apunta el generador a otra carpeta _DATOS (la usa lz_informes.py)."""
    global OUT
    OUT = ruta if ruta.endswith(('/', '\\')) else ruta + '/'

TURNO = {'1':'Mañ','2':'Noc','3':'Tar'}
TIPO  = {}   # se arma desde mxctv (circuitos) del PDV
CPB   = {'7':'FCB','9':'NCB','B':'TIC','6':'FCA','A':'FCA','8':'NCA'}
MOZO  = {}   # se arma desde mxemp del PDV (el admin solo tiene 5 empleados)

def rd(f): return pd.read_csv(OUT+f, sep="\t", dtype=str, keep_default_na=False)

def generar(suc='0', desde=None, hasta=None, usar_referencia=True):
    fac = rd("20_ventas_cab.tsv"); ctc = rd("21_ventas_cobros.tsv"); fmt = rd("06_formas_cobro.tsv")
    emp = rd("04_empleados.tsv"); ctv = rd("05_circuitos.tsv"); cli = rd("17_clientes.tsv")
    # El informe NO usa el nombre que quedo congelado en la venta: lo toma del
    # maestro de clientes. Si la venta no tiene cliente (cod_cli = 0) va vacio.
    CLI = {c: ((n.strip() + ' ' + a.strip()).strip(), r.strip(), u.strip())
           for c, n, a, r, u in zip(cli.codigo, cli.nombre, cli.apellido, cli.razon, cli.cuit)}
    FOR = dict(zip(fmt.codigo, fmt.nombre))          # del PDV: completas, sin parches
    MOZO.update(dict(zip(emp.codigo, emp.nombre)))   # del PDV: los 78 reales
    TIPO.update({c: n[:5] for c, n in zip(ctv.codigo, ctv.nombre)})
    f = fac[fac.cod_suc == suc].copy()
    c = ctc[ctc.cod_suc == suc].copy()
    if desde: f = f[f.fecha >= desde]; c = c[c.fecha >= desde]
    if hasta: f = f[f.fecha <= hasta]; c = c[c.fecha <= hasta]
    # Fuera las cobranzas POSTERIORES de cuenta corriente: son las que traen en
    # 'pago' la forma con que se cobro despues ('*', '7', 'W'...).
    # OJO: pago == 'a' NO es una cobranza posterior, son las anulaciones de la
    # propia venta (importes negativos, con la NC en la referencia) y SI van.
    c = c[c.pago.str.strip().isin(['', 'a'])]
    c['o'] = pd.to_numeric(c.orden, errors='coerce').fillna(0)
    c = c.sort_values(['numero','o'])
    K = ['cod_cpb','prefijo','numero']
    grp = {k: g for k, g in c.groupby(K, sort=False)}
    f['nord'] = pd.to_numeric(f.numero)
    f['pord'] = pd.to_numeric(f.prefijo)
    # El informe sale ordenado por dia, turno, tipo de comprobante, prefijo y numero.
    f = f.sort_values(['fecha','turno','cod_cpb','pord','nord'])
    # MaxiRest indexa el informe por (comprobante, prefijo, numero). Si la base
    # tiene el mismo numero dos veces (paso el 28/05/2026 con el ticket
    # 1-28052027) el informe imprime UNO solo: el primero.
    f = f[~f.duplicated(subset=K, keep='first')]

    filas = []
    V = lambda: {'TURNO':'   ','COMPROBANT':' '*20,'HORA':' '*5,'TIPO':' '*5,'MESA':' '*4,
                 'MOZO':' '*20,'CUB':0,'COBRO':' '*17,'COD_COBRO':' ','IMPORTE':0,'TOTAL':0,
                 'DESCUENTO':0,'CLINOMBRE':' '*50,'CLIRAZON':' '*35,'CLICUIT':' '*35,
                 'FECHA':None,'COD_SUC':0,'NOMBRESUC':' '*60,'CUPON':0}
    def num(s):                      # enteros (cubiertos, cupon)
        try: return int(float(s))
        except: return 0
    def imp(s):                      # importes: con centavos
        try: return round(float(s), 2)
        except: return 0.0

    gcub = gimp = gtot = gdto = 0
    filas.append(V())                                   # fila en blanco inicial
    for fecha, dia in f.groupby('fecha', sort=True):
        h = V(); h['COMPROBANT'] = ("FECHA: " + dt.date.fromisoformat(fecha).strftime('%d/%m/%Y')).ljust(20)
        filas.append(h)
        cub = 0; impo = 0.0; tot = 0.0; dto = 0.0
        for r in dia.itertuples():
            g = grp.get((r.cod_cpb, r.prefijo, r.numero))
            if g is not None:
                # del resto, solo los cobros del mismo dia del comprobante
                g = g[(g.fecha == r.fecha) | (g.cod_for == '/')]
                if len(g) == 0: g = None
            n = len(g) if g is not None else 1
            # El TOTAL es lo COBRADO mas el descuento. En las ventas normales la
            # suma de cobros coincide con el total de la cabecera, pero en las
            # notas de credito no: ahi manda el cobro.
            cobrado = sum(imp(x) for x in g.importe) if g is not None else None
            base = cobrado if cobrado not in (None, 0) else imp(r.total)
            T, D = round(base + imp(r.imp_dto), 2), imp(r.imp_dto)
            mesa = r.mesa.strip()
            for i in range(n):
                cb = g.iloc[i] if g is not None else None
                v = V(); ultimo = (i == n - 1)
                if i == 0:
                    v['TURNO'] = TURNO.get(r.turno, '   ')
                    v['COMPROBANT'] = ("  %-3s %04d-%08d " % (CPB.get(r.cod_cpb, r.cod_cpb), int(r.prefijo), int(r.numero)))
                    hs = r.hora_sal.strip()
                    v['HORA'] = dt.time(int(hs[:2]), int(hs[3:5])) if len(hs) >= 5 else ' '*5
                    v['TIPO'] = TIPO.get(r.cod_ctv, '     ').ljust(5)
                    v['MESA'] = int(mesa) if mesa.isdigit() else mesa.rjust(4)
                    v['MOZO'] = " %3s.%-15s" % (r.cod_emp, MOZO.get(r.cod_emp, ''))
                    v['CUB'] = num(r.cubiertos)
                    cn, cr, cu = CLI.get(r.cod_cli.strip(), ('', '', ''))
                    v['CLINOMBRE'] = cn.ljust(50)[:50]
                    v['CLIRAZON']  = cr.ljust(35)[:35]
                    v['CLICUIT']   = cu.ljust(35)[:35]
                if cb is not None:
                    ref = cb.referencia.strip()
                    nom = ref if (usar_referencia and RE_CPB.match(ref)) else FOR.get(cb.cod_for, '')
                    v['COBRO'] = nom.ljust(17)[:17]
                    v['COD_COBRO'] = cb.cod_for
                    v['IMPORTE'] = imp(cb.importe)
                    v['CUPON'] = num(cb.cupon)
                if ultimo:
                    v['TOTAL'] = T; v['DESCUENTO'] = D
                v['FECHA'] = dt.date.fromisoformat(fecha)
                filas.append(v)
            cub += num(r.cubiertos); tot += T; dto += D
            impo += sum(imp(x) for x in g.importe) if g is not None else 0
        filas.append(V())
        t = V(); t['COMPROBANT'] = "TOTALES DEL DIA:".ljust(20)
        t['CUB'], t['IMPORTE'], t['TOTAL'], t['DESCUENTO'] = cub, round(impo,2), round(tot,2), round(dto,2)
        filas.append(t)
        filas.append(V())
        gcub += cub
        gimp = round(gimp + round(impo,2), 2); gtot = round(gtot + round(tot,2), 2)
        gdto = round(gdto + round(dto,2), 2)
    tg = V(); tg['COMPROBANT'] = "TOTALES GENERALES:".ljust(20)
    tg['CUB'], tg['IMPORTE'], tg['TOTAL'], tg['DESCUENTO'] = gcub, round(gimp,2), round(gtot,2), round(gdto,2)
    filas.append(tg)
    df = pd.DataFrame(filas)
    # MaxiRest exporta el texto rellenado a ancho fijo, pero Excel guarda como
    # NUMERO toda celda cuyo contenido parezca un numero (p.ej. el mozo "  1."
    # de un empleado sin nombre queda como el numero 1).
    def celda(v):
        if not isinstance(v, str) or not v.strip(): return v
        try:
            n = float(v); return int(n) if n % 1 == 0 else n
        except ValueError: return v
    for col in ('TURNO','COMPROBANT','TIPO','MESA','MOZO','COBRO','COD_COBRO',
                'CLINOMBRE','CLIRAZON','CLICUIT','NOMBRESUC'):
        df[col] = df[col].map(celda)
    return df
