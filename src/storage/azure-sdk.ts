import {
  BlobSASPermissions,
  BlobServiceClient,
  generateBlobSASQueryParameters,
  StorageSharedKeyCredential,
} from "@azure/storage-blob";
import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import type { AzureBlobRecord, AzureClientAdapter, AzureListPage } from "./azure";

export class AzureSdkAdapter implements AzureClientAdapter {
  private readonly service: BlobServiceClient;
  private readonly credential: StorageSharedKeyCredential | undefined;

  constructor(connectionString: string, client?: BlobServiceClient) {
    this.service = client ?? BlobServiceClient.fromConnectionString(connectionString);
    const account = /(?:^|;)AccountName=([^;]+)/.exec(connectionString)?.[1];
    const key = /(?:^|;)AccountKey=([^;]+)/.exec(connectionString)?.[1];
    this.credential = account && key ? new StorageSharedKeyCredential(account, key) : undefined;
  }

  async upload(input: {
    container: string;
    name: string;
    body: Buffer;
    contentType: string;
    metadata: Record<string, string>;
    immutableUntil?: string;
    immutabilityPolicyMode?: "Locked" | "Unlocked";
  }): Promise<{ versionId?: string }> {
    const blob = this.service.getContainerClient(input.container).getBlockBlobClient(input.name);
    const result = await blob.uploadData(input.body, {
      blobHTTPHeaders: { blobContentType: input.contentType },
      metadata: input.metadata,
      ...(input.immutableUntil
        ? {
            immutabilityPolicy: {
              expiriesOn: immutableDate(input.immutableUntil),
              policyMode: input.immutabilityPolicyMode ?? "Unlocked",
            },
          }
        : {}),
    });
    return { ...(result.versionId ? { versionId: result.versionId } : {}) };
  }

  async download(container: string, name: string): Promise<Readable> {
    const response = await this.service.getContainerClient(container).getBlobClient(name).download();
    if (!response.readableStreamBody) throw new Error("Azure adapter requires the Node.js runtime");
    return Readable.from(response.readableStreamBody as unknown as AsyncIterable<Uint8Array>);
  }

  async delete(container: string, name: string): Promise<void> {
    await this.service.getContainerClient(container).getBlobClient(name).deleteIfExists();
  }

  async exists(container: string, name: string): Promise<boolean> {
    return this.service.getContainerClient(container).getBlobClient(name).exists();
  }

  async list(input: {
    container: string;
    prefix: string;
    limit: number;
    cursor?: string;
    hierarchical?: boolean;
  }): Promise<AzureBlobRecord[]> {
    return (await this.listPage(input)).records;
  }

  async listPage(input: {
    container: string;
    prefix: string;
    limit: number;
    cursor?: string;
    hierarchical?: boolean;
  }): Promise<AzureListPage> {
    return input.hierarchical ? this.listHierarchicalPage(input) : this.listFlatPage(input);
  }

  async presign(input: {
    container: string;
    name: string;
    operation: "download" | "upload";
    expiresIn: number;
    contentType?: string;
  }): Promise<string> {
    if (!this.credential) throw new Error("Azure SAS signing requires AccountName and AccountKey");
    if (!Number.isSafeInteger(input.expiresIn) || input.expiresIn <= 0 || input.expiresIn > 604800)
      throw new Error("Azure URL expiry must be between 1 second and 7 days");
    const permissions = new BlobSASPermissions();
    if (input.operation === "download") permissions.read = true;
    else {
      permissions.create = true;
      permissions.write = true;
    }
    const sas = generateBlobSASQueryParameters(
      {
        containerName: input.container,
        blobName: input.name,
        permissions,
        startsOn: new Date(Date.now() - 60_000),
        expiresOn: new Date(Date.now() + input.expiresIn * 1000),
        ...(input.operation === "download" && input.contentType ? { contentType: input.contentType } : {}),
      },
      this.credential,
    ).toString();
    return `${this.service.getContainerClient(input.container).getBlobClient(input.name).url}?${sas}`;
  }

  async probe(container: string): Promise<void> {
    await this.service.getContainerClient(container).getProperties();
  }

  async stageBlock(input: { container: string; name: string; blockId: string; body: Buffer }): Promise<void> {
    await this.service
      .getContainerClient(input.container)
      .getBlockBlobClient(input.name)
      .stageBlock(input.blockId, input.body, input.body.length, {
        transactionalContentMD5: createHash("md5").update(input.body).digest(),
      });
  }

  async commitBlocks(input: {
    container: string;
    name: string;
    blockIds: string[];
    contentType: string;
    metadata: Record<string, string>;
    immutableUntil?: string;
    immutabilityPolicyMode?: "Locked" | "Unlocked";
  }): Promise<{ versionId?: string }> {
    if (!input.blockIds.length) throw new Error("Azure block commit requires at least one block");
    const blob = this.service.getContainerClient(input.container).getBlockBlobClient(input.name);
    const result = await blob.commitBlockList(input.blockIds, {
      blobHTTPHeaders: { blobContentType: input.contentType },
      metadata: input.metadata,
      ...(input.immutableUntil
        ? {
            immutabilityPolicy: {
              expiriesOn: immutableDate(input.immutableUntil),
              policyMode: input.immutabilityPolicyMode ?? "Unlocked",
            },
          }
        : {}),
    });
    return { ...(result.versionId ? { versionId: result.versionId } : {}) };
  }

  private async listFlatPage(input: {
    container: string;
    prefix: string;
    limit: number;
    cursor?: string;
  }): Promise<AzureListPage> {
    const container = this.service.getContainerClient(input.container);
    const pages = container
      .listBlobsFlat({ includeMetadata: true, prefix: input.prefix })
      .byPage({ continuationToken: input.cursor, maxPageSize: input.limit });
    const iterator = pages[Symbol.asyncIterator]();
    const result = await iterator.next();
    if (result.done || !result.value) return { records: [] };
    const records = result.value.segment.blobItems.map((item) => ({
      name: item.name,
      size: item.properties.contentLength ?? 0,
      ...(item.properties.contentType ? { contentType: item.properties.contentType } : {}),
      ...(item.properties.etag ? { etag: item.properties.etag } : {}),
      ...(item.properties.createdOn ? { createdAt: item.properties.createdOn.toISOString() } : {}),
      ...(item.metadata ? { metadata: item.metadata } : {}),
      kind: "blob" as const,
    }));
    return {
      records,
      ...(result.value.continuationToken ? { nextCursor: result.value.continuationToken } : {}),
    };
  }

  private async listHierarchicalPage(input: {
    container: string;
    prefix: string;
    limit: number;
    cursor?: string;
  }): Promise<AzureListPage> {
    const container = this.service.getContainerClient(input.container);
    const pages = container
      .listBlobsByHierarchy("/", { includeMetadata: true, prefix: input.prefix })
      .byPage({ continuationToken: input.cursor, maxPageSize: input.limit });
    const iterator = pages[Symbol.asyncIterator]();
    const result = await iterator.next();
    if (result.done || !result.value) return { records: [] };
    const blobs: AzureBlobRecord[] = result.value.segment.blobItems.map((item) => ({
      name: item.name,
      size: item.properties.contentLength ?? 0,
      ...(item.properties.contentType ? { contentType: item.properties.contentType } : {}),
      ...(item.properties.etag ? { etag: item.properties.etag } : {}),
      ...(item.properties.createdOn ? { createdAt: item.properties.createdOn.toISOString() } : {}),
      ...(item.metadata ? { metadata: item.metadata } : {}),
      kind: "blob",
    }));
    const prefixes: AzureBlobRecord[] = (result.value.segment.blobPrefixes ?? []).map((item) => ({
      name: item.name,
      size: 0,
      kind: "prefix",
    }));
    return {
      records: [...prefixes, ...blobs],
      ...(result.value.continuationToken ? { nextCursor: result.value.continuationToken } : {}),
    };
  }
}

function immutableDate(value: string): Date {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error("Invalid Azure immutability expiry");
  return date;
}
