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
```

Add route mounts (alongside existing `app.use` lines):

```typescript
app.use('/api/error-analyzer', errorAnalyzerRoutes);
app.use('/api/logs', logRoutes);
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
