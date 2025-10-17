const express = require('express');
const r = express.Router();

const adminCtrl = require('../controllers/adminController');
const { authRequired } = require('../middleware/authMiddleware');
const requireAppAdmin = require('../middleware/requireAppAdmin');

r.use(authRequired, requireAppAdmin);

r.get('/overview', adminCtrl.overview);
r.get('/users',    adminCtrl.listUsers);
r.patch('/users/:id', adminCtrl.updateUser);
r.delete('/users/:id', adminCtrl.softDeleteUser);
r.post('/users/:id/reset-password', adminCtrl.resetPassword);
r.post('/users/:id/restore', adminCtrl.restoreUser);

module.exports = r;
