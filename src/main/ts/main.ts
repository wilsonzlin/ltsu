#!/usr/bin/env node

import {promises as fs} from "fs";
import * as path from "path";
import {Progress} from "./Context";
import ProgressBar from "progress";
import {AWSGlacier} from "./service/AWSGlacier/AWSGlacier";
import {Service} from "./service/Service";
import {parseOptions} from "./service/AWSGlacier/parseOptions";
import minimist = require("minimist");

const DEFAULT_CONCURRENT_UPLOADS = 3;
const DEFAULT_MAX_RETRIES_PER_PART = 5;

const nullableReadFile = async (path: string): Promise<Buffer | null> => {
  try {
    return await fs.readFile(path);
  } catch (err) {
    if (err.code == "ENOENT") {
      return null;
    }
    throw err;
  }
};

const sessionPath = (workDir: string): string => {
  return path.join(workDir, "session");
};

const statePath = (workDir: string, key: string): string => {
  return path.join(workDir, `state_${key}`);
};

const main = async (args: { [name: string]: string }): Promise<void> => {
  const filePath = args.file;
  const fileStats = await fs.stat(filePath);
  if (!fileStats.isFile()) {
    throw new Error(`${filePath} is not a file`);
  }

  const workingDirectory = args.work;
  if (!(await fs.stat(workingDirectory)).isDirectory()) {
    throw new Error(`${workingDirectory} is not a directory`);
  }

  const concurrentUploads = +args.concurrency || DEFAULT_CONCURRENT_UPLOADS;
  const maximumRetriesPerPart = +args.retries || DEFAULT_MAX_RETRIES_PER_PART;

  const progressBar = new ProgressBar(":title [:bar] :percent", {
    total: 100,
    complete: "=",
    incomplete: " ",
    renderThrottle: 0,
    clear: true,
  });

  const serviceName = args.service.toLowerCase();
  let service: Service<any>;
  let serviceOptions: any;
  switch (serviceName) {
  case "aws":
    service = AWSGlacier;
    serviceOptions = parseOptions(args);
    break;
  default:
    throw new Error(`Unknown service "${serviceName}"`);
  }

  const ctx = {
    concurrentUploads,
    maximumRetriesPerPart,
    file: {
      path: filePath,
      size: fileStats.size,
    },
    logError: (msg: string) => {
      progressBar.interrupt(msg);
    },
    readState: (key: string) => {
      return nullableReadFile(statePath(workingDirectory, key));
    },
    resumeSession: () => {
      return nullableReadFile(sessionPath(workingDirectory));
    },
    updateProgress: (p: Progress) => {
      if (p.completeRatio != undefined) {
        progressBar.update(p.completeRatio, {
          title: p.description,
        });
      } else {
        progressBar.render({
          title: p.description,
        });
      }
    },
    writeSession: (session: Buffer) => {
      return fs.writeFile(sessionPath(workingDirectory), session);
    },
    writeState: (key: string, value: Buffer) => {
      return fs.writeFile(statePath(workingDirectory, key), value);
    },
  };

  await service(ctx, serviceOptions)
    .then(() => {
      progressBar.terminate();
      console.log(`File successfully uploaded`);
    }, err => {
      progressBar.terminate();
      console.error(err);
    });
};

main(minimist(process.argv.slice(2)));
