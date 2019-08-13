import * as AWS from "aws-sdk";
import {Context} from "../../Context";
import PQueue from "p-queue";
import {uploadPart, UploadPartResponse} from "./uploadPart";
import {maybeLoadExistingUploadId, saveUploadIdToSession} from "./session";
import {computeFinalChecksum} from "./computeFinalChecksum";
import {loadPartTreeHash, savePartTreeHash} from "./state";

const byteSize = require("byte-size");

// See https://docs.aws.amazon.com/amazonglacier/latest/dev/uploading-archive-mpu.html for limits.
const MAX_PARTS_PER_UPLOAD = 10000;
const MIN_PART_SIZE = 1024 * 1024; // 1 MiB.
const MAX_PART_SIZE = 1024 * 1024 * 1024 * 4; // 4 GiB.

export interface AWSGlacierOptions {
  region: string;
  accessId: string;
  secretKey: string;
  vaultName: string;
}

export const AWSGlacier = async (ctx: Context, options: AWSGlacierOptions) => {
  const service = new AWS.Glacier({
    accessKeyId: options.accessId,
    secretAccessKey: options.secretKey,
    region: options.region,
  });

  const partSize = Math.max(MIN_PART_SIZE, ctx.file.size / MAX_PARTS_PER_UPLOAD);
  const partsNeeded = Math.ceil(ctx.file.size / partSize);
  if (partsNeeded < 1) {
    throw new Error(`File is too small`);
  }
  if (partsNeeded > MAX_PARTS_PER_UPLOAD) {
    throw new Error(
      `File is too big and cannot fit into ${MAX_PARTS_PER_UPLOAD} parts of ${byteSize(MAX_PART_SIZE)} files`
    );
  }

  ctx.updateProgress({
    description: `Checking for existing work...`,
  });

  const uploadId = (await maybeLoadExistingUploadId(ctx)) || (await (async () => {
    ctx.updateProgress({
      description: `No existing upload found, initiating new upload...`,
    });
    const uploadId = (await service.initiateMultipartUpload({
      accountId: "-",
      vaultName: options.vaultName,
      partSize: `${partSize}`,
    }).promise()).uploadId!;
    await saveUploadIdToSession(ctx, uploadId);
    return uploadId;
  })());

  // TODO Add ability to verify integrity of hashes.
  const treeHashes = await Promise.all(
    new Array(partsNeeded)
      .fill(0)
      .map((_, part) => loadPartTreeHash(ctx, part))
  );

  let partsCompleted = treeHashes.filter(h => h != null).length;
  const retryCounts: { [part: number]: number } = {};
  const queue = new PQueue({concurrency: ctx.concurrentUploads});

  const updateUploadProgress = () => {
    ctx.updateProgress({
      description:
        `Uploading ${
        partsNeeded - partsCompleted
          } ${
          byteSize(partSize)
          } parts (${
          byteSize((partsNeeded - partsCompleted) * partSize)
          })`,
      completeRatio: partsCompleted / partsNeeded,
    });
  };
  updateUploadProgress();

  const queuePartUploadTask = (part: number): void => {
    queue.add(() => uploadPart({
      path: ctx.file.path,
      part: part,
      partSize: partSize,
      uploadId: uploadId,
      fileSize: ctx.file.size,
      service: service,
      vaultName: options.vaultName,
    })
      .then(
        handleUploadPartSuccess,
        err => handleUploadPartFailure(part, err)
      ));
  };

  const handleUploadPartSuccess = ({part, treeHash}: UploadPartResponse) => {
    partsCompleted++;
    treeHashes[part] = treeHash;
    savePartTreeHash(ctx, part, treeHash);

    updateUploadProgress();
  };

  // TODO Abort queue on error.
  const handleUploadPartFailure = (part: number, err: any) => {
    const r = retryCounts[part] || 0;
    if (r > ctx.maximumRetriesPerPart) {
      throw new Error(`Part ${part} failed to upload ${ctx.maximumRetriesPerPart} times, with final error: ${err}`);
    }
    retryCounts[part] = r + 1;
    ctx.logError(`Failed to upload part ${part} with error "${err}", retrying (${r})...`);
    queuePartUploadTask(part);
  };

  for (const [part, hash] of treeHashes.entries()) {
    if (hash) {
      continue;
    }
    queuePartUploadTask(part);
  }

  // NOTE: The queue could change during uploads due to retry,
  // so it's not as simple as awaiting all initial upload Promises.
  await queue.onIdle();

  ctx.updateProgress({
    description: "All parts have been uploaded, finalising...",
  });

  await service.completeMultipartUpload({
    accountId: "-",
    archiveSize: `${ctx.file.size}`,
    checksum: computeFinalChecksum(treeHashes as Buffer[]).toString("hex"),
    uploadId: uploadId,
    vaultName: options.vaultName,
  }).promise();
};
