import { Component } from '@angular/core';
import { SearchComponent } from './components/search/search.component';
import { TraceResultsComponent } from './components/trace-results/trace-results.component';
import { DynatraceService } from './services/dynatrace.service';
import { SpanRecord } from './models/trace.model';

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [SearchComponent, TraceResultsComponent],
  template: `
    <div class="app-container">
      <h1 class="app-title">TESTPROJ Error Analyzer</h1>
      <app-search (search)="onSearch($event)"></app-search>
      <app-trace-results
        [spans]="spans"
        [isLoading]="isLoading"
        [errorMsg]="errorMsg"
        [environment]="environment">
      </app-trace-results>
    </div>
  `,
  styles: [`
    .app-container {
      max-width: 900px;
      margin: 0 auto;
      padding: 24px 16px;
    }
    .app-title {
      font-size: 20px;
      font-weight: 600;
      color: #1B4F72;
      margin: 0 0 20px 0;
    }
  `]
})
export class AppComponent {
  spans: SpanRecord[] = [];
  isLoading = false;
  errorMsg = '';
  environment = 'NON-PROD';

  constructor(private dynatraceService: DynatraceService) {}

  onSearch(traceId: string): void {
    this.isLoading = true;
    this.errorMsg = '';
    this.spans = [];

    this.dynatraceService.fetchTrace(traceId, this.environment).subscribe({
      next: (response) => {
        this.spans = response.result?.records || [];
        if (this.spans.length === 0) {
          this.errorMsg = 'No spans found for this trace ID. Check the trace ID and try again.';
        }
        this.isLoading = false;
      },
      error: (err) => {
        this.errorMsg = err.error?.error || 'Failed to fetch trace data. Please try again.';
        this.isLoading = false;
      }
    });
  }
}
