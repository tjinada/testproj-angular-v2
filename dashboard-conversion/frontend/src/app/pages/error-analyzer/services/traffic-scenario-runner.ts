import type {
  EnvState, FlowResult, JourneyFrame, Scenario, ScenarioConfig, SimState, TrafficPath, UserSession
} from '../models/traffic-flow.model';
import { resolveTraffic } from './traffic-resolver';
import { defaultSimState } from '../components/traffic-flow/traffic-topology';

/** A user who has never been here before. */
function emptyUser(): UserSession {
  return { cookie: null, jsSite: null, jsServer: null };
}

/** The estate half of the default state — a healthy setup, nothing carried. */
function baseEnv(): EnvState {
  const { path, session, site, jsession, jsessionSite, ...env } = defaultSimState();
  return env;
}

/** Recombines the estate and a carried session into a resolvable SimState. */
function toSimState(
  env: EnvState, user: UserSession, path: TrafficPath, fallbackSite: SimState['site']
): SimState {
  const existing = user.cookie !== null;
  return {
    ...env,
    // The estate is mutated in place as the journey advances, so these have to
    // be snapshotted. Sharing the references lets a later stage retroactively
    // rewrite an earlier frame's diagram.
    down: { ...env.down },
    live: { ...env.live },
    gtmPick: { ...env.gtmPick },
    path,
    // csgcb is post-auth, so it always presents a cookie even before this
    // journey has stamped one.
    session: existing || path === 'csgcb' ? 'existing' : 'new',
    site: user.cookie ?? fallbackSite,
    jsession: user.jsServer ?? 1,
    jsessionSite: user.jsSite ?? undefined
  };
}

/** Folds whatever a request established back into the carried session. */
function carry(user: UserSession, r: ReturnType<typeof resolveTraffic>): UserSession {
  let next = user;
  if (r.stampedSite) { next = { ...next, cookie: r.stampedSite }; }
  if (r.bosSite && r.appServer) {
    next = { ...next, jsSite: r.bosSite, jsServer: r.appServer };
  }
  return next;
}

/**
 * Folds a scenario into one frame per user action. Pure: rebuilt from a clean
 * base on every call, so jumping to step N is the same code path as playing to
 * it.
 *
 * Each frame carries three flows. The 'new' cohort is deliberately stateless —
 * a fresh arrival at this instant, the control against which the pinned user is
 * read. Only the existing user folds state forward.
 *
 * Ordering matters inside a frame: initISAMSession runs *after* the primary
 * call, so it inherits the cookie that call just stamped. That is the whole
 * mechanism of the shared-cookie defect, and reversing the two would hide it.
 *
 * The journey never terminates early. A failed request is not the end of the
 * story — recovery frames are where the second wave shows up.
 */
export function runJourney(scenario: Scenario, c: ScenarioConfig): JourneyFrame[] {
  const frames: JourneyFrame[] = [];
  const env = baseEnv();
  let user = emptyUser();

  scenario.base?.(env);
  const gtmSite = env.gtmPick.bos;

  for (const step of scenario.steps) {
    step.apply?.(env);

    const results: FlowResult[] = [];

    // Control: someone arriving right now with no history.
    const newState = toSimState(env, emptyUser(), c.primaryPath, gtmSite);
    results.push({
      key: 'primary-new', flow: 'primary', cohort: 'new', path: c.primaryPath,
      state: newState, resolution: resolveTraffic(newState)
    });

    const oldState = toSimState(env, user, c.primaryPath, gtmSite);
    const oldRes = resolveTraffic(oldState);
    results.push({
      key: 'primary-existing', flow: 'primary', cohort: 'existing', path: c.primaryPath,
      state: oldState, resolution: oldRes
    });
    user = carry(user, oldRes);

    const isamState = toSimState(env, user, 'csgcb', gtmSite);
    const isamRes = resolveTraffic(isamState);
    results.push({
      key: 'isam-existing', flow: 'isam', cohort: 'existing', path: 'csgcb',
      state: isamState, resolution: isamRes
    });
    user = carry(user, isamRes);

    frames.push({
      label: step.label,
      change: step.change ?? null,
      state: isamState,
      results,
      user: { ...user }
    });
  }

  return frames;
}
