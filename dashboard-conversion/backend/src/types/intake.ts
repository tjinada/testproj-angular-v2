export interface IntakePropertyValue {
  schemaVersion: number; // 2 for new-format
  exportedAt: string;
  exportedBy: string;
  createdBy?: { name?: string; email?: string } | null;
  step1: any;
  generalValues: Record<string, any>;
  selectedScopes: string[];
  scopeValues: Record<string, any>;
  dynamicRows: Record<string, any>;
  metadata: {
    createdBy: string | null;
    createdAt: string | null;
    lastModifiedBy: string | null;
    lastModifiedAt: string | null;
    editHistory: Array<any>;
  };
}

export interface IntakePropertyPayload {
  key: 'intake-data';
  value: IntakePropertyValue;
}
