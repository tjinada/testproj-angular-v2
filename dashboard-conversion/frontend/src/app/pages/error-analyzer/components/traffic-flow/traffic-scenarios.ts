import type { Scenario } from '../../models/traffic-flow.model';
import { APP_SERVERS, WEB_SERVERS } from './traffic-topology';

/**
 * Journeys: one user followed across several requests, carrying their
 * cdbbossiteId and JSESSIONID forward so later steps see the consequences of
 * earlier ones. A single request can show the 500; only a journey can show
 * why the cookie was pointing at the dead site in the first place.
 */
export const SCENARIOS: Scenario[] = [
  {
    id: 'isam-500',
    title: 'initISAMSession 500 after an APIC failover',
    blurb: 'SCC BOS is down. The /api/cdb call succeeds by failing over to BCC — ' +
      'but stamps the cookie SCC, which sends the next csgcb call into the dead site.',

    // The scenario pins both 50/50 splits so the journey is deterministic.
    // Landing on SCC APIC is the precondition for the whole defect.
    base: env => {
      env.gtmPick = { bos: 'SCC', api: 'SCC' };
    },

    steps: [
      {
        kind: 'env',
        label: 'Shut down SCC BOS (IHS + JVMs)',
        apply: env => {
          for (let i = 1; i <= WEB_SERVERS; i++) { env.down[`web-SCC-${i}`] = true; }
          for (let i = 1; i <= APP_SERVERS; i++) { env.down[`app-SCC-${i}`] = true; }
        }
      },
      {
        kind: 'request',
        label: 'User loads the app — /api/cdb',
        path: 'api'
      },
      {
        kind: 'request',
        label: 'App calls initISAMSession — /banking/services/csgcb',
        path: 'csgcb'
      }
    ]
  }
];
