import 'dotenv/config'
import { Hono } from 'hono'
import { serve } from '@hono/node-server'
import { cors } from 'hono/cors'
import { auth } from './lib/auth.js'
import { trustedOrigins } from './lib/trusted-origins.js'
import { nativeAppSchemes } from './lib/native-app-schemes.js'
import { glpiRoutes } from './routes/glpi.js'

const app = new Hono()

app.use(
  '/api/auth/*',
  cors({
    origin: trustedOrigins,
    allowHeaders: ['Content-Type', 'Authorization'],
    allowMethods: ['GET', 'POST', 'OPTIONS'],
    exposeHeaders: ['set-auth-token'],
    credentials: true
  })
)

app.all('/api/auth/*', (c) => auth.handler(c.req.raw))

app.route('/api/glpi', glpiRoutes)

// Browser-only leg of the OAuth-for-native flow. Native clients pass this as
// the sign-in `callbackURL` (with `?returnTo=<app-deep-link>` appended), so
// after the OAuth redirect lands here — same-origin, carrying the session
// cookie the callback just set, which the app's own HTTP client never sees —
// it's traded for a one-time-token appended to the app's deep link.
app.get('/native-oauth-bridge', async (c) => {
  const returnTo = c.req.query('returnTo')
  if (!returnTo || !nativeAppSchemes.some((scheme) => returnTo.startsWith(scheme))) {
    return c.text('Invalid or untrusted returnTo', 400)
  }

  try {
    const { token } = await auth.api.generateOneTimeToken({
      headers: c.req.raw.headers
    })
    const separator = returnTo.includes('?') ? '&' : '?'
    return c.redirect(`${returnTo}${separator}token=${encodeURIComponent(token)}`, 302)
  } catch {
    return c.text('No active session', 401)
  }
})

app.get('/', (c) => {
  return c.text('Backbone API is running.')
})

// Vercel's Node runtime calls `app.fetch` directly from the default export
// below and needs no listener of its own — only start one for local dev
// (`pnpm dev`). Binds 0.0.0.0 by default so physical devices on the same LAN
// (e.g. the Kotlin/Android app) can reach it, not just this machine; override
// with HOST if that's not wanted.
if (!process.env.VERCEL) {
  const port = Number(process.env.PORT ?? 3000)
  const hostname = process.env.HOST ?? '0.0.0.0'
  serve({ fetch: app.fetch, port, hostname }, (info) => {
    console.log(`Backbone API listening on http://${info.address}:${info.port}`)
  })
}

export default app
