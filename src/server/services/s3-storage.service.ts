import {
  DeleteObjectsCommand,
  ListObjectsV2Command,
  S3Client,
  type ObjectIdentifier,
} from "@aws-sdk/client-s3";
import { decrypt } from "../lib/crypto";

export interface S3StorageClientDestination {
  accessKeyId: string;
  secretAccessKeyEnc: string | null;
  region: string | null;
  endpoint: string | null;
  additionalFlags: string[];
  bucket: string;
  objectPrefix?: string | null;
}

export function createS3Client(destination: S3StorageClientDestination) {
  if (!destination.secretAccessKeyEnc) {
    throw new Error("Storage destination secret key is missing");
  }

  return new S3Client({
    region: destination.region ?? "auto",
    endpoint: destination.endpoint || undefined,
    forcePathStyle:
      Boolean(destination.endpoint) ||
      destination.additionalFlags.some((flag) =>
        flag.toLowerCase().includes("forcepathstyle=true"),
      ),
    credentials: {
      accessKeyId: destination.accessKeyId,
      secretAccessKey: decrypt(destination.secretAccessKeyEnc),
    },
  });
}

export function normalizeObjectPrefix(prefix: string | null | undefined) {
  return (prefix ?? "")
    .trim()
    .replace(/\\/g, "/")
    .replace(/^\/+|\/+$/g, "")
    .split("/")
    .filter((segment) => segment && segment !== "." && segment !== "..")
    .join("/");
}

export function buildS3ObjectKey(
  destination: Pick<S3StorageClientDestination, "objectPrefix">,
  filename: string,
) {
  const prefix = normalizeObjectPrefix(destination.objectPrefix);
  return prefix ? `${prefix}/${filename}` : filename;
}

export async function listS3Objects(
  destination: S3StorageClientDestination,
) {
  const client = createS3Client(destination);
  const prefix = normalizeObjectPrefix(destination.objectPrefix);
  const objects: Array<{
    key: string;
    lastModified: Date | null;
    size: number;
  }> = [];
  let continuationToken: string | undefined;

  do {
    const response = await client.send(
      new ListObjectsV2Command({
        Bucket: destination.bucket,
        Prefix: prefix ? `${prefix}/` : undefined,
        ContinuationToken: continuationToken,
      }),
    );

    for (const object of response.Contents ?? []) {
      if (!object.Key) continue;
      objects.push({
        key: object.Key,
        lastModified: object.LastModified ?? null,
        size: object.Size ?? 0,
      });
    }

    continuationToken = response.IsTruncated
      ? response.NextContinuationToken
      : undefined;
  } while (continuationToken);

  return objects;
}

export async function deleteS3Objects(
  destination: S3StorageClientDestination,
  keys: string[],
) {
  if (keys.length === 0) return;

  const client = createS3Client(destination);
  for (let offset = 0; offset < keys.length; offset += 1000) {
    const identifiers: ObjectIdentifier[] = keys
      .slice(offset, offset + 1000)
      .map((key) => ({ Key: key }));

    const response = await client.send(
      new DeleteObjectsCommand({
        Bucket: destination.bucket,
        Delete: { Objects: identifiers, Quiet: true },
      }),
    );

    if (response.Errors && response.Errors.length > 0) {
      const failedKeys = response.Errors.map((error) => error.Key).filter(
        (key): key is string => Boolean(key),
      );
      throw new Error(
        `Failed to delete ${failedKeys.length || response.Errors.length} S3 object(s): ${failedKeys.join(", ")}`,
      );
    }
  }
}

