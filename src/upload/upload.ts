import {Context} from "../Context";
import sz from "filesize";
import PQueue from "p-queue";
import {Service} from "../service/Service";
import {loadPartHash, savePartHash} from "./state";
import fs from "fs";
import path from "path";
import {wait} from "../util/wait";

// 5 minutes.
const MAX_RETRY_DELAY = 60 * 5;

export const upload = async <S> (ctx: Context, svc: Service<any, S>, s: S) => {
  ctx.log(`Upload started`);

  ctx.updateProgress({
    description: `Checking for existing work...`,
    completeRatio: 0,
  });

  const {uploadId, filePath, fileLastChanged, partSize, partsNeeded} =
  (await ctx.resumeSession()) ||
  (await (async () => {
    ctx.updateProgress({
      description: `No existing upload found, initiating new upload...`,
      completeRatio: 0,
    });

    // Calculate appropriate part size.
    // Note that idealPartSize() can be non-deterministic.
    const partSize = Math.max(
      svc.minPartSize,
      Math.min(
        svc.maxPartSize,
        await svc.idealPartSize(s, ctx.file.size)
      )
    );

    // Validate how many parts are needed.
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

    // Initiate new upload with service.
    const uploadId = await svc.initiateNewUpload(s, path.basename(ctx.file.path), partSize);

    // Build and save new session.
    const session = {
      uploadId,
      filePath: ctx.file.path,
      fileLastChanged: ctx.file.lastModified,
      partSize,
      partsNeeded,
    };
    await ctx.writeSession(session);
    return session;
  })());

  // Ensure that session uses same file with same contents and part size.
  if (filePath !== ctx.file.path || fileLastChanged !== ctx.file.lastModified) {
    throw new Error(`Cannot resume upload as file has changed since last session`);
  }

  // TODO Add ability to verify integrity of hashes and invalidate specific parts.
  const partHashes = await Promise.all(
    new Array(partsNeeded)
      .fill(0)
      .map((_, part) => loadPartHash(ctx, part))
  );

  let partsCompleted = partHashes.filter(h => h != null).length;
  // This value is used as the exponent for exponential backoff, and is
  // incremented for every part upload failure and reset to zero on every
  // successful upload.
  //
  // This means that intermittent failures will not encounter much delay (as
  // this value doesn't increase much and will quickly be reset), but service
  // issues will not cause constant rapid retries and wait longer until
  // the service has resumed normal performance.
  //
  // The maximum retry delay is defined in the constant MAX_RETRY_DELAY,
  // regardless of what 2 ^ $consecutiveFailures is.
  let consecutiveFailures = 0;
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

    // Code awaits for queue to go idle later, so no need to handle individual queued upload Promises.
    queue.add(async () => {
      if (consecutiveFailures) {
        // Exponential backoff if currently in a series of failures.
        await wait(Math.min(MAX_RETRY_DELAY, 2 ** consecutiveFailures));
      }

      let hash: Buffer;
      try {
        hash = await svc.uploadPart(
          s,
          uploadId,
          highWaterMark => fs.createReadStream(ctx.file.path, {highWaterMark, start, end}),
          {number: part, start, end}
        );
      } catch (err) {
        // Part upload failed, increase delay, log, and requeue.
        consecutiveFailures++;
        ctx.log(`Failed to upload part ${part} with error "${err}", retrying...`);
        queuePartUploadTask(part);
        return;
      }

      // Part successfully uploaded.
      ctx.log(`Uploaded part ${part}`, true);
      partsCompleted++;
      // Reset failure streak.
      consecutiveFailures = 0;
      partHashes[part] = hash;
      await savePartHash(ctx, part, hash);

      updateUploadProgress();
    });
  };

  for (const [part, hash] of partHashes.entries()) {
    if (hash) {
      // Hash exists so already previously uploaded.
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

  ctx.log(`File successfully uploaded`);
};
