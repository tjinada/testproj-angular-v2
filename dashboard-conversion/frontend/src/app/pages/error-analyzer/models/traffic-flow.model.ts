/** Which CDB entry path the simulated request takes. */
export type TrafficPath = 'banking' | 'api';

/** Whether the request already carries stickiness cookies. */
export type SessionKind = 'new' | 'existing';

/** The two data centres. */
export type SiteId = 'BCC' | 'SCC';

/** State of the BOS liveness object on a site. */
export type LivenessState = 'present' | 'renamed';

/**
 * What the BOS LTM pool monitor watches. Monitoring the liveness object
 * rather than the httpd TCP port takes the whole pool offline when the
 * object is renamed (DACT-104).
 */
export type LtmMonitor = 'live' | 'tcp';

/** Everything the operator can vary. Serialised into the shareable link. */
export interface SimState {
  path: TrafficPath;
  session: SessionKind;
  /** cdbbossiteid pin. For a new session, previews the GTM's 50/50 pick. */
  site: SiteId;
  /** JSESSIONID jvmRoute -> app server 1..APP_SERVERS. */
  jsession: number;
  live: Record<SiteId, LivenessState>;
  ltmMonitor: LtmMonitor;
  /** Node ids taken out of service, keyed for cheap lookup. */
  down: Record<string, true>;
}

/** Outcome keys, listed in resolver precedence order. */
export type OutcomeKey =
  | 'DOWN503'
  | 'POOL_OFF'
  | 'VHOST'
  | 'LOCAL503'
  | 'TIMEOUT'
  | 'SPLIT'
  | 'DRAINED'
  | 'NEW'
  | 'OK';

export type Severity = 'ok' | 'warn' | 'bad';

export interface Outcome {
  key: OutcomeKey;
  title: string;
  severity: Severity;
  /** One-line plain-English reason, shown under the banner title. */
  why: string;
}

/** One numbered step in the decision trace. Ids link back to diagram nodes. */
export interface DecisionStep {
  ids: string[];
  where: string;
  /** May contain <b> markup; rendered with [innerHTML]. */
  what: string;
  state: Severity;
}

/** Full result of resolving a SimState against the topology. */
export interface Resolution {
  path: TrafficPath;
  existing: boolean;
  /** Site the cookie pins to. */
  pinnedSite: SiteId;
  /** Site whose APIC farm handled the request (api path only). */
  apicSite: SiteId | null;
  /** Site whose BOS tier served the request. Null when nothing served it. */
  bosSite: SiteId | null;
  /** App server that ended up holding the session. */
  appServer: number | null;
  outcome: Outcome;
  /** Response code or transport result shown in the banner. */
  http: string;
  setCookie: string | null;
  /**
   * The cdbbossiteId value the edge stamps on this request. Derived from the
   * origin the edge targeted, so it records a decision already made rather
   * than influencing one.
   */
  cookieStamped: string | null;
  steps: DecisionStep[];
  /** Node id where the request died, if it died. */
  breakAt: string | null;
}
