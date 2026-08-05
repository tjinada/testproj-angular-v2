import type {
  Cohort, CohortResult, EnvState, JourneyFrame, Scenario, SimState, TrafficPath, UserSession
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
    path,
    // csgcb is post-auth, so it always presents a cookie even before this
    // journey has stamped one.
    session: existing || path === 'csgcb' ? 'existing' : 'new',
    site: user.cookie ?? fallbackSite,
    jsession: user.jsServer ?? 1,
    jsessionSite: user.jsSite ?? undefined
  };
}

/**
 * Resolves one request frame for both cohorts.
 *
 * The 'new' cohort is deliberately stateless — a fresh arrival at this instant,
 * carrying nothing. It is the control: what happens to someone hitting the site
 * right now, with no history. Only the 'existing' cohort folds state forward.
 *
 * csgcb has no 'new' cohort. The call is post-auth by definition, so there is
 * no such thing as an unauthenticated initISAMSession.
 */
function resolveCohorts(
  env: EnvState, user: UserSession, path: TrafficPath, gtmSite: SimState['site']
): CohortResult[] {
  const out: CohortResult[] = [];

  if (path !== 'csgcb') {
    const newState = toSimState(env, emptyUser(), path, gtmSite);
    out.push({ cohort: 'new' as Cohort, state: newState, resolution: resolveTraffic(newState) });
  }

  const oldState = toSimState(env, user, path, gtmSite);
  out.push({ cohort: 'existing' as Cohort, state: oldState, resolution: resolveTraffic(oldState) });

  return out;
}

/**
 * Folds a scenario into one frame per step. Pure: rebuilt from a clean base on
 * every call, so jumping to step N is the same code path as playing up to it.
 *
 * Env frames get their own frame — the diagram should react the moment the
 * estate changes, before any request is fired at it. They resolve with an empty
 * trace so nothing is drawn as travelling.
 *
 * The journey never terminates early. A failed request is not the end of the
 * story: recovery frames are where the second wave shows up, when users who
 * rode out the outage are logged out as their site comes back.
 */
export function runJourney(scenario: Scenario): JourneyFrame[] {
  const frames: JourneyFrame[] = [];
  const env = baseEnv();
  let user = emptyUser();

  scenario.base?.(env);
  const gtmSite = env.gtmPick.bos;

  for (const step of scenario.steps) {
    if (step.kind === 'env') {
      step.apply(env);

      const state = toSimState(env, user, 'banking', gtmSite);
      const quiet = resolveTraffic(state);

      frames.push({
        label: step.label,
        kind: 'env',
        path: null,
        state,
        results: [{
          cohort: 'existing',
          state,
          resolution: {
            ...quiet, steps: [], breakAt: null, http: '—', setCookie: null,
            outcome: {
              key: 'ENV_CHANGE',
              title: 'Estate changed — no request sent',
              why: `${step.label}. Nothing has been requested yet — the diagram shows the ` +
                'estate as it now stands.',
              severity: 'warn'
            }
          }
        }],
        user: { ...user }
      });
      continue;
    }

    const results = resolveCohorts(env, user, step.path, gtmSite);
    const mine = results[results.length - 1].resolution;

    // Only the existing-user cohort carries state forward. A failed request
    // stamps nothing and issues no session.
    if (mine.stampedSite) { user = { ...user, cookie: mine.stampedSite }; }
    if (mine.bosSite && mine.appServer) {
      user = { ...user, jsSite: mine.bosSite, jsServer: mine.appServer };
    }

    frames.push({
      label: step.label,
      kind: 'request',
      path: step.path,
      state: results[results.length - 1].state,
      results,
      user: { ...user }
    });
  }

  return frames;
}
