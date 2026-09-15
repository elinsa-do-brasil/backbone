import { betterAuth } from 'better-auth'
import { prismaAdapter } from 'better-auth/adapters/prisma'
import { bearer, emailOTP, oneTimeToken } from 'better-auth/plugins'
import { passkey } from '@better-auth/passkey'
import { prisma } from './prisma.js'
import { sendEmail } from './email.js'
import { trustedOrigins } from './trusted-origins.js'

// Root domain shared by the Next.js app and this backend (e.g. ".example.com"),
// so the session cookie set here is also visible on the apex domain.
// Leave unset in local development, where frontend and backend aren't on subdomains.
const cookieDomain = process.env.COOKIE_DOMAIN

// WebAuthn Relying Party ID: the registrable domain passkeys are bound to.
// Must be the same across the Next.js app and this backend, so it's derived
// from COOKIE_DOMAIN (without the leading dot). "localhost" is fine for dev.
const rpID = cookieDomain?.replace(/^\./, '') ?? 'localhost'

// WebAuthn origins allowed to complete passkey ceremonies. Setting this list
// at all (rather than leaving it undefined) makes better-auth check strictly
// against it instead of trusting whatever Origin header the request sends, so
// it must include every legitimate origin: the web app's (trustedOrigins) and
// native ones from PASSKEY_ORIGINS — e.g. the Kotlin/Android app's
// `android:apk-key-hash:<base64url SHA-256 of the signing cert>`.
const passkeyNativeOrigins = process.env.PASSKEY_ORIGINS
  ? process.env.PASSKEY_ORIGINS.split(',')
      .map((origin) => origin.trim())
      .filter(Boolean)
  : []
const passkeyOrigins = [...trustedOrigins, ...passkeyNativeOrigins]

export const auth = betterAuth({
  baseURL: process.env.BETTER_AUTH_URL,
  database: prismaAdapter(prisma, {
    provider: 'postgresql'
  }),
  trustedOrigins,
  advanced: cookieDomain
    ? {
        crossSubDomainCookies: {
          enabled: true,
          domain: cookieDomain
        }
      }
    : undefined,
  emailAndPassword: {
    enabled: true,
    requireEmailVerification: true,
    sendResetPassword: async ({ user, url }) => {
      void sendEmail({
        to: user.email,
        subject: 'Redefina sua senha',
        html: `<p>Clique no link para redefinir sua senha: <a href="${url}">${url}</a></p>`
      })
    }
  },
  emailVerification: {
    sendOnSignUp: true,
    autoSignInAfterVerification: true
  },
  socialProviders: {
    microsoft: {
      clientId: process.env.MICROSOFT_CLIENT_ID as string,
      clientSecret: process.env.MICROSOFT_CLIENT_SECRET as string,
      tenantId: process.env.MICROSOFT_TENANT_ID ?? 'common'
    }
  },
  plugins: [
    emailOTP({
      overrideDefaultEmailVerification: true,
      async sendVerificationOTP({ email, otp, type }) {
        const subject =
          type === 'sign-in'
            ? 'Seu código de login'
            : type === 'email-verification'
              ? 'Verifique seu email'
              : 'Redefina sua senha'
        void sendEmail({
          to: email,
          subject,
          html: `<p>Seu código é: <strong>${otp}</strong></p><p>Ele expira em 10 minutos.</p>`
        })
      }
    }),
    passkey({
      rpID,
      rpName: 'Backbone',
      origin: passkeyOrigins
    }),
    // Lets /native-oauth-bridge hand off a short-lived token to native
    // clients after a browser-based OAuth redirect (see src/index.ts),
    // since they can't read the Set-Cookie the OAuth callback response sets.
    oneTimeToken(),
    bearer()
  ]
})

export type Session = typeof auth.$Infer.Session
