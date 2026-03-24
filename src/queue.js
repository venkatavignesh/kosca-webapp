const { Queue } = require('bullmq');
const { Redis } = require('ioredis');

const connection = new Redis(process.env.REDIS_URL || 'redis://localhost:6379', {
  maxRetriesPerRequest: null
});

const uploadQueue = new Queue('ExcelUploads', {
    connection,
    defaultJobOptions: {
        attempts: 2,
        backoff: { type: 'exponential', delay: 5000 },
        removeOnComplete: 50,
        removeOnFail: 100,
    }
});

module.exports = { uploadQueue, connection };
