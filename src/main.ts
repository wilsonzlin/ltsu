#!/usr/bin/env node

import {promises as fs, Stats} from "fs";
import path from "path";
import {Context, Session} from "./Context";
import {AWSS3Glacier, parseAWSS3GlacierOptions} from "./service/AWSS3Glacier";
import {nullableReadFile, nullableReadJson} from "./util/nullableReadFile";
import {BackblazeB2, parseBackblazeB2Options} from "./service/BackblazeB2";
import {Service} from "./service/Service";
import {CLIArgs} from "./CLI";
import {upload} from "./upload/upload";
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
const force = !!args.force;

const {service, options: parseOptions} = SERVICES[args.service.toLowerCase()];
const serviceOptions = parseOptions(args);

const progressBar = quiet ? null : new ProgressBar(":title [:bar] :percent%");
const logFormat = (msg: any) => `[${new Date().toISOString()}] ${msg}`;

const filePath = args.file;
const workingDirectory = args.work;
let fileStats: Stats;

const ctx: Context = {
  concurrentUploads,
  file: {
    path: filePath,
    // File stats aren't available right now, but will be loaded later before $ctx is used.
    get size () {
      return fileStats.size;
    },
    get lastModified () {
      return fileStats.mtime.toISOString();
    },
  },
  force,
  log: (msg, info = false) => {
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
  readState: key => nullableReadFile(statePath(workingDirectory, key)),
  resumeSession: () => nullableReadJson<Session>(sessionPath(workingDirectory)),
  updateProgress: p => progressBar && progressBar.update({
    percent: p.completeRatio * 100,
    title: p.description,
  }),
  writeSession: session => fs.writeFile(sessionPath(workingDirectory), JSON.stringify(session)),
  writeState: (key, value) => fs.writeFile(statePath(workingDirectory, key), value),
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

Promise.all([filePath, workingDirectory].map(fs.stat))
  .then(([file, work]) => {
    if (!file.isFile()) {
      throw new TypeError(`${filePath} is not a file`);
    }
    if (!work.isDirectory()) {
      throw new TypeError(`${workingDirectory} is not a directory`);
    }
    fileStats = file;
    return service.fromOptions(serviceOptions);
  })
  .then(serviceState => upload(ctx, service, serviceState))
  .then(onEnd, onEnd);
