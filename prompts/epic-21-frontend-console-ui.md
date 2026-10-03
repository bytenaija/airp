# Epic 21 prompt: Frontend console UI (45 pages, themeable accent)

Read CONTEXT.md first.

GOAL: The complete AIRP web console: every page in the approved 45-page
inventory, implemented in TypeScript, with the accent theme controlled by the
`ui.theme.accent` feature flag. Design references live in `docs/frontend/`
(page inventory, theme tokens, and a click-through HTML prototype of every
section). Match the prototype's look, feel, and information architecture; wire
every page to real backend data where the backend exists.

ALREADY BUILT: Epics 1-20 (as each lands). This epic consumes their HTTP APIs.
Where a backend endpoint does not exist yet, the page renders against an
explicit, clearly-marked stub data layer behind the same repository
interface — never hardcoded demo literals inside generic components.

SCOPE — the 45 pages (full descriptions in
`docs/frontend/page-inventory-and-theme.md`):
- Public (4): landing, sign up, sign in, password reset.
- Onboarding (7): workspace creation, connect Git, connect cloud, connect
  observability, connect chat (Slack), onboarding checklist, connection-success.
  NOTE: Epic 19 builds the onboarding connect flow first. Reuse its work and
  its API contracts; do not rebuild a competing onboarding flow. If Epic 19
  is still open when you start, implement the onboarding pages against its
  prompt's contracts and flag any drift in your PR.
- Main app (17): dashboard, incidents, incident detail, new investigation,
  threads, issues, escalations, pull requests, runbooks, patches, approvals,
  rollouts, learning flywheel, connector catalog (Epic 17 registry UI),
  feature flags, audit log, analytics.
- Settings (17): settings home, workspace, billing & usage, members, teams,
  coding agents, integrations, clouds, repositories, memories, API keys,
  OAuth clients, telemetry tokens, labels, pages, notifications, support.

BUILD:
1. New frontend app in the repo built on TanStack Start (https://tanstack.com
   — MIT-licensed, no paid tiers, self-hostable) with React and TypeScript
   in strict mode, Node 20+ toolchain, Vite build. No paid cloud services
   required for local dev or CI. The app must run from the existing Docker
   Compose stack and deploy to the production targets (VPS, Cloudflare)
   without vendor lock-in.
2. Routing: TanStack Router — one type-safe route per page in the 45-page
   inventory. The route tree is the source of truth for navigation; no
   ad-hoc show/hide view switching.
3. Server state: TanStack Query for all backend data fetching. Caching,
   retries, and loading/error states come from Query, not hand-rolled
   fetch wrappers.
4. Theme system: all five accent token sets from
   `docs/frontend/page-inventory-and-theme.md` (signal-green, ember-orange,
   cyan, violet, crimson) implemented as CSS custom properties, applied via
   a `data-theme` attribute on the root element. Switching accent = changing
   the attribute; no redeploy, no rebuild.
5. Feature flag `ui.theme.accent`: values
   `signal-green | ember-orange | cyan | violet | crimson`; default `violet`;
   per-workspace setting, changeable at runtime from Workspace settings by
   workspace admins only; persisted per workspace.
6. App shell: icon nav rail + sub-navigation + content area, as in the
   prototype. Every one of the 45 pages reachable through the nav, no dead
   entries.
7. Data layer: one repository interface per domain (incidents, threads,
   patches, flags, connectors, billing, members, ...). Real implementations
   call the backend APIs from Epics 1-20; stub implementations are explicit
   test doubles used only where the backend is not built yet, and are
   clearly labeled as stubs.
8. In-app navigation MUST use TanStack Router links and `<button>` elements,
   never `<a href="#">` with click handlers — hash-links fail to fire in
   some embedded WebViews. Verified during prototyping.
9. Responsive: usable at 1280px desktop and 390px mobile widths. No page may
   require horizontal scrolling for its primary content at either width.
10. Auth pages (sign up / sign in / password reset) and the public landing
   page render without a session; all app pages require one.
11. Copy: plain professional English, no lorem ipsum anywhere in the shipped
   UI.

ACCEPTANCE CRITERIA:
- All 45 pages from the inventory exist, are reachable via the nav, and
  render without console errors (click-through test in CI, headless).
- `ui.theme.accent` accepts all five values; switching updates the accent
  across the whole console instantly with no reload; the choice persists per
  workspace; non-admins cannot change it (API rejects with 403).
- Default accent is violet on a fresh workspace.
- Dashboard, incidents, threads, patches, approvals, flags, and connector
  catalog pages render REAL data from the backend on a local compose stack
  (seeded via the existing seed scripts); no page shows hardcoded demo
  service names, file paths, or error strings outside explicitly-marked
  stubs. (Builder rule: no hardcoded demo values in generic code.)
- Screenshots: the PR attaches a screenshot of EVERY page group (public,
  onboarding, dashboard+analytics, incidents+threads, code automation,
  platform, settings) proving the changed flow end-to-end. No screenshots =
  no merge (standing merge-gate rule; docs-only PRs are the sole exemption).
- `pnpm build` (or equivalent) passes with TypeScript strict, zero errors;
  unit tests for the theme flag logic and the repository interfaces pass.
- Anything deliberately left stubbed is listed in the PR description with
  the backend epic that will fill it in.

