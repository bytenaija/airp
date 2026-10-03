# AIRP Frontend — Page Inventory and Theme

Planned page list for the AIRP frontend build, plus theme direction adapted from the reference product. Designs start after this is confirmed.

## Page inventory

### Public

1. **Landing page** — marketing homepage, signup CTA
2. **Sign up** — Google, GitHub, email
3. **Sign in**
4. **Password reset**

### Onboarding

5. **Welcome / create workspace** — name the workspace, first step after signup
6. **Connect Git** — GitHub app install for codebase context
7. **Connect cloud** — AWS, Cloudflare, and other providers
8. **Connect observability tool** — logs, metrics, alerts feed detection
9. **Connect chat** — Slack workspace link
10. **Onboarding checklist** — tracks progress through the steps above
11. **Connection success** — "You're all set" confirmation after each integration, with the next recommended step

### Main app

12. **Dashboard** — incident overview, MTTR, system health
13. **Incidents** — incident list
14. **Incident detail** — timeline, handoff, similar incidents
15. **New investigation** — agent chat thread composer
16. **Threads** — thread list and thread detail
17. **Issues**
18. **Escalations**
19. **Pull requests** — list and detail with agent review comments
20. **Runbooks** — list, detail, drafts
21. **Patches** — patch pipeline proposals awaiting review
22. **Approvals** — policy engine approval queue
23. **Rollouts** — rollout controller status
24. **Learning flywheel** — outcomes, labels, rewards, datasets
25. **Connector catalog** — the Epic 17 integration registry UI
26. **Feature flags** — flag admin
27. **Audit log**
28. **Analytics** — MTTR trends, override rates, usage

### Settings

29. **Settings home**
30. **Workspace** — general (name, slug, avatar, description), AI models, autofix behavior, pull request reviews, privacy and data export, danger zone
31. **Billing and usage** — plan, monthly allowance, usage trend, plan limits, invoices
32. **Members** — user management: invite, roles, deactivate; pending invites
33. **Teams** — organize members for ownership and visibility
34. **Coding agents** — connect editors over MCP, test connection, recent agent activity
35. **Integrations** — connected integrations up top (manage/disconnect), browsable catalog by category
36. **Clouds** — connected cloud accounts with sync status
37. **Repositories** — GitHub app repositories agents can read and act on
38. **Memories** — institutional knowledge from investigations
39. **API keys** — scoped keys for programmatic access
40. **OAuth clients** — third-party apps that sign users in
41. **Telemetry tokens** — credentials for alerts forwarded from observability tools
42. **Labels** — organize and categorize resources
43. **Pages** — published reports (PR analyses, autofix runs, issue explanations)
44. **Notifications** — personal notification preferences by category
45. **Support** — documentation links, onboarding call booking, feedback

## Theme — adapted from the reference

### Shared base (all options)

- Near-black background, slightly lifted card surfaces, hairline borders
- Three-column app shell: icon nav rail, settings sub-navigation, content area
- Metric cards with small colored trend lines; donut and bar charts for outcomes
- Empty states: centered icon, headline, one-line description, single primary action
- Status conveyed with green (active/on), amber (syncing/pending), red (failed/off)

### Color options (accent)

**Option A — Signal green (closest to the reference)**
Accent `#4ade80`, hover `#22c55e`, on dark `#0a0a0b`, surface `#141417`, text `#f4f4f5` / `#a1a1aa`

**Option B — Ember orange**
Accent `#fb923c`, hover `#f97316`, on dark `#0b0a09`, surface `#161412`, text `#faf7f4` / `#a8a29e`

**Option C — Cyan**
Accent `#22d3ee`, hover `#06b6d4`, on dark `#090b0c`, surface `#121819`, text `#f2fafa` / `#9fb3b8`

**Option D — Violet**
Accent `#a78bfa`, hover `#8b5cf6`, on dark `#0b0a10`, surface `#15131d`, text `#f5f3fa` / `#a8a3b8`

**Option E — Crimson**
Accent `#f87171`, hover `#ef4444`, on dark `#0c0909`, surface `#181214`, text `#faf3f3` / `#b8a3a3`

### Theme switching — feature flag

All five options ship. The active accent is controlled by a feature flag rather than a hardcoded choice:

- Flag: `ui.theme.accent`, values `signal-green | ember-orange | cyan | violet | crimson`
- Default: `violet` (Eva's decision 2026-10-03; `signal-green` is closest to the reference look). Prototype defaults to violet.
- Each theme is a token set (CSS custom properties) applied via a `data-theme` attribute on the root element, so switching needs no redeploy and no page rebuild
- Scope: per workspace, changeable from Workspace settings; admins only
- The designs below demonstrate all five themes live through a flag switcher.
