/** Which CDB entry path the simulated request takes. */
export type TrafficPath = 'banking' | 'api';

/** Whether the request already carries stickiness cookies. */
export type SessionKind = 'new' | 'existing';

/** The two data centres. */
export type SiteId = 'BCC' | 'SCC';

/** State of the BOS liveness object on a site. */
export type LivenessState = 'present' | 'renamed';

/**
 * What a pool monitor watches. Monitoring the liveness object rather than the
 * httpd TCP port means a renamed object marks the pool down even though httpd
 * is still serving (DACT-104 at the LTM; the same choice exists at the EXT GTM).
 */
export type PoolMonitor = 'live' | 'tcp';

/** The two Akamai GTMs. Each has its own 50/50 pick for cookie-less requests. */
export type GtmId = 'bos' | 'api';

/** Everything the operator can vary. Serialised into the shareable link. */
export interface SimState {
  path: TrafficPath;
  session: SessionKind;
  /** cdbbossiteId value carried by an existing session. Ignored when new. */
  site: SiteId;
  /**
   * Which way each GTM's 50/50 lands for a cookie-less request. Ignored when
   * the session is existing, because the cookie bypasses the GTM entirely.
   */
  gtmPick: Record<GtmId, SiteId>;
  /** JSESSIONID jvmRoute -> app server 1..APP_SERVERS. */
  jsession: number;
  /**
   * Which site's JVM issued the JSESSIONID. Normally the same as `site`, but
   * after a failover the user holds a session from one site while the cookie
   * still pins the other. Defaults to `site` when absent.
   */
  jsessionSite?: SiteId;
  live: Record<SiteId, LivenessState>;
  /** BOS LTM pool monitor (DACT-104). */
  ltmMonitor: PoolMonitor;
  /** EXT GTM pool monitor. Decides whether a renamed object drains the API path. */
  extGtmMonitor: PoolMonitor;
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
  /** Distribution text shown inside each GTM oval, e.g. "50/50", "100% → SCC". */
  gtmDistribution: Record<GtmId, string>;
  /**
   * The site each GTM would actually answer with: the operator's pick when both
   * datacentres are healthy, otherwise whichever one still passes its check.
   * Null when neither does.
   */
  gtmAnswer: Record<GtmId, SiteId | null>;
  /** True when the GTM pick is actually in play (cookie-less request). */
  gtmActive: boolean;
  /** Own-site and crossover percentages for each EXT GTM. */
  extGtmSplit: Record<SiteId, { own: string; cross: string }>;
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
  /** Cookie and JSESSIONID the user carries away from this request. */
  nextUser: UserSession;
}

/** What a user carries between requests in a replayed scenario. */
export interface UserSession {
  /** cdbbossiteId value, or null before the edge has stamped one. */
  cookie: SiteId | null;
  /** Site whose JVM issued the JSESSIONID. */
  jsSite: SiteId | null;
  /** jvmRoute app server number. */
  jsServer: number | null;
}

// ── Scenario replay ────────────────────────────────────────────────

/** Environment slice of SimState — everything not tied to one user. */
export type EnvState = Omit<SimState, 'path' | 'session' | 'site' | 'jsession' | 'jsessionSite'>;

/** A user makes a request. Advances the carried session. */
export interface RequestStep {
  kind: 'request';
  label: string;
  path: TrafficPath;
}

/** Something changes in the estate. The user is untouched. */
export interface EnvStep {
  kind: 'env';
  label: string;
  apply: (env: EnvState) => void;
}

export type ScenarioStep = RequestStep | EnvStep;

/** Follows one user through time, carrying their cookie and JSESSIONID. */
export interface Scenario {
  id: string;
  title: string;
  blurb: string;
  steps: ScenarioStep[];
}

/** One rendered step of a journey replay. */
export interface ScenarioFrame {
  kind: 'request' | 'env';
  label: string;
  env: EnvState;
  userBefore: UserSession;
  userAfter: UserSession;
  /** Populated on request steps: what actually happened. */
  result: Resolution | null;
  /**
   * Populated on env steps: where the next request would land given the
   * change, so the diagram reacts immediately instead of waiting a step.
   */
  projection: Resolution | null;
  /** Whichever of the two is set — what the diagram and trace render from. */
  shown: Resolution;
}

// ── Stage scenarios (cohorts observed in parallel) ─────────────────

/**
 * One tracked class of user. Cohorts run in parallel across the same stage
 * timeline, so a single environment change can be seen through several users
 * at once — which is how "existing traffic fails while new traffic reroutes"
 * becomes one moment rather than two steps.
 */
export interface Cohort {
  id: string;
  label: string;
  path: TrafficPath;
  /**
   * 'new' resets to a cookie-less user before every stage — it models someone
   * arriving right now. 'existing' carries its cookie and JSESSIONID forward.
   */
  kind: 'new' | 'existing';
  /** Site the existing user starts pinned to. Ignored when kind is 'new'. */
  seedSite?: SiteId;
}

/** One cohort's result at one stage. */
export interface CohortFrame {
  cohortId: string;
  userBefore: UserSession;
  userAfter: UserSession;
  result: Resolution;
}

/** One point on the environment timeline. */
export interface Stage {
  label: string;
  /** What changed here, shown above the cohort table. */
  note: string;
  apply: (env: EnvState) => void;
}

/**
 * Walks the estate through stages and observes every cohort at each one.
 * Contrast with Scenario, which follows one user through time.
 */
export interface StageScenario {
  id: string;
  title: string;
  blurb: string;
  cohorts: Cohort[];
  stages: Stage[];
}

/** Everything rendered for one stage. */
export interface StageFrame {
  label: string;
  note: string;
  env: EnvState;
  /** One entry per cohort, in scenario order. */
  cohorts: CohortFrame[];
}
