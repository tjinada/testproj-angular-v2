import ConfluenceService from './confluence.service';
import confluenceExportService from './confluence-export.service';
import techGovernanceReleasesIntakeService, { TechGovernanceRelease } from './tech-governance-releases-intake.service';
import { IntakeFormData } from './intake-template';

/**
 * Marks intakes as discussed in the Tech Governance meeting (or revokes that) by writing the
 * "Discussed in Tech Governance Meeting on <date>" line to the intake's Confluence page,
 * then mirrors the result into the tech governance cache used by the ADO PR check.
 *
 * Two kinds of intake page:
 *  - dashboard-created: locked, re-rendered from the `intake-data` property on every team edit,
 *    so the date is stored in the property (generalValues.techGovernanceDate) and the page re-rendered;
 *  - hand-made: the line is edited directly in the page body.
 */

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const DISCUSSED_LABEL = 'Discussed in Tech Governance Meeting on';
// Label + the date that follows it (a Confluence <time> tag or plain text), as the intake parser reads it.
const DISCUSSED_LINE_SOURCE =
  '(Discussed in Tech Governance Meeting on(?:\\s|&nbsp;|\\u00a0)*)(<time\\b[^>]*?(?:\\/>|>[\\s\\S]*?<\\/time>)|[\\w\\-,.\\/ ]+)';
const DISCUSSED_TEXT = /Discussed in Tech Governance Meeting on\s*[\w\-,.\/ ]*/gi;
// Elements that may be removed together with the line on revoke (never table structure).
const LINE_CONTAINER_TAGS = [
  'ac:adf-extension', 'ac:structured-macro', 'ac:task-list', 'ac:task',
  'ul', 'ol', 'li', 'p', 'div', 'blockquote', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
];
const MAX_LINES_REMOVED = 10;

export class IntakeApprovalError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
    this.name = 'IntakeApprovalError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** Same ISO string the intake parser derives from a date-only value (3pm EST). */
export function discussedOnFromDate(date: string): string {
  return new Date(`${date}T20:00:00.000Z`).toISOString();
}

function discussedLinePattern(): RegExp {
  return new RegExp(DISCUSSED_LINE_SOURCE, 'gi');
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function visibleText(html: string): string {
  return html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;| /g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** All [start, end) ranges of `tag` elements that contain `index`. */
function enclosingElements(html: string, index: number, tag: string): Array<[number, number]> {
  const name = escapeRegExp(tag);
  const events: Array<{ pos: number; end: number; open: boolean }> = [];
  for (const m of html.matchAll(new RegExp(`<${name}(?=[\\s>/])[^>]*>`, 'gi'))) {
    if (!m[0].endsWith('/>')) events.push({ pos: m.index!, end: m.index! + m[0].length, open: true });
  }
  for (const m of html.matchAll(new RegExp(`</${name}\\s*>`, 'gi'))) {
    events.push({ pos: m.index!, end: m.index! + m[0].length, open: false });
  }
  events.sort((a, b) => a.pos - b.pos);

  const stack: number[] = [];
  const ranges: Array<[number, number]> = [];
  for (const e of events) {
    if (e.open) {
      stack.push(e.pos);
      continue;
    }
    const start = stack.pop();
    if (start !== undefined && start <= index && e.end > index) ranges.push([start, e.end]);
  }
  return ranges;
}

/** The largest element around `index` whose only visible content is the discussed line. */
function lineOnlyContainer(html: string, index: number): [number, number] | null {
  let best: [number, number] | null = null;
  for (const tag of LINE_CONTAINER_TAGS) {
    for (const range of enclosingElements(html, index, tag)) {
      const rest = visibleText(html.slice(range[0], range[1])).replace(DISCUSSED_TEXT, '').trim();
      if (rest) continue;
      if (!best || range[1] - range[0] > best[1] - best[0]) best = range;
    }
  }
  return best;
}

export function setDiscussedLine(html: string, date: string): string {
  const timeTag = `<time datetime="${date}" />`;
  if (discussedLinePattern().test(html)) {
    return html.replace(discussedLinePattern(), (_match, label: string) => `${label}${timeTag}`);
  }
  return `${html}<p>${DISCUSSED_LABEL} ${timeTag}</p>`;
}

export function removeDiscussedLine(html: string): string {
  let result = html;
  for (let i = 0; i < MAX_LINES_REMOVED; i++) {
    const match = discussedLinePattern().exec(result);
    if (!match) break;
    const range = lineOnlyContainer(result, match.index) ?? [match.index, match.index + match[0].length];
    result = result.slice(0, range[0]) + result.slice(range[1]);
  }
  return result;
}

class IntakeApprovalService {
  async approve(releaseKey: string, intakeId: string, date: string, actor: string): Promise<TechGovernanceRelease> {
    if (!ISO_DATE.test(date) || Number.isNaN(Date.parse(date))) {
      throw new IntakeApprovalError(400, 'Body field "date" must be a valid YYYY-MM-DD date');
    }
    this.assertIntakeInRelease(releaseKey, intakeId);
    await this.writeDiscussedDate(intakeId, date, actor);
    return techGovernanceReleasesIntakeService.patchIntakeApproval(releaseKey, intakeId, {
      discussedOn: discussedOnFromDate(date),
      approvedBy: actor,
    });
  }

  async revoke(releaseKey: string, intakeId: string, actor: string): Promise<TechGovernanceRelease> {
    this.assertIntakeInRelease(releaseKey, intakeId);
    await this.writeDiscussedDate(intakeId, null, actor);
    return techGovernanceReleasesIntakeService.patchIntakeApproval(releaseKey, intakeId, {});
  }

  private assertIntakeInRelease(releaseKey: string, intakeId: string): void {
    const release = techGovernanceReleasesIntakeService.getByBranch(releaseKey);
    if (!release) throw new IntakeApprovalError(404, `Release '${releaseKey}' not found`);
    if (!release.intakes.some((i) => i.id === intakeId)) {
      throw new IntakeApprovalError(404, `Intake '${intakeId}' not found in release '${releaseKey}'`);
    }
  }

  private async writeDiscussedDate(pageId: string, date: string | null, actor: string): Promise<void> {
    const property = await ConfluenceService.getIntakeProperty(pageId);
    if (property?.value?.step1) {
      await this.writeToDashboardIntake(pageId, property, date, actor);
    } else {
      await this.writeToPageBody(pageId, date, actor);
    }
  }

  private async writeToDashboardIntake(pageId: string, property: any, date: string | null, actor: string): Promise<void> {
    const value = property.value;
    const generalValues: Record<string, any> = { ...(value.generalValues || {}) };
    const previousDate = generalValues.techGovernanceDate ?? null;
    if (date) generalValues.techGovernanceDate = date;
    else delete generalValues.techGovernanceDate;

    const formData: IntakeFormData = {
      step1: value.step1,
      generalValues,
      selectedScopes: Array.isArray(value.selectedScopes) ? value.selectedScopes : [],
      scopeValues: value.scopeValues || {},
    };
    // Keep the page's creator / last-updated lines as they are: an approval isn't a team edit.
    const rendered = confluenceExportService.renderFromFullForm(
      formData,
      value.createdBy || undefined,
      value.lastUpdatedBy || undefined,
    );

    const pageInfo = await ConfluenceService.getPageVersion(pageId);
    if (!pageInfo) throw new IntakeApprovalError(404, `Page ${pageId} not found in Confluence`);
    await ConfluenceService.updatePage(pageId, {
      title: rendered.title,
      body: rendered.body,
      version: pageInfo.version.number + 1,
      versionMessage: this.versionMessage(date, actor),
    });

    const auditEntry = {
      editedBy: { name: actor, email: '', accountId: '' },
      editedAt: new Date().toISOString(),
      fieldsChanged: [{
        field: 'techGovernanceDate',
        label: 'Discussed in Tech Governance Meeting',
        section: 'Tech Governance',
        oldValue: previousDate,
        newValue: date,
      }],
    };
    const metadata = value.metadata || {};
    await ConfluenceService.updateIntakeProperty(
      pageId,
      {
        ...value,
        generalValues,
        metadata: { ...metadata, editHistory: [...(metadata.editHistory || []), auditEntry] },
      },
      property.version?.number || 1,
    );
  }

  private async writeToPageBody(pageId: string, date: string | null, actor: string): Promise<void> {
    const page = await ConfluenceService.getPageContent(pageId);
    const body: string = page?.body?.storage?.value ?? '';
    const next = date ? setDiscussedLine(body, date) : removeDiscussedLine(body);
    if (next === body) return;
    await ConfluenceService.updatePage(pageId, {
      title: page.title,
      body: next,
      version: page.version.number + 1,
      versionMessage: this.versionMessage(date, actor),
    });
  }

  private versionMessage(date: string | null, actor: string): string {
    return date
      ? `Marked discussed in Tech Governance on ${date} by ${actor} via CDB Dashboard`
      : `Tech Governance approval revoked by ${actor} via CDB Dashboard`;
  }
}

export default new IntakeApprovalService();
