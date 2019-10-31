import crypto from "crypto";
import {createReadStream, promises as fs, ReadStream} from "fs";
import {Response} from "request";
import {CLIArgs} from "../CLI";
import {assertExists, assertTrue} from "../util/assert";
import {getLastHeaderValue, http, HTTPRequestHeaders, HTTPRequestMethod} from "../util/http";
import {nextPowerOfTwo} from "../util/nextPowerOfTwo";
import {createAuthHeader, getISOTime, EMPTY_BODY_SHA256} from "../util/v4";
import {Service} from "./Service";

interface GlacierAPIRequest {
  method: HTTPRequestMethod;
  subpath: string;
  headers: HTTPRequestHeaders;
  body?: {
    data: ReadStream | string;
    SHA256: string;
  };
}

const createBoundRequestFunction = (
  {
    region,
    accessId,
    secretKey,
    vaultName,
  }: {
    region: string;
    accessId: string;
    secretKey: string;
    vaultName: string;
  }
) => (
  {
    method,
    subpath,
    headers,
    body,
  }: GlacierAPIRequest
): Promise<Response> => {
  const host = `glacier.${region}.amazonaws.com`;
  const path = `/-/vaults/${vaultName}${subpath}`;

  const isoDateTime = getISOTime();

  headers["x-amz-date"] = isoDateTime;
  headers["x-amz-glacier-version"] = `2012-06-01`;
  if (body) {
    headers["x-amz-content-sha256"] = body.SHA256;
  }
  headers["Authorization"] = createAuthHeader({
    isoDateTime,
    method,
    host,
    path,
    headers,
    contentSHA256: body ? body.SHA256 : EMPTY_BODY_SHA256,
    service: "glacier",
    region,
    accessKeyId: accessId,
    secretAccessKey: secretKey,
  });

  return http({
    url: `https://${host}${path}`,
    method,
    headers,
    body: body && body.data,
  });
};

export interface AWSS3GlacierOptions {
  region: string;
  accessId: string;
  secretKey: string;
  vaultName: string;
}

export const parseAWSS3GlacierOptions = (args: CLIArgs): AWSS3GlacierOptions => {
  // Call .toString to ensure value is not null/undefined.
  const region = args.region.toString();
  const accessId = args.access.toString();
  const secretKey = args.secret.toString();
  const vaultName = args.vault.toString();

  return {
    region, accessId, secretKey, vaultName,
  };
};

export interface AWSS3GlacierState {
  readonly requester: (request: GlacierAPIRequest) => Promise<Response>;
  readonly vaultName: string;
}

const buildFinalTreeHash = (hashes: Buffer[]): Buffer => {
  while (hashes.length > 1) {
    const newHashes = [];
    for (let i = 0; i < hashes.length - 1; i += 2) {
      newHashes.push(
        crypto.createHash("sha256")
          .update(Buffer.concat(hashes.slice(i, i + 2)))
          .digest()
      );
    }
    if (hashes.length % 2 === 1) {
      newHashes.push(hashes[hashes.length - 1]);
    }
    hashes = newHashes;
  }
  return hashes[0];
};

const MiB = 1024 * 1024;

// This is difficult, as it needs to build the tree hash while reading the part,
// not collect hashes for the entire part first (which might result in heavy
// memory usage for large part sizes).
const calculateTreeAndLinearHashesOfPart = async ({path, start, end}: { path: string, start: number, end: number }): Promise<{ linear: Buffer; tree: Buffer; }> => {
  const tree: { level: number; hash: Buffer }[] = [];
  const linear = crypto.createHash("sha256");

  const fd = await fs.open(path, "r");

  try {
    for (let chunkStart = start; chunkStart <= end; chunkStart += MiB) {
      // Calculate chunk range and length.
      const chunkEnd = Math.min(chunkStart + MiB - 1, end);
      const chunkSize = chunkEnd - chunkStart + 1;

      // Read chunk.
      const chunk = Buffer.allocUnsafe(chunkSize);
      const {bytesRead} = await fd.read(chunk, 0, chunkSize, chunkStart);
      assertTrue(bytesRead === chunkSize);

      // Build linear hash.
      linear.update(chunk);

      // Build tree hash.
      tree.push({
        level: 1,
        hash: crypto.createHash("sha256").update(chunk).digest(),
      });
      while (tree.length > 1 && tree[tree.length - 1].level === tree[tree.length - 2].level) {
        const right = assertExists(tree.pop());
        const left = assertExists(tree.pop());
        tree.push({
          level: right.level + 1,
          hash: crypto.createHash("sha256")
            .update(Buffer.concat([left.hash, right.hash]))
            .digest(),
        });
      }
    }
  } finally {
    await fd.close();
  }

  // Finalise tree hash.
  while (tree.length > 1) {
    const right = assertExists(tree.pop());
    const left = assertExists(tree.pop());
    tree.push({
      // To silence type errors.
      level: -1,
      hash: crypto.createHash("sha256")
        .update(Buffer.concat([left.hash, right.hash]))
        .digest(),
    });
  }

  return {
    tree: tree[0].hash,
    linear: linear.digest(),
  };
};

export const AWSS3Glacier: Service<AWSS3GlacierOptions, AWSS3GlacierState> = {
  // See https://docs.aws.amazon.com/amazonglacier/latest/dev/uploading-archive-mpu.html for limits.
  minParts: 1,
  maxParts: 10000,
  minPartSize: 1024 * 1024, // 1 MiB.
  maxPartSize: 1024 * 1024 * 1024 * 4, // 4 GiB.

  async fromOptions (options) {
    return {
      requester: createBoundRequestFunction({
        accessId: options.accessId,
        secretKey: options.secretKey,
        region: options.region,
        vaultName: options.vaultName,
      }),
      vaultName: options.vaultName,
    };
  },

  async completeUpload (s, uploadId, fileSize, partHashes) {
    await s.requester({
      subpath: `/multipart-uploads/${uploadId}`,
      method: "POST",
      headers: {
        "x-amz-sha256-tree-hash": buildFinalTreeHash(partHashes).toString("hex"),
        "x-amz-archive-size": fileSize,
      },
    });
  },

  async idealPartSize (_, fileSize) {
    return nextPowerOfTwo(fileSize / this.maxParts);
  },

  async initiateNewUpload (s, fileName, partSize) {
    const res = await s.requester({
      headers: {
        "x-amz-part-size": partSize.toString(),
        "x-amz-archive-description": fileName,
      },
      method: "POST",
      subpath: "/multipart-uploads",
    });
    return getLastHeaderValue(res, "x-amz-multipart-upload-id");
  },

  async uploadPart (s, uploadId, part) {
    const {path, start, end} = part;
    const {linear, tree} = await calculateTreeAndLinearHashesOfPart({path, start, end});
    const res = await s.requester({
      subpath: `/multipart-uploads/${uploadId}`,
      method: "PUT",
      headers: {
        "Content-Length": end - start + 1,
        "Content-Range": `bytes ${start}-${end}/*`,
        "x-amz-sha256-tree-hash": tree.toString("hex"),
      },
      body: {
        data: createReadStream(path, {start, end}),
        SHA256: linear.toString("hex"),
      },
    });

    const serverTreeHash = Buffer.from(getLastHeaderValue(res, "x-amz-sha256-tree-hash"), "hex");
    assertTrue(tree.equals(serverTreeHash));
    return tree;
  }
};
