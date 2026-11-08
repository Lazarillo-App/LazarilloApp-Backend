# -*- coding: utf-8 -*-
"""
Informe 71 - CTA POR COMPROBANTE (cuenta corriente de CLIENTES, por comprobante).

Reconstruido el 25/09/2026 contra el 71 real de San Justo (1.145 filas).
Sale de mxctc (cobros) + mxfac (comprobante) + mxcli (cliente) + mxfor (forma).

  ORDEN 1 = lo que se fue a CUENTA CORRIENTE: fila de mxctc con cod_for '/'
            y pago vacio (o 'a' = anulada por una NC). TOTAL = importe de esa fila.
  ORDEN 2 = cada COBRANZA de esa deuda: fila de mxctc con cod_for '/' y pago =
            la forma con que se cobro ('*' efectivo, 'W' transferencia, ...).
            FECHACOB = fecha del cobro, COBRANZA = nombre de la forma, IMPORTE.
            Los pagos "a cuenta" sin comprobante son cod_cpb 'P' ("Pag").
  Es acumulativo (todo el historico), sin corte por año.

Columnas fijas que MaxiRest deja vacias o en cero: PUNTOS, NUMOPERA,
CATEGORIA (6 espacios), SECTOR (200 espacios).
COBRADOR sale de mxctc.cobrador y TELCLI de mxcli.telefono (si la consulta
no los trae todavia, van en 0 / vacio).
"""
import pandas as pd, openpyxl
from openpyxl.cell.cell import ILLEGAL_CHARACTERS_RE

ETIQ = {'Y': 'FcC', 'B': 'Tic', 'P': 'Pag', '_': 'NCC', 'X': 'FcA', 'Z': 'NCA',
        '7': 'FcB', '9': 'NCB', '6': 'FcA', '8': 'NCA', 'A': 'FcA'}


def _pad(s, n):
    return ('' if s is None else str(s))[:n].ljust(n)


def _num_o_texto(s, n):
    # MaxiRest: si el texto parece numero, Excel lo guarda como NUMERO
    t = ('' if s is None else str(s)).strip()
    if t.isdigit() and len(t) < 16:
        return int(t)
    return _pad(s, n)


def _i(x):
    try:
        return int(float(x))
    except Exception:
        return 0


def _f(x):
    try:
        return round(float(x), 2)
    except Exception:
        return 0.0


def generar_71(B, salida=None):
    ctc = pd.read_csv(B + "21_ventas_cobros.tsv", sep="\t", dtype=str, keep_default_na=False)
    fac = pd.read_csv(B + "20_ventas_cab.tsv",    sep="\t", dtype=str, keep_default_na=False)
    cli = pd.read_csv(B + "17_clientes.tsv",      sep="\t", dtype=str, keep_default_na=False)
    fr  = pd.read_csv(B + "06_formas_cobro.tsv",  sep="\t", dtype=str, keep_default_na=False)
    # 07/11/2026: un telefono de Canchas Ramos traia un caracter de control
    # (0x02) pegado adelante y openpyxl cortaba todo el 71. Se limpian los textos
    # al leer: el telefono queda "1169190597" y sale como NUMERO, igual que los
    # demas.
    ctc, fac, cli, fr = (d.replace(ILLEGAL_CHARACTERS_RE, '', regex=True) for d in (ctc, fac, cli, fr))

    fnom = dict(zip(fr.codigo, fr.nombre)); ftip = dict(zip(fr.codigo, fr.tipo))
    cnom = dict(zip(cli.codigo, cli.nombre))
    ctel = dict(zip(cli.codigo, cli['telefono'])) if 'telefono' in cli.columns else {}
    fac['k'] = fac.cod_suc + '|' + fac.cod_cpb + '|' + fac.prefijo + '|' + fac.numero
    fac = fac.drop_duplicates('k', keep='first').set_index('k')

    c = ctc[ctc.cod_for == '/'].copy()
    c['k'] = c.cod_suc + '|' + c.cod_cpb + '|' + c.prefijo + '|' + c.numero
    c['orden'] = [1 if p in ('', 'a') else 2 for p in c.pago]

    filas = []
    for r in c.itertuples():
        fa = fac.loc[r.k] if r.k in fac.index else None
        o1 = r.orden == 1
        forma = r.cod_for if o1 else r.pago
        fcomp = fa['fecha'] if fa is not None else r.fecha
        filas.append({
            'ORDEN': r.orden,
            'FECHA': pd.to_datetime(fcomp, errors='coerce'),
            'COMPROBANT': '%s %04d-%08d ' % (ETIQ.get(r.cod_cpb, r.cod_cpb.ljust(3)[:3]), _i(r.prefijo), _i(r.numero)),
            'TOTAL': _f(r.importe) if o1 else 0,
            'FECHACOB': None if o1 else pd.to_datetime(r.fecha, errors='coerce'),
            'COBRANZA': _pad('' if o1 else fnom.get(r.pago, ''), 30),
            'RECIBO': 0 if o1 else _i(r.recibo),
            'IMPORTE': 0 if o1 else _f(r.importe),
            'NOMCLI': _pad(cnom.get(r.cod_cli, ''), 50),
            'TELCLI': _num_o_texto(ctel.get(r.cod_cli, ''), 40),
            'MESA': _num_o_texto(fa['mesa'] if fa is not None else '', 8),
            'CUBIERTOS': _i(fa['cubiertos']) if fa is not None else 0,
            'TURNO': _i(fa['turno'] if fa is not None else r.turno),
            'COD_CPB': _pad(r.cod_cpb, 2),
            'PREFIJO': _i(r.prefijo),
            'NUMERO': _i(r.numero),
            'COD_SUC': _i(r.cod_suc),
            'COD_CTV': _pad(fa['cod_ctv'] if fa is not None else '', 2),
            'PUNTOS': 0,
            'REFERENCIA': _pad(r.referencia, 36),
            'CATEGORIA': _pad('', 6),
            'COD_FOR': _pad(forma, 2),
            'COBRADOR': 0 if o1 else _i(getattr(r, 'cobrador', 0)),
            'COD_EMP': _i(fa['cod_emp']) if fa is not None else 0,
            'PAGO': _pad(r.pago, 2),
            'SECTOR': _pad('', 200),
            'COD_CLI': _i(r.cod_cli),
            'IDFAC': _i(fa['id']) if fa is not None else 0,
            'TIPFOR': _pad(ftip.get(forma, ''), 2),
            'NUMOPERA': 0,
            'CUPON': _i(r.cupon),
            '_id': _i(r.id),
            '_ref': str(r.referencia).strip(),
        })
    out = pd.DataFrame(filas)
    if len(out):
        out = out.sort_values(['COD_CLI', 'FECHA', 'COMPROBANT', 'ORDEN', 'FECHACOB', 'PAGO', 'RECIBO', '_id'],
                              kind='stable', na_position='first')
        out = out.drop(columns=['_id', '_ref']).reset_index(drop=True)
    if salida:
        wb = openpyxl.Workbook(); ws = wb.active; ws.title = 'Hoja1'
        ws.append(list(out.columns) if len(out) else ['ORDEN'])
        for fila in out.itertuples(index=False):
            ws.append([None if (isinstance(v, float) and v != v) or v is pd.NaT else
                       (v.to_pydatetime() if isinstance(v, pd.Timestamp) else v) for v in fila])
        for col in ('B', 'E'):
            for cel in ws[col][1:]:
                cel.number_format = 'mm-dd-yy'
        wb.save(salida)
    return out
