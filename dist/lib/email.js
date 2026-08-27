import { Resend } from 'resend';
const resend = new Resend(process.env.RESEND_API_KEY);
const from = process.env.RESEND_FROM_EMAIL ?? 'onboarding@resend.dev';
export async function sendEmail({ to, subject, html }) {
    const { error } = await resend.emails.send({ from, to, subject, html });
    if (error) {
        console.error('Failed to send email:', error);
    }
}
