# Asian Street Gourmet — Project Log

A running summary of features built and decisions made on this site,
grouped by area rather than strict chronology. Commit hashes in
parentheses are pointers into `git log` for the exact diffs.

---

## Foundation

- Initial single-page site with custom typography (Fraunces serif,
  Inter Tight sans, DM Mono, Noto Serif TC for 中文), oklch color
  palette, hero photo of the storefront, and a tailored brand voice
  ("Home Kitchen. Avenue O. Brooklyn.") (`7f4ef0a`).
- Vanilla HTML + Tailwind Play CDN + a tiny inline JS — no build
  step, no framework. Total stack is intentionally boring so the
  whole codebase fits in one person's head.
- Hosted on **Vercel** with the custom domain
  `https://www.asianstreetgourmet.com` (`6f44b31`).

## Menu and content

- 4 menu categories live on the page: **Steamed Rice Plates**,
  **Home-Style Dishes**, **Slow-Simmered Soups**, **Snacks** —
  each with menu codes (S1–S4, A1–A6, B1–B6, C1–C6, D1–D6).
- Soup category subtitle simplified for English readers: was
  "Cantonese 老火湯 — bones, herbs, vegetables…", now "Cantonese
  soups — …" (`9aa2522`).
- Steamed Rice Plates labelled "— Lunch", Home-Style labelled
  "— Dinner" (`1a6ad15`).
- Home-style dishes (A1–A6, B1–B6) repriced from \$7 to \$8 with a
  prep-time disclaimer added below them (`8287ed4`, `c81ffb7`).
- S5 (支竹羊腩蒸飯) removed from the menu (`1c09ded`).
- Maps links across the site point at the Google Business Profile
  short URL, not just the address (`887b121`).
- Storefront photo for the hero (`9cafddc`), real photos for the
  first three menu categories (`d172d17`), a clearer lotus-root
  soup shot for C1 (`a42d9ec`), snacks photo + live Google Maps
  embed in the Visit section (`674642b`).

## SEO / AEO

- Schema.org structured data (Restaurant + FAQPage), Open Graph
  + Twitter cards, `robots.txt` with explicit allow-list for AI
  search engines (OpenAI, Anthropic, Perplexity, Google-Extended,
  etc.), a sitemap, and a visible FAQ section (`64808c9`).
- `robots.txt` blocks `/admin/` and `/api/` from indexing; admin is
  also protected by real cookie-auth, not just robots.txt politeness.

## Database + dynamic menu

- **Neon Postgres** schema with 4 tables — `ingredients`, `menu_items`,
  `menu_item_ingredients`, `hours` — seeded with 35 ingredients, 29
  menu items, and 55 ingredient-to-dish relations (`9a8bb0b`).
- `/api/menu-today` endpoint with a deterministic daily rotation
  function in `lib/rotation.js` (`27567cf`).
- Public site reads the live menu from the database; unavailable
  items reorder to the bottom of each category list (`499565c`,
  `f0a6a26`).
- Unavailable items hidden entirely from the public menu instead of
  shown struck-out (`8534514`).

## Admin portal

- Cookie-based auth using Node's built-in `crypto` (scrypt for
  password hashing, HMAC-SHA256 for cookie signing) — no JWT,
  no Passport, ~100 lines (`52ff1f8`, `ecde5a4`).
- Admin page with 5 endpoints initially, simplified to a per-item
  availability checkbox (`6beea5e`, `e33b66f`).
- Admin-editable hours, with the public site reflecting changes
  via the closed-now logic (`7be8f0a`).
- Endpoints later consolidated to stay under Vercel Hobby's
  12-function limit — login + logout merged into `/api/auth`,
  cart-status + cart-validate merged into `/api/cart`, etc.
  (`67a94c1`).
- Internal "What visitors see right now" preview hidden — the
  per-item availability section below was the single source of
  truth and the duplicate was confusing.
- **Change-password UI inside the admin page.** New collapsible
  section at the bottom of the admin view: enter current + new (+
  confirm) password and submit. Old workflow (regenerate hash via
  `node lib/auth.js hash`, paste into Vercel env var, redeploy) is
  gone. The scrypt hash now lives in the existing `settings` Postgres
  table under key `admin_password_hash`; `ADMIN_PASSWORD_HASH` env var
  becomes a bootstrap + lockout-recovery fallback (used only when the
  DB row is missing). `PATCH /api/auth { current_password, new_password }`
  added to the consolidated auth endpoint — function count unchanged
  at 11/12. Sessions are intentionally NOT invalidated on change (8-hour
  TTL continues). Minimum new-password length: 8 characters. Bilingual
  EN + zh-Hant. Each password input has a built-in eye-icon toggle for
  show/hide.
- **Recovery via Vercel env var.** If nobody remembers the active
  password: set `ADMIN_RECOVERY_MODE=true` in Vercel env vars. While
  the flag is set, the login form accepts the original
  `ADMIN_PASSWORD_HASH` env-var password instead of the DB row. On a
  successful recovery login the DB row is wiped automatically — the
  env-var password becomes the live one again, the password-change
  section auto-opens, and a flash reminds the family to set a new
  password and remove `ADMIN_RECOVERY_MODE` from Vercel. A
  "Forgot password?" expandable panel on the login form walks through
  these steps. No terminal or Neon SQL access required. Alternative
  manual path (still works): in Neon SQL editor, run
  `DELETE FROM settings WHERE key='admin_password_hash';`.

## Bilingual EN ↔ Cantonese (zh-Hant)

- Custom in-page i18n: `LANG_STRINGS.en` + `LANG_STRINGS.zh`
  dictionaries with `data-i18n` attributes; `applyLang()` uses
  `Range#createContextualFragment` (not `innerHTML`) so character
  encoding stays clean and there's no XSS heuristic.
- HTML entities fixed in translation strings (`06743c9`).
- FAQ answers translated and reset to Inter Tight font (`8ebdc63`).
- Site **defaults to Cantonese** on first visit; remembers your
  explicit toggle after that (`3aecf95`).

## Hours + closed-state logic

- NY-time aware via `Intl.DateTimeFormat({timeZone:'America/New_York'})`.
- Nav pill, hero CTA, and "Pick up the phone" CTA strip all show a
  small CLOSED indicator when the kitchen is shut.
- Closed-notice initially placed next to the logo, later moved to
  below the Call CTA per request (`3aecf95`, `851ecc7`).
- Notice text simplified — dropped "Opens tomorrow at 11am" detail,
  now reads just "Currently closed" / "現已休息" (`c0059e1`).

## Online ordering — the cart feature

Tier 1 "order ahead, pay at pickup" — no payment processor, no PCI
scope. Built as 9 incremental steps:

1. Schema: `orders`, `order_items`, `settings` tables (`309256b`).
2. `lib/orders.js` + `lib/settings.js` — pickup-code generation,
   totals math, cart-flag helper (`b824132`).
3–4. Public cart endpoints — status, validate, submit (`bb7125f`).
5–6. Admin cart-toggle endpoint + UI block (`c8546e7`).
7. Cart drawer, Add buttons, checkout, success view (`9053aaa`).
8–9. Admin Orders inbox with polling + chime (`efb0264`).

### Cart UX
- Pickup-only, ASAP wait estimate, customer name is the only
  required field (phone + email optional).
- **4-character alphanumeric pickup code** (e.g. `A7K2`) shown
  prominently on the success view; persisted in `sessionStorage` so
  refresh re-renders the success view cleanly.
- Whole feature is **admin-togglable**, defaults OFF. When OFF, the
  cart UI doesn't even mount; the server independently rejects
  submissions with 403.
- Bilingual throughout — 27 cart.* i18n keys per language.
- Tax removed from all calculations and UI; total = subtotal
  (`c3d15d5`).
- Customer "Special instructions" field capped at **200 characters**
  with a live counter (orange at 160, red at 200) and a hint:
  "allergies, no spice, extra ginger, etc." (`1803d15`).

### Admin Orders inbox
- Status pill filters: Active · Picked up · Cancelled · All — with
  live counts.
- Order cards show pickup code in big mono red, customer name +
  tap-to-call phone, relative time + NY-local absolute date/time
  ("2 min ago / Jun 10 · 4:23 PM ET") (`1803d15`).
- 15-second polling; polling continues even when the tab is hidden
  so background-tab alerts still fire (`38a3a46`).
- **Cancel button** uses a two-click "arm then confirm" pattern
  instead of `confirm()` (which can race against the polling
  re-render and gets silently suppressed by Chrome) (`38a3a46`).

### Three independent alert channels
- **In-page chime** — Web Audio ding-dong (880Hz → 1320Hz),
  ~1.1s long, played twice with a 0.4s gap. Plays whenever the
  tab is focused and new orders arrive (`38a3a46`).
- **OS desktop notification** via the Notifications API — has its
  own sound, surfaces through the OS, click to focus the admin tab.
  Yellow prompt in the Orders header asks the family to enable it
  once (`7b09509`).
- **Tab title badge** — `(N) NEW · ASG Admin` prefix on
  `document.title` when the tab is hidden with unseen orders.
  Always visible in the tab strip even with sound muted (`7b09509`).

### Print template + auto-print
- Each order card has a **🖨 PRINT** button that opens the OS print
  dialog with a letter-sized one-page order slip (`8f4f4de`):
  - Restaurant header (name, address, phone) + timestamp + order #
  - BIG pickup code in a boxed block + ready time + "Pay at pickup"
  - Customer name + tap-to-call phone + email
  - Items table: code · qty · 中文 + English name · line total
  - Dashed-border notes block (only when present)
  - Bold total
  - "Thank you · 多謝晒 · Show this code at the counter" footer
- **Auto-print toggle** in the Orders header (persisted in
  localStorage) — fires `window.print()` on every newly-detected
  order with a 1.2s stagger so multiple arrivals don't collide.
- Designed for **Chrome kiosk-printing mode** on a dedicated
  kitchen tablet: launch with `--kiosk --kiosk-printing` and the
  print dialog is skipped entirely — orders go straight to the
  default printer with zero clicks.

## Google reviews

- "Leave a Google Review" CTAs in two places (`1f0062f`):
  - **Visit section / Address card** — small mono red link next to
    "Open in Maps", for ambient visitors.
  - **Cart success view** — solid red button between order summary
    and Done: "Loved your meal? Leave a Google review". Highest-
    intent moment we have.
- Uses a stable CID-based Google Maps URL
  (`https://www.google.com/maps?cid=8705321142465470103`) derived
  from the hex CID in the original Maps URL — durable, won't break
  when Google rotates map-tile tokens.
- Upgrade path documented: when the family grabs the proper
  `g.page/r/.../review` short link from Google Business Profile,
  swap that in for direct-to-write-review behavior.

## Navigation polish

- Top marquee — hours line removed; now shows just "Home Kitchen ·
  Call to Order · 917-723-6262 · 84 Avenue O · Brooklyn · $7 …"
  (`c3d15d5`).
- Desktop Call CTA shows the phone number directly ("CALL
  917-723-6262") instead of "Call to Order" so visitors can read it
  without tapping (`6b11654`).
- **Mobile Call CTA** — was hidden behind the hamburger menu; now
  always visible as a square red icon-only button on phones,
  expanding to the full pill at the `md` breakpoint and up
  (`f93ce09`).
- "Pick up the phone" CTA strip lost its "Daily · 11am – 9pm · 84
  Avenue O" subline — was redundant with the Visit section and the
  closed-now notice (`8311a5b`).

## Bug fixes worth remembering

- **Empty closed-notice box** appearing under the Call CTA even when
  the restaurant was open. Root cause: Tailwind's `flex` utility tied
  in CSS specificity with `[hidden]`, and Tailwind's stylesheet loads
  after the browser's user-agent rules, so `display: flex` was
  winning. Fixed with a single `[hidden] { display: none !important }`
  override in both `index.html` and `admin/index.html` (`b74ee61`).
- Admin's `loadEverything()` was still calling `/api/cart-status`
  after the endpoint was consolidated into `/api/cart` — 404 broke
  the whole admin render via Promise.all's fail-fast (`1e14800`).

---

*This log is a snapshot. For exact diffs and chronological history,
`git log` is authoritative.*
