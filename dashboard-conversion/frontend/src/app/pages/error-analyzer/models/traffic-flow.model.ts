/**
 * Which CDB entry path the simulated request takes.
 *
 * 'csgcb' is /banking/services/csgcb. It is post-auth, so it always carries a
 * cdbbossiteId, never queries a GTM, and never passes through the cloudlet —
 * legacy ISAM has no blue/green instances, so there is no env header to set.
 *
 * 'idp' is authentication.bmo.com/aac/* through GTM-ISAM to the ISAM IdP LTM.
 * Its affinity cookie is apidc, independent of cdbbossiteId.
 *
 * 'spaapi' is apis.bmo.com/api/* from the CIAM Auth SPAs, through
 * GTM-CDB-API to APIC. It carries no affinity cookie: the property has no
 * stickiness rule for apis.bmo.com, so every request is answered by the GTM.
 */
export type TrafficPath = 'banking' | 'api' | 'csgcb' | 'idp' | 'spaapi';

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

/**
 * The Akamai GTMs, plus the es-api.bmogc.net GSS in front of SSS V2. Each has
 * its own 50/50 pick for requests nothing pins.
 */
export type GtmId = 'bos' | 'api' | 'isam' | 'spa' | 'sss';

/**
 * The Akamai GTMs whose traffic weighting the operator can set in the GTM
 * console. GTM-CDB-API is one property for www1 /api/cdb and apis.bmo.com, so
 * its weight covers both; only the per-hostname pick ('api' / 'spa') differs.
 */
export type WeightedGtm = 'bos' | 'api' | 'isam';

/** 'split' is the normal 50/50; a site is a manual 100% to that site. */
export type GtmWeight = 'split' | SiteId;

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
  /**
   * Manual traffic weighting per GTM. A forced site wins over the pick, but
   * health still wins over the weight: if the weighted site fails its check,
   * the GTM answers the other site rather than nothing.
   */
  gtmWeight: Record<WeightedGtm, GtmWeight>;
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
  /** apidc value carried into the idp call. Absent means unpinned. */
  idpSite?: SiteId;
  /**
   * The request reaches CDBBOS code that calls SSS V2, so the resolver fans it
   * out downstream. initCDBSession and the /api/cdb/* app calls do; sign-in,
   * initISAMSession and /banking/services stop at CDBBOS.
   */
  fanout?: boolean;
  /**
   * Where this call stands with JSESSIONID, which initCDBSession issues as the
   * first /api/cdb call after authentication. 'none': sign-in, before any
   * session exists. 'issue': initCDBSession, which starts a fresh one. 'check':
   * every call after it, held to the JVM that issued it. Absent means 'check'.
   */
  sessionMode?: 'none' | 'issue' | 'check';
  live: Record<SiteId, LivenessState>;
  /** ISAM IdP liveness object per site. Drives GTM-ISAM health only. */
  idpLive: Record<SiteId, LivenessState>;
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
  | 'DS500'
  | 'PARTIAL'
  | 'SPLIT'
  | 'DRAINED'
  | 'DS_FAILOVER'
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

/**
 * How a downstream SSS V2 host picks its site.
 *
 * 'gss'     — es-api.bmogc.net, 50/50 across both sites by F5 health.
 * 'sitegss' — api-svc-bgss / -sgss, 100% own site; the other site only when
 *             the own-site F5 is fully down.
 * 'direct'  — es-api-*prod / api-svc-*prod, the site host itself. No failover.
 */
export type DownstreamKind = 'gss' | 'sitegss' | 'direct';

/** One downstream call made by CDBBOS (or CWH APIC), resolved on its own. */
export interface DownstreamRoute {
  /** Hostname as CDBBOS calls it. */
  host: string;
  kind: DownstreamKind;
  /** /api/cdb goes via Channel Services; /api goes straight to AWS. */
  path: '/api/cdb' | '/api';
  /** Site whose SSS V2 served it. Null when no site could be picked. */
  site: SiteId | null;
  status: 'ok' | 'failover' | 'broken';
  /** Endpoints CDBBOS calls this way, e.g. "edoc". For the outcome text. */
  example?: string;
  /**
   * Hops in order, as [from, to] pairs. Ids may be pseudo-ids the layout
   * understands (`cdbbos-BCC`, `sssapic-BCC#cdb`) as well as node ids.
   */
  legs: [string, string][];
  /** Node id where it died, if it died. */
  breakAt: string | null;
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
  /**
   * The SSS V2 calls this request fans out to once it is served. Each is
   * resolved independently: one call can fail over on one route and break on
   * another. Empty when the request never reached CDBBOS or CWH APIC.
   */
  downstream: DownstreamRoute[];
}

/** The estate half of SimState — everything a request does not carry. */
export type EnvState = Omit<SimState, 'path' | 'session' | 'site' | 'jsession' | 'jsessionSite' | 'idpSite' | 'fanout' | 'sessionMode'>;

/**
 * What one user carries between requests. cdbbossiteId and the JSESSIONID
 * origin are tracked separately because a failover pulls them apart. apidc is
 * independent of both: auth on one site and app calls on the other is fine.
 */
export interface UserSession {
  cookie: SiteId | null;
  jsSite: SiteId | null;
  jsServer: number | null;
  idpCookie: SiteId | null;
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
  /**
   * Applied after the existing user is pinned, before the first step. For
   * changes that should land on someone already holding their cookies —
   * otherwise the pin would simply route around them.
   */
  afterPin?: (env: EnvState) => void;
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
  /**
   * Which site the deciding GTM's 50/50 answers on sign-in. Applies only when
   * the request arrives unpinned — once cdbbossiteId is set, the Akamai
   * property rule wins and no GTM is consulted.
   */
  site: SiteId;
  /** Which site GTM-ISAM's 50/50 answers when the auth call arrives without apidc. */
  idpSite: SiteId;
  /** Which site GTM-CDB-API's 50/50 answers for apis.bmo.com. No cookie, so every call. */
  spaSite: SiteId;
  /** Which site the es-api.bmogc.net GSS 50/50 answers for downstream calls. */
  sssSite: SiteId;
  /** What breaks. Independent of `site`, so the healthy-site control works. */
  outageSite: SiteId;
  outageType: OutageType;
  recovery: RecoveryOrder;
}

/**
 * What the operator has changed by hand from the production defaults. Set from
 * the chips on the diagram and box clicks, and survive every journey
 * regeneration. Editable mid-journey on purpose — comparing live.txt against a
 * TCP check is the whole reason the flip exists.
 */
export interface Overrides {
  down: Record<string, true>;
  ltmMonitor: PoolMonitor;
  extGtmMonitor: PoolMonitor;
  /** ISAM IdP liveness object per site. */
  idpLive: Record<SiteId, LivenessState>;
  /** Manual GTM traffic weighting, as set in the GTM console. */
  gtmWeight: Record<WeightedGtm, GtmWeight>;
  /**
   * BOS live.txt per site. Only applied when no outage scenario is selected —
   * the planned and unplanned stages own it otherwise.
   */
  live: Record<SiteId, LivenessState>;
}

/**
 * The calls a user action makes, in the order the app fires them.
 *
 * Sign-in arrives unpinned, so its GTM answer is what gets stamped into
 * cdbbossiteId. 'idp' (authentication.bmo.com) follows it and decides apidc
 * the same way, through GTM-ISAM. 'spaapi' (apis.bmo.com, still during login)
 * has no cookie and is answered fresh by GTM-CDB-API every time. The rest
 * inherit cdbbossiteId.
 *
 * 'cdbsession' is initCDBSession, the first /api/cdb call once the user is
 * authenticated. It issues JSESSIONID; sign-in does not. initISAMSession
 * follows it. 'apicdb' stands for the regular post-login /api/cdb calls
 * (getCount, entitlements, edoc…): the same front path, but CDBBOS goes on to
 * call SSS V2 and AWS. 'banking' is a post-login /banking/services call. Those
 * last two are held to the session and decide nothing.
 */
export type CallKind = 'signin' | 'idp' | 'spaapi' | 'cdbsession' | 'isam' | 'apicdb' | 'banking';

export const CALL_SEQUENCE: CallKind[] =
  ['signin', 'idp', 'spaapi', 'cdbsession', 'isam', 'apicdb', 'banking'];

/** Calls the app cannot continue without. A failure stops the sequence. */
export const BLOCKING_CALLS: CallKind[] = ['signin', 'idp', 'spaapi', 'cdbsession'];

/** One cohort's answer for the call a frame is showing. */
export interface CallResult {
  cohort: Cohort;
  call: CallKind;
  /**
   * Null when an earlier call stopped the sequence. Any failed BLOCKING_CALLS
   * entry does this — the app cannot continue without login. A failed
   * initISAMSession still lets /banking/services be shown, so the consequence
   * is visible.
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