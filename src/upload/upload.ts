import {Context} from "../Context";
import sz from "filesize";
import PQueue from "p-queue";
import {Service} from "../service/Service";
import {loadPartHash, savePartHash} from "./state";
import {maybeLoadExistingUploadId, saveUploadIdToSession} from "./session";
import fs from "fs";
import path from "path";

export const upload = async <S> (ctx: Context, svc: Service<any, S>, s: S) => {
  const partSize = Math.max(
    svc.minPartSize,
    Math.min(
      svc.maxPartSize,
      // TODO Part size should be loaded from session
      // as idealPartSize can be non-deterministic.
      await svc.idealPartSize(s, ctx.file.size)
    )
  );
  const partsNeeded = Math.ceil(ctx.file.size / partSize);
  if (partsNeeded < 1) {
    throw new Error(`File is too small`);
  }
  if (partsNeeded > svc.maxParts) {
    throw new Error(
      `File is too big (${sz(ctx.file.size)}) and cannot fit into ${svc.maxParts} ${sz(svc.maxPartSize)} parts ` +
      `(requires ${partsNeeded} parts)`
    );
  }

  ctx.updateProgress({
    description: `Checking for existing work...`,
    completeRatio: 0,
  });

  // TODO Ensure that session used same file with same contents and part size.
  const uploadId = (await maybeLoadExistingUploadId(ctx)) || (await (async () => {
    ctx.updateProgress({
      description: `No existing upload found, initiating new upload...`,
      completeRatio: 0,
    });
    const uploadId = await svc.initiateNewUpload(s, path.basename(ctx.file.path), partSize);
    await saveUploadIdToSession(ctx, uploadId);
    return uploadId;
  })());

  // TODO Add ability to verify integrity of hashes.
  const partHashes = await Promise.all(
    new Array(partsNeeded)
      .fill(0)
      .map((_, part) => loadPartHash(ctx, part))
  );

  let partsCompleted = partHashes.filter(h => h != null).length;
  const retryCounts: { [part: number]: number } = {};
  const queue = new PQueue({concurrency: ctx.concurrentUploads});

  const updateUploadProgress = () => {
    const partsRemaining = partsNeeded - partsCompleted;
    ctx.updateProgress({
      description: `Uploading ${partsRemaining} ${sz(partSize)} parts (${sz(partsRemaining * partSize)})...`,
      completeRatio: Math.min(0.99, partsCompleted / partsNeeded),
    });
  };
  updateUploadProgress();

  const queuePartUploadTask = (part: number): void => {
    const start = part * partSize;
    const end = Math.min(ctx.file.size, (part + 1) * partSize) - 1;
    queue.add(
      () => svc.uploadPart(
        s,
        uploadId,
        highWaterMark => fs.createReadStream(ctx.file.path, {highWaterMark, start, end}),
        {number: part, start, end}
      )
        .then(
          ({hash}) => handleUploadPartSuccess(part, hash),
          err => handleUploadPartFailure(part, err)
        ));
  };

  const handleUploadPartSuccess = (part: number, hash: Buffer) => {
    partsCompleted++;
    partHashes[part] = hash;
    savePartHash(ctx, part, hash);

    updateUploadProgress();
  };

  // TODO Abort queue on error and add option to allowing ignoring this session.
  const handleUploadPartFailure = (part: number, err: any) => {
    const r = retryCounts[part] || 0;
    if (r > ctx.maximumRetriesPerPart) {
      throw new Error(`Part ${part} failed to upload ${ctx.maximumRetriesPerPart} times, with final error: ${err}`);
    }
    retryCounts[part] = r + 1;
    ctx.logError(`Failed to upload part ${part} with error "${err}", retrying (${r})...`);
    queuePartUploadTask(part);
  };

  for (const [part, hash] of partHashes.entries()) {
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
    completeRatio: 0.99,
  });

  await svc.completeUpload(s, uploadId, ctx.file.size, partHashes as Buffer[]);
};
