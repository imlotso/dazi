import { createVercelHandler } from '../server/vercel.js';

// Fastify must receive the original request stream instead of a parsed body.
export const config = { api: { bodyParser: false } };
export default createVercelHandler();
