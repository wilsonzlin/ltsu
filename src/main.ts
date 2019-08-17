#!/usr/bin/env node

import {promises as fs} from "fs";
import path from "path";
import {Context, Progress} from "./Context";
import {AWSS3Glacier, parseAWSS3GlacierOptions} from "./service/AWSS3Glacier";
import {nullableReadFile, nullableReadJson} from "./util/nullableReadFile";
import {BackblazeB2, parseBackblazeB2Options} from "./service/BackblazeB2";
import {Service} from "./service/Service";
import {CLIArgs} from "./CLI";
import {upload} from "./upload/upload";
import {Session} from "./upload/session";
import {ProgressBar} from "./ProgressBar";
import minimist = require("minimist");

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

const exit = (error?: string): never => {
  if (error) {
    console.error(error);
  }
  process.exit(error ? 1 : 0);
  // This is for TypeScript, which doesn't recognise that
  // calling process.exit doesn't return.
  throw 1;
};

const sessionPath = (workDir: string): string => {
  return path.join(workDir, "session");
};

const statePath = (workDir: string, key: string): string => {
  return path.join(workDir, `state_${key}`);
};

const args = minimist(process.argv.slice(2));

const concurrentUploads = +args.concurrency || DEFAULT_CONCURRENT_UPLOADS;
const quiet = !!args.quiet;
const verbose = !!args.verbose;

const {service, options: parseOptions} = SERVICES[args.service.toLowerCase()];
const serviceOptions = parseOptions(args);

const progressBar = quiet ? null : new ProgressBar(":title [:bar] :percent%");
const logFormat = (msg: any) => `[${new Date().toISOString()}] ${msg}`;

const filePath = args.file;
const workingDirectory = args.work;
let fileSize: number;

const ctx: Context = {
  concurrentUploads,
  file: {
    path: filePath,
    // Size isn't available right now, but will be loaded later before $ctx is used.
    get size () {
      return fileSize;
    },
  },
  log: (msg: string, info: boolean = false) => {
    if (info && !verbose) {
      return;
    }
    const out = logFormat(msg);
    if (progressBar) {
      progressBar.log(out);
    } else {
      console.error(out);
    }
  },
  readState: (key: string) => {
    return nullableReadFile(statePath(workingDirectory, key));
  },
  resumeSession: () => {
    return nullableReadJson<Session>(sessionPath(workingDirectory));
  },
  updateProgress: (p: Progress) => {
    if (!progressBar) {
      return;
    }
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

const onEnd = (err: any) => {
  if (progressBar) {
    progressBar.clear();
  }
  if (err) {
    exit(err.stack || err);
  } else {
    exit();
  }
};

Promise.all([fs.stat(filePath), fs.stat(workingDirectory)])
  .then(([fileStats, workStats]) => {
    if (!fileStats.isFile()) {
      throw new TypeError(`${filePath} is not a file`);
    }
    if (!workStats.isDirectory()) {
      throw new TypeError(`${workingDirectory} is not a directory`);
    }
    fileSize = fileStats.size;
    return service.fromOptions(serviceOptions);
  })
  .then(serviceState => upload(ctx, service, serviceState))
  .then(onEnd, onEnd);
