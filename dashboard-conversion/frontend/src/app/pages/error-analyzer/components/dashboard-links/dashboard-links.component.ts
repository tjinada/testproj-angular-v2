import { ChangeDetectionStrategy, Component, Input, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { DashboardLink } from '../../services/config.service';

/**
 * CDB Monitoring tab: a table of Dynatrace dashboard links driven by
 * backend/config/cdb-dynatrace-dashboards.yaml. No API calls of its own —
 * the list arrives with the app config.
 */
@Component({
  selector: 'app-dashboard-links',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './dashboard-links.component.html',
  styleUrls: ['./dashboard-links.component.scss'],
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class DashboardLinksComponent {
  @Input() dashboards: DashboardLink[] = [];

  /** When set, shows the access-required banner above the table. */
  @Input() accessRequestUrl: string | null = null;

  /** Name of the row whose URL was just copied, driving the transient label. */
  readonly copiedName = signal<string | null>(null);

  async copyUrl(dashboard: DashboardLink): Promise<void> {
    try {
      await navigator.clipboard.writeText(dashboard.url);
      this.copiedName.set(dashboard.name);
      setTimeout(() => this.copiedName.set(null), 1400);
    } catch {
      this.copiedName.set(null);
    }
  }
}
