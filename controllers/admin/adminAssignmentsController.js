// controllers/admin/adminAssignmentsController.js
//
// Acciones "en nombre de un usuario" (opción de gestión, nunca de datos de
// negocio): revocar o cambiar el rol de una asignación de staff puntual,
// cuando el dueño/admin del negocio no puede hacerlo él mismo. Mismo criterio
// que teamController.js (revokeAssignment/updateAssignment) pero sin las
// validaciones de "el caller debe ser owner/admin del scope" — el admin de
// plataforma no lo es, y actúa igual, siempre auditado.

const pool = require('../../config/db');
const { logAudit } = require('../../services/audit/auditLog');

exports.revokeAssignment = async (req, res) => {
  const client = await pool.connect();
  try {
    const assignmentId = Number(req.params.id);
    if (!assignmentId) return res.status(400).json({ error: 'invalid_id' });

    const { rows } = await client.query(
      `SELECT * FROM user_assignments WHERE id = $1 LIMIT 1`,
      [assignmentId]
    );
    if (!rows.length) return res.status(404).json({ error: 'not_found' });
    const a = rows[0];

    if (a.role === 'owner') {
      return res.status(403).json({ error: 'cannot_revoke_owner' });
    }

    await client.query('BEGIN');
    await client.query(
      `UPDATE user_assignments SET revoked_at = NOW(), updated_at = NOW() WHERE id = $1`,
      [assignmentId]
    );

    await logAudit(client, {
      userId: req.user?.id || null,
      businessId: a.scope_type === 'business' ? a.scope_id : null,
      organizationId: a.scope_type === 'organization' ? a.scope_id : null,
      entityType: 'team_member',
      entityId: assignmentId,
      action: 'delete',
      diff: { before: { alias: a.alias, role: a.role, user_id: a.user_id } },
      metadata: { source: 'admin_panel' },
    });

    await client.query('COMMIT');
    res.json({ ok: true });
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch {}
    console.error('[admin revokeAssignment]', e);
    res.status(500).json({ error: 'internal' });
  } finally {
    client.release();
  }
};

exports.updateAssignmentRole = async (req, res) => {
  const client = await pool.connect();
  try {
    const assignmentId = Number(req.params.id);
    const { role } = req.body || {};
    if (!assignmentId) return res.status(400).json({ error: 'invalid_id' });
    if (!['admin', 'staff'].includes(role)) {
      return res.status(400).json({ error: 'invalid_role' });
    }

    const { rows } = await client.query(
      `SELECT * FROM user_assignments WHERE id = $1 LIMIT 1`,
      [assignmentId]
    );
    if (!rows.length) return res.status(404).json({ error: 'not_found' });
    const a = rows[0];

    if (a.role === 'owner') {
      return res.status(403).json({ error: 'cannot_modify_owner' });
    }

    await client.query('BEGIN');
    const { rows: updated } = await client.query(
      `UPDATE user_assignments SET role = $1, updated_at = NOW() WHERE id = $2 RETURNING *`,
      [role, assignmentId]
    );

    await logAudit(client, {
      userId: req.user?.id || null,
      businessId: a.scope_type === 'business' ? a.scope_id : null,
      organizationId: a.scope_type === 'organization' ? a.scope_id : null,
      entityType: 'team_member',
      entityId: assignmentId,
      action: 'update',
      diff: { before: { role: a.role }, after: { role: updated[0].role } },
      metadata: { source: 'admin_panel' },
    });

    await client.query('COMMIT');
    res.json({ ok: true, assignment: updated[0] });
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch {}
    console.error('[admin updateAssignmentRole]', e);
    res.status(500).json({ error: 'internal' });
  } finally {
    client.release();
  }
};
