import test from 'node:test';
import assert from 'node:assert/strict';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const gatewayEmail = require('../../gateway/src/email');

test('Nodemailer transport options mirror the Gmail and SMTP operator configurations', () => {
  assert.equal(typeof gatewayEmail.buildTransportOptions, 'function');

  assert.deepEqual(gatewayEmail.buildTransportOptions({
    emailProvider: 'gmail',
    gmailUser: 'mailer@example.com',
    gmailAppPassword: 'app-password'
  }), {
    service: 'gmail',
    auth: { user: 'mailer@example.com', pass: 'app-password' }
  });

  assert.deepEqual(gatewayEmail.buildTransportOptions({
    emailProvider: 'smtp',
    smtpHost: 'smtp.example.com',
    smtpPort: 587,
    smtpSecure: false,
    smtpUser: 'mailer@example.com',
    smtpPass: 'smtp-password'
  }), {
    host: 'smtp.example.com',
    port: 587,
    secure: false,
    auth: { user: 'mailer@example.com', pass: 'smtp-password' }
  });
});

test('approval email recommends the published npm installer command', () => {
  assert.equal(typeof gatewayEmail.buildTokenEmailText, 'function');
  const text = gatewayEmail.buildTokenEmailText({ defaultDailyLimit: 100 }, 'to_test_token');
  assert.match(text, /npx --yes @softawarest\/token-optimizer-installer config --token to_test_token/);
  assert.match(text, /cd \$HOME/);
  assert.match(text, /Restart your client/);
  assert.doesNotMatch(text, /npm run gateway:config/);
});

test('operator notification describes the requester and request time', () => {
  assert.equal(typeof gatewayEmail.buildTokenRequestNotificationText, 'function');
  const text = gatewayEmail.buildTokenRequestNotificationText(
    'requester@example.com',
    new Date('2026-07-10T12:00:00.000Z')
  );
  assert.match(text, /requester@example\.com/);
  assert.match(text, /2026-07-10T12:00:00\.000Z/);
});
