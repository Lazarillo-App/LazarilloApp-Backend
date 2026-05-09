'use strict';

const pool = require('../config/db');
const { fetchMaxiPriceLists } = require('../services/maxiPriceListsService');
const getBusinessId = require('../utils/getBusinessId');

// ── Helper: resuelve el bizId raíz para credenciales Maxi ──
async function resolveCredsBizId(bizId) {
    const { rows } = await pool.query(
        'SELECT created_from, organization_id FROM app_businesses WHERE id = $1',
        [bizId]
    );
    const biz = rows[0];
    if (!biz || biz.created_from !== 'from_group' || !biz.organization_id) return bizId;
    const { rows: rootRows } = await pool.query(
        `SELECT id FROM app_businesses
      WHERE organization_id = $1
        AND (created_from IS NULL OR created_from = 'manual' OR created_from = 'onboarding')
      ORDER BY id ASC LIMIT 1`,
        [biz.organization_id]
    );
    return rootRows[0]?.id ?? bizId;
}

// ── Helper: resuelve organization_id desde un bizId ──
async function resolveOrgId(bizId) {
    const { rows } = await pool.query(
        'SELECT organization_id FROM app_businesses WHERE id = $1',
        [bizId]
    );
    return rows[0]?.organization_id ?? null;
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/organizations/:orgId/price-lists/config
// Devuelve la config de las 4 listas para la org
// ─────────────────────────────────────────────────────────────────────────────
exports.getOrgPriceListConfig = async (req, res, next) => {
    try {
        const orgId = Number(req.params.orgId);
        if (!orgId) return res.status(400).json({ ok: false, error: 'orgId inválido' });

        const { rows } = await pool.query(
            `SELECT list_number, alias, is_principal, discount_pct
         FROM org_price_list_config
        WHERE organization_id = $1
        ORDER BY list_number ASC`,
            [orgId]
        );

        // Devolver las 4 listas siempre (con defaults si no existen)
        const config = [1, 2, 3, 4].map(n => {
            const found = rows.find(r => r.list_number === n);
            return {
                listNumber: n,
                alias: found?.alias ?? `Lista ${n}`,
                isPrincipal: found?.is_principal ?? (n === 1),
                discountPct: found?.discount_pct != null ? Number(found.discount_pct) : null,
            };
        });

        return res.json({ ok: true, config });
    } catch (e) {
        console.error('[getOrgPriceListConfig]', e);
        next(e);
    }
};

// ─────────────────────────────────────────────────────────────────────────────
// PUT /api/organizations/:orgId/price-lists/config
// Body: { lists: [{ listNumber, alias, isPrincipal, discountPct }] }
// ─────────────────────────────────────────────────────────────────────────────
exports.saveOrgPriceListConfig = async (req, res, next) => {
    const client = await pool.connect();
    try {
        const orgId = Number(req.params.orgId);
        if (!orgId) return res.status(400).json({ ok: false, error: 'orgId inválido' });

        const lists = Array.isArray(req.body?.lists) ? req.body.lists : [];
        if (!lists.length) return res.status(400).json({ ok: false, error: 'lists requerido' });

        // Validar que solo haya una principal
        const principals = lists.filter(l => l.isPrincipal);
        if (principals.length !== 1) {
            return res.status(400).json({ ok: false, error: 'Debe haber exactamente una lista principal' });
        }

        await client.query('BEGIN');

        for (const l of lists) {
            const n = Number(l.listNumber);
            if (!Number.isFinite(n) || n < 1 || n > 4) continue;

            await client.query(
                `INSERT INTO org_price_list_config
           (organization_id, list_number, alias, is_principal, discount_pct, updated_at)
         VALUES ($1, $2, $3, $4, $5, NOW())
         ON CONFLICT (organization_id, list_number)
         DO UPDATE SET
           alias        = EXCLUDED.alias,
           is_principal = EXCLUDED.is_principal,
           discount_pct = EXCLUDED.discount_pct,
           updated_at   = NOW()`,
                [orgId, n, l.alias || `Lista ${n}`, !!l.isPrincipal, l.discountPct ?? null]
            );
        }

        await client.query('COMMIT');
        return res.json({ ok: true });
    } catch (e) {
        await client.query('ROLLBACK').catch(() => { });
        console.error('[saveOrgPriceListConfig]', e);
        next(e);
    } finally {
        client.release();
    }
};

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/businesses/:businessId/price-list
// Devuelve qué lista usa este negocio
// ─────────────────────────────────────────────────────────────────────────────
exports.getBusinessPriceList = async (req, res, next) => {
    try {
        const bizId = Number(req.params.businessId);
        if (!bizId) return res.status(400).json({ ok: false, error: 'businessId inválido' });

        const { rows } = await pool.query(
            'SELECT list_number FROM business_price_list WHERE business_id = $1',
            [bizId]
        );

        return res.json({ ok: true, listNumber: rows[0]?.list_number ?? 1 });
    } catch (e) {
        next(e);
    }
};

// ─────────────────────────────────────────────────────────────────────────────
// PUT /api/businesses/:businessId/price-list
// Body: { listNumber: 1|2|3|4 }
// ─────────────────────────────────────────────────────────────────────────────
exports.setBusinessPriceList = async (req, res, next) => {
    try {
        const bizId = Number(req.params.businessId);
        const listNumber = Number(req.body?.listNumber);

        if (!bizId || !Number.isFinite(listNumber) || listNumber < 1 || listNumber > 4) {
            return res.status(400).json({ ok: false, error: 'parámetros inválidos' });
        }

        await pool.query(
            `INSERT INTO business_price_list (business_id, list_number, updated_at)
       VALUES ($1, $2, NOW())
       ON CONFLICT (business_id)
       DO UPDATE SET list_number = EXCLUDED.list_number, updated_at = NOW()`,
            [bizId, listNumber]
        );

        return res.json({ ok: true, listNumber });
    } catch (e) {
        next(e);
    }
};

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/businesses/:businessId/price-list/prices
// Trae los precios desde Maxi para la lista activa del negocio
// Devuelve Map: { [codigo]: precio }
// ─────────────────────────────────────────────────────────────────────────────
exports.getBusinessPrices = async (req, res, next) => {
    try {
        const bizId = Number(req.params.businessId);
        if (!bizId) return res.status(400).json({ ok: false, error: 'businessId inválido' });

        // Qué lista usa este negocio
        const { rows: listRows } = await pool.query(
            'SELECT list_number FROM business_price_list WHERE business_id = $1',
            [bizId]
        );
        const listNumber = listRows[0]?.list_number ?? 1;

        // Config de la org (para saber si hay descuento)
        const orgId = await resolveOrgId(bizId);
        let discountPct = null;
        let principalListNumber = 1;

        if (orgId) {
            const { rows: cfgRows } = await pool.query(
                `SELECT list_number, is_principal, discount_pct
           FROM org_price_list_config
          WHERE organization_id = $1`,
                [orgId]
            );
            const principal = cfgRows.find(r => r.is_principal);
            principalListNumber = principal?.list_number ?? 1;

            // Si este negocio NO usa la lista principal, puede tener descuento
            if (listNumber !== principalListNumber) {
                const thisCfg = cfgRows.find(r => r.list_number === listNumber);
                discountPct = thisCfg?.discount_pct ?? null;
            }
        }

        // Credenciales del principal
        const credsBizId = await resolveCredsBizId(bizId);

        // Fetch de Maxi
        const articles = await fetchMaxiPriceLists({ businessId: credsBizId, req });
        console.log('[getBusinessPrices] articles count:', articles.length);
        console.log('[getBusinessPrices] sample:', articles.slice(0, 2));

        // Armar respuesta: { [codigo]: { precio, precioOriginal, listNumber } }
        const priceKey = `precio${listNumber}`;
        const principalKey = `precio${principalListNumber}`;

        const prices = {};
        for (const a of articles) {
            const precio = Number(a[priceKey] ?? 0);
            const precioPrincipal = Number(a[principalKey] ?? 0);
            let precioFinal = precio;

            // Aplicar descuento si corresponde (sobre la principal)
            if (discountPct != null && discountPct !== 0 && precioPrincipal > 0) {
                precioFinal = precioPrincipal * (1 - discountPct / 100);
            }

            prices[String(a.codigo)] = {
                precio: precioFinal, precioOriginal: precio,
                precioPrincipal, listNumber,
            };
            prices[String(a.id)] = {
                precio: precioFinal, precioOriginal: precio,
                precioPrincipal, listNumber,
            };
        }

        return res.json({ ok: true, prices, listNumber, discountPct });
    } catch (e) {
        console.error('[getBusinessPrices]', e);
        next(e);
    }
};

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/organizations/:orgId/price-lists/discount-exceptions
// PUT /api/organizations/:orgId/price-lists/discount-exceptions
// Body PUT: { scope, scopeId } para agregar; DELETE para quitar
// ─────────────────────────────────────────────────────────────────────────────
exports.getDiscountExceptions = async (req, res, next) => {
    try {
        const orgId = Number(req.params.orgId);
        if (!orgId) return res.status(400).json({ ok: false, error: 'orgId inválido' });

        const { rows } = await pool.query(
            `SELECT scope, scope_id FROM price_list_discount_exceptions WHERE organization_id = $1`,
            [orgId]
        );
        return res.json({ ok: true, exceptions: rows });
    } catch (e) { next(e); }
};

exports.addDiscountException = async (req, res, next) => {
    try {
        const orgId = Number(req.params.orgId);
        const { scope, scopeId } = req.body || {};

        if (!orgId || !scope || !scopeId) {
            return res.status(400).json({ ok: false, error: 'parámetros inválidos' });
        }

        await pool.query(
            `INSERT INTO price_list_discount_exceptions (organization_id, scope, scope_id)
       VALUES ($1, $2, $3)
       ON CONFLICT (organization_id, scope, scope_id) DO NOTHING`,
            [orgId, scope, String(scopeId)]
        );
        return res.json({ ok: true });
    } catch (e) { next(e); }
};

exports.removeDiscountException = async (req, res, next) => {
    try {
        const orgId = Number(req.params.orgId);
        const { scope, scopeId } = req.body || {};

        if (!orgId || !scope || !scopeId) {
            return res.status(400).json({ ok: false, error: 'parámetros inválidos' });
        }

        await pool.query(
            `DELETE FROM price_list_discount_exceptions
        WHERE organization_id = $1 AND scope = $2 AND scope_id = $3`,
            [orgId, scope, String(scopeId)]
        );
        return res.json({ ok: true });
    } catch (e) { next(e); }
};