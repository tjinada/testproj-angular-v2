import type {
  EnvState, EstateOverrides, JourneyStep, Scenario, ScenarioConfig, SiteId
} from '../../models/traffic-flow.model';
import { APIC_INSTANCES, APP_SERVERS, WEB_SERVERS } from './traffic-topology';

/** Opens healthy on BCC so the tool starts from a working estate. */
export const DEFAULT_CONFIG: ScenarioConfig = {
  site: 'BCC',
  outageSite: 'BCC',
  outageType: 'none',
  recovery: 'none'
};

const jvms = (env: EnvState, site: SiteId, down: boolean) => {
  for (let i = 1; i <= APP_SERVERS; i++) {
    if (down) { env.down[`app-${site}-${i}`] = true; }
    else { delete env.down[`app-${site}-${i}`]; }
  }
};

const ihs = (env: EnvState, site: SiteId, down: boolean) => {
  for (let i = 1; i <= WEB_SERVERS; i++) {
    if (down) { env.down[`web-${site}-${i}`] = true; }
    else { delete env.down[`web-${site}-${i}`]; }
  }
};

const apic = (env: EnvState, site: SiteId, down: boolean) => {
  if (down) { env.down[`apicfs-${site}`] = true; } else { delete env.down[`apicfs-${site}`]; }
  for (let i = 1; i <= APIC_INSTANCES; i++) {
    if (down) { env.down[`apic-${site}-${i}`] = true; }
    else { delete env.down[`apic-${site}-${i}`]; }
  }
};

/** The primary path this journey exercises. csgcb rides alongside it. */
export function primaryLabel(): string {
  return '/api/cdb';
}

/**
 * The outage stages. Order of operations is the whole point:
 *
 * planned   — live.txt is renamed first, so the GTM drains the site before the
 *             JVMs stop. New arrivals never touch it; only cookie-pinned
 *             traffic is exposed.
 * unplanned — the JVMs stop while live.txt is still being served by IHS, so
 *             both GTMs keep sending into a site that cannot answer. Prod
 *             support then renames the object to force the drain, and the
 *             server is shut down last.
 */
function outageStages(c: ScenarioConfig): { label: string; apply: (e: EnvState) => void }[] {
  const s = c.outageSite;
  switch (c.outageType) {
    case 'planned':
      return [
        { label: `Rename live.txt on ${s} — GTM drains the site`,
          apply: e => { e.live[s] = 'renamed'; } },
        { label: `Shut down ${s} JVMs`, apply: e => jvms(e, s, true) }
      ];
    case 'unplanned':
      return [
        { label: `${s} JVMs go down — live.txt still served`,
          apply: e => jvms(e, s, true) },
        { label: `Prod support renames live.txt on ${s}`,
          apply: e => { e.live[s] = 'renamed'; } },
        { label: `Shut down the ${s} server (IHS)`, apply: e => ihs(e, s, true) }
      ];
    case 'apic':
      return [
        { label: `${s} APIC outage — LTM and all instances`,
          apply: e => apic(e, s, true) }
      ];
    default:
      return [];
  }
}

/**
 * Recovery stages. Only the unplanned mode has an ordering worth choosing,
 * because only it takes both tiers down. Bringing IHS back before the JVMs
 * restores live.txt while there is still nothing behind it, so the GTM returns
 * traffic to a site that answers 503.
 */
function recoveryStages(c: ScenarioConfig): { label: string; apply: (e: EnvState) => void }[] {
  const s = c.outageSite;
  if (c.recovery === 'none' || c.outageType === 'none') { return []; }

  if (c.outageType === 'apic') {
    return [{ label: `Bring ${s} APIC back up`, apply: e => apic(e, s, false) }];
  }

  if (c.outageType === 'planned') {
    return [{
      label: `Bring ${s} JVMs up, then restore live.txt`,
      apply: e => { jvms(e, s, false); e.live[s] = 'present'; }
    }];
  }

  const jvmStage = {
    label: `Bring ${s} JVMs back up`,
    apply: (e: EnvState) => jvms(e, s, false)
  };
  const ihsStage = {
    label: `Bring ${s} IHS back up — live.txt returns`,
    apply: (e: EnvState) => { ihs(e, s, false); e.live[s] = 'present'; }
  };
  return c.recovery === 'ihs-then-jvm' ? [ihsStage, jvmStage] : [jvmStage, ihsStage];
}

const OUTAGE_TITLE: Record<string, string> = {
  none: 'Healthy estate',
  planned: 'Planned CDBBOS drain',
  unplanned: 'Unplanned CDBBOS outage',
  apic: 'APIC outage'
};

/**
 * Turns the rail's config into a journey. Pure — the component regenerates on
 * every control change rather than behind a build button.
 *
 * Every stage is followed by a request pair, so each frame answers "who is
 * broken right now" rather than only showing the end state.
 */
export function buildScenario(c: ScenarioConfig, o: EstateOverrides): Scenario {
  const stages = outageStages(c);
  const recovery = recoveryStages(c);
  const steps: JourneyStep[] = [];

  // Every step is one user action: the primary call plus the initISAMSession
  // that follows it. An estate change rides on the step it precedes rather
  // than taking a frame of its own.
  // No "before the outage" frame — the pinned user is established silently by
  // the runner, so the first step is the first thing that actually changes.
  if (stages.length === 0) {
    steps.push({ label: 'Healthy estate' });
  }

  stages.forEach((stage, i) => {
    steps.push({ label: `Stage ${i + 1}`, change: stage.label, apply: stage.apply });
  });

  recovery.forEach((stage, i) => {
    steps.push({ label: `Recovery ${i + 1}`, change: stage.label, apply: stage.apply });
  });

  const same = c.site === c.outageSite;
  return {
    id: `${c.site}-${c.outageType}-${c.outageSite}-${c.recovery}`,
    title: `${OUTAGE_TITLE[c.outageType]}${c.outageType === 'none' ? '' : ` on ${c.outageSite}`}`,
    blurb: c.outageType === 'none'
      ? `A healthy estate with the user on ${c.site}. Click any box to take it out of service.`
      : same
        ? `The user belongs to ${c.site}, which is the site going down.`
        : `The user belongs to ${c.site} while ${c.outageSite} goes down — the control case.`,
    // The user's own site is the GTM's answer while both sites are healthy.
    // Rail-owned settings are applied here so they survive every regeneration.
    base: env => {
      env.gtmPick = { bos: c.site, api: c.site };
      env.ltmMonitor = o.ltmMonitor;
      env.extGtmMonitor = o.extGtmMonitor;
      Object.keys(o.down).forEach(id => { env.down[id] = true; });
    },
    steps
  };
}
