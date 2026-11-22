import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  DeleteBucketLifecycleCommand,
  DeleteObjectCommand,
  GetBucketLifecycleConfigurationCommand,
  GetBucketVersioningCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  ListObjectVersionsCommand,
  PutBucketLifecycleConfigurationCommand,
  PutBucketVersioningCommand,
  PutObjectCommand,
  S3Client,
  UploadPartCommand,
  type LifecycleRule,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";
import type { S3ClientAdapter, S3ListPage, S3ObjectRecord } from "./s3";

export interface S3AdapterOptions {
  region?: string;
  endpoint?: string;
  accessKeyId?: string;
  secretAccessKey?: string;
  sessionToken?: string;
  forcePathStyle?: boolean;
}

export interface S3VersionListPage extends S3ListPage {
  isTruncated: boolean;
}

export class AwsSdkS3Adapter implements S3ClientAdapter {
  private readonly client: S3Client;
  private readonly multipartChecksums = new Map<string, Map<number, string>>();

  constructor(options: S3AdapterOptions = {}, client?: S3Client) {
    if (Boolean(options.accessKeyId) !== Boolean(options.secretAccessKey))
      throw new Error("S3 accessKeyId and secretAccessKey must be configured together");
    this.client =
      client ??
      new S3Client({
        region: options.region ?? process.env.AWS_REGION ?? "us-east-1",
        ...(options.endpoint ? { endpoint: options.endpoint } : {}),
        forcePathStyle: options.forcePathStyle ?? true,
        ...(options.accessKeyId && options.secretAccessKey
          ? {
              credentials: {
                accessKeyId: options.accessKeyId,
                secretAccessKey: options.secretAccessKey,
                ...(options.sessionToken ? { sessionToken: options.sessionToken } : {}),
              },
            }
          : {}),
      });
  }

  async putObject(input: {
    bucket: string;
    key: string;
    body: Buffer;
    contentType: string;
    metadata: Record<string, string>;
  }): Promise<{ versionId?: string }> {
    const result = await this.client.send(
      new PutObjectCommand({
        Bucket: input.bucket,
        Key: input.key,
        Body: input.body,
        ContentType: input.contentType,
        Metadata: input.metadata,
        ChecksumAlgorithm: "SHA256",
        ChecksumSHA256: createPartChecksum(input.body),
      }),
    );
    return { ...(result.VersionId ? { versionId: result.VersionId } : {}) };
  }

  async getObject(
    bucket: string,
    key: string,
    versionId?: string,
  ): Promise<{ body: Readable; versionId?: string }> {
    const result = await this.client.send(
      new GetObjectCommand({ Bucket: bucket, Key: key, ...(versionId ? { VersionId: versionId } : {}) }),
    );
    if (!result.Body) throw new Error("S3 response has no body");
    const body = result.Body;
    if (body instanceof Readable)
      return { body, ...(result.VersionId ? { versionId: result.VersionId } : {}) };
    if ("transformToWebStream" in body && typeof body.transformToWebStream === "function") {
      return {
        body: Readable.fromWeb(body.transformToWebStream() as NodeReadableStream<Uint8Array>),
        ...(result.VersionId ? { versionId: result.VersionId } : {}),
      };
    }
    if (Symbol.asyncIterator in body)
      return {
        body: Readable.from(body as AsyncIterable<Uint8Array>),
        ...(result.VersionId ? { versionId: result.VersionId } : {}),
      };
    throw new Error("S3 adapter requires a readable response body");
  }

  async deleteObject(bucket: string, key: string, versionId?: string): Promise<void> {
    await this.client.send(
      new DeleteObjectCommand({ Bucket: bucket, Key: key, ...(versionId ? { VersionId: versionId } : {}) }),
    );
  }

  async headObject(bucket: string, key: string): Promise<boolean> {
    try {
      await this.client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
      return true;
    } catch (error) {
      if (isNotFound(error)) return false;
      throw error;
    }
  }

  async listObjects(input: {
    bucket: string;
    prefix: string;
    limit: number;
    cursor?: string;
  }): Promise<S3ObjectRecord[]> {
    return (await this.listObjectsPage(input)).records;
  }

  async listObjectsPage(input: {
    bucket: string;
    prefix: string;
    limit: number;
    cursor?: string;
  }): Promise<S3ListPage> {
    const result = await this.client.send(
      new ListObjectsV2Command({
        Bucket: input.bucket,
        Prefix: input.prefix,
        MaxKeys: input.limit,
        ...(input.cursor ? { ContinuationToken: input.cursor } : {}),
      }),
    );
    const records = await Promise.all(
      (result.Contents ?? []).flatMap((item) =>
        item.Key
          ? [this.describeListedObject(input.bucket, item.Key, item.Size ?? 0, item.ETag, item.LastModified)]
          : [],
      ),
    );
    return {
      records: records.filter((record) => !record.isDeleteMarker),
      ...(result.NextContinuationToken ? { nextCursor: result.NextContinuationToken } : {}),
    };
  }

  private async describeListedObject(
    bucket: string,
    key: string,
    size: number,
    etag?: string,
    lastModified?: Date,
  ): Promise<S3ObjectRecord> {
    try {
      const head = await this.client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
      return {
        key,
        size: head.ContentLength ?? size,
        ...((head.ETag ?? etag) ? { etag: head.ETag ?? etag } : {}),
        ...((head.LastModified ?? lastModified)
          ? { lastModified: (head.LastModified ?? lastModified)?.toISOString() }
          : {}),
        ...(head.VersionId ? { versionId: head.VersionId } : {}),
        ...(head.Metadata ? { metadata: head.Metadata } : {}),
      };
    } catch (error) {
      if (isNotFound(error)) return { key, size, isDeleteMarker: true };
      throw error;
    }
  }

  async listObjectVersions(input: {
    bucket: string;
    prefix?: string;
    limit: number;
    cursor?: string;
  }): Promise<S3VersionListPage> {
    const marker = decodeVersionCursor(input.cursor);
    const result = await this.client.send(
      new ListObjectVersionsCommand({
        Bucket: input.bucket,
        ...(input.prefix ? { Prefix: input.prefix } : {}),
        MaxKeys: input.limit,
        ...(marker.keyMarker ? { KeyMarker: marker.keyMarker } : {}),
        ...(marker.versionIdMarker ? { VersionIdMarker: marker.versionIdMarker } : {}),
      }),
    );
    const versions: S3ObjectRecord[] = (result.Versions ?? []).flatMap((item) =>
      item.Key
        ? [
            {
              key: item.Key,
              size: item.Size ?? 0,
              ...(item.ETag ? { etag: item.ETag } : {}),
              ...(item.VersionId ? { versionId: item.VersionId } : {}),
              ...(item.LastModified ? { lastModified: item.LastModified.toISOString() } : {}),
              ...(item.IsLatest !== undefined ? { isLatest: item.IsLatest } : {}),
            },
          ]
        : [],
    );
    const deleteMarkers: S3ObjectRecord[] = (result.DeleteMarkers ?? []).flatMap((item) =>
      item.Key
        ? [
            {
              key: item.Key,
              size: 0,
              ...(item.VersionId ? { versionId: item.VersionId } : {}),
              ...(item.LastModified ? { lastModified: item.LastModified.toISOString() } : {}),
              ...(item.IsLatest !== undefined ? { isLatest: item.IsLatest } : {}),
              isDeleteMarker: true,
            },
          ]
        : [],
    );
    const nextCursor =
      result.IsTruncated && (result.NextKeyMarker || result.NextVersionIdMarker)
        ? encodeVersionCursor({
            keyMarker: result.NextKeyMarker,
            versionIdMarker: result.NextVersionIdMarker,
          })
        : undefined;
    return {
      records: [...versions, ...deleteMarkers],
      isTruncated: result.IsTruncated ?? false,
      ...(nextCursor ? { nextCursor } : {}),
    };
  }

  async headBucket(bucket: string): Promise<void> {
    await this.client.send(new HeadBucketCommand({ Bucket: bucket }));
  }

  async presign(input: {
    bucket: string;
    key: string;
    operation: "download" | "upload";
    expiresIn: number;
    contentType?: string;
    versionId?: string;
  }): Promise<string> {
    if (!Number.isSafeInteger(input.expiresIn) || input.expiresIn <= 0 || input.expiresIn > 604800)
      throw new Error("S3 URL expiry must be between 1 second and 7 days");
    const command =
      input.operation === "download"
        ? new GetObjectCommand({
            Bucket: input.bucket,
            Key: input.key,
            ...(input.versionId ? { VersionId: input.versionId } : {}),
          })
        : new PutObjectCommand({
            Bucket: input.bucket,
            Key: input.key,
            ...(input.contentType ? { ContentType: input.contentType } : {}),
          });
    return getSignedUrl(this.client, command, { expiresIn: input.expiresIn });
  }

  async createMultipartUpload(input: {
    bucket: string;
    key: string;
    contentType: string;
    metadata: Record<string, string>;
  }): Promise<string> {
    const result = await this.client.send(
      new CreateMultipartUploadCommand({
        Bucket: input.bucket,
        Key: input.key,
        ContentType: input.contentType,
        Metadata: input.metadata,
        ChecksumAlgorithm: "SHA256",
      }),
    );
    if (!result.UploadId) throw new Error("S3 did not return an upload id");
    this.multipartChecksums.set(this.multipartKey(input.bucket, input.key, result.UploadId), new Map());
    return result.UploadId;
  }

  async uploadPart(input: {
    bucket: string;
    key: string;
    uploadId: string;
    index: number;
    body: Buffer;
    checksum?: string;
  }): Promise<string> {
    const checksum = input.checksum ?? createPartChecksum(input.body);
    const result = await this.client.send(
      new UploadPartCommand({
        Bucket: input.bucket,
        Key: input.key,
        UploadId: input.uploadId,
        PartNumber: input.index,
        Body: input.body,
        ChecksumAlgorithm: "SHA256",
        ChecksumSHA256: checksum,
      }),
    );
    if (!result.ETag) throw new Error("S3 did not return a part ETag");
    if (result.ChecksumSHA256 && result.ChecksumSHA256 !== checksum)
      throw new Error("S3 part checksum mismatch");
    this.multipartChecksums
      .get(this.multipartKey(input.bucket, input.key, input.uploadId))
      ?.set(input.index, checksum);
    return result.ETag;
  }

  async completeMultipartUpload(input: {
    bucket: string;
    key: string;
    uploadId: string;
    parts: Array<{ index: number; etag: string }>;
  }): Promise<{ versionId?: string }> {
    if (!input.parts.length) throw new Error("S3 multipart upload requires at least one part");
    const multipartKey = this.multipartKey(input.bucket, input.key, input.uploadId);
    const checksums = this.multipartChecksums.get(multipartKey);
    if (!checksums || input.parts.some((part) => !checksums.has(part.index)))
      throw new Error("S3 multipart checksum state is unavailable");
    const result = await this.client.send(
      new CompleteMultipartUploadCommand({
        Bucket: input.bucket,
        Key: input.key,
        UploadId: input.uploadId,
        MultipartUpload: {
          Parts: input.parts.map((part) => ({
            PartNumber: part.index,
            ETag: part.etag,
            ChecksumSHA256: checksums.get(part.index),
          })),
        },
      }),
    );
    this.multipartChecksums.delete(multipartKey);
    return { ...(result.VersionId ? { versionId: result.VersionId } : {}) };
  }

  async abortMultipartUpload(input: { bucket: string; key: string; uploadId: string }): Promise<void> {
    try {
      await this.client.send(
        new AbortMultipartUploadCommand({ Bucket: input.bucket, Key: input.key, UploadId: input.uploadId }),
      );
    } finally {
      this.multipartChecksums.delete(this.multipartKey(input.bucket, input.key, input.uploadId));
    }
  }

  private multipartKey(bucket: string, key: string, uploadId: string): string {
    return `${bucket}\0${key}\0${uploadId}`;
  }

  async getBucketLifecycleConfiguration(bucket: string): Promise<LifecycleRule[]> {
    const result = await this.client.send(new GetBucketLifecycleConfigurationCommand({ Bucket: bucket }));
    return result.Rules ?? [];
  }

  async putBucketLifecycleConfiguration(bucket: string, rules: LifecycleRule[]): Promise<void> {
    await this.client.send(
      new PutBucketLifecycleConfigurationCommand({
        Bucket: bucket,
        LifecycleConfiguration: { Rules: rules },
      }),
    );
  }

  async deleteBucketLifecycleConfiguration(bucket: string): Promise<void> {
    await this.client.send(new DeleteBucketLifecycleCommand({ Bucket: bucket }));
  }

  async getBucketVersioning(
    bucket: string,
  ): Promise<{ status?: "Enabled" | "Suspended"; mfaDelete?: "Enabled" | "Disabled" }> {
    const result = await this.client.send(new GetBucketVersioningCommand({ Bucket: bucket }));
    return {
      ...(result.Status ? { status: result.Status } : {}),
      ...(result.MFADelete ? { mfaDelete: result.MFADelete } : {}),
    };
  }

  async putBucketVersioning(
    bucket: string,
    status: "Enabled" | "Suspended",
    mfaDelete?: "Enabled" | "Disabled",
  ): Promise<void> {
    await this.client.send(
      new PutBucketVersioningCommand({
        Bucket: bucket,
        VersioningConfiguration: { Status: status, ...(mfaDelete ? { MFADelete: mfaDelete } : {}) },
      }),
    );
  }
}

function createPartChecksum(body: Buffer): string {
  return createHash("sha256").update(body).digest("base64");
}

function isNotFound(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if (error.name === "NotFound" || error.name === "NoSuchKey" || error.name === "NotModified") return true;
  if (!("$metadata" in error)) return false;
  const metadata = error.$metadata;
  return (
    typeof metadata === "object" &&
    metadata !== null &&
    "httpStatusCode" in metadata &&
    metadata.httpStatusCode === 404
  );
}

function encodeVersionCursor(value: { keyMarker?: string; versionIdMarker?: string }): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function decodeVersionCursor(cursor: string | undefined): { keyMarker?: string; versionIdMarker?: string } {
  if (!cursor) return {};
  try {
    const value = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as {
      keyMarker?: unknown;
      versionIdMarker?: unknown;
    };
    return {
      ...(typeof value.keyMarker === "string" ? { keyMarker: value.keyMarker } : {}),
      ...(typeof value.versionIdMarker === "string" ? { versionIdMarker: value.versionIdMarker } : {}),
    };
  } catch {
    throw new Error("Invalid S3 version cursor");
  }
}
