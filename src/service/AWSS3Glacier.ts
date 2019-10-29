import {Glacier as OriginalGlacier} from "aws-sdk";
import crypto from "crypto";
import {createReadStream, promises as fs, ReadStream} from "fs";
import {CLIArgs} from "../CLI";
import {assertExists, assertTrue} from "../util/assert";
import {nextPowerOfTwo} from "../util/nextPowerOfTwo";
import {PartDetails, Service} from "./Service";

type ReadStreamWithPartDetails = ReadStream & { __ltsuPartDetails: PartDetails };
type AWSGlacierRequestBody = ReadStreamWithPartDetails | Buffer | string | undefined;

declare namespace AWS {
  class Glacier extends OriginalGlacier {
    // This is an internal-only method usually not declared via public TS declaration files.
    addTreeHashHeaders (
      request: {
        params: { body: AWSGlacierRequestBody };
        httpRequest: { headers: { [name: string]: string } };
        service: AWS.Glacier,
      },
      callNextListener: (err?: any) => void,
    ): void;
  }
}

const isReadStreamWithPartDetails = (body: AWSGlacierRequestBody): body is ReadStreamWithPartDetails => {
  return body instanceof ReadStream && !!body.__ltsuPartDetails;
};

const joinReadStreamWithPartDetails = (stream: ReadStream, part: PartDetails): ReadStreamWithPartDetails => {
  return Object.assign(stream, {__ltsuPartDetails: part});
};

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
  const chunksCount = Math.ceil((end - start + 1) / MiB);

  const fd = await fs.open(path, "r");

  try {
    for (let chunkNo = 0; chunkNo < chunksCount; chunkNo++) {
      const chunkStart = start + chunkNo * MiB;
      const chunkEnd = Math.min(chunkStart + MiB - 1, end);
      const chunkSize = chunkEnd - chunkStart + 1;

      const buf = Buffer.allocUnsafe(chunkSize);
      const read = await fd.read(buf, 0, chunkSize, chunkStart);
      assertTrue(read.bytesRead === chunkSize);
      const chunk = read.buffer;
      linear.update(chunk);

      const hash = crypto.createHash(`sha256`).update(chunk).digest();
      tree.push({
        level: 1,
        hash: hash,
      });
      while (tree.length > 1 && tree[tree.length - 1].level === tree[tree.length - 2].level) {
        const right = assertExists(tree.pop());
        const left = assertExists(tree.pop());
        tree.push({
          level: right.level + 1,
          hash: crypto.createHash(`sha256`).update(
            Buffer.concat([left.hash, right.hash])
          ).digest(),
        });
      }
    }

    while (tree.length > 1) {
      const right = assertExists(tree.pop());
      const left = assertExists(tree.pop());
      tree.push({
        // To silence type errors.
        level: -1,
        hash: crypto.createHash(`sha256`)
          .update(Buffer.concat([left.hash, right.hash]))
          .digest(),
      });
    }

    return {
      tree: tree[0].hash,
      linear: linear.digest(),
    };
  } finally {
    await fd.close();
  }
};

// Patch internal method addTreeHashHeaders on AWS.Glacier class to support
// a body of type `fs.ReadStream & {psf: PartStreamFactory}`. By default, the
// SDK tries to convert the ReadStream into a Buffer, which fails as Buffer.from
// doesn't support an argument of type fs.ReadStream. In addition, we don't want
// to read the entire part (which could be up to 4 GiB) into memory, so we pass
// a ReadStream as the body value (which the SDK does support uploading from) with
// a `psf` property that, when called, creates a new ReadStream of the same part,
// as the initial ReadStream will be consumed when building the hashes.
AWS.Glacier.prototype.addTreeHashHeaders = async (request, callNextListener) => {
  const body = request.params.body;
  if (isReadStreamWithPartDetails(body)) {
    const {path, start, end} = body.__ltsuPartDetails;
    const {linear, tree} = await calculateTreeAndLinearHashesOfPart({path, start, end});
    // The property "X-Amz-Content-Sha256" needs to be exactly in that letter casing,
    // otherwise the SDK will think it doesn't exist and try to hash the ReadStream (which fails).
    request.httpRequest.headers["X-Amz-Content-Sha256"] = linear.toString("hex");
    // TODO Replace with assertion
    if (request.httpRequest.headers["x-amz-sha256-tree-hash"]) {
      throw new Error(`Tree hash header already exists on AWS Glacier request`);
    }
    request.httpRequest.headers["x-amz-sha256-tree-hash"] = tree.toString("hex");
    // Length property is needed as by default the SDK gets the length of a fs.ReadStream by the size of the
    // file at `stream._path`, which is the length of the entire file.
    request.params.body = Object.assign(body, {length: end - start + 1});
  } else if (body != undefined) {
    // Default code.
    const {linearHash, treeHash} = request.service.computeChecksums(body);
    request.httpRequest.headers["X-Amz-Content-Sha256"] = linearHash;
    if (!request.httpRequest.headers["x-amz-sha256-tree-hash"]) {
      request.httpRequest.headers["x-amz-sha256-tree-hash"] = treeHash;
    }
  }
  callNextListener();
};
// The AWS SDK uses this to determine that the function is asynchronous and so will provide
// a callback and wait for it to be called with any error before continuing.
// This is necessary as our calculateTreeAndLinearHashesOfPart function is asynchronous.
// @ts-ignore
AWS.Glacier.prototype.addTreeHashHeaders._isAsync = true;

export const AWSS3Glacier: Service<AWSS3GlacierOptions, AWSS3GlacierState> = {
  // See https://docs.aws.amazon.com/amazonglacier/latest/dev/uploading-archive-mpu.html for limits.
  minParts: 1,
  maxParts: 10000,
  minPartSize: 1024 * 1024, // 1 MiB.
  maxPartSize: 1024 * 1024 * 1024 * 4, // 4 GiB.

  async fromOptions (options) {
    return {
      service: new AWS.Glacier({
        accessKeyId: options.accessId || undefined,
        secretAccessKey: options.secretKey || undefined,
        region: options.region || undefined,
      }),
      vaultName: options.vaultName,
    };
  },

  async completeUpload (s, uploadId, fileSize, partHashes) {
    await s.service.completeMultipartUpload({
      accountId: "-",
      archiveSize: `${fileSize}`,
      checksum: buildFinalTreeHash(partHashes).toString("hex"),
      uploadId: uploadId,
      vaultName: s.vaultName,
    }).promise();
  },

  async idealPartSize (_, fileSize) {
    return nextPowerOfTwo(fileSize / this.maxParts);
  },

  async initiateNewUpload (s, fileName, partSize) {
    return (await s.service.initiateMultipartUpload({
      accountId: "-",
      vaultName: s.vaultName,
      partSize: `${partSize}`,
      archiveDescription: fileName,
    }).promise()).uploadId!;
  },

  async uploadPart (s, uploadId, part) {
    const {path, start, end} = part;
    const res = await s.service.uploadMultipartPart({
      accountId: "-",
      // See comment above the AWS.Glacier.prototype.addTreeHashHeaders patch above to see why.
      body: joinReadStreamWithPartDetails(createReadStream(path, {start, end}), part),
      range: `bytes ${start}-${end}/*`,
      uploadId: uploadId,
      vaultName: s.vaultName,
    }).promise();

    return Buffer.from(res.checksum!, "hex");
  }
};
