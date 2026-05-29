import { Release, ReleaseComponents, Stage, SubStep, SubStepTrack } from '../models/release-workflow.model';

export function normalizeReleaseComponents(
  input?: Partial<ReleaseComponents> | null,
): ReleaseComponents {
  return {
    cdbui: input?.cdbui ?? true,
    cdbbos: input?.cdbbos ?? true,
  };
}

export function isTrackVisibleForRelease(
  track: SubStepTrack | string | null | undefined,
  release: Pick<Release, 'releaseComponents'>,
): boolean {
  const normalizedTrack: SubStepTrack = track === 'cdbui' || track === 'cdbbos' ? track : 'generic';
  if (normalizedTrack === 'generic') return true;
  const components = normalizeReleaseComponents(release.releaseComponents);
  return normalizedTrack === 'cdbui' ? components.cdbui : components.cdbbos;
}

export function visibleSubStepsForRelease(
  stage: Stage,
  release: Pick<Release, 'releaseComponents'>,
): SubStep[] {
  return stage.subSteps.filter((subStep) => isTrackVisibleForRelease(subStep.track, release));
}

export function visibleStagesForRelease(release: Release): Stage[] {
  return release.stages.filter((stage) => visibleSubStepsForRelease(stage, release).length > 0);
}

export function selectedReleaseComponentsLabel(release: Pick<Release, 'releaseComponents'>): string {
  const components = normalizeReleaseComponents(release.releaseComponents);
  const labels: string[] = [];
  if (components.cdbbos) labels.push('CDB BOS');
  if (components.cdbui) labels.push('CDB UI/Mobile');
  return labels.length > 0 ? labels.join(', ') : 'None selected';
}