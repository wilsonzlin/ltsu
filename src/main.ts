#!/usr/bin/env node

import {promises as fs} from "fs";
import path from "path";
import {Progress} from "./Context";
import {AWSS3Glacier, parseAWSS3GlacierOptions} from "./service/AWSS3Glacier";
import {nullableReadFile, nullableReadJson} from "./util/nullableReadFile";
import {BackblazeB2, parseBackblazeB2Options} from "./service/BackblazeB2";
import {Service} from "./service/Service";
import {CLIArgs} from "./CLI";
import {upload} from "./upload/upload";
import {Session} from "./upload/session";
import minimist = require("minimist");
import {ProgressBar} from "./ProgressBar";

const DEFAULT_CONCURRENT_UPLOADS = 3;

const SERVICES: {
  [name: string]: {
    service: Service<any, any>,
    options: (args: CLIArgs) => any,
  }
} = {
  aws: {
    service: AWSS3Glacier,
    options: parseAWSS3GlacierOptions,
  },
  b2: {
    service: BackblazeB2,
    options: parseBackblazeB2Options,
  },
};

const sessionPath = (workDir: string): string => {
  return path.join(workDir, "session");
};

const statePath = (workDir: string, key: string): string => {
  return path.join(workDir, `state_${key}`);
};

const main = async (rawArgs: string[], progressBar: ProgressBar): Promise<void> => {
  const args = minimist(rawArgs);

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

  const serviceName = args.service.toLowerCase();
  const {service, options: parseOptions} = SERVICES[serviceName];
  const serviceOptions = parseOptions(args);
  const serviceState = await service.fromOptions(serviceOptions);

  const ctx = {
    concurrentUploads,
    file: {
      path: filePath,
      size: fileStats.size,
    },
    logError: (msg: string) => {
      progressBar.log(msg);
    },
    readState: (key: string) => {
      return nullableReadFile(statePath(workingDirectory, key));
    },
    resumeSession: () => {
      return nullableReadJson<Session>(sessionPath(workingDirectory));
    },
    updateProgress: (p: Progress) => {
      progressBar.update({
        percent: p.completeRatio * 100,
        title: p.description,
      });
    },
    writeSession: (session: Session) => {
      return fs.writeFile(sessionPath(workingDirectory), JSON.stringify(session));
    },
    writeState: (key: string, value: any) => {
      return fs.writeFile(statePath(workingDirectory, key), value);
    },
  };

  await upload(ctx, service, serviceState);
};

const progressBar = new ProgressBar(":title [:bar] :percent%");

main(process.argv.slice(2), progressBar)
  .then(() => {
    progressBar.clear();
    console.log(`File successfully uploaded`);
  }, (err: Error) => {
    progressBar.clear();
    console.error(err);
  });