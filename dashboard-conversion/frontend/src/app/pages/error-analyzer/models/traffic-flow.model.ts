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
  /** Where cdbbossiteId is written. Estate-level, not per-request. */
  cookieSetBy: CookieSetter;
}

/**
 * Where cdbbossiteId is written.
 *
 * 'edge' — today. Akamai stamps it from the origin it *targeted*, so the value
 *          records a routing intention. On /api/cdb that is the APIC site,
 *          which knows nothing about BOS health.
 * 'ihs'  — proposed. The BOS web server writes it on the response, so it can
 *          only name a site that just demonstrably served the request. A
 *          refused or bounced request sets nothing, leaving the user unpinned
 *          to re-roll the GTM next time.
 */
export type CookieSetter = 'edge' | 'ihs';

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
  /**
   * Which path carries SigninRequestManager, and therefore which GTM decides
   * where the user is pinned.
   *
   * 'api'     — today. GTM-CDB-API answers on a TCP:443 check of the APIC
   *             farm, so cdbbossiteId records an APIC that knows nothing about
   *             BOS health. That is the defect.
   * 'banking' — proposed. GTM-CDB-BOS answers on /banking/live.txt, so the
   *             cookie records a site BOS liveness has already vouched for.
   */
  signinPath: TrafficPath;
  /** Where cdbbossiteId is written — the proposed IHS-set workaround. */
  cookieSetBy: CookieSetter;
  /**
   * Which site the deciding GTM's 50/50 answers on sign-in. Applies only when
   * the request arrives unpinned — once cdbbossiteId is set, the Akamai
   * property rule wins and no GTM is consulted.
   */
  site: SiteId;
  /** What breaks. Independent of `site`, so the healthy-site control works. */
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
 * The three calls a user action makes, in the order the app fires them.
 *
 * Sign-in is the only one that decides anything: it arrives unpinned, so its
 * GTM answer is what gets stamped into cdbbossiteId. The other two inherit it.
 *
 * 'trailing' is whichever of /api/cdb or /banking/services is not carrying
 * sign-in. It is cookie-bound and decides nothing.
 */
export type CallKind = 'signin' | 'isam' | 'trailing';

export const CALL_SEQUENCE: CallKind[] = ['signin', 'isam', 'trailing'];

/** One cohort's answer for the call a frame is showing. */
export interface CallResult {
  cohort: Cohort;
  call: CallKind;
  /**
   * Null when an earlier call stopped the sequence. Only a failed sign-in does
   * this — a failed initISAMSession still lets /banking/services be shown, so
   * the consequence is visible.
   */
  state: SimState | null;
  resolution: Resolution | null;
  skipped: boolean;
}

/**
 * One frame: one call, for both cohorts, at one point in the outage.
 *
 * `context` carries each cohort's sign-in resolution so the diagram can draw
 * the path that pinned the cookie underneath the call being shown.
 */
export interface JourneyFrame {
  /** Stage label, e.g. "Stage 1". */
  label: string;
  /** Estate change landing at this stage, named once on its first call. */
  change: string | null;
  call: CallKind;
  /** 1-based position within the stage, for the step badge. */
  callIndex: number;
  /** Representative estate state for out-of-service and monitor rendering. */
  state: SimState;
  /** One entry per cohort. Never empty. */
  results: CallResult[];
  /** Sign-in resolution per cohort, for the faint context path. */
  context: Partial<Record<Cohort, Resolution>>;
  /** The carried session as it stands after this frame. */
  user: UserSession;
}