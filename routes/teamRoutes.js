// routes/teamRoutes.js
const router = require('express').Router();
const { authRequired } = require('../middleware/authMiddleware');
const team = require('../controllers/teamController');

// Listado
router.get('/members', authRequired, team.listMembers);
router.get('/invitations', authRequired, team.listPendingInvitations);
router.get('/known-people', authRequired, team.listKnownPeople);

// Invitaciones
router.post('/invitations', authRequired, team.createInvitation);
router.post('/invitations/:assignmentId/resend', authRequired, team.resendInvitation);

// Assignments (edición / revocación)
router.patch('/assignments/:assignmentId', authRequired, team.updateAssignment);
router.delete('/assignments/:assignmentId', authRequired, team.revokeAssignment);

module.exports = router;