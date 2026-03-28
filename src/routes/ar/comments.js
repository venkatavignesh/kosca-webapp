// src/routes/ar/comments.js
const express = require('express');
const router = express.Router();
const prisma = require('../../prisma');
const { requireAuth, requireModule, requireRole } = require('../../middleware/auth');
const logger = require('../../logger');
const { validate, commentSchema } = require('../../validation');

// ======== COLLECTION COMMENTS ========

// Helper to build N-level comment trees
async function fetchStructuredComments(customerCode) {
    const allComments = await prisma.comment.findMany({
        where: { customerCode },
        orderBy: { createdAt: 'asc' }, // Oldest first for chronological order of replies
    });

    const commentMap = new Map();
    const rootComments = [];

    // Initialize the replies array for all comments
    allComments.forEach((c) => {
        c.replies = [];
        commentMap.set(c.id, c);
    });

    // Build the tree by attaching children to parents
    allComments.forEach((c) => {
        if (c.parentId && commentMap.has(c.parentId)) {
            commentMap.get(c.parentId).replies.push(c);
        } else {
            rootComments.push(c);
        }
    });

    // Sort top-level roots and all replies descending (newest on top)
    rootComments.sort((a, b) => b.createdAt - a.createdAt);
    commentMap.forEach((c) => c.replies.sort((a, b) => b.createdAt - a.createdAt));

    return rootComments;
}

// GET comments for a customer (HTMX partial)
router.get('/ar/comments/:customerCode', requireAuth, requireModule('ar_directory'), async (req, res) => {
    try {
        const customerCode = req.params.customerCode;
        // Fetch fully nested threaded comments
        const comments = await fetchStructuredComments(customerCode);

        // ADMIN and MANAGER can always post; USER needs ar_comments module
        const canPost =
            req.session.userRole === 'ADMIN' ||
            req.session.userRole === 'MANAGER' ||
            (req.session.userModules && req.session.userModules.includes('ar_comments'));

        res.render('partials/comment_panel', {
            comments,
            customerCode,
            canPost,
            currentUserId: req.session.userId,
            userRole: req.session.userRole,
        });
    } catch (error) {
        logger.error(
            { err: error, route: 'GET /ar/comments/:customerCode', customerCode: req.params.customerCode },
            'Error fetching comments'
        );
        res.status(500).send('<div class="text-red-500 text-sm p-4">Error loading comments</div>');
    }
});

// POST a new comment or reply
router.post('/ar/comments', requireAuth, validate(commentSchema), async (req, res) => {
    const canPost =
        req.session.userRole === 'ADMIN' ||
        req.session.userRole === 'MANAGER' ||
        (req.session.userModules && req.session.userModules.includes('ar_comments'));
    if (!canPost) {
        return res.status(403).send('<div class="text-red-500 text-sm p-4">Not authorized to post comments</div>');
    }
    try {
        const { customerCode, invoiceNo, comment, followUpDate, parentId } = req.body;

        await prisma.comment.create({
            data: {
                customerCode,
                invoiceNo: invoiceNo || null,
                comment: comment.trim(),
                followUpDate: followUpDate ? new Date(followUpDate) : null,
                parentId: parentId || null,
                createdBy: req.session.userId,
                createdByName: req.session.userName,
            },
        });

        // Refetch structured comments
        const comments = await fetchStructuredComments(customerCode);

        res.render('partials/comment_panel', {
            comments,
            customerCode,
            canPost,
            currentUserId: req.session.userId,
            userRole: req.session.userRole,
        });
    } catch (error) {
        logger.error(
            { err: error, route: 'POST /ar/comments', customerCode: req.body.customerCode },
            'Error creating comment'
        );
        res.status(500).send('<div class="text-red-500 text-sm p-4">Error saving comment</div>');
    }
});

// PUT edit an existing comment
router.put('/ar/comments/:id', requireAuth, async (req, res) => {
    try {
        const commentId = req.params.id;
        const { commentBody, customerCode, followUpDate } = req.body;

        const existing = await prisma.comment.findUnique({ where: { id: commentId } });
        if (!existing) return res.status(404).send('Comment not found');

        // Only author or ADMIN/MANAGER can edit
        const isAuthor = existing.createdBy === req.session.userId;
        const isAdminOrManager = req.session.userRole === 'ADMIN' || req.session.userRole === 'MANAGER';
        if (!isAuthor && !isAdminOrManager) {
            return res.status(403).send('<div class="text-red-500 text-sm">Not authorized to edit</div>');
        }

        await prisma.comment.update({
            where: { id: commentId },
            data: {
                comment: commentBody.trim(),
                followUpDate: followUpDate ? new Date(followUpDate) : null,
            },
        });

        // Refetch comments
        const comments = await fetchStructuredComments(customerCode);

        const canPost =
            req.session.userRole === 'ADMIN' ||
            req.session.userRole === 'MANAGER' ||
            (req.session.userModules && req.session.userModules.includes('ar_comments'));

        res.render('partials/comment_panel', {
            comments,
            customerCode,
            canPost,
            currentUserId: req.session.userId,
            userRole: req.session.userRole,
        });
    } catch (error) {
        logger.error({ err: error, route: 'PUT /ar/comments/:id', commentId: req.params.id }, 'Error editing comment');
        res.status(500).send('<div class="text-red-500 text-sm p-4">Error editing comment</div>');
    }
});

// POST to resolve a follow-up
router.post('/ar/comments/:id/resolve', requireAuth, async (req, res) => {
    try {
        const commentId = req.params.id;

        const existing = await prisma.comment.findUnique({ where: { id: commentId } });
        if (!existing) return res.status(404).send('Comment not found');

        const customerCode = (req.body || {}).customerCode || existing.customerCode;

        const isAuthor = existing.createdBy === req.session.userId;
        const isAdminOrManager = req.session.userRole === 'ADMIN' || req.session.userRole === 'MANAGER';
        if (!isAuthor && !isAdminOrManager) {
            return res
                .status(403)
                .send('<div class="text-red-500 text-sm p-4">Not authorized to resolve this comment</div>');
        }

        await prisma.comment.update({
            where: { id: commentId },
            data: { isResolved: true },
        });

        // Refetch structured comments
        const comments = await fetchStructuredComments(customerCode);

        const canPost =
            req.session.userRole === 'ADMIN' ||
            req.session.userRole === 'MANAGER' ||
            (req.session.userModules && req.session.userModules.includes('ar_comments'));

        res.render('partials/comment_panel', {
            comments,
            customerCode,
            canPost,
            currentUserId: req.session.userId,
            userRole: req.session.userRole,
        });
    } catch (error) {
        logger.error(
            { err: error, route: 'POST /ar/comments/:id/resolve', commentId: req.params.id },
            'Error resolving comment'
        );
        res.status(500).send('<div class="text-red-500 text-sm p-4">Error resolving comment</div>');
    }
});

// DELETE a single comment (ADMIN only — also removes all replies)
router.post('/ar/comments/:id/delete', requireAuth, requireRole(['ADMIN']), async (req, res) => {
    try {
        const commentId = req.params.id;

        const existing = await prisma.comment.findUnique({ where: { id: commentId } });
        const customerCode = (req.body || {}).customerCode || (existing && existing.customerCode);

        // Collect all descendant IDs via iterative BFS, then delete in one query
        const allDescendantIds = [];
        const queue = [commentId];
        while (queue.length > 0) {
            const parentId = queue.shift();
            const children = await prisma.comment.findMany({ where: { parentId }, select: { id: true } });
            for (const child of children) {
                allDescendantIds.push(child.id);
                queue.push(child.id);
            }
        }
        if (allDescendantIds.length > 0) {
            await prisma.comment.deleteMany({ where: { id: { in: allDescendantIds } } });
        }
        await prisma.comment.delete({ where: { id: commentId } });

        const comments = await fetchStructuredComments(customerCode);
        const canPost = req.session.userRole === 'ADMIN' || (req.session.userModules || []).includes('ar_comments');
        res.render('partials/comment_panel', {
            comments,
            customerCode,
            canPost,
            currentUserId: req.session.userId,
            userRole: req.session.userRole,
        });
    } catch (error) {
        logger.error(
            { err: error, route: 'POST /ar/comments/:id/delete', commentId: req.params.id },
            'Error deleting comment'
        );
        res.status(500).send('<div class="text-red-500 text-sm p-4">Error deleting comment</div>');
    }
});

// DELETE all comments for a customer (ADMIN only)
router.post('/ar/comments/:customerCode/delete-all', requireAuth, requireRole(['ADMIN']), async (req, res) => {
    try {
        const { customerCode } = req.params;
        await prisma.comment.deleteMany({ where: { customerCode } });
        const canPost = req.session.userRole === 'ADMIN' || (req.session.userModules || []).includes('ar_comments');
        res.render('partials/comment_panel', {
            comments: [],
            customerCode,
            canPost,
            currentUserId: req.session.userId,
            userRole: req.session.userRole,
        });
    } catch (error) {
        logger.error(
            { err: error, route: 'POST /ar/comments/:customerCode/delete-all', customerCode: req.params.customerCode },
            'Error deleting all comments'
        );
        res.status(500).send('<div class="text-red-500 text-sm p-4">Error deleting comments</div>');
    }
});

module.exports = router;
