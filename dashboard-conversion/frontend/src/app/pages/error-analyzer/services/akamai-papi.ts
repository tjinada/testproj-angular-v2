/**
 * PAPI rule-tree evaluation, in the browser.
 *
 * Three concerns, kept as separate sections and separate exports so they
 * can be split into their own files if this grows:
 *
 *   1. Variable resolution  — expandExpression, seedVariables
 *   2. Criterion evaluation — evaluateCriterion, evaluate
 *   3. Outcome extraction   — buildOutcome
 *
 * Derived from backend/src/services/papi-naive-matcher.ts, with four
 * corrections that each produced a plausible wrong answer before being
 * found (see the comments at each site):
 *
 *   - a rule can never be more certain than its enclosing branch
 *   - declared defaults apply only to variables the config assigns
 *   - matchVariable may compare via variableExpression, not variableValues
 *   - the last matching origin wins even when it doesn't resolve
 *
 * Pure module: no Angular, no I/O, no dependency on the config service.
 */

import {
  AkamaiRuleEntry,
  ConfigIndex,
  DecidedStep,
  MatchedRule,
  Outcome,
  TraceRequest,
  TraceResult,
  VarProvenance
} from '../models/akamai-rule-tree.model';

/** Marker left in a value that couldn't be resolved from the request. */
export const UNRESOLVED = '?';

/** True when a value is known and contains no unresolved fragment. */
export function isResolved(value: string | undefined): boolean {
  return value !== undefined && value.indexOf(UNRESOLVED) < 0;
}

// ── 1. Variable resolution ───────────────────────────────────────────

/**
 * Expands {{...}} references.
 *
 * `{{user.PMUSER_X}}` resolves from simulated state. Three builtins come
 * from the request itself; every other builtin (TLS version, origin DNS
 * name, cipher) is only knowable at request time and yields UNRESOLVED.
 */
export function expandExpression(
  template: unknown,
  vars: Record<string, string>,
  req: TraceRequest
): string {
  const text = String(template === null || template === undefined ? '' : template);
  return text.replace(/\{\{([^}]+)\}\}/g, (_match, rawRef: string) => {
    const ref = rawRef.trim();
    if (ref.startsWith('user.')) {
      const value = vars[ref.slice(5)];
      return value === undefined ? UNRESOLVED : value;
    }
    if (ref === 'builtin.AK_HOST') return req.hostname;
    if (ref === 'builtin.AK_PATH') return req.path;
    if (ref === 'builtin.AK_QUERY') return req.query;
    return UNRESOLVED;
  });
}

/**
 * Seeds the variable table before the walk starts.
 *
 * A declared variable holds its default at runtime until a rule overwrites
 * it — that is how the PMUSER_INVALID_* flags work, and several are
 * declared as empty string. But variables the config never assigns via
 * setVariable come from advanced XML or the edge, so their declared
 * default is not their real value and they must stay unknown.
 */
function seedVariables(
  index: ConfigIndex,
  req: TraceRequest
): { vars: Record<string, string>; prov: Record<string, VarProvenance> } {
  const vars: Record<string, string> = {};
  const prov: Record<string, VarProvenance> = {};

  (index.doc.rules.variables || []).forEach(declared => {
    const assigned = index.assignedVariables.has(declared.name);
    const value = assigned ? String(declared.value === null || declared.value === undefined ? '' : declared.value) : UNRESOLVED;
    vars[declared.name] = value;
    prov[declared.name] = {
      raw: assigned ? value : 'set outside the JSON (advanced XML or edge runtime)',
      value,
      ruleId: null,
      ruleName: 'property default'
    };
  });

  // The GTM answer is ground truth for PMUSER_COOKIE. The config derives it
  // by regex over the origin DNS name, which no config parse can see, so
  // that assignment is skipped later rather than allowed to clobber this.
  if (req.gtmAnswer) {
    vars['PMUSER_COOKIE'] = req.gtmAnswer;
    prov['PMUSER_COOKIE'] = {
      raw: '{{builtin.AK_ORIGIN_DNS_NAME}}',
      value: req.gtmAnswer,
      ruleId: null,
      ruleName: 'GTM answer (supplied)'
    };
  }

  return { vars, prov };
}

/** 'www13' is BCC, 'www12' is SCC — consistent across every scope. */
export function gtmDatacentre(gtmAnswer: string): string | null {
  if (gtmAnswer === 'www13') return 'BCC';
  if (gtmAnswer === 'www12') return 'SCC';
  return null;
}

// ── 2. Criterion evaluation ──────────────────────────────────────────

/** Akamai wildcard match. `*` matches any run of characters. */
function wildcardMatch(pattern: string, value: string, caseSensitive: boolean): boolean {
  let p = pattern;
  let v = value;
  if (!caseSensitive) {
    p = p.toLowerCase();
    v = v.toLowerCase();
  }
  const source = p
    .split('*')
    .map(part => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
    .join('.*');
  return new RegExp('^' + source + '$').test(v);
}

function anyWildcardMatch(patterns: unknown, value: string, caseSensitive: boolean): boolean {
  return ((patterns as string[]) || []).some(p => wildcardMatch(String(p), value, caseSensitive));
}

/**
 * Evaluates one criterion.
 *
 * Returns true, false, or null. null means "cannot be decided from the
 * request" — a response-code gate, an advanced XML block, a device
 * characteristic. It is not the same as false, and conflating the two is
 * what makes a trace confidently wrong.
 */
export function evaluateCriterion(
  criterion: AkamaiRuleEntry,
  req: TraceRequest,
  vars: Record<string, string>
): boolean | null {
  const o = (criterion.options || {}) as Record<string, any>;
  const operator = String(o['matchOperator'] || '');
  const negated = /NOT|DOES_NOT/.test(operator);
  const flip = (result: boolean | null) => (result === null ? null : negated ? !result : result);

  switch (criterion.name) {
    case 'path':
      return flip(anyWildcardMatch(o['values'], req.path, o['matchCaseSensitive'] === true));

    case 'hostname':
      return flip(anyWildcardMatch(o['values'], req.hostname, false));

    case 'fileExtension':
      return flip(((o['values'] as string[]) || []).some(v => String(v).toLowerCase() === req.fileExtension));

    case 'requestProtocol':
      return flip(String(o['value'] || '').toUpperCase() === 'HTTPS');

    case 'cloudletsOrigin':
      if (!req.cloudletArm) return null;
      return req.cloudletArm === o['originId'];

    case 'requestHeader': {
      // TARGET is an Akamai-side test/bypass header, never present on real
      // traffic. Treating it as absent decides 16 criteria that would
      // otherwise be permanently undecidable. Every other header is unknown.
      if (String(o['headerName'] || '').toLowerCase() !== 'target') return null;
      if (operator === 'EXISTS' || operator === 'DOES_NOT_EXIST') return flip(false);
      return null;
    }

    case 'requestCookie': {
      const known = req.cookies[String(o['cookieName'])];
      if (known === undefined) return null;
      if (operator === 'EXISTS' || operator === 'DOES_NOT_EXIST') return flip(known !== '');
      if (known === '') return flip(false);
      return flip(
        o['matchWildcardValue']
          ? wildcardMatch(String(o['value']), known, o['matchCaseSensitiveValue'] === true)
          : String(o['value']) === known
      );
    }

    case 'matchVariable': {
      const current = vars[String(o['variableName'])];
      if (!isResolved(current)) return null;
      // Some criteria compare against a single expression rather than a
      // values list, and that expression can itself contain {{...}}.
      let candidates: string[];
      if (o['variableExpression'] !== undefined) {
        const expanded = expandExpression(o['variableExpression'], vars, req);
        if (!isResolved(expanded)) return null;
        candidates = [expanded];
      } else {
        candidates = ((o['variableValues'] as string[]) || []).map(String);
      }
      return flip(
        o['matchWildcard']
          ? candidates.some(c => wildcardMatch(c, current as string, o['matchCaseSensitive'] === true))
          : candidates.some(c => c === current)
      );
    }

    default:
      // matchAdvanced, matchResponseCode, originTimeout, cacheability,
      // responseHeader, contentType, userAgent, deviceCharacteristic,
      // metadataStage — none decidable from a request line.
      return null;
  }
}

/**
 * Walks the rule tree against a request, resolving variables as it goes.
 *
 * Children are only reached when their parent could match, and a child is
 * never more certain than its parent — without that, a decidable rule
 * under an undecidable branch stamps variables for a path the request may
 * never take.
 */
export function evaluate(index: ConfigIndex, req: TraceRequest): TraceResult {
  const { vars, prov } = seedVariables(index, req);
  const matched: MatchedRule[] = [];
  const datacentre = gtmDatacentre(req.gtmAnswer);

  const walk = (id: number, parentStatus: 'full' | 'partial'): void => {
    const node = index.nodes[id];
    const rule = node.rule;
    const criteria = rule.criteria || [];
    let status: 'full' | 'partial' = 'full';
    let unknown: string[] = [];

    if (criteria.length) {
      const results = criteria.map(c => ({ c, value: evaluateCriterion(c, req, vars) }));
      unknown = results
        .filter(r => r.value === null)
        .map(r => {
          const name = (r.c.options as Record<string, any>)['variableName'];
          return name ? `${r.c.name} ${name}` : r.c.name;
        });

      if (rule.criteriaMustSatisfy === 'any') {
        if (results.some(r => r.value === true)) {
          status = unknown.length ? 'partial' : 'full';
        } else if (unknown.length) {
          status = 'partial';
        } else {
          return;
        }
      } else {
        if (results.some(r => r.value === false)) return;
        status = unknown.length ? 'partial' : 'full';
      }
    }

    if (parentStatus === 'partial') {
      status = 'partial';
      if (!unknown.length) unknown = ['enclosing rule'];
    }

    matched.push({ id, status, unknown });

    if (status === 'full') {
      (rule.behaviors || []).forEach(behavior => {
        if (behavior.name !== 'setVariable') return;
        const o = (behavior.options || {}) as Record<string, any>;
        const name = String(o['variableName'] || '');
        if (!name) return;
        // See seedVariables: the supplied GTM answer outranks the config's
        // own derivation of PMUSER_COOKIE.
        if (req.gtmAnswer && name === 'PMUSER_COOKIE') return;

        let value: string;
        if (o['valueSource'] === 'EXPRESSION') {
          value = expandExpression(o['variableValue'], vars, req);
          if (o['transform'] === 'SUBSTITUTE' && o['regex']) {
            try {
              value = value.replace(
                new RegExp(String(o['regex']), o['globalSubstitution'] ? 'g' : ''),
                String(o['replacement'] || '')
              );
            } catch {
              // A regex the browser won't compile leaves the value as-is.
            }
          }
          if (o['transform'] === 'TRIM') value = value.trim();
        } else {
          // EXTRACT reads a header or cookie we can't see.
          value = UNRESOLVED;
        }

        vars[name] = value;
        prov[name] = {
          raw: o['valueSource'] === 'EXPRESSION' ? String(o['variableValue']) : `EXTRACT ${o['extractLocation']}`,
          value,
          ruleId: id,
          ruleName: rule.name
        };

        // Entering a scope pins its GTM hostname. Combined with the answer
        // the caller supplied, that is the CNAME chain the edge would have
        // resolved — which is what the no-cookie branch reads.
        if (name === 'PMUSER_GTM' && datacentre) {
          const scope = index.gtmMap[value];
          if (scope && scope[datacentre]) {
            vars['PMUSER_CNAME_CHAIN'] = scope[datacentre];
            prov['PMUSER_CNAME_CHAIN'] = {
              raw: `GTM lookup on ${value}`,
              value: scope[datacentre],
              ruleId: id,
              ruleName: `GTM answer (${datacentre}) via ${rule.name}`
            };
          }
        }
      });
    }

    node.children.forEach(childId => walk(childId, status));
  };

  walk(0, 'full');
  return { matched, vars, prov };
}

// ── 3. Outcome extraction ────────────────────────────────────────────

/** Applies one rewriteUrl behavior to the current path. */
function applyRewrite(path: string, o: Record<string, any>, target: string): string {
  switch (o['behavior']) {
    case 'REPLACE':
      return path.split(String(o['match'])).join(target || '');
    case 'REMOVE':
      return path.split(String(o['match'])).join('');
    case 'PREPEND':
      return (target || '') + path;
    default:
      return target || path;
  }
}

/** Session-routing cookies. Everything else is noise for this tab. */
const SESSION_COOKIE = /siteId$|dc$/i;

/** Variables worth reporting when a rule assigns them. */
const ROUTING_VARIABLE = /^PMUSER_(TARGET|GTM|COOKIE|INVALID_)/;

/** Scopes named in the tree, used to label the "Decided" line. */
const APP_SCOPE = /^(CDB_SPA|CDB_BOS|CDB - APIC|GSS-BUX - ISAM|APIC Origin|ISAM Launch)/i;

/**
 * Reduces a walk into what actually happens to the request: where it goes,
 * what the path becomes, which session cookies get stamped, and a one-line
 * account of how the destination was chosen.
 */
export function buildOutcome(index: ConfigIndex, req: TraceRequest, result: TraceResult): Outcome {
  const vars = result.vars;
  const outcome: Outcome = {
    startPath: req.path,
    path: req.path,
    rewrites: [],
    origin: null,
    cookies: [],
    redirect: null,
    actions: {},
    decided: []
  };

  result.matched.forEach(match => {
    const rule = index.nodes[match.id].rule;
    const certain = match.status === 'full';
    const did: string[] = [];
    const ref = { ruleId: match.id, ruleName: rule.name };

    (rule.behaviors || []).forEach(behavior => {
      const o = (behavior.options || {}) as Record<string, any>;

      switch (behavior.name) {
        case 'rewriteUrl': {
          const before = outcome.path;
          const after = applyRewrite(before, o, expandExpression(o['targetUrl'], vars, req));
          if (after === before) break;
          if (certain) {
            outcome.rewrites.push({ ...ref, before, after });
            outcome.path = after;
            did.push(`rewrites path → ${after}`);
          } else {
            did.push(`would rewrite → ${after}`);
          }
          break;
        }

        case 'origin': {
          if (!o['hostname']) break;
          const host = expandExpression(o['hostname'], vars, req);
          if (certain) {
            outcome.origin = {
              ...ref,
              host,
              raw: String(o['hostname']),
              resolved: isResolved(host) && host !== '',
              forwardHostHeader:
                o['forwardHostHeader'] === 'CUSTOM' ? String(o['customForwardHostHeader']) : o['forwardHostHeader']
            };
          }
          did.push(`origin ${host}`);
          break;
        }

        case 'responseCookie': {
          const name = String(o['cookieName'] || '');
          if (!name || !SESSION_COOKIE.test(name)) break;
          const value = expandExpression(o['value'], vars, req);
          if (certain && isResolved(value)) {
            outcome.cookies.push({ ...ref, name, value });
            did.push(`sets cookie ${name}=${value}`);
          }
          break;
        }

        case 'redirect': {
          outcome.redirect = {
            ...ref,
            code: String(o['responseCode']),
            to: String(o['destinationPathOther'] || o['destinationHostnameOther'] || '(same host)')
          };
          did.push(`redirect ${o['responseCode']}`);
          break;
        }

        case 'setVariable': {
          const name = String(o['variableName'] || '');
          if (!certain || !ROUTING_VARIABLE.test(name)) break;
          const value = vars[name];
          if (isResolved(value)) did.push(`${name} = ${value}`);
          break;
        }

        default:
          // Header injection, caching, cpCode, compression — none of these
          // change where the request goes, so they don't count as acting.
          break;
      }
    });

    if (did.length) outcome.actions[match.id] = did;
  });

  outcome.decided = buildDecided(index, result, outcome);
  return outcome;
}

/**
 * The three facts the Origin line alone doesn't give you: which app branch
 * owns the path, which stickiness branch it took, and what produced
 * PMUSER_TARGET. Read off the ancestor trail of the rule that settled it,
 * so it follows the config rather than a hardcoded model of it.
 */
function buildDecided(index: ConfigIndex, result: TraceResult, outcome: Outcome): DecidedStep[] {
  const target = result.prov['PMUSER_TARGET'];
  const anchor = target && target.ruleId !== null ? target.ruleId : outcome.origin ? outcome.origin.ruleId : null;
  if (anchor === null) return [];

  const node = index.nodes[anchor];
  const trail = node.trail.concat(node.rule.name);
  const find = (re: RegExp) => trail.find(name => re.test(name));
  const steps: DecidedStep[] = [];

  const scope = find(APP_SCOPE);
  if (scope) steps.push({ label: scope });

  const forced = Object.keys(result.prov).find(
    name => /^PMUSER_INVALID_/.test(name) && result.prov[name].value === 'TRUE'
  );
  if (forced) {
    steps.push({ label: `forced invalid by ${result.prov[forced].ruleName}`, warn: true });
  } else if (find(/^Cookie in Request/)) {
    steps.push({ label: 'sticky cookie' });
  } else if (find(/^No Cookie|^No TARGET Header/)) {
    steps.push({ label: 'no valid cookie' });
  }

  if (target && isResolved(target.value)) {
    if (/PMUSER_CNAME_CHAIN/.test(target.raw || '')) {
      const chain = result.prov['PMUSER_CNAME_CHAIN'];
      steps.push({ label: `GTM lookup on ${chain ? chain.raw.replace(/^GTM lookup on /, '') : ''}` });
    } else {
      steps.push({ label: target.ruleName });
    }
  } else if (target) {
    steps.push({ label: 'GTM answer not supplied', warn: true });
  }

  return steps;
}
