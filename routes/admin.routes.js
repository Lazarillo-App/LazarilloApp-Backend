const express = require('express');
const r = express.Router();
const admin = require('../controllers/adminController');
const requireAdmin = require('../middleware/requireAdmin');

// Todas requieren admin
r.get('/overview', requireAdmin, admin.overview);
r.get('/users', requireAdmin, admin.listUsers);
r.patch('/users/:id', requireAdmin, admin.updateUser);
r.delete('/users/:id', requireAdmin, admin.softDeleteUser);
r.post('/users/:id/reset-password', requireAdmin, admin.resetPassword);

module.exports = r;
