// routes/admin.routes.js
const express = require('express');
const r = express.Router();
const adminCtrl = require('../controllers/adminController');

r.get('/overview', adminCtrl.overview);
r.get('/users',    adminCtrl.listUsers);
r.patch('/users/:id', adminCtrl.updateUser);
r.delete('/users/:id', adminCtrl.softDeleteUser);
r.post('/users/:id/reset-password', adminCtrl.resetPassword);

module.exports = r;

