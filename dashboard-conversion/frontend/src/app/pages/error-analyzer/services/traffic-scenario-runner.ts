import type {
  CallKind, CallResult, Cohort, EnvState, JourneyFrame, Resolution, Scenario,
  ScenarioConfig, SimState, TrafficPath, UserSession
} from '../models/traffic-flow.model';
import { CALL_SEQUENCE } from '../models/traffic-flow.model';
import { resolveTraffic } from './traffic-resolver';
import { defaultSimState } from '../components/traffic-flow/traffic-topology';

/**
 * Which path each call takes. Sign-in moves between /api/cdb and
 * /banking/services; the trailing call is whichever one it left behind.
 */
export function callPaths(c: ScenarioConfig): Record<CallKind, TrafficPath> {
  return {
    signin: c.signinPath,
    isam: 'csgcb',
    trailing: c.signinPath === 'api' ? 'banking' : 'api'
  };
}

function emptyUser(): UserSession {
  return { cookie: null, jsSite: null, jsServer: null };
}

function baseEnv(): EnvState {
  const { path, session, site, jsession, jsessionSite, ...env } = defaultSimState();
  return env;
}

/**
 * Recombines the estate and a carried session into a resolvable SimState.
 *
 * `fallbackSite` is GTM-CDB-API's 50/50 answer, used only when the user has no
 * cdbbossiteId. Once pinned, the Akamai property rule wins outright.
 */
function toSimState(
  env: EnvState, user: UserSession, path: TrafficPath, fallbackSite: SimState['site']
): SimState {
  const existing = user.cookie !== null;
  return {
    ...env,
    down: { ...env.down },
    live: { ...env.live },
    gtmPick: { ...env.gtmPick },
    path,
    session: existing || path === 'csgcb' ? 'existing' : 'new',
    site: user.cookie ?? fallbackSite,
    jsession: user.jsServer ?? 1,
    jsessionSite: user.jsSite ?? undefined
  };
}

/**
 * Folds what a call established back into the carried session.
 *
 * The cookie is stamped by the edge on the way out, so it lands whenever the
 * origin answered at all.
 *
 * The JSESSIONID is set by sign-in and only by sign-in. initISAMSession and
 * /banking/services respect it rather than reissuing, so they never move the
 * session — which is what lets the cookie and the session point at different
 * sites and stay that way.
 *
 * Even on sign-in it needs the request to have been served: a 302 back to
 * login, a 503 or an RST never reached an app server, so nothing was issued.
 * Without that guard a session-mismatch 302 would adopt the site that bounced
 * it and the mismatch would vanish on the next frame.
 */
function carry(user: UserSession, call: CallKind, r: Resolution): UserSession {
  let next = user;
  if (r.stampedSite) { next = { ...next, cookie: r.stampedSite }; }
  const served = r.outcome.severity !== 'bad';
  if (call === 'signin' && served && r.bosSite && r.appServer) {
    next = { ...next, jsSite: r.bosSite, jsServer: r.appServer };
  }
  return next;
}

/** One cohort's walk through the three calls at a single point in the outage. */
interface CohortPass {
  results: Record<CallKind, CallResult>;
  signin: Resolution;
  user: UserSession;
}

/**
 * Runs the full sequence for one cohort against the current estate.
 *
 * A failed sign-in stops everything: no session means the UI never gets as far
 * as the other two calls. A failed initISAMSession does not — /banking/services
 * is still resolved and shown, so the knock-on is visible.
 */
function runPass(
  env: EnvState, start: UserSession, cohort: Cohort, gtmSite: SimState['site'],
  paths: Record<CallKind, TrafficPath>
): CohortPass {
  let user = start;
  const results = {} as Record<CallKind, CallResult>;
  let signin!: Resolution;
  let stopped = false;

  for (const call of CALL_SEQUENCE) {
    if (stopped) {
      results[call] = { cohort, call, state: null, resolution: null, skipped: true };
      continue;
    }

    const state = toSimState(env, user, paths[call], gtmSite);
    const resolution = resolveTraffic(state);
    results[call] = { cohort, call, state, resolution, skipped: false };

    if (call === 'signin') {
      signin = resolution;
      if (resolution.outcome.severity === 'bad') { stopped = true; }
    }

    user = carry(user, call, resolution);
  }

  return { results, signin, user };
}

/**
 * Folds a scenario into three frames per stage — one per call. Pure: rebuilt
 * from a clean base every time, so jumping to a frame is the same code path as
 * playing up to it.
 *
 * Both cohorts are walked at every stage, but only the existing user's session
 * carries forward between stages. The new cohort is deliberately stateless: a
 * fresh arrival at that instant, and the control the pinned user is read
 * against.
 *
 * The journey never terminates early. A failure is not the end of the story —
 * recovery frames are where the second wave shows up.
 */
export function runJourney(scenario: Scenario, c: ScenarioConfig): JourneyFrame[] {
  const frames: JourneyFrame[] = [];
  const env = baseEnv();
  let user = emptyUser();

  scenario.base?.(env);
  const gtmSite = c.site;
  const paths = callPaths(c);

  // Establish the pinned user against the healthy estate without emitting a
  // frame. Otherwise the first stage has nobody holding a cookie and the
  // "existing" user behaves like a new arrival.
  user = runPass(env, emptyUser(), 'existing', gtmSite, paths).user;

  for (const step of scenario.steps) {
    step.apply?.(env);

    const fresh = runPass(env, emptyUser(), 'new', gtmSite, paths);
    const pinned = runPass(env, user, 'existing', gtmSite, paths);

    CALL_SEQUENCE.forEach((call, i) => {
      const state = pinned.results[call].state
        ?? fresh.results[call].state
        ?? toSimState(env, user, paths[call], gtmSite);

      frames.push({
        label: step.label,
        // Named once, on the call the change lands before.
        change: i === 0 ? step.change ?? null : null,
        call,
        callIndex: i + 1,
        state,
        results: [fresh.results[call], pinned.results[call]],
        context: { new: fresh.signin, existing: pinned.signin },
        user: { ...pinned.user }
      });
    });

    user = pinned.user;
  }

  return frames;
}
