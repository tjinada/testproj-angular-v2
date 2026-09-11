import { Component, Input } from '@angular/core';
import { CommonModule } from '@angular/common';

import { AkamaiRuleEntry, RuleNode } from '../../../models/akamai-rule-tree.model';

/** One key/value line inside a criterion or behavior. */
interface OptionRow {
  key: string;
  value: string;
}

/** A run of text, flagged when it matches the active search term. */
interface Segment {
  text: string;
  hit: boolean;
}

/**
 * The expanded view of a single rule: its comment, criteria and behaviors
 * with every option spelled out.
 *
 * Shared by the trace evidence list and the browse results so the two read
 * identically. Deliberately dense — it only appears on an explicit click.
 */
@Component({
  selector: 'app-rule-detail',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './rule-detail.component.html',
  styleUrls: ['./rule-detail.component.scss']
})
export class RuleDetailComponent {
  @Input({ required: true }) node!: RuleNode;

  /** Highlights matching text when the detail is opened from a search. */
  @Input() searchTerm = '';

  get breadcrumb(): string {
    return this.node.trail.concat(this.node.rule.name).join('  \u203a  ');
  }

  get comments(): string {
    return this.node.rule.comments || '';
  }

  get criteria(): AkamaiRuleEntry[] {
    return this.node.rule.criteria || [];
  }

  get behaviors(): AkamaiRuleEntry[] {
    return this.node.rule.behaviors || [];
  }

  /** "all" is the default when the property omits criteriaMustSatisfy. */
  get criteriaLabel(): string {
    return this.node.rule.criteriaMustSatisfy === 'any' ? 'match ANY' : 'match ALL';
  }

  /**
   * Advanced criteria and behaviors carry raw metadata XML. It's rendered
   * verbatim rather than broken into key/value rows — a lot of the custom
   * logic lives in there and reformatting it loses the shape.
   */
  embeddedXml(entry: AkamaiRuleEntry): string | null {
    const o = entry.options as Record<string, any>;
    if (o['openXml']) return `${o['openXml']}\n  \u2026\n${o['closeXml'] || ''}`;
    return o['xml'] ? String(o['xml']) : null;
  }

  description(entry: AkamaiRuleEntry): string {
    return String((entry.options as Record<string, any>)['description'] || '');
  }

  /** Key/value rows for entries without embedded XML. */
  optionRows(entry: AkamaiRuleEntry): OptionRow[] {
    const o = (entry.options || {}) as Record<string, unknown>;
    return Object.keys(o).map(key => {
      const raw = o[key];
      let value: string;
      if (Array.isArray(raw)) value = raw.join(', ');
      else if (typeof raw === 'object' && raw !== null) value = JSON.stringify(raw);
      else value = String(raw);
      return { key, value };
    });
  }

  /**
   * True when the operator inverts the match. Rendered with a red edge,
   * because reading a six-deep IS_NOT chain without the negation gives
   * exactly the opposite meaning.
   */
  isNegated(entry: AkamaiRuleEntry): boolean {
    return /NOT|DOES_NOT/.test(String((entry.options as Record<string, any>)['matchOperator'] || ''));
  }

  /** Splits text so the template can mark matches without innerHTML. */
  segments(text: string): Segment[] {
    const needle = this.searchTerm.trim().toLowerCase();
    if (!needle) return [{ text, hit: false }];

    const out: Segment[] = [];
    const haystack = text.toLowerCase();
    let from = 0;
    let at = haystack.indexOf(needle);
    while (at >= 0) {
      if (at > from) out.push({ text: text.slice(from, at), hit: false });
      out.push({ text: text.slice(at, at + needle.length), hit: true });
      from = at + needle.length;
      at = haystack.indexOf(needle, from);
    }
    if (from < text.length) out.push({ text: text.slice(from), hit: false });
    return out;
  }

  trackByIndex(index: number): number {
    return index;
  }
}
