import type {
  Cohort, CohortFrame, EnvState, Scenario, ScenarioFrame, SimState,
  StageFrame, StageScenario, TrafficPath, UserSession
} from '../models/traffic-flow.model';
import { resolveTraffic } from './traffic-resolver';
import { defaultSimState } from '../components/traffic-flow/traffic-topology';

/** A user who has never been here before. */
export function emptyUser(): UserSession {
  return { cookie: null, jsSite: null, jsServer: null };
}

/** Environment half of the default state — a healthy estate. */
export function baseEnv(): EnvState {
  const { path, session, site, jsession, jsessionSite, ...env } = defaultSimState();
  return env;
}

/** Recombines the estate and the carried user into a SimState to resolve. */
export function toSimState(env: EnvState, user: UserSession, path: TrafficPath): SimState {
  const existing = user.cookie !== null;
  return {
    ...env,
    path,
    session: existing ? 'existing' : 'new',
    site: user.cookie ?? env.gtmPick[path === 'api' ? 'api' : 'bos'],
    jsession: user.jsServer ?? 1,
    jsessionSite: user.jsSite ?? undefined
  };
}

/**
 * Folds a scenario into one frame per step. Pure: rebuilt from a clean base on
 * every call, so jumping to step N is the same code path as playing to it.
 *
 * Env steps carry a projection — resolving the *unchanged* user against the
 * *changed* estate — so the diagram reacts the moment something is toggled
 * rather than waiting for the next request.
 */
export function runScenario(scenario: Scenario): ScenarioFrame[] {
  const frames: ScenarioFrame[] = [];
  let env = baseEnv();
  let user = emptyUser();

  /** Project an env change against the next request's path, else the last. */
  const pathAt = (i: number): TrafficPath => {
    for (let j = i; j < scenario.steps.length; j++) {
      const s = scenario.steps[j];
      if (s.kind === 'request') { return s.path; }
    }
    for (let j = i; j >= 0; j--) {
      const s = scenario.steps[j];
      if (s.kind === 'request') { return s.path; }
    }
    return 'api';
  };

  scenario.steps.forEach((step, i) => {
    if (step.kind === 'env') {
      // Clone so earlier frames keep the estate as it was at their point.
      env = JSON.parse(JSON.stringify(env)) as EnvState;
      step.apply(env);
      const projection = resolveTraffic(toSimState(env, user, pathAt(i)));
      frames.push({
        kind: 'env', label: step.label, env,
        userBefore: user, userAfter: user,
        result: null, projection, shown: projection
      });
    } else {
      const result = resolveTraffic(toSimState(env, user, step.path));
      frames.push({
        kind: 'request', label: step.label, env,
        userBefore: user, userAfter: result.nextUser,
        result, projection: null, shown: result
      });
      user = result.nextUser;
    }
  });

  return frames;
}

/** Seeds an existing cohort's starting cookie and JSESSIONID. */
function seedUser(cohort: Cohort): UserSession {
  if (cohort.kind === 'new' || !cohort.seedSite) { return emptyUser(); }
  return { cookie: cohort.seedSite, jsSite: cohort.seedSite, jsServer: 1 };
}

/**
 * Folds a stage scenario into one frame per stage. At each stage the estate
 * change is applied once, then every cohort makes a request against it.
 *
 * 'new' cohorts reset to a cookie-less user before each stage — they model
 * whoever is arriving right now. 'existing' cohorts carry their cookie and
 * JSESSIONID forward, so a failure at one stage is still visible at the next.
 */
export function runStages(scenario: StageScenario): StageFrame[] {
  const frames: StageFrame[] = [];
  let env = baseEnv();
  const users = new Map<string, UserSession>();
  scenario.cohorts.forEach(c => users.set(c.id, seedUser(c)));

  scenario.stages.forEach(stage => {
    env = JSON.parse(JSON.stringify(env)) as EnvState;
    stage.apply(env);

    const cohorts: CohortFrame[] = scenario.cohorts.map(c => {
      const before = c.kind === 'new' ? emptyUser() : (users.get(c.id) ?? emptyUser());
      const result = resolveTraffic(toSimState(env, before, c.path));
      users.set(c.id, result.nextUser);
      return { cohortId: c.id, userBefore: before, userAfter: result.nextUser, result };
    });

    frames.push({ label: stage.label, note: stage.note, env, cohorts });
  });

  return frames;
}
