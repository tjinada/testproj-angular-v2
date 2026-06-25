import { Component, ChangeDetectionStrategy, ChangeDetectorRef, Input, OnInit, inject, signal, Output, EventEmitter } from '@angular/core';
import { CommonModule } from '@angular/common';
import { ReleaseWorkflowService } from '../../../../../../services/release-workflow.service';
import { AuthService } from '../../../../../../services/auth.service';
import { usernameFromEmail } from '../../../../../../utils/sheriff.util';

@Component({
  selector: 'app-da-team-emails',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './da-team-emails.component.html',
  styleUrls: ['./da-team-emails.component.scss'],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class DaTeamEmailsComponent implements OnInit {
  @Input() releaseId?: string;
  @Input() releaseName?: string;
  @Input() configType?: string;
  @Input() branchUrl?: string;
  @Input() configFilePath?: string;

  @Input() existingJiraUrl?: string | null;
  @Output() created = new EventEmitter<void>();

  private readonly api = inject(ReleaseWorkflowService);
  private readonly cdr = inject(ChangeDetectorRef);
  private readonly auth = inject(AuthService);

  readonly emailList = signal<string>('');
  readonly backendEmail = signal<{ subject: string; to: string; body: string } | null>(null);
  readonly matched = signal<Array<{ name: string; jiraProjects: string[]; scope?: string; devLead?: { name: string; email: string } }>>([]);
  readonly bodyCopied = signal<boolean>(false);
  readonly loading = signal<boolean>(false);
  readonly error = signal<string | null>(null);
  readonly copied = signal<boolean>(false);
  readonly isCreating = signal<boolean>(false);
  readonly createError = signal<string | null>(null);

  ngOnInit(): void {
    if (this.releaseId) this.load();
  }

  private get scope(): string {
    if (this.configType?.toLowerCase().includes('bos')) return 'CDB BOS';
    return 'CDB UI';
  }

  load(): void {
    if (!this.releaseId) return;
    this.loading.set(true);
    this.error.set(null);
    this.api.getParticipatingDATeams(this.releaseId).subscribe({
      next: (res) => {
        const scopeKey = this.scope;
        const raw = res.emailsByScope?.[scopeKey] ?? '';
        this.emailList.set(raw);
        this.matched.set(res.teamsByScope?.[scopeKey] ?? []);
        // Store the backend-generated email template (prefer this when present)
        const emailKey: 'cdbBOS' | 'cdbUI' = scopeKey === 'CDB BOS' ? 'cdbBOS' : 'cdbUI';
        this.backendEmail.set(res.emails?.[emailKey] ?? null);
        this.loading.set(false);
        this.cdr.detectChanges();
      },
      error: (err) => {
        console.error('Failed to load DA team emails', err);
        this.error.set(err?.error?.error ?? 'Failed to load DA team emails');
        this.loading.set(false);
        this.cdr.detectChanges();
      },
    });
  }

  async copyEmails(): Promise<void> {
    const raw = this.emailList();
    if (!raw) return;
    try {
      await navigator.clipboard.writeText(raw);
      this.copied.set(true);
      this.cdr.detectChanges();
      setTimeout(() => {
        this.copied.set(false);
        this.cdr.detectChanges();
      }, 2000);
    } catch (err) {
      console.error('Failed to copy emails', err);
    }
  }

  emailBody(): string {
    // Prefer backend-generated email body (has resolved variables)
    const backend = this.backendEmail();
    if (backend?.body) return backend.body;

    const version = this.releaseName || '{RELEASE_VERSION}';
    const configType = this.configType || '{CONFIG_TYPE}';
    const branchUrl = this.branchUrl || '{BRANCH_URL}';
    const configFile = this.configFilePath || '{CONFIG_FILE_PATH}';

    const devLeadRows = this.matched()
      .filter((t) => !!t.devLead)
      .map((t) => `${t.devLead!.name}\t${t.name}`)
      .join('\n');

    return [
      `Hello Team,`,
      ``,
      `I have created the ${configType} ${version} release branch ${branchUrl} .`,
      `Please raise PR's to above branch for ${configType} for ${version} bundle.`,
      `To all the ADM's who are part of ${version}, Please forward this email to your developers if I have missed anyone.`,
      ``,
      `Steps/Process:`,
      `1. Create a branch off release/${version}`,
      `2. Add/Update your project's config changes in ${configFile}`,
      `3. Create a PR with your project name in title and details in the description section`,
      ``,
      `Features with missed configs will not work as expected in pre-prod, so please make sure all the required config changes for your project are merged into the release branch (feature toggles, urls, entitlements, etc.)`,
      ``,
      `Dev Lead Name\tDA Team`,
      devLeadRows,
    ].join('\n');
  }

  emailSubject(): string {
    const backend = this.backendEmail();
    if (backend?.subject) return backend.subject;
    const version = this.releaseName || '{RELEASE_VERSION}';
    const configType = this.configType || '{CONFIG_TYPE}';
    return `${configType} ${version} - Release Branch Created`;
  }

  async copyEmailBody(): Promise<void> {
    const body = this.emailBody();
    if (!body) return;
    try {
      await navigator.clipboard.writeText(body);
      this.bodyCopied.set(true);
      this.cdr.detectChanges();
      setTimeout(() => {
        this.bodyCopied.set(false);
        this.cdr.detectChanges();
      }, 2000);
    } catch (err) {
      console.error('Failed to copy email body', err);
    }
  }

  createConfigJiras(): void {
    if (!this.releaseId) return;
    if (this.existingJiraUrl) return;
    const user = this.auth.currentUser();
    const requestor = { name: user ? usernameFromEmail(user.email) : '', email: user?.email ?? '' };

    // Determine which master to create based on the component configType
    const type = (this.configType && this.configType.toLowerCase().includes('ui')) ? 'ui' : 'bos';

    this.isCreating.set(true);
    this.createError.set(null);
    this.api.createConfigJiras(this.releaseId, requestor, type).subscribe({
      next: (res) => {
        this.isCreating.set(false);
        // Notify parent to refresh release data
        this.created.emit();
        // Basic user feedback — alerts used because the app has no global toast
        try {
          if (res.subtaskErrors && res.subtaskErrors.length > 0) {
            alert(`Master config tickets created successfully. Some subtasks failed:\n${res.subtaskErrors.join('\n')}`);
          } else {
            alert('Master config tickets created successfully.');
          }
        } catch (e) {
          /* ignore */
        }
        this.cdr.detectChanges();
      },
      error: (err) => {
        this.isCreating.set(false);
        this.createError.set(err?.error?.error ?? err?.message ?? 'Failed to create config JIRA tickets');
        alert(this.createError() || 'Failed to create config JIRA tickets');
        this.cdr.detectChanges();
      },
    });
  }
}
