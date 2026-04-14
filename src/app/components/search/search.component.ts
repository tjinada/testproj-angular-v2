import { Component, Output, EventEmitter } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { SearchMode, TimeWindow, Timeframe } from '../../models/trace.model';

export interface SearchField {
  mode: SearchMode;
  label: string;
  placeholder: string;
}

export interface SearchEvent {
  mode: SearchMode;
  value: string;
  timeframe: Timeframe;
}

/** Field type options. Add new entries here to support additional search modes. */
export const SEARCH_FIELDS: SearchField[] = [
  { mode: 'trace', label: 'Trace ID', placeholder: 'Enter a trace ID to search...' },
  { mode: 'request', label: 'Request ID', placeholder: 'Enter a request ID to search...' },
  { mode: 'url', label: 'URL', placeholder: 'Paste a full URL (e.g. olb-qa8.abc.com/banking/services/...)' },
  { mode: 'session', label: 'Session ID', placeholder: 'Enter a RUM session ID (e.g. AQSNRLGUDIM...)' }
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
  { id: '5d', label: 'Last 5 days', durationMs: 5 * 24 * 60 * 60 * 1000 }
];

/** Default window matches the previous hardcoded -120m behavior */
const DEFAULT_WINDOW_ID = '2h';

@Component({
  selector: 'app-search',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './search.component.html',
  styleUrls: ['./search.component.css']
})
export class SearchComponent {
  readonly fields = SEARCH_FIELDS;
  readonly timeWindows = TIME_WINDOWS;

  inputValue = '';
  selectedMode: SearchMode = 'trace';
  selectedWindowId: string = DEFAULT_WINDOW_ID;

  @Output() search = new EventEmitter<SearchEvent>();

  onModeChange(): void {
    this.inputValue = '';
  }

  get placeholder(): string {
    const field = this.fields.find(f => f.mode === this.selectedMode);
    return field ? field.placeholder : '';
  }

  onSearch(): void {
    const trimmed = this.inputValue.trim();
    if (!trimmed) return;

    const window = this.timeWindows.find(w => w.id === this.selectedWindowId) || this.timeWindows[0];
    const now = Date.now();
    const timeframe: Timeframe = {
      from: new Date(now - window.durationMs).toISOString(),
      to: new Date(now).toISOString()
    };

    this.search.emit({ mode: this.selectedMode, value: trimmed, timeframe });
  }
}
