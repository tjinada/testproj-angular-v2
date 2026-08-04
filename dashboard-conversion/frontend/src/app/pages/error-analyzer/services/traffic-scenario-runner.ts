import type {
  EnvState, JourneyFrame, Scenario, SimState, TrafficPath, UserSession
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

/** Recombines the estate and the carried session into a resolvable SimState. */
function toSimState(env: EnvState, user: UserSession, path: TrafficPath): SimState {
  // csgcb is post-auth, so it always presents a cookie even if this journey has
  // not stamped one yet; fall back to the GTM pick rather than inventing a site.
  const existing = user.cookie !== null;
  return {
    ...env,
    path,
    session: existing || path === 'csgcb' ? 'existing' : 'new',
    site: user.cookie ?? env.gtmPick[path === 'api' ? 'api' : 'bos'],
    jsession: user.jsServer ?? 1,
    jsessionSite: user.jsSite ?? undefined
  };
}

/**
 * Folds a scenario into one frame per step. Pure: rebuilt from a clean base on
 * every call, so jumping to step N is the same code path as playing up to it.
 *
 * Env steps get their own frame — the diagram should react the moment the
 * estate changes, before any request is fired at it. Those frames resolve the
 * *unchanged* user against the *changed* estate, projected onto whatever path
 * the next request will use.
 *
 * Folding stops after a frame that fails. Once initISAMSession returns 500 the
 * flow is over; there is no meaningful next hop to show.
 */
export function runJourney(scenario: Scenario): JourneyFrame[] {
  const frames: JourneyFrame[] = [];
  const env = baseEnv();
  let user = emptyUser();

  scenario.base?.(env);

  for (let i = 0; i < scenario.steps.length; i++) {
    const step = scenario.steps[i];

    if (step.kind === 'env') {
      step.apply(env);

      // Project against the next request's path so the preview is honest about
      // what is going to be attempted; fall back to the last one at the end.
      const nextReq = scenario.steps.slice(i + 1).find(s => s.kind === 'request');
      const prevReq = frames.length ? frames[frames.length - 1].state.path : 'api';
      const projected = nextReq && nextReq.kind === 'request' ? nextReq.path : prevReq;

      const state = toSimState(env, user, projected);
      frames.push({
        label: step.label, kind: 'env', state,
        resolution: resolveTraffic(state), user: { ...user }
      });
      continue;
    }

    const state = toSimState(env, user, step.path);
    const resolution = resolveTraffic(state);

    // Carry forward whatever this request actually established. A failed
    // request stamps nothing and issues no session.
    if (resolution.stampedSite) { user = { ...user, cookie: resolution.stampedSite }; }
    if (resolution.bosSite && resolution.appServer) {
      user = { ...user, jsSite: resolution.bosSite, jsServer: resolution.appServer };
    }

    frames.push({
      label: step.label, kind: 'request', state, resolution, user: { ...user }
    });

    if (resolution.outcome.severity === 'bad') { break; }
  }

  return frames;
}
