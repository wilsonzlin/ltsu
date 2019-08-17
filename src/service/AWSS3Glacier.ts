import AWS from "aws-sdk";
import {Part, PartStreamFactory, Service} from "./Service";
import crypto from "crypto";
import fs from "fs";
import {CLIArgs} from "../CLI";
import {nextPowerOfTwo} from "../util/nextPowerOfTwo";

export interface AWSS3GlacierOptions {
  region?: string;
  accessId?: string;
  secretKey?: string;
  vaultName: string;
}

const optionalMap = <I, O> (val: I | undefined, mapper: (v: I) => O): O | undefined => {
  return val == undefined ? undefined : mapper(val);
};

export const parseAWSS3GlacierOptions = (args: CLIArgs): AWSS3GlacierOptions => {
  const region = optionalMap(args.region, v => v.toString());
  const accessId = optionalMap(args.access, v => v.toString());
  const secretKey = optionalMap(args.secret, v => v.toString());
  const vaultName = args.vault.toString();

  return {
    region, accessId, secretKey, vaultName,
  };
};

export interface AWSS3GlacierState {
  readonly service: AWS.Glacier;
  readonly vaultName: string;
}

const buildTreeHash = (hashes: Buffer[]): Buffer => {
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
const calculateTreeAndLinearHashOfPart = async (p: fs.ReadStream): Promise<{ linear: Buffer; tree: Buffer; }> => {
  const tree: { level: number; hash: Buffer; }[] = [];
  const linear = crypto.createHash("sha256");
  let leftover = Buffer.alloc(0);

  const handleChunk = (chunk: Buffer) => {
    // WARNING: Don't assign to or use outer scope $leftover in this function,
    // as $chunk argument might be $leftover.

    // Build linear hash.
    linear.update(chunk);

    // Calculate tree hash leaf.
    tree.push({
      level: 1,
      hash: crypto.createHash("sha256").update(chunk).digest(),
    });
    // Merge hashes during tree building.
    while (tree.length > 1 && tree[tree.length - 1].level === tree[tree.length - 2].level) {
      const right = tree.pop()!;
      const left = tree.pop()!;
      tree.push({
        level: right.level + 1,
        hash: crypto.createHash("sha256")
          .update(Buffer.concat([left.hash, right.hash]))
          .digest(),
      });
    }
  };

  for await (let chunk of p) {
    // Even though the highWaterMark should be set to 1 MiB,
    // it's allowed that the ReadStream only reads < 1 MiB for a chunk.

    if (chunk.length > MiB) {
      // This should never happen.
      throw new Error(`ReadStream chunk is larger than 1 MiB`);
    }

    // Combine read chunk with previous leftover.
    chunk = Buffer.concat([leftover, chunk]);
    if (chunk.length < MiB) {
      // Combined chunk is smaller than 1 MiB, not ready to process yet.
      leftover = chunk;
      continue;
    }

    // Process only first 1 MiB of combined chunk and leave remaining for later.
    leftover = chunk.slice(MiB);
    chunk = chunk.slice(0, MiB);

    handleChunk(chunk);
  }
  if (leftover.length) {
    handleChunk(leftover);
  }

  while (tree.length > 1) {
    const right = tree.pop()!;
    const left = tree.pop()!;
    tree.push({
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

// Patch internal method addTreeHashHeaders on AWS.Glacier class to support
// a body of type `fs.ReadStream & {psf: PartStreamFactory}`. By default, the
// SDK tries to convert the ReadStream into a Buffer, which fails as Buffer.from
// doesn't support an argument of type fs.ReadStream. In addition, we don't want
// to read the entire part (which could be up to 4 GiB) into memory, so we pass
// a ReadStream as the body value (which the SDK does support uploading from) with
// a `psf` property that, when called, creates a new ReadStream of the same part,
// as the initial ReadStream will be consumed when building the hashes.
(AWS.Glacier.prototype as any).addTreeHashHeaders = async (
  request: {
    params: { body: any };
    httpRequest: { headers: { [name: string]: string } };
    service: AWS.Glacier,
  },
  callNextListener: (err?: any) => void
) => {
  const body = request.params.body;
  if (body instanceof fs.ReadStream && typeof (body as any).psf == "function") {
    const {linear, tree} = await calculateTreeAndLinearHashOfPart(request.params.body.psf(MiB));
    // The property "X-Amz-Content-Sha256" needs to be exactly in that letter casing,
    // otherwise the SDK will think it doesn't exist and try to hash the ReadStream (which fails).
    request.httpRequest.headers["X-Amz-Content-Sha256"] = linear.toString("hex");
    if (request.httpRequest.headers["x-amz-sha256-tree-hash"]) {
      throw new Error(`Tree hash header already exists on AWS Glacier request`);
    }
    request.httpRequest.headers["x-amz-sha256-tree-hash"] = tree.toString("hex");
    // Length property is needed as by default the SDK gets the length of a fs.ReadStream by the size of the
    // file at `stream._path`.
    request.params.body = Object.assign(request.params.body.psf(), {length: request.params.body.length});
  } else if (body != undefined) {
    const {linearHash, treeHash} = request.service.computeChecksums(request.params.body);
    request.httpRequest.headers["X-Amz-Content-Sha256"] = linearHash;
    if (!request.httpRequest.headers["x-amz-sha256-tree-hash"]) {
      request.httpRequest.headers["x-amz-sha256-tree-hash"] = treeHash;
    }
  }
  callNextListener();
};
// The AWS SDK uses this to determine that the function is asynchronous and so will provide
// a callback and wait for it to be called with any error before continuing.
// This is necessary as our calculateTreeAndLinearHashOfPart function is asynchronous.
(AWS.Glacier.prototype as any).addTreeHashHeaders._isAsync = true;

export const AWSS3Glacier: Service<AWSS3GlacierOptions, AWSS3GlacierState> = {
  // See https://docs.aws.amazon.com/amazonglacier/latest/dev/uploading-archive-mpu.html for limits.
  minParts: 1,
  maxParts: 10000,
  minPartSize: 1024 * 1024, // 1 MiB.
  maxPartSize: 1024 * 1024 * 1024 * 4, // 4 GiB.

  async fromOptions (options: AWSS3GlacierOptions) {
    return {
      service: new AWS.Glacier({
        accessKeyId: options.accessId || undefined,
        secretAccessKey: options.secretKey || undefined,
        region: options.region || undefined,
      }),
      vaultName: options.vaultName,
    };
  },

  async completeUpload (s: AWSS3GlacierState, uploadId: string, fileSize: number, partHashes: Buffer[]): Promise<void> {
    await s.service.completeMultipartUpload({
      accountId: "-",
      archiveSize: `${fileSize}`,
      checksum: buildTreeHash(partHashes).toString("hex"),
      uploadId: uploadId,
      vaultName: s.vaultName,
    }).promise();
  },

  async idealPartSize (_: AWSS3GlacierState, fileSize: number): Promise<number> {
    return nextPowerOfTwo(fileSize / this.maxParts);
  },

  async initiateNewUpload (s: AWSS3GlacierState, fileName: string, partSize: number): Promise<string> {
    return (await s.service.initiateMultipartUpload({
      accountId: "-",
      vaultName: s.vaultName,
      partSize: `${partSize}`,
      archiveDescription: fileName,
    }).promise()).uploadId!;
  },

  async uploadPart (s: AWSS3GlacierState, uploadId: string, psf: PartStreamFactory, {start, end}: Part): Promise<Buffer> {
    const res = await s.service.uploadMultipartPart({
      accountId: "-",
      // See comment above the AWS.Glacier.prototype.addTreeHashHeaders patch above to see why.
      body: Object.assign(psf(), {psf, length: end - start + 1}),
      range: `bytes ${start}-${end}/*`,
      uploadId: uploadId,
      vaultName: s.vaultName,
    }).promise();

    return Buffer.from(res.checksum!, "hex");
  }
};
