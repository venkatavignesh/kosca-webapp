const { z } = require('zod');

// Middleware factory: validates req.body against a Zod schema
function validate(schema) {
    return (req, res, next) => {
        const result = schema.safeParse(req.body);
        if (!result.success) {
            const message = result.error.issues.map(i => i.message).join(', ');
            if (req.headers['hx-request']) {
                return res.status(400).send(
                    `<div class="text-red-600 text-sm font-medium">${message}</div>`
                );
            }
            return res.status(400).render('error', {
                message: 'Validation Error',
                details: message,
            });
        }
        req.validated = result.data;
        next();
    };
}

// ── Schemas ──

const loginSchema = z.object({
    email: z.string().email('Please enter a valid email address'),
    password: z.string().min(1, 'Password is required'),
});

const createUserSchema = z.object({
    name: z.string().min(1, 'Name is required').max(100),
    email: z.string().email('Please enter a valid email address'),
    password: z.string().min(6, 'Password must be at least 6 characters'),
    role: z.enum(['ADMIN', 'MANAGER', 'USER']).default('USER'),
    modules: z.union([z.string(), z.array(z.string())]).optional().transform(v =>
        v ? (Array.isArray(v) ? v : [v]) : []
    ),
});

const editUserSchema = z.object({
    name: z.string().min(1, 'Name is required').max(100),
    email: z.string().email('Please enter a valid email address'),
    password: z.string().optional().transform(v => (v && v.trim() ? v : undefined)),
    role: z.enum(['ADMIN', 'MANAGER', 'USER']),
    modules: z.union([z.string(), z.array(z.string())]).optional().transform(v =>
        v ? (Array.isArray(v) ? v : [v]) : []
    ),
});

const commentSchema = z.object({
    customerCode: z.string().min(1, 'Customer code is required'),
    invoiceNo: z.string().optional().default(''),
    comment: z.string().min(1, 'Comment cannot be empty').max(5000),
    followUpDate: z.string().optional().transform(v => (v && v.trim()) ? v : null),
    parentId: z.string().optional().transform(v => v || null),
});

const siteAssignmentSchema = z.object({
    siteName: z.string().min(1, 'Site name is required'),
});

const assignmentSchema = z.object({
    customerCode: z.string().min(1, 'Customer code is required'),
    userId: z.string().min(1, 'User is required'),
});

module.exports = {
    validate,
    loginSchema,
    createUserSchema,
    editUserSchema,
    commentSchema,
    siteAssignmentSchema,
    assignmentSchema,
};
