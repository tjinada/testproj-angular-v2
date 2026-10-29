import type {
  EnvState, JourneyStep, LivenessState, Overrides, PoolMonitor, Scenario, ScenarioConfig, SiteId
} from '../../models/traffic-flow.model';
import {
  APIC_INSTANCES, APP_SERVERS, IDP_LIVENESS, SITE_IDS, WEB_SERVERS, nodeLabel
} from './traffic-topology';

/** Production defaults: nothing overridden. */
export function defaultOverrides(): Overrides {
  return {
    down: {}, ltmMonitor: 'live', extGtmMonitor: 'live',
    idpLive: { BCC: 'present', SCC: 'present' },
    live: { BCC: 'present', SCC: 'present' }
  };
}

/** One way the estate differs from production, as listed under Overrides. */
export type OverrideItem =
  | { kind: 'down'; id: string; label: string; nodeIds: string[] }
  | { kind: 'extgtm' | 'ltm'; label: string; nodeIds: string[] }
  | { kind: 'idplive' | 'live'; site: SiteId; label: string; nodeIds: string[] };

/**
 * Everything the operator has changed from the production defaults. live.txt
 * only counts when no outage is selected, because only then is it applied.
 * `nodeIds` are the boxes to highlight when the row is hovered.
 */
export function listOverrides(o: Overrides, outageNone: boolean): OverrideItem[] {
  const items: OverrideItem[] = [];
  const both = (tier: string) => SITE_IDS.map(s => `${tier}-${s}`);
  const mon = (m: PoolMonitor) => (m === 'tcp' ? 'TCP' : 'live.txt');

  if (o.extGtmMonitor !== 'live') {
    items.push({ kind: 'extgtm', label: `EXT GTM monitor → ${mon(o.extGtmMonitor)}`, nodeIds: both('extgtm') });
  }
  if (o.ltmMonitor !== 'live') {
    items.push({ kind: 'ltm', label: `BOS LTM pool → ${mon(o.ltmMonitor)}`, nodeIds: both('ltm') });
  }
  SITE_IDS.forEach(site => {
    if (o.idpLive[site] !== 'present') {
      items.push({ kind: 'idplive', site, label: `${site} ${IDP_LIVENESS.split('/').pop()} → renamed`,
        nodeIds: [`idpltm-${site}`] });
    }
    if (outageNone && o.live[site] !== 'present') {
      items.push({ kind: 'live', site, label: `${site} /banking/live.txt → dead.txt`,
        nodeIds: [`web-${site}-1`, `web-${site}-2`] });
    }
  });
  Object.keys(o.down).forEach(id => {
    items.push({ kind: 'down', id, label: `${nodeLabel(id)} out of service`, nodeIds: [id] });
  });
  return items;
}

/** The value a chip flips to. */
export const flipLiveness = (v: LivenessState): LivenessState => (v === 'present' ? 'renamed' : 'present');
export const flipMonitor = (v: PoolMonitor): PoolMonitor => (v === 'live' ? 'tcp' : 'live');

/** Opens healthy on BCC, with sign-in where it lives today. */
export const DEFAULT_CONFIG: ScenarioConfig = {
  signinPath: 'api',
  site: 'BCC',
  idpSite: 'BCC',
  spaSite: 'BCC',
  sssSite: 'BCC',
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
  none: 'Normal',
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
export function buildScenario(c: ScenarioConfig, o: Overrides): Scenario {
  const stages = outageStages(c);
  const recovery = recoveryStages(c);
  const steps: JourneyStep[] = [];
  const outageNone = c.outageType === 'none';

  // Every step is one user action: sign-in, authentication.bmo.com,
  // apis.bmo.com, initISAMSession, /api/cdb/* and /banking/services. An estate change rides
  // on the step it precedes rather than taking a frame of its own.
  // No "before the outage" frame — the pinned user is established silently by
  // the runner, so the first step is the first thing that actually changes.
  if (stages.length === 0) {
    // "Normal" stops being true once anything is overridden, so say so.
    const n = listOverrides(o, outageNone).length;
    steps.push({ label: n ? `Normal + ${n} override${n > 1 ? 's' : ''}` : 'Normal' });
  }

  stages.forEach((stage, i) => {
    steps.push({ label: `Stage ${i + 1}`, change: stage.label, apply: stage.apply });
  });

  recovery.forEach((stage, i) => {
    steps.push({ label: `Recovery ${i + 1}`, change: stage.label, apply: stage.apply });
  });

  const same = c.site === c.outageSite;
  return {
    id: `${c.site}-${c.idpSite}-${c.spaSite}-${c.sssSite}-${c.outageType}-${c.outageSite}-${c.recovery}`,
    title: `${OUTAGE_TITLE[c.outageType]}${c.outageType === 'none' ? '' : ` on ${c.outageSite}`}`,
    blurb: outageNone
      ? `Normal running with the user on ${c.site}. Click any box to take it out of service.`
      : same
        ? `The user belongs to ${c.site}, which is the site going down.`
        : `The user belongs to ${c.site} while ${c.outageSite} goes down — the control case.`,
    // The user's own site is the GTM's answer while both sites are healthy.
    // Overrides are applied here so they survive every regeneration.
    base: env => {
      env.gtmPick = { bos: c.site, api: c.site, isam: c.idpSite, spa: c.spaSite, sss: c.sssSite };
      env.ltmMonitor = o.ltmMonitor;
      env.extGtmMonitor = o.extGtmMonitor;
      Object.keys(o.down).forEach(id => { env.down[id] = true; });
    },
    // Both liveness toggles are drains: they land on users already holding
    // their cookie, so those users keep hitting the drained site while new
    // users move away. live.txt is only applied with no outage selected —
    // otherwise the planned/unplanned stages own it.
    afterPin: env => {
      env.idpLive = { ...o.idpLive };
      if (outageNone) { env.live = { ...o.live }; }
    },
    steps
  };
}
