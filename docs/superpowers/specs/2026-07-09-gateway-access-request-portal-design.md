# Gateway Access Request Portal Design

## Goal

Provide a simple browser-accessible way for people to request a gateway access token without changing the existing API-based request flow.

## Route and page

- `GET /` returns a self-contained HTML access-request page.
- The page contains one required email field and a submit button.
- The page uses `POST /v1/token-requests` with `{ "email": "..." }`, preserving that endpoint's request and response contract for programmatic users.
- `/admin`, `/stats`, `/health`, and all `/v1/*` routes retain their current behavior.

## User feedback

- A `202` response confirms that the request was submitted and awaits operator approval.
- A `400` response asks the user to enter a valid email address.
- A `409` response explains that the email already has a request and cannot be submitted again.
- A `429` response asks the user to wait before trying again.
- Other failures show a concise retry message without exposing server details.

## Admin behavior

`GET /admin` remains enabled only when `ADMIN_TOKEN` is configured. The operator pastes that token into the dashboard and clicks Load. Browser requests to `/admin/api/*` send it as `Authorization: Bearer <ADMIN_TOKEN>`, allowing the dashboard to list, approve, deny, revoke, and adjust limits for stored requests. The HTML page itself contains no request data.

## Implementation and tests

- Add an HTML renderer alongside the existing stats and admin renderers.
- Register `GET /` in the gateway router before its 404 fallback.
- Add route-level tests that assert the portal is served as HTML and includes the token-request endpoint; existing end-to-end token lifecycle coverage remains the contract test for submission behavior.
- Update the gateway README to document the public portal URL and retain the API endpoint documentation.
