export type AuditOutcome = "success" | "failure";

export interface AuditInput {
  tenantId: string;
  actorId: string;
  action: string;
  resourceType: string;
  resourceId: string;
  ip: string;
  userAgent: string;
  outcome: AuditOutcome;
  details?: Record<string, unknown>;
}

export interface AuditRecord extends AuditInput {
  id: number;
  timestamp: string;
  previousHash: string;
  hash: string;
}

export interface AuditSearchQuery {
  tenantId: string;
  text?: string;
  actorId?: string;
  action?: string;
  from?: Date;
  to?: Date;
  limit?: number;
}

export interface AuditStoreSnapshot {
  records: AuditRecord[];
  anchor: string;
  nextId: number;
}

export interface AuditChainHead {
  anchor: string;
  hash: string;
  nextId: number;
}

export interface AuditArchiveManifest {
  version: 1;
  cutoff: string;
  recordCount: number;
  firstId: number | null;
  lastId: number | null;
  firstHash: string | null;
  lastHash: string | null;
  previousAnchor: string;
  anchor: string;
  merkleRoot: string;
}

export interface AuditArchive {
  records: AuditRecord[];
  merkleRoot: string;
  anchor: string;
  manifest: AuditArchiveManifest;
}

export interface AuditRetentionResult {
  removed: number;
  anchor: string;
  archive: AuditArchive;
}

export interface AuditStore {
  load(): AuditRecord[];
  snapshot(): AuditStoreSnapshot;
  append(record: AuditRecord, expected?: AuditChainHead): void;
  replace(snapshot: AuditStoreSnapshot, expected?: AuditChainHead): void;
  writeArchive?(archive: AuditArchive): void;
  close?(): void;
}

export interface AuditLoggerOptions {
  maxRecords?: number;
  store?: AuditStore;
}
