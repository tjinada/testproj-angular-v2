import { Component, Output, EventEmitter } from '@angular/core';
import { FormsModule } from '@angular/forms';

@Component({
  selector: 'app-search',
  standalone: true,
  imports: [FormsModule],
  templateUrl: './search.component.html',
  styleUrls: ['./search.component.css']
})
export class SearchComponent {
  traceId = '';

  @Output() search = new EventEmitter<string>();

  onSearch(): void {
    const trimmed = this.traceId.trim();
    if (trimmed) {
      this.search.emit(trimmed);
    }
  }
}
