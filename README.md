<div align="center">
<img width="1200" height="475" alt="GHBanner" src="https://ai.google.dev/static/site-assets/images/share-ais-513315318.png" />
</div>

# Run and deploy your AI Studio app

This contains everything you need to run your app locally.

View your app in AI Studio: https://ai.studio/apps/be7722d2-a5c1-493a-8532-7f710580411c

## Mobile app builds

The Capacitor Android and iOS projects package the static download page in
`website/`.

- Android: `npx cap sync android`, then `android\gradlew.bat -p android assembleDebug`.
  The installable debug APK is written to
  `android\app\build\outputs\apk\debug\app-debug.apk`.
- iOS: `npx cap sync ios`, then open `ios/App/App.xcodeproj` in Xcode and
  build/sign it on macOS. An iOS `.ipa` cannot be built on Windows.

The Android debug APK is for testing/sideloading; publishing to Google Play
requires a release build signed with your own release key.

## GitHub Pages download website

The static desktop-app download site lives in `website/`; the root `index.html`
is the Vite application entry point and should not be selected as the Pages
site root. For this repository, set **Settings → Pages → Build and deployment
→ Source** to **GitHub Actions**. The
`.github/workflows/deploy-website.yml` workflow validates and publishes
`website/` on changes to that folder. It also validates the Windows download
archive before deployment.

## Windows desktop app

Build a portable Windows executable with `npm run pack:win`. The executable is
written to `release/`. Windows release builds require a code-signing
certificate that is trusted by the target machine's application-control
policy. Supply it to electron-builder through `CSC_LINK` and `CSC_KEY_PASSWORD`
in the build environment; never commit the certificate or password. The build
fails rather than silently producing an unsigned release executable. On
managed Windows devices, ask IT to issue/trust the publisher certificate or
approve the signed publisher under the active policy.

Its overview includes a provider-sourced market tape and
historical price charts; Yahoo Finance snapshots and Binance crypto streaming
may be delayed or unavailable depending on provider and network availability.
The interface marks missing or stale quotes instead of fabricating live prices.
The overview also includes an interactive 3D topology of the selected
instrument's market, trading, portfolio, risk, profile, and linked research
context.
Crypto prices are applied as Binance aggregate-trade messages arrive; the tape's
UTC clock displays milliseconds, but neither that clock nor the stream promises
one new market price every millisecond. Other instruments continue to use
provider snapshots.
The interactive price chart updates its active candle from incoming market
ticks and polls the selected instrument's quote through the server every five
seconds, subject to provider availability, caching, market hours, and data
entitlements. It includes trendlines, rays, horizontal price levels, vertical
time markers, price-zone rectangles, and Fibonacci retracements; drawings are
saved locally per instrument and timeframe.
The **Suppliers & Buyers** workspace searches listed equities in the local
catalog and can query Yahoo Finance's provider-indexed listings by supported
country/region. Choose a region and search by company name or ticker to add a
provider-listed equity to the profile view. Provider search is query-based and
limited; it does not cover every issuer or exchange and is not an exhaustive
global security master. Counterparties are shown only when supported by a cited
issuer filing; the app does not generate modeled suppliers, customers, or
concentration estimates. For SEC-reporting issuers, the workspace can retrieve
the latest 10-K, 20-F, or 40-F and show verbatim sentences containing supplier/customer
terms, with a link to the filing. These excerpts are source context, not
automatically verified counterparty identities; review the filing before
relying on a relationship. Coverage is limited to SEC-indexed issuers with
accessible annual filings, not every global exchange. No supplier/customer
records are currently bundled. Absence of a record does not establish that an
issuer has no suppliers or customers.
Market depth, when a supported live feed is available, contains anonymous
aggregated bids and asks and cannot identify individual buyers or sellers. No
order is routed by clicking a depth level.
Select **Monte Carlo** in the shared instrument chart, or open the
Monte Carlo section in Financial Calculations, to graph simulated price
percentiles and illustrative European call/put estimates for the selected
equity, ETF, bond/rate, credit, FX, commodity, derivative, or crypto instrument.
Volatility, expected return, carry/yield, risk-free rate, strike, horizon, and
path count are editable; the displayed outputs are assumption-dependent model
estimates, not forecasts or investment advice.
If the desktop app fails to start or its renderer crashes, startup details are
written to `startup.log` in Electron's user-data folder.
The desktop build shows a native loading splash while its local backend and
workspace start, then replaces it only after the app window is ready.

## Global instrument search and option pricing

The **Global Instruments** workspace searches Yahoo Finance's public instrument
catalogue across the country/region choices shown in the app and requests
available quote snapshots for matches. Provider coverage, symbol conventions,
quote availability, and quote timing vary by listing and entitlement; this is
not an exhaustive global security master or a guaranteed real-time feed. The
app's local order ticket does not route orders to a broker. A complete,
exchange-licensed worldwide instrument master and executable market data
require an appropriate licensed provider.

## Intelligence & Strategy Desk

The **Intelligence & Strategy Desk** joins the terminal's existing instrument,
news, geopolitical/maritime event, OMS, and portfolio views:

- Event links show direct ticker references and explain keyword-based thematic
  links. These are research associations, not price forecasts.
- Price, ticker-news, and event alerts create in-app notifications; instrument
  watchlists and reorderable, named dashboard layouts are stored in this
  browser's local storage.
- AI analyst chat and news summaries require the server-side `GEMINI_API_KEY`.
  The request sends your prompt plus the selected instrument, a limited
  portfolio-position and OMS-order snapshot, recent news, and linked events to
  the configured Google Gemini service, along with up to eight recent chat
  messages. Do not send sensitive information unless you are comfortable
  sharing it with that provider. Responses are research support, not investment
  advice.
- Portfolio P&L and asset-class shock estimates use the current in-app
  positions; the link to **Aladdin Risk** opens the terminal's existing
  scenario engine.
- The TypeScript backtester retrieves up to one year of daily provider closes
  when available, uses a local sparkline fallback, supports built-in
  momentum/mean-reversion templates, and includes configurable fees. Templates
  are illustrative Python-style snippets; arbitrary Python is not executed.
  This is a lightweight long-only research simulation, not a production
  execution system, and provider history may be incomplete or delayed.
- Paper orders are explicitly labeled and use the existing local OMS workflow;
  they are not sent to a broker. CSV files for positions, orders, news, and
  event links are generated locally in the browser.

The read-only API includes `GET /api/terminal/v1/instruments` (optional `q`,
`limit`, and `offset`), `GET /api/terminal/v1/events`,
`GET /api/terminal/v1/news`, and the same-origin WebSocket
`/api/terminal/v1/stream` for quote-cache snapshots. These interfaces provide
reference market/event/news data only; they do not expose private orders or
positions. AI requests use `POST /api/analyst/chat` and require server
configuration.

## Privacy and compliance controls

The app now gates entry on an 18+ check and acceptance of the versioned Terms
and Privacy notice, offers necessary/analytics/marketing preference controls,
records a server timestamp for consent changes, and exposes account-scoped
export, profile-correction, and deletion requests when Firebase Admin is
configured. Accounts use local usernames and passwords; saved user records are
associated with the local account ID. Sensitive profile corrections and DMCA submissions use
AES-256-GCM with `FINERD_DATA_ENCRYPTION_KEY`; audit records are written with
restricted local file permissions and expire after the configured retention
period (default 365 days). `firestore.rules` restricts app-owned note writes to
their authenticated owner and makes shared reference collections read-only
from clients. Local workspace snapshots older than 365 days are removed when
next loaded. Build-time third-party notices are generated at
`dist/third-party-licenses.json`.

Configure server-side secrets through the deployment environment or secret
manager, never in source control:

- `FIREBASE_SERVICE_ACCOUNT_JSON` or `GOOGLE_APPLICATION_CREDENTIALS` for
  Firestore-backed privacy and email preference APIs. Firebase Authentication
  is not used for sign-in.
- `FINERD_DATA_ENCRYPTION_KEY` as 64 hexadecimal characters (32 random bytes),
  `FINERD_SESSION_SECRET` and `EMAIL_TOKEN_SECRET` each at least 32 bytes.
- The packaged Electron desktop app creates and persists its own random
  `FINERD_SESSION_SECRET` in its per-user application data folder when one is
  not provided. Server deployments must configure this secret themselves.
- Local accounts are stored in `~/.finerd/accounts.json` by default. Set
  `FINERD_ACCOUNT_STORE_FILE` to override the path. The file contains account
  names and salted scrypt password hashes, not plaintext passwords. Back it up
  securely; there is no password-reset flow.
- For public hosting, `HOST`, `ALLOW_PUBLIC_BIND=true`, `PUBLIC_HTTPS=true`,
  `PUBLIC_APP_URL`, and `TRUST_PROXY_HOPS` must match the trusted TLS proxy
  configuration.
- Optional `COMPLIANCE_AUDIT_FILE` and `COMPLIANCE_RETENTION_DAYS` (30–3650;
  defaults to a per-user-home audit file and 365 days).
- Stripe-hosted subscription checkout requires `STRIPE_SECRET_KEY`,
  `STRIPE_PRICE_ID`, and an HTTPS `PUBLIC_APP_URL`. Card data is not accepted by
  the app. This does not include a Stripe webhook or entitlement/reconciliation
  service.
- Marketing email requires `SMTP_URL`, `SMTP_FROM`, `BUSINESS_LEGAL_NAME`,
  `BUSINESS_MAILING_ADDRESS`, `EMAIL_TOKEN_SECRET`, and `PUBLIC_APP_URL`.
  Sending is limited to accounts that opted in and
  includes a signed unsubscribe link and List-Unsubscribe headers.

## Application security

The Express API binds to `127.0.0.1` by default. Public binding is rejected
unless `ALLOW_PUBLIC_BIND=true`, `PUBLIC_HTTPS=true`, an HTTPS
`PUBLIC_APP_URL`, and `TRUST_PROXY_HOPS` are configured for a trusted
TLS-terminating proxy. Set
`HOST=0.0.0.0` only for that deployment topology. Never trust forwarded headers
from clients that can bypass the proxy.

The app supports self-service local account creation with a username and a
password of at least 12 characters. Passwords are salted and derived with
scrypt on the server; the account file defaults to `~/.finerd/accounts.json`
and can be moved with `FINERD_ACCOUNT_STORE_FILE`. After sign-in, the server
issues a 15-minute HS256 session JWT in an HttpOnly, SameSite=Strict cookie;
unsafe cookie-authenticated requests require a matching CSRF token. Set
`FINERD_SESSION_SECRET` to a random secret of at least 32 bytes. Login and
registration share the API's per-IP rate limit. Local accounts do not support
MFA, so `FINERD_REQUIRE_MFA=true` intentionally blocks local sign-in and
registration. Local account roles default to regular user. Operators can
assign admin access by setting `FINERD_ADMIN_ACCOUNT_IDS` to one or more
account IDs from the protected account store; users must sign in again for a
new role to take effect. Client-provided role fields are ignored. Existing
Firebase Auth identities and Firebase records keyed by their former UIDs are
not automatically migrated or linked to new local accounts. The JSON account store is intended for one server process;
multi-instance public deployments need a transactional shared account store and
shared rate limiting.

API requests have bounded JSON/form bodies, per-process IP-based rate limits,
strict symbol and chart-parameter allowlists, same-origin checks, and generic
error responses. Firestore-backed private records are scoped to the verified
local account ID; the app has no SQL driver, shell execution route,
or user-controlled outbound URL fetch. The DMCA URL is stored as submitted and
is never fetched by the server. The browser uses CSP, HSTS on HTTPS requests,
and clickjacking/content-type/referrer protections. Dependency advisories are
checked with `npm run security:audit` and the scheduled GitHub Actions workflow.

The in-memory rate limiter is suitable for a single desktop/server process;
multi-instance public deployments must enforce equivalent limits at a trusted
gateway or use a shared rate-limit store. TLS termination, Firestore rule
deployment, persistent local account storage, and secret rotation remain
deployment responsibilities. These controls do not
constitute an OWASP certification or security audit.

Before release, deploy the Firestore rules to the correct Firebase project and
configure persistent, access-controlled storage for both the account file and
audit file. Historical
Firestore notes without an `ownerId` cannot be reliably assigned to a person;
the rights APIs cover only the user's `users/{uid}` tree and notes tagged with
that user's ID. Local workspace backups remain plaintext and must be exported,
removed, or migrated separately. Age verification is currently a client-side
18+ gate, not identity/age verification, and can be bypassed by clearing browser
storage. Production TLS is the responsibility of the hosting platform.

The Privacy/Terms text is an implementation template, not legal advice or a
compliance certification. The operator legal entity, privacy contact, mailing
address, applicable jurisdictions, retention rationale, designated DMCA agent,
and governing terms were not provided; complete those items and obtain legal
review before production. Breach endpoints record status events but do not
determine notification duties or send regulatory notices. Accessibility
semantics and keyboard focus handling are implemented for the new consent
dialog; the full product has not been audited for WCAG 2.1 AA.

## Workspace data

The app automatically saves the local workspace on this device, including
instruments, the selected instrument, orders, positions, portfolio metrics,
theme, live-feed preference, and overview display preferences. Use **Workspace
data** in the top bar to save immediately or export a JSON backup for transfer
to another device and later import. Local workspace data is not encrypted and
is not synchronized between devices; snapshots older than 365 days are removed
when next loaded. It is not an order-routing or brokerage record.

The **Financial Formulas** workspace includes a European Black-Scholes-Merton
pricer with Greeks and a seeded risk-neutral geometric-Brownian-motion Monte
Carlo estimator with antithetic variates, standard errors, and 95% confidence
intervals. The simulation shares spot, strike, expiry, volatility, interest
rate, and dividend-yield inputs with the analytic model. It assumes European
payoffs and constant rates/volatility; futures options and American exercise
are not covered by this pricer. These are research tools, not investment advice.

## Run Locally

**Prerequisites:**  Node.js


1. Install dependencies:
   `npm install`
2. Set the `GEMINI_API_KEY` in [.env.local](.env.local) to your Gemini API key
   (the local server loads this file at startup; for deployment, use a secret
   manager or environment variable instead).
3. Run the app:
   `npm run dev`
