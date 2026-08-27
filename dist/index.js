import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { auth } from './lib/auth.js';
const app = new Hono();
const trustedOrigins = process.env.TRUSTED_ORIGINS
    ? process.env.TRUSTED_ORIGINS.split(',')
        .map((origin) => origin.trim())
        .filter(Boolean)
    : ['http://localhost:8081'];
app.use('/api/auth/*', cors({
    origin: trustedOrigins,
    allowHeaders: ['Content-Type', 'Authorization'],
    allowMethods: ['GET', 'POST', 'OPTIONS'],
    exposeHeaders: ['set-auth-token'],
    credentials: true
}));
app.all('/api/auth/*', (c) => auth.handler(c.req.raw));
app.get('/', (c) => {
    return c.text('Backbone API is running.');
});
export default app;
