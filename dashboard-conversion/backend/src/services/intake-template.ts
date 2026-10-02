import { loadIntakeTemplate, IntakeFieldDef, IntakeTemplate } from './intake-template-loader';
import config from '../config';

export interface IntakeStep1 {
  daTeam: string;
  release: string;
  jiraBoardKey?: string;
  intakeTitle?: string;
}

export interface IntakeFormData {
  step1: {
    daTeam: string;
    release: string;
    jiraBoardKey?: string;
    intakeTitle?: string;
  };
  generalValues: Record<string, any>;
  selectedScopes: string[];
  scopeValues: Record<string, any>;
  dynamicRows?: Record<string, any[][]>;
}

function escapeHtml(s: string | undefined | null): string {
  return (s || '')
    .toString()
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function renderOptionLabel(opt: any): string {
  if (typeof opt === 'string') return opt;
  if (!opt) return '';
  return String(opt.label || opt.value || opt.name || '');
}

function renderTaskListOptions(options: any[], selected: Set<string>): string {
  const tasks = options.map((opt) => {
    const label = renderOptionLabel(opt);
    const checked = selected.has(label) ? 'complete' : 'incomplete';
    return `<ac:task><ac:task-status>${checked}</ac:task-status><ac:task-body>${escapeHtml(label)}</ac:task-body></ac:task>`;
  });
  return `<ac:task-list>${tasks.join('')}</ac:task-list>`;
}

function renderCheckboxField(field: IntakeFieldDef, value: any): string {
  const options = (field.options || []) as string[];
  const selected = new Set(Array.isArray(value) ? value.map(String) : []);
  return renderTaskListOptions(options, selected);
}

function renderLinkValue(val: any): string {
  const href = String(val || '');
  if (!href) return '';
  // If the value does not look like a full URL, treat it as a Jira project/board key
  // and construct the full boards URL using configured Jira/Confluence base.
  let url = href;
  if (!/^https?:\/\//i.test(href)) {
    // Prefer Jira base URL, fallback to Confluence base URL
    const candidate = (config.jira?.baseUrl || config.confluence?.baseUrl || '').toString();
    let origin = '';
    try {
      if (candidate) {
        const u = new URL(candidate);
        origin = u.origin;
      }
    } catch (e) {
      // fallback: strip path after host if present
      const idx = candidate.indexOf('/', candidate.indexOf('://') + 3);
      origin = idx === -1 ? candidate : candidate.substring(0, idx);
    }
    if (origin) {
      url = `${origin.replace(/\/$/, '')}/browse/${encodeURIComponent(href)}`;
    } else {
      // As last resort, use href as-is
      url = href;
    }
  }
  return `<a href="${escapeHtml(url)}">${escapeHtml(href)}</a>`;
}

function renderDynamicRows(field: IntakeFieldDef, dynamicRows: any[][] | undefined): string {
  const rows = dynamicRows || [];
  const cols = field.columns || [];
  const th = cols.map((c) => `<th>${escapeHtml(c)}</th>`).join('');
  const trs = rows.map((r) => `<tr>${r.map((c) => `<td>${escapeHtml(c)}</td>`).join('')}</tr>`).join('');
  return `<table class="dynamic-table"><thead><tr>${th}</tr></thead><tbody>${trs}</tbody></table>`;
}

// Helper: whether a dynamic row has any non-empty cell
function rowHasContent(row: any[]): boolean {
  return row.some(cell => String(cell || '').trim());
}

// Helper: join filtered row cells into single string
function rowToJoinedString(row: any[]): string {
  return row
    .filter((c) => String(c || '').trim())
    .map((c) => escapeHtml(String(c).trim()))
    .join(' - ');
}

function renderSubFieldsHtml(subs: any[] = [], formData?: IntakeFormData): string {
  const parts: string[] = [];
  for (const sub of subs) {
    const subVal = formData?.generalValues?.[sub.field] ?? formData?.scopeValues?.[sub.field];
    if (sub.type === 'checkbox') {
      const labelPrefix = sub.label ? `<p><strong>${escapeHtml(sub.label)}</strong></p>` : '';
      parts.push(labelPrefix + renderTaskListOptions(sub.options || [], new Set(Array.isArray(subVal) ? subVal.map(String) : [])));
    } else if (sub.type === 'textarea' || sub.type === 'text') {
      if (sub.label) parts.push(`<p>${escapeHtml(sub.label)}${subVal ? '<br/>' + escapeHtml(subVal) : ''}</p>`);
      else if (subVal) parts.push(`<p>${escapeHtml(subVal)}</p>`);
    } else if (sub.type === 'link') {
      parts.push(`<p><strong>${escapeHtml(sub.label || sub.field)}</strong>: ${renderLinkValue(subVal)}</p>`);
    } else {
      parts.push(`<p>${escapeHtml(subVal)}</p>`);
    }
  }
  return parts.join('');
}

function renderFieldValue(field: IntakeFieldDef, value: any, formData: IntakeFormData): string {
  switch (field.type) {
    case 'text':
    case 'date':
    case 'number':
      return `<div>${escapeHtml(value)}</div>`;
    case 'link':
      return renderLinkValue(value);
    case 'textarea':
      return `<p>${escapeHtml(value).replaceAll('\n', '<br/>')}</p>`;
    case 'dynamic-rows':
      return renderDynamicRows(field, formData.dynamicRows?.[field.field]);
    default:
      return `<div>${escapeHtml(value)}</div>`;
  }
}

function getFieldValue(field: IntakeFieldDef, formData: IntakeFormData, scopeId?: string): any {
  const val = formData.generalValues?.[field.field] ?? formData.scopeValues?.[field.field];
  if (val !== undefined) return val;
  if (scopeId && !formData.selectedScopes?.includes(scopeId)) {
    if (field.type === 'yes-no') return 'No';
    if (field.type === 'radio' || field.type === 'conditional-radio') return 'No';
    if (field.type === 'checkbox') return [];
  }
  return val;
}



function renderRadioWithLinkRows(field: IntakeFieldDef, val: any, formData?: IntakeFormData): string[] {
  const result: string[] = [];
  const opts = field.options || [];
  const numOpts = opts.length;
  // Support two shapes:
  // 1) Object shape: { selected: 'Option', links: { 'Option': 'https://...' } }
  // 2) Flat shape (frontend current): selected is a string and link is stored under `${field.field}_link`
  let selected = '';
  let links: Record<string, string> = {};
  if (typeof val === 'object' && (val as any)?.selected !== undefined) {
    selected = String((val as any).selected || '');
    links = (val as any).links || {};
  } else {
    selected = typeof val === 'string' ? val : String(val || '');
    // Fallback: check for a separate <field>_link key in generalValues or scopeValues
    const linkKey = `${field.field}_link`;
    const linkVal = formData?.generalValues?.[linkKey] ?? formData?.scopeValues?.[linkKey] ?? '';
    if (linkVal && selected) {
      links = { [selected]: String(linkVal) };
    } else {
      links = {};
    }
  }
  const labelHtml = `<p><strong>${escapeHtml(field.label || field.field)}</strong></p>`;
  opts.forEach((opt: any, idx: number) => {
    const optLabel = renderOptionLabel(opt);
    const checked = optLabel === selected ? 'complete' : 'incomplete';
    const taskHtml = `<ac:task-list><ac:task><ac:task-status>${checked}</ac:task-status><ac:task-body>${escapeHtml(optLabel)}</ac:task-body></ac:task></ac:task-list>`;
    const linkHtml = links[optLabel] ? `<p>${renderLinkValue(links[optLabel])}</p>` : `<p></p>`;
    if (idx === 0) {
      result.push(`<tr><td rowspan="${numOpts}" data-highlight-colour="#f4f5f7">${labelHtml}</td><td>${taskHtml}</td><td colspan="2">${linkHtml}</td><td rowspan="${numOpts}"><p></p></td></tr>`);
    } else {
      result.push(`<tr><td>${taskHtml}</td><td colspan="2">${linkHtml}</td></tr>`);
    }
  });
  return result;
}

function renderRadioFieldTwoRow(field: IntakeFieldDef, val: any, formData: IntakeFormData): string[] {
  const options = (field.options || []) as string[];
  const selected = String(val || '');
  const labelHtml = `<p><strong>${escapeHtml(field.label || field.field)}</strong></p>`;
  const activeOpts = options.filter(o => renderOptionLabel(o).toLowerCase() !== 'no');
  const noOpt = options.find(o => renderOptionLabel(o).toLowerCase() === 'no');
  const activeTasks = activeOpts.map(opt => {
    const label = renderOptionLabel(opt);
    const checked = label === selected ? 'complete' : 'incomplete';
    return `<ac:task><ac:task-status>${checked}</ac:task-status><ac:task-body>${escapeHtml(label)}</ac:task-body></ac:task>`;
  }).join('');
  const noLabel = noOpt ? renderOptionLabel(noOpt) : 'No';
  const noChecked = (noLabel === selected || (!selected && !activeOpts.some(o => renderOptionLabel(o) === selected))) ? 'complete' : 'incomplete';
  const noTask = `<ac:task-list><ac:task><ac:task-status>${noChecked}</ac:task-status><ac:task-body>${escapeHtml(noLabel)}</ac:task-body></ac:task></ac:task-list>`;
  const detailVal = field.detailField ? (formData.generalValues?.[field.detailField] ?? formData.scopeValues?.[field.detailField] ?? '') : '';
  const hintText = field.hint ? escapeHtml(field.hint) : '';
  const defaultDetailPrompt = field.hasDetails ? 'Add details' : '';
  const detailPrompt = hintText || defaultDetailPrompt;
  let detailContent = '';
  if (detailPrompt) {
    detailContent = detailPrompt + (detailVal ? '<br/>' + escapeHtml(detailVal) : '');
  } else if (detailVal) {
    detailContent = escapeHtml(detailVal);
  }
  const detailHtml = detailContent ? `<p>${detailContent}</p>` : '<p></p>';
  const result: string[] = [];
  result.push(`<tr><td rowspan="2" data-highlight-colour="#f4f5f7">${labelHtml}</td><td><ac:task-list>${activeTasks}</ac:task-list></td><td colspan="2">${detailHtml}</td><td rowspan="2"><p></p></td></tr>`, `<tr><td colspan="3">${noTask}</td></tr>`);
  return result;
}

function renderCheckboxFieldTwoRow(field: IntakeFieldDef, val: any, formData?: IntakeFormData): string[] {
  const options = (field.options || []) as string[];
  const selected = new Set(Array.isArray(val) ? val.map(String) : []);
  const labelHtml = `<p><strong>${escapeHtml(field.label || field.field)}</strong></p>`;
  const tasks = options.map(opt => {
    const label = renderOptionLabel(opt);
    const checked = selected.has(label) ? 'complete' : 'incomplete';
    return `<ac:task><ac:task-status>${checked}</ac:task-status><ac:task-body>${escapeHtml(label)}</ac:task-body></ac:task>`;
  }).join('');
  const noChecked = selected.size === 0 ? 'complete' : 'incomplete';
  const noTask = `<ac:task-list><ac:task><ac:task-status>${noChecked}</ac:task-status><ac:task-body>No</ac:task-body></ac:task></ac:task-list>`;
  const detailPrompt = field.hint ? `<p>${escapeHtml(field.hint)}</p>` : '<p></p>';
  const result: string[] = [];
  result.push(`<tr><td rowspan="2" data-highlight-colour="#f4f5f7">${labelHtml}</td><td><ac:task-list>${tasks}</ac:task-list></td><td colspan="2">${detailPrompt}</td><td rowspan="2"><p></p></td></tr>`, `<tr><td colspan="3">${noTask}</td></tr>`);
  return result;
}

function renderConditionalRadioTwoRow(field: IntakeFieldDef, val: any, formData: IntakeFormData): string[] {
  const options = (field.options || []) as string[];
  const selected = String(val || '');
  const labelHtml = `<p><strong>${escapeHtml(field.label || field.field)}</strong></p>`;
  const cond = (field.conditionalFields || {}) as any;
  const activeOpts = options.filter(o => renderOptionLabel(o).toLowerCase() !== 'no');
  const noOpt = options.find(o => renderOptionLabel(o).toLowerCase() === 'no');
  const activeTasks = activeOpts.map(opt => {
    const label = renderOptionLabel(opt);
    const checked = label === selected ? 'complete' : 'incomplete';
    return `<ac:task><ac:task-status>${checked}</ac:task-status><ac:task-body>${escapeHtml(label)}</ac:task-body></ac:task>`;
  }).join('');
  let subHtml = '<p></p>';
  if (cond.whenNotNo && selected.toLowerCase() !== 'no') {
    subHtml = renderSubFieldsHtml(cond.whenNotNo, formData);
  }
  const noLabel = noOpt ? renderOptionLabel(noOpt) : 'No';
  const noChecked = (noLabel === selected) ? 'complete' : 'incomplete';
  const noTask = `<ac:task-list><ac:task><ac:task-status>${noChecked}</ac:task-status><ac:task-body>${escapeHtml(noLabel)}</ac:task-body></ac:task></ac:task-list>`;
  let noSubHtml = '<p></p>';
  if (cond.whenNo && noLabel === selected) {
    noSubHtml = renderSubFieldsHtml(cond.whenNo, formData) || '<p></p>';
  }
  const result: string[] = [];
  result.push(`<tr><td rowspan="2" data-highlight-colour="#f4f5f7">${labelHtml}</td><td><ac:task-list>${activeTasks}</ac:task-list></td><td colspan="2">${subHtml}</td><td rowspan="2"><p></p></td></tr>`, `<tr><td>${noTask}</td><td colspan="2">${noSubHtml}</td></tr>`);
  return result;
}

export function renderFullIntakeTemplate(formData: IntakeFormData): string {
  const template = loadIntakeTemplate();
  const rows: string[] = [];

  const wrap = (html: string) => {
    if (!html) return '<p></p>';
    const trimmed = html.trim();
    if (trimmed.startsWith('<ac:')) return html;
    return `<p>${html}</p>`;
  };
  // Build field lookup from general + all scopeDetails
  const allFields: Map<string, { field: IntakeFieldDef; scopeId?: string }> = new Map();
  for (const f of template.general.fields || []) {
    allFields.set(f.field, { field: f });
  }
  for (const section of Object.values(template.scopeDetails || {})) {
    for (const f of ((section as any).fields || [])) {
      allFields.set(f.field, { field: f, scopeId: (section as any).showWhen });
    }
  }

  // Header
  rows.push(`<tr><th colspan="4"><p><strong>📝 PLATFORM CDB INTAKE CHECKLIST 📝</strong></p></th><th><p><strong>DETAILS/NOTES</strong></p></th></tr>`);

  // Jira Board Key (first data row — sets column widths)
  const jiraKey = formData.step1.jiraBoardKey || '';
  rows.push(`<tr><td data-colwidth="420"><p><strong>Jira Board Key (e.g. RELMAN, PCI, PBT)</strong></p></td><td data-colwidth="200" colspan="3"><p>${renderLinkValue(jiraKey)}</p></td><td data-colwidth="300"><p></p></td></tr>`);

  // Change Scope row: render selected scopes as a task list (checked per selectedScopes)
  const scopeSections = Object.entries((template as any).scopeDetails || {});
  const allScopeOptions = scopeSections.map(([scopeId, section]) => ({
    id: scopeId,
    label: (section as any).label || scopeId,
  }));
  if (allScopeOptions.length > 0) {
    const selectedSet = new Set(formData.selectedScopes || []);
    const scopeTasks = allScopeOptions
      .map((scope) => {
        const checked = selectedSet.has(scope.id) ? 'complete' : 'incomplete';
        return `<ac:task><ac:task-status>${checked}</ac:task-status><ac:task-body>${escapeHtml(scope.label)}</ac:task-body></ac:task>`;
      })
      .join('');
    rows.push(`<tr><td data-highlight-colour="#f4f5f7"><p><strong>Change Scope</strong></p></td><td colspan="3"><ac:task-list>${scopeTasks}</ac:task-list></td><td><p></p></td></tr>`);
  }

  const renderOrder = (template as any).renderOrder || [];

  function processFieldEntry(entry: any, template: IntakeTemplate, formData: IntakeFormData, allFields: Map<string, { field: IntakeFieldDef; scopeId?: string }>, rows: string[]) {
    if (entry?.synthetic) {
      rows.push(renderSynthetic(entry.synthetic, template, formData));
      return;
    }
    const fieldId = entry.field;
    const fieldEntry = allFields.get(fieldId);
    if (!fieldEntry) return;
    const { field, scopeId: defaultScopeId } = fieldEntry as any;
    const labelHtml = `<p><strong>${escapeHtml(field.label || field.field)}</strong></p>`;
    const scopeId = entry.source || defaultScopeId;

    if ((field as any).skipRender) return;
    if (field.field === 'uiConfigEntries' || field.field === 'bosConfigEntries') return;
    // Skip scope-specific fields if their scope is not selected
    if (scopeId && !formData.selectedScopes?.includes(scopeId)) return;

    const val = getFieldValue(field, formData, scopeId);

    // Render related detail fields that are not explicitly listed in renderOrder
    if (field.field === 'akamaiChangeType') {
      const akamaiDetails = formData.scopeValues?.['akamaiDetails'] || formData.generalValues?.['akamaiDetails'] || '';
      if (akamaiDetails) {
        const detailHtml = `<p>${escapeHtml(akamaiDetails).replaceAll('\n', '<br/>')}</p>`;
        rows.push(`<tr><td data-highlight-colour="#f4f5f7"><p><strong>Akamai change details</strong></p></td><td colspan="3">${detailHtml}</td><td><p></p></td></tr>`);
      }
    }
    if (field.field === 'isamChangeType') {
      const isamDetails = formData.scopeValues?.['isamDetails'] || formData.generalValues?.['isamDetails'] || '';
      if (isamDetails) {
        const detailHtml = `<p>${escapeHtml(isamDetails).replaceAll('\n', '<br/>')}</p>`;
        rows.push(`<tr><td data-highlight-colour="#f4f5f7"><p><strong>ISAM Details</strong></p></td><td colspan="3">${detailHtml}</td><td><p></p></td></tr>`);
      }
    }
    if (field.field === 'newNavigation') {
      const newRouteDetails = formData.scopeValues?.['newRouteDetails'] || '';
      if (newRouteDetails) {
        const detailHtml = `<p>${escapeHtml(newRouteDetails).replaceAll('\n', '<br/>')}</p>`;
        rows.push(`<tr><td data-highlight-colour="#f4f5f7"><p><strong>New Route Path(s)</strong></p></td><td colspan="3">${detailHtml}</td><td><p></p></td></tr>`);
      }
      const beyondAppDetails = formData.scopeValues?.['beyondAppDetails'] || '';
      if (beyondAppDetails) {
        const detailHtml = `<p>${escapeHtml(beyondAppDetails).replaceAll('\n', '<br/>')}</p>`;
        rows.push(`<tr><td data-highlight-colour="#f4f5f7"><p><strong>Beyond App Details</strong></p></td><td colspan="3">${detailHtml}</td><td><p></p></td></tr>`);
      }
    }

    const renderHint = (field as any).render as string | undefined;

    // per-option-row (radio-with-link)
    if (renderHint === 'per-option-row' || field.type === 'radio-with-link') {
      rows.push(...renderRadioWithLinkRows(field, val, formData));
      return;
    }

    // split-no: conditional-radio/radio/checkbox with "No" split
    if (renderHint === 'split-no') {
      if (field.type === 'conditional-radio') {
        rows.push(...renderConditionalRadioTwoRow(field, val, formData));
        return;
      }
      if (field.type === 'radio') {
        rows.push(...renderRadioFieldTwoRow(field, val, formData));
        return;
      }
      if (field.type === 'checkbox') {
        rows.push(...renderCheckboxFieldTwoRow(field, val, formData));
        return;
      }
    }

    // split-last (codeModularization pattern)
    if (renderHint === 'split-last' || field.field === 'codeModularization') {
      const options = (field.options || []) as string[];
      const selectedSet = new Set(Array.isArray(val) ? val.map(String) : []);
      const activeOpts = options.slice(0, -1);
      const lastOpt = options.at(-1);
      const lastOptStr = String(lastOpt ?? '');
      const activeTasks = activeOpts.map(opt => {
        const checked = selectedSet.has(opt) ? 'complete' : 'incomplete';
        return `<ac:task><ac:task-status>${checked}</ac:task-status><ac:task-body>${escapeHtml(opt)}</ac:task-body></ac:task>`;
      }).join('');
      const lastChecked = selectedSet.has(lastOptStr) ? 'complete' : 'incomplete';
      const lastTask = `<ac:task-list><ac:task><ac:task-status>${lastChecked}</ac:task-status><ac:task-body>${escapeHtml(lastOptStr)}</ac:task-body></ac:task></ac:task-list>`;
      rows.push(`<tr><td rowspan="2" data-highlight-colour="#f4f5f7">${labelHtml}</td><td colspan="3"><ac:task-list>${activeTasks}</ac:task-list></td><td rowspan="2"><p></p></td></tr>`, `<tr><td colspan="3">${lastTask}</td></tr>`);
      return;
    }

    // yes-no fields (auto 2-row when conditionalFields exist)
    if (field.type === 'yes-no') {
      const cond = (field.conditionalFields || {}) as any;
      const yesChecked = (val === true || String(val).toLowerCase() === 'yes');
      const noChecked = !yesChecked;
      const yesTask = `<ac:task-list><ac:task><ac:task-status>${yesChecked ? 'complete' : 'incomplete'}</ac:task-status><ac:task-body>Yes</ac:task-body></ac:task></ac:task-list>`;
      const noTask = `<ac:task-list><ac:task><ac:task-status>${noChecked ? 'complete' : 'incomplete'}</ac:task-status><ac:task-body>No</ac:task-body></ac:task></ac:task-list>`;
      if (Array.isArray(cond?.whenYes) && cond.whenYes.length > 0) {
        const parts: string[] = [];
        for (const sub of cond.whenYes) {
          const subVal = formData.generalValues?.[sub.field] ?? formData.scopeValues?.[sub.field];
          if (sub.type === 'checkbox') {
            const labelPrefix = sub.label ? `<p><strong>${escapeHtml(sub.label)}</strong></p>` : '';
            parts.push(labelPrefix + renderTaskListOptions(sub.options || [], new Set(Array.isArray(subVal) ? subVal.map(String) : [])));
          } else if (sub.type === 'textarea' || sub.type === 'text') {
            if (sub.label) {
              parts.push(`<p>${escapeHtml(sub.label)}${subVal ? '<br/>' + escapeHtml(subVal) : ''}</p>`);
            } else if (subVal) {
              parts.push(`<p>${escapeHtml(subVal)}</p>`);
            }
          } else if (sub.type === 'link') {
            parts.push(`<p><strong>${escapeHtml(sub.label || sub.field)}</strong>: ${renderLinkValue(subVal)}</p>`);
          } else {
            parts.push(`<p>${escapeHtml(subVal)}</p>`);
          }
        }
        const subHtml = parts.join('');
        rows.push(`<tr><td rowspan="2" data-highlight-colour="#f4f5f7">${labelHtml}</td><td>${yesTask}</td><td colspan="2">${subHtml}</td><td rowspan="2"><p></p></td></tr>`, `<tr><td colspan="3">${noTask}</td></tr>`);
      } else {
        const hintHtml = field.hint ? `<p>${escapeHtml(field.hint)}</p>` : '<p></p>';
        rows.push(`<tr><td data-highlight-colour="#f4f5f7">${labelHtml}</td><td colspan="2">${yesTask}${noTask}</td><td>${hintHtml}</td><td><p></p></td></tr>`);
      }
      return;
    }

    // Simple fields (text, link, date, textarea)
    if (field.type === 'text' || field.type === 'date' || field.type === 'number' || field.type === 'link' || field.type === 'textarea') {
      const valueHtml = wrap(renderFieldValue(field, val, formData));
      rows.push(`<tr><td data-highlight-colour="#f4f5f7">${labelHtml}</td><td colspan="3">${valueHtml}</td><td><p></p></td></tr>`);
      return;
    }

    // Generic checkbox (single row)
    if (field.type === 'checkbox') {
      const valHtml = renderCheckboxField(field, val);
      rows.push(`<tr><td data-highlight-colour="#f4f5f7">${labelHtml}</td><td colspan="3">${valHtml}</td><td><p></p></td></tr>`);
      return;
    }

    // Generic radio without "No" (single row)
    if (field.type === 'radio') {
      const tasks = (field.options || []).map((opt: any) => {
        const label = renderOptionLabel(opt);
        const checked = label === String(val || '') ? 'complete' : 'incomplete';
        return `<ac:task><ac:task-status>${checked}</ac:task-status><ac:task-body>${escapeHtml(label)}</ac:task-body></ac:task>`;
      }).join('');
      rows.push(`<tr><td data-highlight-colour="#f4f5f7">${labelHtml}</td><td colspan="3"><ac:task-list>${tasks}</ac:task-list></td><td><p></p></td></tr>`);
      return;
    }

    // Dynamic rows
    if (field.type === 'dynamic-rows') {
      const dyn = renderDynamicRows(field, formData.dynamicRows?.[field.field]);
      rows.push(`<tr><td data-highlight-colour="#f4f5f7">${labelHtml}</td><td colspan="3">${wrap(dyn)}</td><td><p></p></td></tr>`);
      return;
    }

    // Fallback
    const valHtml = wrap(renderFieldValue(field, val, formData));
    rows.push(`<tr><td data-highlight-colour="#f4f5f7">${labelHtml}</td><td colspan="3">${valHtml}</td><td><p></p></td></tr>`);
  }

  function renderSynthetic(id: string, template: IntakeTemplate, formData: IntakeFormData): string {
    const def = (template as any).synthetics?.[id];
    if (!def) return '';
    if (id === 'changingConfigurations') return renderChangingConfigurationsFromDef(def, formData);
    return '';
  }

  function renderChangingConfigurationsFromDef(def: any, formData: IntakeFormData): string {
    const options = def.options || [];
    const numRows = options.length;
    const rows: string[] = [];
    let anySelected = false;
    options.forEach((opt: any, idx: number) => {
      if (opt.isDefault) {
        const checked = !anySelected ? 'complete' : 'incomplete';
        const task = `<ac:task-list><ac:task><ac:task-status>${checked}</ac:task-status><ac:task-body>${escapeHtml(opt.label)}</ac:task-body></ac:task></ac:task-list>`;
        if (idx === 0) {
          rows.push(`<tr><td rowspan="${numRows}" data-highlight-colour="#f4f5f7"><p><strong>${escapeHtml(def.label)}</strong></p></td><td colspan="3">${task}</td><td rowspan="${numRows}"><p></p></td></tr>`);
        } else {
          rows.push(`<tr><td colspan="3">${task}</td></tr>`);
        }
        return;
      }
      const isSelected = formData.selectedScopes?.includes(opt.scopeCheck);
      if (isSelected) anySelected = true;
      const checked = isSelected ? 'complete' : 'incomplete';
      const task = `<ac:task-list><ac:task><ac:task-status>${checked}</ac:task-status><ac:task-body>${escapeHtml(opt.label)}</ac:task-body></ac:task></ac:task-list>`;
      const entries = (formData.dynamicRows?.[opt.dynamicRowsKey] || [])
        .filter(rowHasContent)
        .map(rowToJoinedString)
        .join('<br/>');
      const promptHtml = escapeHtml(opt.prompt || '');
      const contentHtml = entries ? `${promptHtml}<br/>${entries}` : promptHtml;
      if (idx === 0) {
        rows.push(`<tr><td rowspan="${numRows}" data-highlight-colour="#f4f5f7"><p><strong>${escapeHtml(def.label)}</strong></p></td><td>${task}</td><td colspan="2"><p>${contentHtml}</p></td><td rowspan="${numRows}"><p></p></td></tr>`);
      } else {
        rows.push(`<tr><td>${task}</td><td colspan="2"><p>${contentHtml}</p></td></tr>`);
      }
    });
    return rows.join('');
  }

  // Iterate YAML-driven render order
  for (const entry of renderOrder) {
    processFieldEntry(entry, template, formData, allFields, rows);
  }

  // Footer
  const govDate = formData.generalValues?.techGovernanceDate ?? '';
  if (govDate) {
    rows.push(`<tr><td colspan="5"><p>Discussed in Tech Governance Meeting on ${escapeHtml(govDate)}</p></td></tr>`);
  }

  return `<table data-layout="full-width">${rows.join('')}</table>`;
}

// Backward-compatible simple renderer
export function renderIntakeTemplate(data: IntakeStep1): string {
  const formData: IntakeFormData = {
    step1: { daTeam: data.daTeam, release: data.release, jiraBoardKey: data.jiraBoardKey, intakeTitle: data.intakeTitle },
    generalValues: {},
    selectedScopes: [],
    scopeValues: {},
    dynamicRows: {},
  };
  return renderFullIntakeTemplate(formData);
}

export default renderIntakeTemplate;
