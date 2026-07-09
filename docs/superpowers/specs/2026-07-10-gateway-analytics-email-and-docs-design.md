# Gateway Analytics, Email, and Documentation Design

## Goal

Keep gateway analytics statistically meaningful, deliver approved access tokens
through the existing Nodemailer credential pattern, and separate operator setup
documentation from end-user product documentation.

## Analytics

The gateway is the authoritative analytics filter. It accepts sanitized
analytics records below 1,000 raw-source tokens as successful no-ops, but
persists and aggregates only records at or above that threshold. A gateway stats
schema-version change resets existing aggregate state on startup, so the public
portal contains only qualifying calls after deployment.

## Approved Token Email

Approved requests keep the current lifecycle: requesters create a pending
request, and an administrator approval issues the token and attempts delivery.
The gateway replaces Resend with Nodemailer and follows the established
`softaware-apis` configuration pattern:

- Gmail app password: `EMAIL_PROVIDER=gmail`, `GMAIL_USER`,
  `GMAIL_APP_PASSWORD`, `EMAIL_FROM`, optional `EMAIL_REPLY_TO`.
- Generic SMTP: `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, optional
  `SMTP_USER`/`SMTP_PASS`, `EMAIL_FROM`, optional `EMAIL_REPLY_TO`.

No mail credentials, token plaintext, or request body are logged. Missing or
failed delivery preserves the existing admin-only one-time manual-token
fallback.

## Documentation Boundary

- Root `README.md` is an end-user product guide. Its opening quickstart makes
  the npm installer the recommended installation method and contains no
  deployment, admin, or gateway-secret setup details.
- `packages/installer/README.md` describes installer invocation, client setup,
  and user-facing troubleshooting.
- `gateway/README.md` is the complete operator guide for deployment,
  Nodemailer configuration, access-request administration, analytics behavior,
  and portal operations.

## Validation

Gateway tests cover threshold filtering and the legacy-stats reset. Email tests
verify Gmail and SMTP transport selection without sending external mail. Build,
full tests, generated plugin assets, and the installer package dry run verify
the release output.
