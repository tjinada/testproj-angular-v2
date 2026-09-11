# Changes Required to Existing CDB_Dashboard Files

## 1. frontend/src/app/app.routes.ts

Add this route entry to the `routes` array:

```typescript
{
  path: 'error-analyzer',
  loadComponent: () =>
    import('./pages/error-analyzer/error-analyzer.component').then(
      (m) => m.ErrorAnalyzerComponent
    ),
},
```

## 2. frontend/src/app/app.component.ts

Add this nav link in the template's `<nav class="nav-links">` section:

```html
<a routerLink="/error-analyzer" routerLinkActive="active">Error Analyzer</a>
```

## 3. backend/src/index.ts

Add imports at top:

```typescript
import errorAnalyzerRoutes from './routes/error-analyzer.routes';
import logRoutes from './routes/log.routes';
import opensearchRoutes from './routes/opensearch.routes';
import akamaiRoutes from './routes/akamai.routes';
```

Add route mounts (alongside existing `app.use` lines):

```typescript
app.use('/api/error-analyzer', errorAnalyzerRoutes);
app.use('/api/logs', logRoutes);
app.use('/api/opensearch', opensearchRoutes);
app.use('/api/akamai', akamaiRoutes);
```

## 4. backend/src/services/index.ts

Add barrel exports:

```typescript
export { default as dynatraceService } from './dynatrace.service';
export * from './log.service';
```

## 5. backend/.env.example

Append after existing Confluence section:

```
# Error Analyzer - Dynatrace Configuration
USE_MOCK=false
ENV_HOSTNAME_PATTERNS=*.dev.bmo.com,cgsg-*,api*-sit*
INDIVIDUAL_USER_TOKEN=false
DYNATRACE_NONPROD_TOKEN_URL=https://your-nonprod-tenant.dynatrace.com/ui/access-tokens
DYNATRACE_PROD_TOKEN_URL=https://your-prod-tenant.dynatrace.com/ui/access-tokens
DYNATRACE_NONPROD_API_URL=dynatrace_nonprod_api_url_here
DYNATRACE_NONPROD_TOKEN=your-platform-token-here
DYNATRACE_PREP_API_URL=dynatrace_prep_api_url_here
DYNATRACE_PREP_TOKEN=your-platform-token-here
DYNATRACE_PROD_ENABLED=true
DYNATRACE_PROD_API_URL=dynatrace_prod_api_url_here
DYNATRACE_PROD_TOKEN=your-platform-token-here

# CDBBOS Log Search - Basic Auth for log file server (e.g., https://10.195.26.240)
LOG_SERVER_USERNAME=<PLACEHOLDER_USERNAME>
LOG_SERVER_PASSWORD=<PLACEHOLDER_PASSWORD>

# CDBBOS Logs - OpenSearch (TEST feature - uses fixed session cookie)
# OPENSEARCH_URL is the base of the AWS OpenSearch domain (no trailing slash, no path).
# OPENSEARCH_COOKIE is the full `security_authentication=...` cookie string copied
# from a logged-in browser session. Expires after a few hours; must be refreshed.
# OPENSEARCH_INDEX is the single-index fallback (used only if OPENSEARCH_INDEX_OPTIONS is not set).
# OPENSEARCH_INDEX_OPTIONS lists the choices shown in the Index dropdown. Format is
# comma-separated `label|value` pairs. Example:
#   OPENSEARCH_INDEX_OPTIONS=CDBBOS|channels-olb-*,channels|channels-*
# The first option is selected by default. Values are validated server-side; only these
# are accepted in /api/opensearch/search.
# No proxy is used — both laptop and OpenShift pod reach AWS directly.
OPENSEARCH_URL=https://vpc-your-domain.ca-central-1.es.amazonaws.com
OPENSEARCH_COOKIE=security_authentication=<PASTE_FROM_BROWSER>
OPENSEARCH_INDEX=channels-olb-*
OPENSEARCH_INDEX_OPTIONS=CDBBOS|channels-olb-*,channels|channels-*

# Akamai Flow — Property Manager (PAPI) integration
# EdgeGrid credentials come from the .edgerc file (host, client_token,
# client_secret, access_token). For container deployments, inject these as
# env vars from your secrets manager rather than mounting the .edgerc file.
AKAMAI_HOST=akab-xxxxxxxxxxxxxxxx-xxxxxxxxxxxxxxxx.luna.akamaiapis.net
AKAMAI_CLIENT_TOKEN=akab-xxxxxxxxxxxxxxxx-xxxxxxxxxxxxxxxx
AKAMAI_CLIENT_SECRET=<PLACEHOLDER_CLIENT_SECRET>
AKAMAI_ACCESS_TOKEN=akab-xxxxxxxxxxxxxxxx-xxxxxxxxxxxxxxxx
# PAPI lookups require contract + group context. Both are visible in PAPI
# `/papi/v1/groups` response.
AKAMAI_DEFAULT_CONTRACT_ID=ctr_C-XXXXXXX
AKAMAI_DEFAULT_GROUP_ID=grp_XXXXX
# Comma-separated allowlist of PM property IDs to scan. Order matters:
# if two properties claim the same hostname, the one earlier in this list wins.
# Properties whose productionVersion is null are skipped (logged once at startup).
AKAMAI_PROPERTY_IDS=prp_XXXXXX,prp_XXXXXX,prp_XXXXXX
```

## 6. Files to Copy As-Is from V2

Copy these from `testproj-angular-v2` into the corresponding paths under
`frontend/src/app/pages/error-analyzer/`. Rename `.css` → `.scss`.

### HTML files (copy directly):
- `components/search/search.component.html`
- `components/trace-results/trace-results.component.html`
- `components/trace-results-table/trace-results-table.component.html`
- `components/flow-diagram/flow-diagram.component.html`
- `components/session-results/session-results.component.html`
- `components/token-setup/token-setup.component.html`

### CSS → SCSS files (copy and rename):
- `components/search/search.component.css` → `.scss`
- `components/trace-results/trace-results.component.css` → `.scss`
- `components/trace-results-table/trace-results-table.component.css` → `.scss`
- `components/flow-diagram/flow-diagram.component.css` → `.scss`
- `components/session-results/session-results.component.css` → `.scss`
- `components/token-setup/token-setup.component.css` → `.scss`

### Pure logic files (copy directly, no changes):
- `services/trace-analyzer.ts` → `services/trace-analyzer.ts`
- `services/session-analyzer.ts` → `services/session-analyzer.ts`
- `models/trace.model.ts` → `models/trace.model.ts`
- `models/environment.model.ts` → `models/environment.model.ts`
- `components/flow-diagram/flow-layout.ts` → `components/flow-diagram/flow-layout.ts`

### Mock data (copy to backend):
- `server/mocks/trace-sample.json` → `backend/src/mocks/trace-sample.json`

## 7. CDBBOS Log Search — New Files (No Action Needed Beyond Merge)

The following are brand-new files already created in `dashboard-conversion/`
under the standard paths. No edits to existing files required for these
files themselves — just copy the `dashboard-conversion/` tree into place.

**Backend:**
- `backend/src/services/log.service.ts`
- `backend/src/routes/log.routes.ts`

**Frontend:**
- `frontend/src/app/pages/error-analyzer/models/log.model.ts`
- `frontend/src/app/pages/error-analyzer/services/log.service.ts`
- `frontend/src/app/pages/error-analyzer/components/log-search/log-search.component.ts`
- `frontend/src/app/pages/error-analyzer/components/log-search/log-search.component.html`
- `frontend/src/app/pages/error-analyzer/components/log-search/log-search.component.scss`

**Existing error-analyzer component updated in place** (all within
`dashboard-conversion/`): `error-analyzer.component.{ts,html,scss}` — now wraps
the original trace-analysis UI in a two-tab layout alongside the new CDBBOS
Log Search tab.

## 8. CDBBOS Logs - OpenSearch (TEST) — New Files

A third tab alongside Trace Analysis and CDBBOS Log Search. Sends the user's
search term to AWS OpenSearch (`_dashboards/internal/search/opensearch`) via
the backend using a fixed session cookie from `.env`. Displays the raw JSON
response.

**Backend:**
- `backend/src/services/opensearch.service.ts`
- `backend/src/routes/opensearch.routes.ts`

**No proxy required.** Both local laptop and OpenShift pod have a direct
network path to AWS (`*.amazonaws.com`). Axios is configured with
`proxy: false` to prevent `HTTPS_PROXY` / `HTTP_PROXY` env vars from
accidentally routing these calls through the corporate proxy (which only
allows internal BMO destinations).

**Frontend:**
- `frontend/src/app/pages/error-analyzer/services/opensearch.service.ts`
- `frontend/src/app/pages/error-analyzer/components/opensearch-log-search/opensearch-log-search.component.ts`
- `frontend/src/app/pages/error-analyzer/components/opensearch-log-search/opensearch-log-search.component.html`
- `frontend/src/app/pages/error-analyzer/components/opensearch-log-search/opensearch-log-search.component.scss`

**Existing error-analyzer updated again** (already in `dashboard-conversion/`):
third tab added; `TabId` union extended to include `'opensearch'`; component
import list updated.

## 9. Akamai Flow — New Files

A fourth tab alongside Trace Analysis, CDBBOS Log Search, and OpenSearch.
The user pastes a full URL (e.g. `https://blue.www.olb-gss-QA1112.dev.bmo.com/banking/foo`).
The backend extracts the hostname, looks it up against an allowlist of PM
properties (`AKAMAI_PROPERTY_IDS` in `.env`), fetches that property's active
production rule tree from PAPI, extracts default-rule baseline behaviors
(origin, cache, CP code), and runs a naive matcher (path + hostname +
fileExtension criteria, with `*` wildcard support, honoring `criteriaMustSatisfy`)
to find rules whose criteria match the URL. The frontend renders a flat
list of matched rules — each is a collapsible card showing its criteria,
behaviors, and (on click) full options JSON — plus a default-rule baseline
card and a yellow disclaimer that this is naive matching, not a full PM
evaluator.

**Auth:** EdgeGrid v1 (host / client_token / client_secret / access_token).
In container deployments, inject these as env vars from your secrets manager
— do not mount the `.edgerc` file.

**Property scoping:** the `AKAMAI_PROPERTY_IDS` env var is the explicit
allowlist of properties to scan. Hostname → property mapping is built lazily
on the first request and cached in-memory for 30 minutes. Rule trees are
cached per (propertyId, version) for 10 minutes. Properties with
`productionVersion: null` are skipped (logged once per property).

**Hostname matching:** case-insensitive exact match against `cnameFrom`. If
the input hostname is not on any monitored property, the response is a clear
error including a sample of configured hostnames. On collision (same hostname
on multiple properties), first-match-wins ordered by `AKAMAI_PROPERTY_IDS`.

**Naive matcher scope (Phase 1):** path / hostname / fileExtension criteria
with `MATCHES_ONE_OF`, `DOES_NOT_MATCH_ONE_OF`, `IS_ONE_OF`, `IS_NOT_ONE_OF`
operators, `*` wildcard support, and `criteriaMustSatisfy: all|any`. Rules
containing unsupported criteria (cookies, headers, geo, device, regex,
time-of-day, etc.) are flagged "partial match — unevaluated criteria
present". The full PAPI evaluator is parked as Phase 2.

**Backend:**
- `backend/src/services/akamai.service.ts`
- `backend/src/services/papi-baseline-extractor.ts`
- `backend/src/services/papi-naive-matcher.ts`
- `backend/src/routes/akamai.routes.ts`

**Frontend:**
- `frontend/src/app/pages/error-analyzer/models/akamai.model.ts`
- `frontend/src/app/pages/error-analyzer/services/akamai.service.ts`
- `frontend/src/app/pages/error-analyzer/components/akamai-flow/akamai-flow.component.ts`
- `frontend/src/app/pages/error-analyzer/components/akamai-flow/akamai-flow.component.html`
- `frontend/src/app/pages/error-analyzer/components/akamai-flow/akamai-flow.component.scss`
- `frontend/src/app/pages/error-analyzer/components/akamai-flow/matched-rule/matched-rule.component.ts`
- `frontend/src/app/pages/error-analyzer/components/akamai-flow/matched-rule/matched-rule.component.html`
- `frontend/src/app/pages/error-analyzer/components/akamai-flow/matched-rule/matched-rule.component.scss`

**New backend dependency:**
Add to `backend/package.json`:

```json
"akamai-edgegrid": "^3.5.0"
```

Run `npm install` in `backend/` after merging.

**Existing error-analyzer updated again** (already in `dashboard-conversion/`):
fourth tab added; `TabId` union extended to include `'akamai'`; component
import list updated. The existing tab pattern (`[hidden]="activeTab !== 'xxx'"`)
is preserved.

## 10. Akamai Rules — New Files (No Action Needed Beyond Merge)

Brand-new tab that evaluates a request against an Akamai PAPI rule tree
entirely in the browser. The user uploads the Property Manager rule export
(`propertyName` / `propertyVersion` / `rules`); nothing is sent anywhere.
**No backend routes, no new dependencies, no `.env` entries.**

Distinct from the Akamai Flow work in section 9: that one calls PAPI live
and traces a single URL to origin. This one parses an uploaded config and
answers "where does this request go, and why". Its `TabId` is
`'akamai-rules'`, leaving `'akamai'` free for the Flow tab.

**Frontend:**
- `frontend/src/app/pages/error-analyzer/models/akamai-rule-tree.model.ts`
- `frontend/src/app/pages/error-analyzer/services/akamai-config.service.ts`
- `frontend/src/app/pages/error-analyzer/services/akamai-papi.ts`
- `frontend/src/app/pages/error-analyzer/components/akamai-rules/akamai-rules.component.ts`
- `frontend/src/app/pages/error-analyzer/components/akamai-rules/akamai-rules.component.html`
- `frontend/src/app/pages/error-analyzer/components/akamai-rules/akamai-rules.component.scss`
- `frontend/src/app/pages/error-analyzer/components/akamai-rules/rule-detail/rule-detail.component.ts`
- `frontend/src/app/pages/error-analyzer/components/akamai-rules/rule-detail/rule-detail.component.html`
- `frontend/src/app/pages/error-analyzer/components/akamai-rules/rule-detail/rule-detail.component.scss`

`akamai-rule-tree.model.ts` re-exports `AkamaiRuleEntry` and `MatchStatus`
from `akamai.model.ts` (section 9) rather than redeclaring them, so that
file must be merged too.

**Existing error-analyzer updated again** (already in `dashboard-conversion/`):
fifth tab added between Traffic Flow and CDB Monitoring; `TabId` union and
`TAB_IDS` extended with `'akamai-rules'`; `AkamaiRulesComponent` added to the
import list. The `[hidden]="activeTab !== 'xxx'"` pattern is preserved.

**Future PAPI path:** `akamai-config.service.ts` is the only file that knows
where the config came from — everything downstream consumes a parsed
`ConfigIndex`. Swapping upload for a live fetch means adding a
`loadFromPapi()` beside `loadFromFile()` and a backend route; the evaluator,
models and components don't change.

**Verify after merge.** The evaluator is easy to make confidently wrong — a
rule that shouldn't have applied still produces a real-looking origin. Run
these with cloudlet arm `blue` and GTM answer `BCC` (both are the defaults)
and check the origins:

| Host | Path | Expected origin |
| --- | --- | --- |
| `www1.bmo.com` | `/onlinebanking/cgi-bin/netbnx/CSPMain` | `bmonsori-apisbccprod.bmo.com` |
| `www1.bmo.com` | `/banking/digital/dashboard` | `bmonsori-new2-www41.harrismycfo.com` |
| `www1.bmo.com` | `/banking/digital/login` | same, via GTM lookup (forced invalid path) |
| `blue.www1.bmo.com` | `/banking/digital/login` | `bmonsori-new2-www41.harrismycfo.com` |
| `www1.bmo.com` | `/api/cdb/contact-handler/signout/signOut` | `bmonsori-apisbccprod.bmo.com` |
| `www1.bmo.com` | `/aac/sps/authsvc` | `bmonsori-www13.bmo.com` |

**Known gaps.** `PMUSER_CNAME_CHAIN` and `PMUSER_NIM_ARL_ORIGIN_ID` are only
assigned inside `advanced` XML blocks, so they resolve via the GTM answer
rather than being read from the config. The GTM switch is global; SPA and
BOS are separate GTM properties and can disagree in reality.
