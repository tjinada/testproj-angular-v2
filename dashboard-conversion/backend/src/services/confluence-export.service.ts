import ConfluenceService from './confluence.service';
import renderIntakeTemplate, { IntakeStep1, IntakeFormData, renderFullIntakeTemplate } from './intake-template';
import daTeamsService from './da-teams.service';

function escapeHtml(value: string): string {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}


export function buildIntakeTitle(data: IntakeStep1): string {
  const release = String(data.release || '').trim();
  const optionalTitle = String(data.intakeTitle || '').trim();

  // Prefer explicitly provided board key
  let boardKey = String(data.jiraBoardKey || '').trim();
  if (!boardKey && data.daTeam) {
    const all = daTeamsService.getAll();
    // Try to find matching team by name (case-insensitive)
    const match = Object.values(all).find((t: any) => String(t.name || '').toLowerCase() === String(data.daTeam || '').toLowerCase());
    if (match && Array.isArray(match.jiraProjects) && match.jiraProjects.length > 0) {
      boardKey = String(match.jiraProjects[0] || '').trim();
    }
  }

  const keyPart = boardKey || String(data.daTeam || '').trim();
  const base = `${release} - ${keyPart}`.trim();
  return optionalTitle ? `${base} - ${optionalTitle}` : base;
}

class ConfluenceExportService {
  async createIntakePage(parentPageId: string, spaceId: string, title: string, bodyStorage: string): Promise<any> {
    const resp = await ConfluenceService.createPage({ parentId: parentPageId, spaceId, title, bodyStorage });
    return resp;
  }

  async updateIntakePage(pageId: string, newBodyStorage: string, currentVersion = 1, title?: string, spaceKey?: string): Promise<any> {
    const resp = await ConfluenceService.updatePage({ pageId, newBodyStorage, currentVersion, title, spaceKey });
    return resp;
  }

  renderFromStep1(
    data: IntakeStep1,
    createdBy?: { name?: string; email?: string; accountId?: string },
    lastUpdatedBy?: { displayName?: string; accountId?: string; date?: string }
  ): { title: string; body: string } {
    const title = buildIntakeTitle(data);
    const existingBodyContent = renderIntakeTemplate(data);
    const createdByHtml = createdBy?.name
      ? `<p><strong>Tech Intake Created By:</strong> ${escapeHtml(createdBy.name)}</p>`
      : '';
    let lastUpdatedHtml = '';
    if (lastUpdatedBy && lastUpdatedBy.displayName) {
      // Render Last Updated By unless we can positively confirm the editor IS the creator
      const creatorAccountId = createdBy?.accountId ?? null;
      const updaterAccountId = lastUpdatedBy?.accountId ?? null;
      const confirmedSameUser = creatorAccountId && updaterAccountId && creatorAccountId === updaterAccountId;
      if (updaterAccountId && !confirmedSameUser) {
        const formattedDate = lastUpdatedBy.date
          ? new Date(lastUpdatedBy.date).toLocaleString('en-US', {
              year: 'numeric',
              month: 'short',
              day: 'numeric',
              hour: 'numeric',
              minute: '2-digit',
              hour12: true,
            })
          : '';
        lastUpdatedHtml = `<p><strong>Last Updated By:</strong> ${escapeHtml(lastUpdatedBy.displayName)}${formattedDate ? ' on ' + formattedDate : ''}</p>`;
      }
    }
    const body = `${createdByHtml}${lastUpdatedHtml}${existingBodyContent}`;
    return { title, body };
  }

  renderFromFullForm(
    formData: IntakeFormData,
    createdBy?: { name?: string; email?: string; accountId?: string },
    lastUpdatedBy?: { displayName?: string; accountId?: string; date?: string }
  ): { title: string; body: string } {
    const title = buildIntakeTitle(formData.step1);
    const existingBodyContent = renderFullIntakeTemplate(formData);
    const createdByHtml = createdBy?.name
      ? `<p><strong>Tech Intake Created By:</strong> ${escapeHtml(createdBy.name)}</p>`
      : '';
    let lastUpdatedHtml = '';
    if (lastUpdatedBy && lastUpdatedBy.displayName) {
      const creatorAccountId = createdBy?.accountId ?? null;
      const updaterAccountId = lastUpdatedBy?.accountId ?? null;
      const confirmedSameUser = creatorAccountId && updaterAccountId && creatorAccountId === updaterAccountId;
      if (updaterAccountId && !confirmedSameUser) {
        const formattedDate = lastUpdatedBy.date
          ? new Date(lastUpdatedBy.date).toLocaleString('en-US', {
              year: 'numeric',
              month: 'short',
              day: 'numeric',
              hour: 'numeric',
              minute: '2-digit',
              hour12: true,
            })
          : '';
        lastUpdatedHtml = `<p><strong>Last Updated By:</strong> ${escapeHtml(lastUpdatedBy.displayName)}${formattedDate ? ' on ' + formattedDate : ''}</p>`;
      }
    }
    const body = `${createdByHtml}${lastUpdatedHtml}${existingBodyContent}`;
    return { title, body };
  }
}

export default new ConfluenceExportService();
