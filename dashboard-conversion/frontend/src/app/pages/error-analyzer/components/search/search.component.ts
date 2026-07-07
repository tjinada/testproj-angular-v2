import { Component, Output, EventEmitter, HostListener } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { SearchMode, TimeWindow, Timeframe } from '../../models/trace.model';

export interface SearchField {
  mode: SearchMode;
  label: string;
  placeholder: string;
  disabled?: boolean;
}

export interface SearchEvent {
  mode: SearchMode;
  value: string;
  timeframe: Timeframe;
}

/** Field type options. Add new entries here to support additional search modes. */
export const SEARCH_FIELDS: SearchField[] = [
  { mode: 'request', label: 'Browser x-request-id', placeholder: 'Paste the x-request-id from your browser network tab...', disabled: true },
  { mode: 'url', label: 'URL / URL path', placeholder: 'Paste a full URL, hostname, or path (e.g. host.com/foo, /banking, services/signin)' },
  { mode: 'trace', label: 'Trace ID', placeholder: 'Enter a trace ID to search...' },
  { mode: 'session', label: 'RUM Session ID', placeholder: 'Enter a RUM session ID (e.g. AQSNRLGUDIM...)' },
  { mode: 'clientIp', label: 'Client IP', placeholder: 'Enter a client IPv4 address (e.g. 24.157.71.45) — Dynatrace masks the last octet' },
  { mode: 'endpoint', label: 'Endpoint search (unique URLs)', placeholder: 'Enter a URL, hostname, or path fragment (e.g. /cdb/credit-card) — lists unique endpoints with traffic' },
  { mode: 'components', label: 'Components by URL path', placeholder: 'Enter the exact url.path (e.g. /banking/services/signin/verifyCredential) — lists every component it touches' }
];

/** Time window presets. Add/remove entries here to change the dropdown options. */
export const TIME_WINDOWS: TimeWindow[] = [
  { id: '15m', label: 'Last 15 minutes', durationMs: 15 * 60 * 1000 },
  { id: '30m', label: 'Last 30 minutes', durationMs: 30 * 60 * 1000 },
  { id: '2h', label: 'Last 2 hours', durationMs: 2 * 60 * 60 * 1000 },
  { id: '6h', label: 'Last 6 hours', durationMs: 6 * 60 * 60 * 1000 },
  { id: '12h', label: 'Last 12 hours', durationMs: 12 * 60 * 60 * 1000 },
  { id: '1d', label: 'Last 1 day', durationMs: 24 * 60 * 60 * 1000 },
  { id: '2d', label: 'Last 2 days', durationMs: 2 * 24 * 60 * 60 * 1000 },
  { id: '5d', label: 'Last 5 days', durationMs: 5 * 24 * 60 * 60 * 1000 },
  { id: 'custom', label: 'Custom…', durationMs: 0 }
];

const CUSTOM_WINDOW_ID = 'custom';
const CUSTOM_WINDOW_MAX_MS = 7 * 24 * 60 * 60 * 1000;
const DEFAULT_WINDOW_ID = '2h';

@Component({
  selector: 'app-search',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './search.component.html',
  styleUrls: ['./search.component.scss']
})
export class SearchComponent {
  readonly fields = SEARCH_FIELDS;
  readonly timeWindows = TIME_WINDOWS;

  inputValue = '';
  selectedMode: SearchMode = 'url';
  selectedWindowId: string = DEFAULT_WINDOW_ID;
  hasSearched = false;
  previewImageSrc: string | null = null;

  customFrom = '';
  customTo = '';
  customError = '';

  private lastPresetWindowId: string = DEFAULT_WINDOW_ID;

  readonly customWindowId = CUSTOM_WINDOW_ID;

  @Output() search = new EventEmitter<SearchEvent>();

  openPreview(src: string): void {
    this.previewImageSrc = src;
  }

  closePreview(): void {
    this.previewImageSrc = null;
  }

  @HostListener('document:keydown.escape')
  onEscape(): void {
    if (this.previewImageSrc) this.closePreview();
  }

  onModeChange(): void {
    // Guard: if user somehow selects a disabled mode, snap back to url
    const field = this.fields.find(f => f.mode === this.selectedMode);
    if (field?.disabled) {
      this.selectedMode = 'url';
    }
    this.inputValue = '';
  }

  onWindowChange(): void {
    this.customError = '';
    if (this.selectedWindowId !== CUSTOM_WINDOW_ID) {
      this.lastPresetWindowId = this.selectedWindowId;
      return;
    }
    if (this.customFrom && this.customTo) return;

    const previous = this.timeWindows.find(w => w.id === this.lastPresetWindowId);
    const now = Date.now();
    const fromMs = previous && previous.durationMs > 0
      ? now - previous.durationMs
      : now - 2 * 60 * 60 * 1000;

    this.customFrom = this.toLocalInputValue(new Date(fromMs));
    this.customTo = this.toLocalInputValue(new Date(now));
  }

  private toLocalInputValue(d: Date): string {
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }

  private buildTimeframe(): Timeframe | null {
    if (this.selectedWindowId !== CUSTOM_WINDOW_ID) {
      const window = this.timeWindows.find(w => w.id === this.selectedWindowId) || this.timeWindows[0];
      const now = Date.now();
      return {
        from: new Date(now - window.durationMs).toISOString(),
        to: new Date(now).toISOString()
      };
    }

    if (!this.customFrom || !this.customTo) {
      this.customError = 'Both From and To are required.';
      return null;
    }

    const fromDate = new Date(this.customFrom);
    const toDate = new Date(this.customTo);

    if (isNaN(fromDate.getTime()) || isNaN(toDate.getTime())) {
      this.customError = 'Invalid date or time.';
      return null;
    }

    if (toDate.getTime() <= fromDate.getTime()) {
      this.customError = 'Start time must be before end time.';
      return null;
    }

    if (toDate.getTime() > Date.now()) {
      this.customError = 'End time cannot be in the future.';
      return null;
    }

    if (toDate.getTime() - fromDate.getTime() > CUSTOM_WINDOW_MAX_MS) {
      this.customError = 'Custom range cannot exceed 7 days.';
      return null;
    }

    this.customError = '';
    return {
      from: fromDate.toISOString(),
      to: toDate.toISOString()
    };
  }

  get placeholder(): string {
    const field = this.fields.find(f => f.mode === this.selectedMode);
    return field ? field.placeholder : '';
  }

  onSearch(): void {
    const trimmed = this.inputValue.trim();
    if (!trimmed) return;

    const timeframe = this.buildTimeframe();
    if (!timeframe) return;

    this.hasSearched = true;
    this.search.emit({ mode: this.selectedMode, value: trimmed, timeframe });
  }
}
