import type { MatchedRule, ParsedRequestUrl } from './papi-naive-matcher';
import type { AkamaiRuleEntry } from './akamai.service';

export type RewriteBehaviorKind = 'REWRITE' | 'REPLACE' | 'REMOVE' | 'PREPEND';

export type FlowHopKind = 'request' | 'property' | 'rewrite' | 'origin' | 'backend';

/** A text sub-line on a hop (e.g. "injects header x-api-key"). */
export interface HopAnnotation {
  label: string;
}

/**
 * A diverting rule we can't fully evaluate from the URL alone (gated by a
 * variable, header, or cookie). Rendered as a dimmed branch off the spine,
 * with the gate spelled out.
 */
export interface ConditionalBranch {
  conditionLabel: string;   // e.g. "if PMUSER_ROUTING_TO_SHAPE = true"
  targetLabel: string;      // e.g. "→ {{user.PMUSER_PATH}}"
  rulePath: string[];
}

export interface FlowHop {
  kind: FlowHopKind;
  label: string;
  detail: string;
  rulePath: string[];
  annotations: HopAnnotation[];
  branches: ConditionalBranch[];
}

export interface FlowResolution {
  destinationPath: string;
  pathChanged: boolean;
  flow: FlowHop[];
}

/**
 * Builds the request-to-origin flow for a URL from its matched rules.
 *
 * Spine (fully evaluable): request → property → rewrite(s) → origin → backend.
 * Path rewrites and the winning origin come from full-match rules, applied
 * in evaluation order (last origin wins, per PAPI). Partial-match rules that
 * would divert routing (rewriteUrl/origin gated by variables, headers, or
 * cookies) become labelled conditional branches off the property hop.
 */
export function resolveFlow(
  matchedRules: MatchedRule[],
  parsed: ParsedRequestUrl,
  property: { propertyName: string; version: number }
): FlowResolution {
  let working = parsed.path;
  const rewriteHops: FlowHop[] = [];
  const annotations: HopAnnotation[] = [];
  const branches: ConditionalBranch[] = [];
  let originHop: { detail: string; rulePath: string[] } | null = null;

  for (const rule of matchedRules) {
    if (rule.matchStatus !== 'full') {
      const branch = buildBranch(rule);
      if (branch) branches.push(branch);
      continue;
    }

    for (const behavior of rule.behaviors) {
      const opts = behavior.options || {};
      switch (behavior.name) {
        case 'rewriteUrl': {
          const before = working;
          const after = applyRewrite(before, opts);
          if (after !== before) {
            rewriteHops.push({
              kind: 'rewrite',
              label: asString(opts.behavior) || 'REWRITE',
              detail: `${before} \u2192 ${after}`,
              rulePath: rule.rulePath,
              annotations: [],
              branches: []
            });
            working = after;
          }
          break;
        }
        case 'origin': {
          const host = asString(opts.hostname);
          if (host) originHop = { detail: host, rulePath: rule.rulePath };
          break;
        }
        case 'modifyOutgoingRequestHeader': {
          const name =
            asString(opts.customHeaderName) ||
            asString(opts.standardAddHeaderName) ||
            asString(opts.headerName);
          if (name) pushAnnotation(annotations, `injects header ${name}`);
          break;
        }
        case 'cpCode': {
          const value = opts.value as Record<string, unknown> | undefined;
          const id = value && (typeof value.id === 'number' || typeof value.id === 'string') ? String(value.id) : '';
          if (id) pushAnnotation(annotations, `cpCode ${id}`);
          break;
        }
        case 'setVariable': {
          const name = asString(opts.variableName);
          if (name) pushAnnotation(annotations, `sets ${name}`);
          break;
        }
        case 'responseCookie': {
          const name = asString(opts.cookieName);
          if (name) pushAnnotation(annotations, `sets cookie ${name}`);
          break;
        }
        default:
          break;
      }
    }
  }

  const flow: FlowHop[] = [];

  flow.push({
    kind: 'request',
    label: parsed.hostname,
    detail: parsed.path,
    rulePath: [],
    annotations: [],
    branches: []
  });

  const hostRule =
    matchedRules.find(r => r.matchStatus === 'full' && r.criteria.some(c => c.name === 'hostname')) ||
    matchedRules.find(r => r.matchStatus === 'full') ||
    matchedRules[0];

  flow.push({
    kind: 'property',
    label: `${property.propertyName} v${property.version}`,
    detail: hostRule ? hostRule.rulePath.join(' \u203a ') : parsed.hostname,
    rulePath: hostRule ? hostRule.rulePath : [],
    annotations: [],
    branches
  });

  for (const hop of rewriteHops) flow.push(hop);

  flow.push({
    kind: 'origin',
    label: 'Origin',
    detail: originHop ? originHop.detail : '(default / unchanged)',
    rulePath: originHop ? originHop.rulePath : [],
    annotations,
    branches: []
  });

  flow.push({
    kind: 'backend',
    label: 'Backend',
    detail: working,
    rulePath: [],
    annotations: [],
    branches: []
  });

  return { destinationPath: working, pathChanged: working !== parsed.path, flow };
}

// ── Conditional branches (partial-match diverting rules) ────────────

function buildBranch(rule: MatchedRule): ConditionalBranch | null {
  const rewrite = rule.behaviors.find(b => b.name === 'rewriteUrl');
  const origin = rule.behaviors.find(b => b.name === 'origin');
  if (!rewrite && !origin) return null;

  let targetLabel = rule.ruleName;
  if (rewrite) {
    const o = rewrite.options || {};
    const target = asString(o.targetUrl) || asString(o.targetPath) || asString(o.targetPathPrepend);
    targetLabel = target ? `\u2192 ${target}` : asString(o.behavior) || 'rewrite';
  } else if (origin) {
    const host = asString((origin.options || {}).hostname);
    targetLabel = host ? `\u2192 origin ${host}` : 'origin';
  }

  return { conditionLabel: gateLabel(rule), targetLabel, rulePath: rule.rulePath };
}

function gateLabel(rule: MatchedRule): string {
  const parts: string[] = [];
  for (const criterion of rule.criteria) {
    if (!rule.unevaluatedCriteria.includes(criterion.name)) continue;
    parts.push(criterionLabel(criterion));
  }
  return parts.length ? 'if ' + parts.join(' and ') : 'conditional';
}

function criterionLabel(criterion: AkamaiRuleEntry): string {
  const o = criterion.options || {};
  const op = asString(o.matchOperator);
  const raw = (Array.isArray(o.values) ? o.values : Array.isArray(o.variableValues) ? o.variableValues : []) as unknown[];
  const values = raw.filter(v => typeof v === 'string') as string[];
  const val = values.join('/');

  switch (criterion.name) {
    case 'matchVariable': {
      const name = asString(o.variableName) || 'variable';
      return val ? `${name} = ${val}` : name;
    }
    case 'requestHeader': {
      const name = asString(o.headerName) || 'header';
      if (op === 'IS_NOT_ONE_OF') return val ? `header ${name} \u2260 ${val}` : `header ${name} absent`;
      return val ? `header ${name} = ${val}` : `header ${name} present`;
    }
    case 'requestCookie': {
      const name = asString(o.cookieName) || 'cookie';
      return val ? `cookie ${name} = ${val}` : `cookie ${name}`;
    }
    case 'matchAdvanced':
      return 'advanced match';
    default:
      return criterion.name;
  }
}

// ── Rewrite application + small helpers ─────────────────────────────

function applyRewrite(path: string, options: Record<string, unknown>): string {
  const kind = asString(options.behavior);
  switch (kind) {
    case 'REWRITE':
      return typeof options.targetUrl === 'string' ? options.targetUrl : path;
    case 'REPLACE': {
      const match = asString(options.match);
      if (!match) return path;
      const target = asString(options.targetPath);
      return options.matchMultiple === true
        ? path.split(match).join(target)
        : replaceFirst(path, match, target);
    }
    case 'REMOVE': {
      const match = asString(options.match);
      if (!match) return path;
      return options.matchMultiple === true
        ? path.split(match).join('')
        : replaceFirst(path, match, '');
    }
    case 'PREPEND': {
      const prepend = asString(options.targetPathPrepend);
      if (!prepend) return path;
      return prepend.replace(/\/+$/, '') + '/' + path.replace(/^\/+/, '');
    }
    default:
      return path;
  }
}

function pushAnnotation(list: HopAnnotation[], label: string): void {
  if (!list.some(a => a.label === label)) list.push({ label });
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function replaceFirst(haystack: string, needle: string, replacement: string): string {
  const idx = haystack.indexOf(needle);
  if (idx < 0) return haystack;
  return haystack.slice(0, idx) + replacement + haystack.slice(idx + needle.length);
}
