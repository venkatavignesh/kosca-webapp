const express = require('express');
const router = express.Router();
const { requireRole } = require('../../middleware/auth');
const prisma = require('../../prisma');
const bcrypt = require('bcrypt');
const logger = require('../../logger');
const { validate, createUserSchema, editUserSchema } = require('../../validation');

const adminOnly = requireRole(['ADMIN']);

// Render the users management dashboard
router.get('/users', adminOnly, async (req, res) => {
    try {
        const users = await prisma.user.findMany({
            orderBy: { createdAt: 'desc' },
        });
        res.render('admin/users', { users });
    } catch (error) {
        logger.error({ err: error, route: 'GET /admin/users' }, 'Error fetching users');
        res.status(500).render('error', {
            message: 'Internal Server Error',
            details: 'Could not fetch users list from database.',
        });
    }
});

// Create a new user
router.post('/users', adminOnly, validate(createUserSchema), async (req, res) => {
    try {
        const { name, email, password, role, modules: assignedModules } = req.validated;

        const hashedPassword = await bcrypt.hash(password, 10);

        await prisma.user.create({
            data: {
                name,
                email,
                password: hashedPassword,
                role,
                modules: assignedModules,
            },
        });

        res.redirect('/admin/users');
    } catch (error) {
        if (error.code === 'P2002') {
            return res.status(400).render('error', {
                message: 'User Creation Failed',
                details: 'A user with that email already exists.',
            });
        }
        res.status(500).send('Error creating user');
    }
});

// Edit a user
router.post('/users/:id/edit', adminOnly, validate(editUserSchema), async (req, res) => {
    try {
        const userId = req.params.id;
        const { name, email, password, role, modules: assignedModules } = req.validated;

        const updateData = {
            name,
            email,
            role,
            modules: assignedModules,
        };

        if (password) {
            updateData.password = await bcrypt.hash(password, 10);
        }

        await prisma.user.update({
            where: { id: userId },
            data: updateData,
        });

        res.redirect('/admin/users');
    } catch (error) {
        logger.error({ err: error, route: 'POST /admin/users/:id/edit', userId: req.params.id }, 'Error updating user');

        if (error.code === 'P2002') {
            return res.status(400).render('error', {
                message: 'User Update Failed',
                details: 'Another user is already using that email.',
            });
        }

        res.status(500).render('error', {
            message: 'Internal Server Error',
            details: 'Could not update user information.',
        });
    }
});

// Delete a user
router.post('/users/:id/delete', adminOnly, async (req, res) => {
    try {
        const userId = req.params.id;

        // Prevent admin suicide
        if (userId === req.session.userId) {
            return res.status(400).send('You cannot delete your own active admin account.');
        }

        // Prevent non-ADMIN from deleting ADMIN accounts
        const targetUser = await prisma.user.findUnique({ where: { id: userId }, select: { role: true } });
        if (targetUser?.role === 'ADMIN' && req.session.userRole !== 'ADMIN') {
            return res.status(403).send('Only admins can delete admin accounts.');
        }

        await prisma.user.delete({
            where: { id: userId },
        });

        res.redirect('/admin/users');
    } catch (error) {
        logger.error(
            { err: error, route: 'POST /admin/users/:id/delete', userId: req.params.id },
            'Error deleting user'
        );
        res.status(500).send('Error deleting user');
    }
});

module.exports = router;
