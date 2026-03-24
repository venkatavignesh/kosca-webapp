// tests/routes/ar/comments.test.js
jest.mock('../../../src/prisma', () => require('../../setup').makePrismaMock());
jest.mock('../../../src/queue', () => ({
    uploadQueue: { add: jest.fn().mockResolvedValue({ id: 'mock-job-id' }) },
    connection:  { get: jest.fn().mockResolvedValue(null), set: jest.fn().mockResolvedValue('OK') }
}));

const request  = require('supertest');
const prisma   = require('../../../src/prisma');
const { makeApp } = require('../../setup');
const router   = require('../../../src/routes/ar/comments');

describe('Comment routes', () => {
    beforeEach(() => jest.clearAllMocks());

    describe('GET /ar/comments/:customerCode', () => {
        it('returns 200 and renders comment panel', async () => {
            prisma.comment.findMany.mockResolvedValue([]);
            const res = await request(makeApp(router)).get('/ar/comments/BNG001');
            expect(res.status).toBe(200);
        });

        it('returns 403 when user lacks ar_directory', async () => {
            const res = await request(makeApp(router, { userRole: 'USER', userModules: [] }))
                .get('/ar/comments/BNG001');
            expect(res.status).toBe(403);
        });
    });

    describe('POST /ar/comments', () => {
        it('returns 200 with rendered comment panel after creating comment', async () => {
            prisma.comment.create.mockResolvedValue({
                id: 'c1', customerCode: 'BNG001', comment: 'test',
                createdBy: 1, createdByName: 'Test User',
                replies: [], createdAt: new Date(), updatedAt: new Date(),
                parentId: null, followUpDate: null, resolved: false, invoiceNo: null
            });
            prisma.comment.findMany.mockResolvedValue([]);
            const res = await request(makeApp(router))
                .post('/ar/comments')
                .send({ customerCode: 'BNG001', comment: 'Test comment', invoiceNo: '', parentId: '' });
            expect(res.status).toBe(200);
            expect(res.text).toContain('<');
        });

        it('returns 403 when USER has no ar_comments module and is not ADMIN/MANAGER', async () => {
            const res = await request(makeApp(router, { userRole: 'USER', userModules: [] }))
                .post('/ar/comments')
                .send({ customerCode: 'BNG001', comment: 'Test', invoiceNo: '', parentId: '' });
            expect(res.status).toBe(403);
        });
    });

    describe('PUT /ar/comments/:id', () => {
        it('returns 200 when author edits their own comment', async () => {
            prisma.comment.findUnique.mockResolvedValue({
                id: 'c1', createdBy: 1, customerCode: 'BNG001'
            });
            prisma.comment.update.mockResolvedValue({});
            prisma.comment.findMany.mockResolvedValue([]);
            const res = await request(makeApp(router))
                .put('/ar/comments/c1')
                .send({ commentBody: 'updated', customerCode: 'BNG001', followUpDate: '' });
            expect(res.status).toBe(200);
        });

        it('returns 403 when non-author non-admin tries to edit', async () => {
            prisma.comment.findUnique.mockResolvedValue({
                id: 'c1', createdBy: 99, customerCode: 'BNG001'  // different user
            });
            const res = await request(makeApp(router, { userId: 1, userRole: 'USER', userModules: [] }))
                .put('/ar/comments/c1')
                .send({ commentBody: 'hack', customerCode: 'BNG001', followUpDate: '' });
            expect(res.status).toBe(403);
        });
    });

    describe('POST /ar/comments/:id/resolve', () => {
        it('returns 200 when author resolves their comment', async () => {
            prisma.comment.findUnique.mockResolvedValue({
                id: 'c1', createdBy: 1, resolved: false, customerCode: 'BNG001'
            });
            prisma.comment.update.mockResolvedValue({});
            prisma.comment.findMany.mockResolvedValue([]);
            const res = await request(makeApp(router)).post('/ar/comments/c1/resolve');
            expect(res.status).toBe(200);
        });

        it('returns 403 when non-author USER tries to resolve', async () => {
            prisma.comment.findUnique.mockResolvedValue({
                id: 'c1', createdBy: 99, resolved: false, customerCode: 'BNG001'
            });
            const res = await request(makeApp(router, { userId: 1, userRole: 'USER', userModules: [] }))
                .post('/ar/comments/c1/resolve');
            expect(res.status).toBe(403);
        });
    });

    describe('POST /ar/comments/:id/delete (ADMIN only)', () => {
        it('returns 200 when ADMIN deletes a comment', async () => {
            prisma.comment.findUnique.mockResolvedValue({
                id: 'c1', customerCode: 'BNG001', parentId: null
            });
            prisma.comment.findMany.mockResolvedValueOnce([]).mockResolvedValue([]);
            prisma.comment.delete.mockResolvedValue({});
            const res = await request(makeApp(router)).post('/ar/comments/c1/delete');
            expect(res.status).toBe(200);
        });

        it('returns 403 when non-ADMIN tries to delete', async () => {
            const res = await request(makeApp(router, { userRole: 'USER', userModules: [] }))
                .post('/ar/comments/c1/delete');
            expect(res.status).toBe(403);
        });
    });
});
