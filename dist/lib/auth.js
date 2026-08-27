import { betterAuth } from 'better-auth';
import { prismaAdapter } from 'better-auth/adapters/prisma';
import { bearer, emailOTP } from 'better-auth/plugins';
import { expo } from '@better-auth/expo';
import { prisma } from './prisma.js';
import { sendEmail } from './email.js';
const expoScheme = process.env.EXPO_SCHEME ?? 'myapp';
export const auth = betterAuth({
    baseURL: process.env.BETTER_AUTH_URL,
    database: prismaAdapter(prisma, {
        provider: 'postgresql'
    }),
    trustedOrigins: [
        `${expoScheme}://`,
        'exp://**',
        'exp://10.0.0.*:*/**'
    ],
    emailAndPassword: {
        enabled: true,
        requireEmailVerification: true,
        sendResetPassword: async ({ user, url }) => {
            void sendEmail({
                to: user.email,
                subject: 'Redefina sua senha',
                html: `<p>Clique no link para redefinir sua senha: <a href="${url}">${url}</a></p>`
            });
        }
    },
    emailVerification: {
        sendOnSignUp: true,
        autoSignInAfterVerification: true
    },
    socialProviders: {
        microsoft: {
            clientId: process.env.MICROSOFT_CLIENT_ID,
            clientSecret: process.env.MICROSOFT_CLIENT_SECRET,
            tenantId: process.env.MICROSOFT_TENANT_ID ?? 'common'
        }
    },
    plugins: [
        expo(),
        emailOTP({
            overrideDefaultEmailVerification: true,
            async sendVerificationOTP({ email, otp, type }) {
                const subject = type === 'sign-in'
                    ? 'Seu código de login'
                    : type === 'email-verification'
                        ? 'Verifique seu email'
                        : 'Redefina sua senha';
                void sendEmail({
                    to: email,
                    subject,
                    html: `<p>Seu código é: <strong>${otp}</strong></p><p>Ele expira em 10 minutos.</p>`
                });
            }
        }),
        bearer()
    ]
});
