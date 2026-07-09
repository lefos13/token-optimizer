# Token-request notifications and bot hardening

## Scope

The public `POST /v1/token-requests` endpoint will notify the gateway operator
when it accepts a new request. The recipient is the configured `GMAIL_USER`.
The message identifies the normalized requester email and the UTC time the
request was accepted.

The public request page and API will also reject common automated submissions
without an external CAPTCHA service. The browser form will include an
accessibility-hidden honeypot and an issuance timestamp. The API will quietly
accept, but not persist or notify on, submissions with a populated honeypot or
an implausibly short completion duration. Existing per-IP rate limiting and
one-request-per-email behavior remain unchanged.

## Design

`gateway/src/email.ts` gains a dedicated operator-notification helper that
reuses the existing Nodemailer transport. Its destination is `GMAIL_USER`,
not the public requester address. Delivery is best-effort: an unavailable mail
service must not alter the accepted request's HTTP 202 response or stored state.

`handleTokenRequest` receives the gateway configuration and notification
sender dependency. After it validates a request and stores it successfully, it
attempts the operator notification. The sender remains injectable so endpoint
tests can assert the call without using a real transport.

The rendered portal records its initial render time and submits it with the
email plus a deliberately unobtrusive honeypot field. The server validates
these fields before calling the token store. Bot-like submissions receive the
same pending-shaped response as a valid request, preventing the endpoint from
being used as an oracle. Direct API clients can provide a valid issued-at time;
requests that omit it remain compatible unless the final implementation finds
the current API contract intentionally requires browser-only access.

## Error handling and verification

Badly shaped timestamps continue to use the endpoint's existing 400 response
format. Mail failures are contained and never exposed through the public API.
Tests will cover notification content/destination, notification only after a
new stored request, honeypot behavior, and minimum-duration behavior. The
gateway build, test suite, changed-file review, and generated plugin assets
will be validated. Gateway documentation and the generated skill materials will
describe the added operator notification and anti-bot controls.
