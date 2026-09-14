import { betterAuth } from 'better-auth'
import { prismaAdapter } from 'better-auth/adapters/prisma'
import { bearer, emailOTP } from 'better-auth/plugins'
import { prisma } from './prisma.js'
import { sendEmail } from './email.js'
import { trustedOrigins } from './trusted-origins.js'

// Root domain shared by the Next.js app and this backend (e.g. ".example.com"),
// so the session cookie set here is also visible on the apex domain.
// Leave unset in local development, where frontend and backend aren't on subdomains.
const cookieDomain = process.env.COOKIE_DOMAIN

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
    bearer()
  ]
})

export type Session = typeof auth.$Infer.Session
