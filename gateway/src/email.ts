import nodemailer from 'nodemailer';
import { GatewayConfig } from './config';

export interface EmailResult {
  sent: boolean;
  error?: string;
}

/* Nodemailer transport selection mirrors softaware-apis so the gateway can
   reuse the same Gmail app-password or generic SMTP credentials. */
export function buildTransportOptions(config: Pick<GatewayConfig,
  'emailProvider' | 'gmailUser' | 'gmailAppPassword' | 'smtpHost' | 'smtpPort' | 'smtpSecure' | 'smtpUser' | 'smtpPass'
>) {
  if (config.emailProvider === 'gmail') {
    return {
      service: 'gmail',
      auth: { user: config.gmailUser, pass: config.gmailAppPassword }
    };
  }
  return {
    host: config.smtpHost,
    port: config.smtpPort,
    secure: config.smtpSecure,
    auth: config.smtpUser || config.smtpPass ? { user: config.smtpUser, pass: config.smtpPass } : undefined
  };
}

function hasEmailConfig(config: GatewayConfig): boolean {
  if (!config.emailFrom) {
    return false;
  }
  return config.emailProvider === 'gmail'
    ? Boolean(config.gmailUser && config.gmailAppPassword)
    : Boolean(config.smtpHost);
}

export function buildTokenEmailText(config: Pick<GatewayConfig, 'defaultDailyLimit'>, token: string): string {
  return [
    'Your Token Optimizer gateway access has been approved.',
    '',
    `Access token: ${token}`,
    '',
    'Recommended setup:',
    '1. Open a terminal outside any Token Optimizer source checkout.',
    '2. Run:',
    '   cd $HOME',
    `   npx --yes @softawarest/token-optimizer-installer config --token ${token}`,
    '3. Restart your client so it loads the updated MCP configuration.',
    '',
    `Your token allows ${config.defaultDailyLimit} tool calls per day by default.`,
    'Keep this token secret. It can be revoked by the gateway operator.'
  ].join('\n');
}

/* Approved tokens are sent only through configured transports. Delivery
   failures return a safe status so the admin response can show its existing
   one-time manual-token fallback without exposing credentials. */
export async function sendTokenEmail(config: GatewayConfig, to: string, token: string): Promise<EmailResult> {
  if (!hasEmailConfig(config)) {
    return { sent: false, error: 'email delivery not configured' };
  }
  const text = buildTokenEmailText(config, token);
  try {
    const transporter = nodemailer.createTransport(buildTransportOptions(config));
    await transporter.sendMail({
      from: config.emailFrom,
      replyTo: config.emailReplyTo,
      to,
      subject: 'Your token-optimizer access token',
      text
    });
    return { sent: true };
  } catch (err) {
    return { sent: false, error: err instanceof Error ? err.message : 'email delivery failed' };
  }
}
