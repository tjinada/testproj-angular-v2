/**
 * Which CDB entry path the simulated request takes.
 *
 * 'csgcb' is /banking/services/csgcb. It is post-auth, so it always carries a
 * cdbbossiteId, never queries a GTM, and never passes through the cloudlet —
 * legacy ISAM has no blue/green instances, so there is no env header to set.
 */
export type TrafficPath = 'banking' | 'api' | 'csgcb';

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
   * Which site issued the JSESSIONID. Distinct from `site`: cdbbossiteId is
   * Akamai affinity, while the clone ID is matched by the WAS plugin against
   * plugin-cfg.xml. A failover pulls them apart — cookie SCC with a BCC-issued
   * JSESSIONID resolves fine so long as the request lands on BCC.
   *
   * Defaults to `site` when absent, so single-request manual mode is unchanged.
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
  | 'ISAM500'
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
  /**
   * Same decision as cookieStamped, as a typed site. The journey runner carries
   * this forward rather than parsing the display string.
   */
  stampedSite: SiteId | null;
  steps: DecisionStep[];
  /** Node id where the request died, if it died. */
  breakAt: string | null;
}

/** The estate half of SimState — everything a request does not carry. */
export type EnvState = Omit<SimState, 'path' | 'session' | 'site' | 'jsession' | 'jsessionSite'>;

/**
 * What one user carries between requests. cdbbossiteId and the JSESSIONID
 * origin are tracked separately because a failover pulls them apart.
 */
export interface UserSession {
  cookie: SiteId | null;
  jsSite: SiteId | null;
  jsServer: number | null;
}

/**
 * One step of a journey. Each step is one user action; `apply` is the estate
 * change that lands immediately before it, named in `change` for the label.
 */
export interface JourneyStep {
  label: string;
  change?: string;
  apply?: (env: EnvState) => void;
}

export interface Scenario {
  id: string;
  title: string;
  blurb: string;
  /** Applied to the healthy default before the first step runs. */
  base?: (env: EnvState) => void;
  steps: JourneyStep[];
}

/** How a site is taken out. Order of operations is the whole story. */
export type OutageType = 'none' | 'planned' | 'unplanned' | 'apic';

/** Only meaningful for the unplanned mode; others collapse to on/off. */
export type RecoveryOrder = 'none' | 'jvm-then-ihs' | 'ihs-then-jvm';

/**
 * Two kinds of user, resolved side by side on every request frame.
 *
 * 'new' is stateless — a fresh arrival at this instant, carrying nothing. It
 * answers "what happens to someone hitting the site right now".
 * 'existing' carries the cookie and JSESSIONID forward across the journey.
 *
 * csgcb frames have no 'new' cohort: the call is post-auth by definition.
 */
export type Cohort = 'new' | 'existing';

/** What the builder rail produces. Everything else is derived from it. */
export interface ScenarioConfig {
  /** 'banking' or 'api'. csgcb is appended automatically, never chosen. */
  primaryPath: TrafficPath;
  /** Where this user belongs: GTM preference, cookie pin, and ISAM front door. */
  site: SiteId;
  /** What breaks. Independent of `site`, so the healthy-site control case works. */
  outageSite: SiteId;
  outageType: OutageType;
  recovery: RecoveryOrder;
}

/**
 * Estate settings the rail keeps control of during playback. The monitors stay
 * editable mid-journey on purpose — comparing live.txt against a TCP check is
 * the whole reason the flip exists — and manual out-of-service toggles let the
 * healthy ('none') outage double as free-form exploration.
 */
export interface EstateOverrides {
  down: Record<string, true>;
  ltmMonitor: PoolMonitor;
  extGtmMonitor: PoolMonitor;
}

/**
 * Which call is being drawn. The primary path and the initISAMSession that
 * follows it share the BOS tail but nothing else, so both fit on one diagram.
 */
export type FlowKind = 'primary' | 'isam';

/**
 * The four flows on a frame. Colour encodes the call, so a hop shared by both
 * calls can stay in the existing blue.
 *
 * A new arrival does get an ISAM call: their primary request stamps a cookie,
 * and initISAMSession then follows it to whichever site that was. "New" means
 * no cookie at the start of the frame, not never having one.
 */
export type FlowKey = 'primary-new' | 'isam-new' | 'primary-existing' | 'isam-existing';

/** One flow's answer within a frame. */
export interface FlowResult {
  key: FlowKey;
  flow: FlowKind;
  cohort: Cohort;
  path: TrafficPath;
  state: SimState;
  resolution: Resolution;
}

/**
 * One frame of a journey: a single user action — load the page, then
 * initialise the session — resolved for both kinds of user.
 *
 * Estate changes do not get their own frame. They are applied immediately
 * before the frame's requests and named in its label, because a frame showing
 * the estate without any traffic is indistinguishable from the request frame
 * that follows it.
 */
export interface JourneyFrame {
  label: string;
  /** Estate change applied at this frame, if any. Null for plain requests. */
  change: string | null;
  /**
   * Representative state for estate-level rendering (out-of-service, liveness,
   * monitors). Flows differ only in the request fields, never the estate.
   */
  state: SimState;
  /** One entry per flow present. Never empty. */
  results: FlowResult[];
  /** The carried session as it stands after this frame. */
  user: UserSession;
}