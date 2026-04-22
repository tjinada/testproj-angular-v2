import { ChangeDetectionStrategy, Component, OnInit, signal, computed, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { LogService } from '../../services/log.service';
import { EnvOption } from '../../models/log.model';

@Component({
  selector: 'app-log-search',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './log-search.component.html',
  styleUrls: ['./log-search.component.scss'],
  changeDetection: ChangeDetectionStrategy.OnPush
})
export class LogSearchComponent implements OnInit {

  private logService = inject(LogService);

  // ── Env dropdown state ────────────────────────────────────────────
  envs = signal<EnvOption[]>([]);
  selectedEnvName = signal<string>('');
  isLoadingEnvs = signal<boolean>(false);
  envsError = signal<string>('');

  // ── Search state ──────────────────────────────────────────────────
  reqId = signal<string>('');
  isSearching = signal<boolean>(false);
  searchError = signal<string>('');
  lines = signal<string[]>([]);
  totalMatched = signal<number>(0);
  truncated = signal<boolean>(false);
  hasSearched = signal<boolean>(false);

  // ── Derived ───────────────────────────────────────────────────────
  canSearch = computed(() =>
    !!this.selectedEnvName() &&
    this.reqId().trim().length > 0 &&
    !this.isSearching()
  );

  selectedEnv = computed<EnvOption | null>(() => {
    const name = this.selectedEnvName();
    return this.envs().find(e => e.name === name) || null;
  });

  ngOnInit(): void {
    this.loadEnvs();
  }

  private loadEnvs(): void {
    this.isLoadingEnvs.set(true);
    this.envsError.set('');
    this.logService.getEnvs().subscribe({
      next: (envs) => {
        this.envs.set(envs);
        if (envs.length > 0 && !this.selectedEnvName()) {
          this.selectedEnvName.set(envs[0].name);
        }
        this.isLoadingEnvs.set(false);
      },
      error: (err) => {
        this.envsError.set(err?.error?.error || err?.message || 'Failed to load environments');
        this.isLoadingEnvs.set(false);
      }
    });
  }

  onRefreshEnvs(): void {
    this.loadEnvs();
  }

  onSearch(): void {
    const env = this.selectedEnv();
    const id = this.reqId().trim();
    if (!env || !id) return;

    this.isSearching.set(true);
    this.searchError.set('');
    this.lines.set([]);
    this.totalMatched.set(0);
    this.truncated.set(false);
    this.hasSearched.set(true);

    this.logService.searchLogs({ logUrl: env.applicationLogsUrl, reqId: id }).subscribe({
      next: (response) => {
        this.lines.set(response.lines || []);
        this.totalMatched.set(response.totalMatched || 0);
        this.truncated.set(!!response.truncated);
        this.isSearching.set(false);
      },
      error: (err) => {
        this.searchError.set(err?.error?.error || err?.message || 'Failed to search logs');
        this.isSearching.set(false);
      }
    });
  }
}
