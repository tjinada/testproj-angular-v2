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

Add import at top:

```typescript
import errorAnalyzerRoutes from './routes/error-analyzer.routes';
```

Add route mount (alongside existing `app.use` lines):

```typescript
app.use('/api/error-analyzer', errorAnalyzerRoutes);
```

## 4. backend/src/services/index.ts

Add barrel export:

```typescript
export { default as dynatraceService } from './dynatrace.service';
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
