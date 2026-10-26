import type { QaEndpointGroup } from './qa-topology';
import { QaChannelRoute, SIT2_CHANNEL_ROUTES } from './qa-channel-routes';

/**
 * Per-environment values for the CDB QA traffic flow. Everything that differs
 * between QA1, QA2, ... lives here; the shape lives in qa-topology.ts.
 *
 * Adding an environment = adding one profile. Anything a profile leaves out
 * renders as "not set" rather than failing, so profiles can be filled in gradually.
 */
export interface QaEnvProfile {
  /** Value of the ?qaenv= query param, e.g. 'qa5'. */
  id: string;
  label: string;
  /** Node id -> hostnames shown on the box and in the drawer. */
  hosts: Record<string, string[]>;
  /** edgeId ('from>to') -> path label, where it differs from the topology default. */
  edgeLabels?: Record<string, string>;
  /** Node id -> endpoint list, replacing the shared catalogue for that node. */
  endpoints?: Record<string, QaEndpointGroup[]>;
  /** Node ids that don't exist in this environment. */
  absent?: string[];
  /** SSS /api/cdb routing to microservices (APIC config for this environment's SIT). */
  channelRoutes?: QaChannelRoute[];
}

export const QA_ENVIRONMENTS: QaEnvProfile[] = [
  {
    id: 'qa5',
    label: 'QA5',
    channelRoutes: SIT2_CHANNEL_ROUTES,
    hosts: {
      spa:   ['www.olb-gss-qa56.dev.bmo.com'],
      gss:   ['QA56 · /api/cdb/* → /api5/cdb/*'],
      mfe:   ['qa2.auth.bmo.com/*'],
      ns:    ['qa2.auth.bmo.com'],
      idp:   ['bmonsori-mobileidp-sit2.bmofg.com'],
      wem:   ['bmonsori-qawem3-harrismycfo.dev.bmo.com'],
      apic:  ['bmonsori-apisit.bmo.com'],
      isam:  ['retailcanapi-sit2.bmofg.com'],
      f5:    ['www.olb-qa5.dev.bmo.com'],
      web1:  ['olb-ocbqlweb051.srv.mgt.bmogc.net'],
      web2:  ['olb-ocbqlweb052.srv.mgt.bmogc.net'],
      bos:   ['olb-ocbqlapp051.srv.mgt.bmogc.net', 'olb-ocbqlapp052.srv.mgt.bmogc.net'],
      sss1:  ['api2-sit2.bmogc.net'],
      mid:   ['s2sb.bmogc.net'],
      chan:  ['ocp4-qa.bmogc.net'],
      sss2:  ['api2-sit2.bmogc.net'],
      dcgw:  ['DigitalCore'],
      dcl:   ['DigitalCore'],
      awsgw: ['dev-shr-ca1-aws-apigw01'],
      awsl:  ['ca-central-1']
    },
    edgeLabels: {
      'gss>apic': '/api5/cdb/*'
    }
  }
];

export const DEFAULT_QA_ENV = 'qa5';
