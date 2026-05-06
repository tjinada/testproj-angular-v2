import {
  ChangeDetectionStrategy,
  ChangeDetectorRef,
  Component,
  EventEmitter,
  OnInit,
  Output,
  inject,
  signal,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { ReleaseWorkflowService } from '../../../../services/release-workflow.service';
import { Release, ReleaseStatus } from '../../../../models/release-workflow.model';

@Component({
  selector: 'app-releases-list',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './releases-list.component.html',
  styleUrl: './releases-list.component.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ReleasesListComponent implements OnInit {
  @Output() newRelease = new EventEmitter<void>();
  @Output() openRelease = new EventEmitter<string>();

  private readonly api = inject(ReleaseWorkflowService);
  private readonly cdr = inject(ChangeDetectorRef);

  readonly releases = signal<Release[]>([]);
  readonly loading = signal<boolean>(true);
  readonly error = signal<string | null>(null);

  ngOnInit(): void {
    this.load();
  }

  load(): void {
    this.loading.set(true);
    this.error.set(null);
    this.api.list().subscribe({
      next: (data) => {
        this.releases.set(data);
        this.loading.set(false);
        this.cdr.detectChanges();
      },
      error: (err) => {
        console.error('Failed to load releases', err);
        this.error.set('Failed to load releases');
        this.loading.set(false);
        this.cdr.detectChanges();
      },
    });
  }

  // ----- presentational helpers -----

  currentStageName(r: Release): string {
    const active = r.stages.find((s) => s.status === 'in_progress')
      ?? r.stages.find((s) => s.status === 'ready')
      ?? r.stages[r.stages.length - 1];
    return active ? `${active.name}` : '—';
  }

  stagesComplete(r: Release): number {
    return r.stages.filter((s) => s.status === 'complete').length;
  }

  totalStages(r: Release): number {
    return r.stages.length;
  }

  progressPct(r: Release): number {
    return Math.round((this.stagesComplete(r) / Math.max(this.totalStages(r), 1)) * 100);
  }

  statusClass(status: ReleaseStatus): string {
    return `status-pill status-pill--${status.replace('_', '-')}`;
  }

  statusLabel(status: ReleaseStatus): string {
    switch (status) {
      case 'not_started': return 'Not started';
      case 'in_progress': return 'In progress';
      case 'blocked':     return 'Blocked';
      case 'complete':    return 'Complete';
      case 'aborted':     return 'Aborted';
      default:            return status;
    }
  }

  formatDate(iso: string | null): string {
    if (!iso) return '—';
    const d = new Date(iso);
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
  }

  // ----- actions -----

  onNewRelease(): void {
    this.newRelease.emit();
  }

  onRowClick(releaseId: string): void {
    this.openRelease.emit(releaseId);
  }
}
