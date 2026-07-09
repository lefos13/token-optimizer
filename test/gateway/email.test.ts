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
