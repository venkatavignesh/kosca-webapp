const express = require('express');
const router = express.Router();
const prisma = require('../prisma');
const { requireAuth, requireModule } = require('../middleware/auth');
const logger = require('../logger');

// Protect all assignment routes — requires ar_assign module (ADMIN bypasses)
router.use(requireAuth, requireModule('ar_assign'));

// Render assignment management page
router.get('/', async (req, res) => {
    try {
        // Get all users with role USER who have ar_directory module
        const officers = await prisma.user.findMany({
            where: { role: 'USER', modules: { has: 'ar_directory' } },
            select: { id: true, name: true, email: true },
            orderBy: { name: 'asc' }
        });

        // Get distinct customer codes from invoices
        const customerCodes = await prisma.invoice.groupBy({
            by: ['customerCode', 'customerName'],
            orderBy: { customerCode: 'asc' }
        });

        // Get all current assignments with user names
        const assignments = await prisma.customerAssignment.findMany({
            orderBy: { createdAt: 'desc' }
        });

        // Enrich assignments with user names and customer names
        const userMap = {};
        const allUsers = await prisma.user.findMany({ select: { id: true, name: true } });
        allUsers.forEach(u => { userMap[u.id] = u.name; });

        const customerMap = {};
        customerCodes.forEach(c => { customerMap[c.customerCode] = c.customerName; });

        const enrichedAssignments = assignments.map(a => ({
            ...a,
            userName: userMap[a.userId] || 'Unknown',
            customerName: customerMap[a.customerCode] || 'Unknown'
        }));

        // Group assignments by userId
        const groupedByUser = {};
        enrichedAssignments.forEach(a => {
            if (!groupedByUser[a.userId]) {
                groupedByUser[a.userId] = { userName: a.userName, assignments: [] };
            }
            groupedByUser[a.userId].assignments.push(a);
        });

        const assignedCodes = new Set(assignments.map(a => a.customerCode));

        res.render('ar/assignments', {
            officers,
            customerCodes: customerCodes.filter(c => c.customerCode && !assignedCodes.has(c.customerCode)),
            groupedByUser
        });
    } catch (error) {
        logger.error({ err: error, route: 'GET /ar/assignments' }, 'Error loading assignments');
        res.status(500).send('Error loading assignments page');
    }
});

// Assign a customer code to a CO
router.post('/', async (req, res) => {
    try {
        let { userId, customerCodes: codes } = req.body;

        if (!userId || !codes) {
            return res.redirect('/ar/assignments');
        }

        // Handle single or multiple customer codes
        if (!Array.isArray(codes)) codes = [codes];

        for (const code of codes) {
            await prisma.customerAssignment.upsert({
                where: {
                    customerCode_userId: { customerCode: code, userId }
                },
                create: {
                    customerCode: code,
                    userId,
                    assignedBy: req.session.userId
                },
                update: {} // no-op if already exists
            });
        }

        res.redirect('/ar/assignments');
    } catch (error) {
        logger.error({ err: error, route: 'POST /ar/assignments' }, 'Error creating assignment');
        res.redirect('/ar/assignments');
    }
});

// Inline toggle assignment (HTMX — returns updated badge HTML)
router.post('/toggle', async (req, res) => {
    try {
        const { customerCode, userId } = req.body;
        if (!customerCode || !userId) return res.status(400).send('Missing fields');

        const existing = await prisma.customerAssignment.findUnique({
            where: { customerCode_userId: { customerCode, userId } }
        });

        if (existing) {
            await prisma.customerAssignment.delete({ where: { id: existing.id } });
        } else {
            await prisma.customerAssignment.create({
                data: { customerCode, userId, assignedBy: req.session.userId }
            });
        }

        // Return updated assignment list for this customer
        const assignments = await prisma.customerAssignment.findMany({
            where: { customerCode },
            select: { userId: true }
        });
        const assignedIds = assignments.map(a => a.userId);

        const officers = await prisma.user.findMany({
            where: { role: 'USER', modules: { has: 'ar_directory' } },
            select: { id: true, name: true },
            orderBy: { name: 'asc' }
        });

        // Render inline HTML fragment
        const badgeHtml = assignedIds.length === 0
            ? '<span class="text-[9px] text-gray-300 italic">unassigned</span>'
            : assignedIds.map(id => {
                const o = officers.find(f => f.id === id);
                return o ? `<span class="inline-flex items-center rounded px-1.5 py-0.5 text-[9px] font-semibold bg-teal-50 text-teal-700 ring-1 ring-teal-200">${o.name}</span>` : '';
              }).join(' ');

        res.send(badgeHtml);
    } catch (error) {
        logger.error({ err: error, route: 'POST /ar/assignments/toggle' }, 'Error toggling assignment');
        res.status(500).send('Error');
    }
});

// Remove an assignment
router.post('/:id/delete', async (req, res) => {
    try {
        await prisma.customerAssignment.delete({
            where: { id: req.params.id }
        });
        res.redirect('/ar/assignments');
    } catch (error) {
        logger.error({ err: error, route: 'POST /ar/assignments/:id/delete', assignmentId: req.params.id }, 'Error deleting assignment');
        res.redirect('/ar/assignments');
    }
});

module.exports = router;
