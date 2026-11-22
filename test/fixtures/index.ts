import { faker } from "@faker-js/faker";
import type { FileMeta } from "../../src/storage/types";
export function fakeFile(overrides: Partial<FileMeta> = {}): FileMeta { return { id: faker.string.uuid(), name: faker.system.fileName(), size: faker.number.int({ min: 0, max: 1048576 }), mimeType: faker.system.mimeType(), tenantId: faker.string.uuid(), ownerId: faker.string.uuid(), createdAt: faker.date.recent().toISOString(), metadata: { fixture: "true" }, ...overrides }; }
export function fakeAudit(tenantId: string) { return { tenantId, actorId: faker.string.uuid(), action: "file.uploaded", resourceType: "file", resourceId: faker.string.uuid(), ip: faker.internet.ipv4(), userAgent: faker.internet.userAgent(), outcome: "success" as const, details: { requestId: faker.string.uuid() } }; }
