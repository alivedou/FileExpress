import { AzureBlobStorageBackend, type AzureClientAdapter } from "./azure";
import { AzureSdkAdapter } from "./azure-sdk";
import { AwsSdkS3Adapter } from "./aws-sdk";
import { DatabaseBlobStorageBackend, type DatabaseClient } from "./database";
import { IpfsStorageBackend, type IpfsClientAdapter } from "./ipfs";
import { IpfsHttpAdapter } from "./ipfs-http";
import { LocalStorageBackend } from "./local";
import { PostgresAdapter } from "./pg-adapter";
import { S3StorageBackend, type S3ClientAdapter } from "./s3";
import type { BackendConfig, StorageBackend } from "./types";
import { readStringOption } from "./types";

export interface StorageAdapters {
  s3?: S3ClientAdapter;
  azure?: AzureClientAdapter;
  db?: DatabaseClient;
  ipfs?: IpfsClientAdapter;
}

export function createStorageBackend(config: BackendConfig, adapters: StorageAdapters = {}): StorageBackend {
  switch (config.kind) {
    case "local":
      return new LocalStorageBackend();
    case "s3":
      return new S3StorageBackend(
        adapters.s3 ??
          new AwsSdkS3Adapter({
            region: readStringOption(config, "region", process.env.AWS_REGION ?? "us-east-1"),
            endpoint: readStringOption(config, "endpoint") || undefined,
            accessKeyId: readStringOption(config, "accessKeyId") || undefined,
            secretAccessKey: readStringOption(config, "secretAccessKey") || undefined,
            sessionToken: readStringOption(config, "sessionToken") || undefined,
            forcePathStyle: config.options.forcePathStyle !== false,
          }),
      );
    case "azure": {
      if (adapters.azure) return new AzureBlobStorageBackend(adapters.azure);
      const connectionString = readStringOption(
        config,
        "connectionString",
        process.env.AZURE_STORAGE_CONNECTION_STRING ?? "",
      );
      if (!connectionString) throw new Error("An Azure connection string is required");
      return new AzureBlobStorageBackend(new AzureSdkAdapter(connectionString));
    }
    case "db": {
      if (adapters.db) return new DatabaseBlobStorageBackend(adapters.db);
      const connectionString = readStringOption(config, "connectionString", process.env.DATABASE_URL ?? "");
      if (!connectionString) throw new Error("A database connection string is required");
      return new DatabaseBlobStorageBackend(new PostgresAdapter(connectionString));
    }
    case "ipfs": {
      if (adapters.ipfs) return new IpfsStorageBackend(adapters.ipfs);
      const apiUrl = readStringOption(config, "apiUrl", process.env.IPFS_API_URL ?? "");
      if (!apiUrl) throw new Error("An IPFS API URL is required");
      return new IpfsStorageBackend(
        new IpfsHttpAdapter({
          apiUrl,
          gateway: readStringOption(config, "gateway") || undefined,
          token: readStringOption(config, "token") || undefined,
          pinningServiceUrl:
            readStringOption(config, "pinningServiceUrl", process.env.IPFS_PINNING_SERVICE_URL ?? "") ||
            undefined,
          pinningServiceToken:
            readStringOption(config, "pinningServiceToken", process.env.IPFS_PINNING_SERVICE_TOKEN ?? "") ||
            undefined,
        }),
      );
    }
  }
}
