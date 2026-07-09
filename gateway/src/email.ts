import { GatewayConfig } from './config';

export interface EmailResult {
  sent: boolean;
  error?: string;
}

/* Token delivery via the Resend HTTP API (a single fetch; keeps the gateway
   zero-dependency). When RESEND_API_KEY / EMAIL_FROM are not configured the
   caller falls back to manual delivery: the admin dashboard shows the plaintext
   token once so the operator can send it themselves. */
export async function sendTokenEmail(
  config: GatewayConfig,
  to: string,
  token: string,
  doFetch: typeof fetch = fetch
): Promise<EmailResult> {
  if (!config.resendApiKey || !config.emailFrom) {
    return { sent: false, error: 'email delivery not configured' };
  }
  const text = [
    'Your token-optimizer gateway access token was approved.',
    '',
    `Access token: ${token}`,
    '',
    `It allows ${config.defaultDailyLimit} tool calls per day by default.`,
    'Configure it with: npm run gateway:config -- setup',
    '(or set LLM_GATEWAY_TOKEN in your client environment).',
    '',
    'Keep this token secret. It can be revoked by the gateway operator.'
  ].join('\n');
  try {
    const response = await doFetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.resendApiKey}`
      },
      body: JSON.stringify({
        from: config.emailFrom,
        to: [to],
        subject: 'Your token-optimizer access token',
        text
      })
    });
    if (!response.ok) {
      return { sent: false, error: `email provider responded ${response.status}` };
    }
    return { sent: true };
  } catch (err) {
    return { sent: false, error: err instanceof Error ? err.message : String(err) };
  }
}
