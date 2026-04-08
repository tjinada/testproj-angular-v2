import { Component, Output, EventEmitter } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { SearchMode } from '../../models/trace.model';

export interface SearchEvent {
  mode: SearchMode;
  value: string;
}

@Component({
  selector: 'app-search',
  standalone: true,
  imports: [FormsModule],
  templateUrl: './search.component.html',
  styleUrls: ['./search.component.css']
})
export class SearchComponent {
  inputValue = '';
  mode: SearchMode = 'trace';

  @Output() search = new EventEmitter<SearchEvent>();

  setMode(mode: SearchMode): void {
    if (this.mode === mode) return;
    this.mode = mode;
    this.inputValue = '';
  }

  get placeholder(): string {
    return this.mode === 'trace'
      ? 'Enter a trace ID to search...'
      : 'Enter a request ID to search...';
  }

  onSearch(): void {
    const trimmed = this.inputValue.trim();
    if (trimmed) {
      this.search.emit({ mode: this.mode, value: trimmed });
    }
  }
}
