import fs from "fs";
import crypto from "crypto";
import {createAuthHeader} from "../util/aws/signature";
import minimist from "minimist";
import http from "../util/http";
import nullableReadBinaryFile from "../util/nullableReadBinaryFile";
import getISOTime from "../util/getISOTime";

const args = minimist(process.argv.slice(2));

const AWS_REGION = args.region;
const ACCESS_ID = args.id;
const ACCESS_SECRET = args.secret;

const FILE_PATH = args.file;

const VAULT_NAME = args.vault;
const WORK_DIR = args.workdir;

if (!fs.existsSync(FILE_PATH)) {
  throw new Error(`${FILE_PATH} does not exist`);
}

if (!fs.existsSync(WORK_DIR) || !fs.lstatSync(WORK_DIR).isDirectory()) {
  throw new Error(`${WORK_DIR} is not a directory`);
}

const PART_SIZE = 1024 * 1024 * 512;
const CONCURRENT_UPLOADS = 3;
const MAX_RETRIES_PER_PART = 5;

let uploadId;
let uploadQueue = [];
let currentUploads = 0;
let partsNeeded;
let fileSize;


function awsGlacierHttp({ method, subpath, headers, body, contentHash }) {
  let host = `glacier.${AWS_REGION}.amazonaws.com`;
  let path = `/-/vaults/${VAULT_NAME}${subpath}`;

  let datetime = getISOTime();

  headers = Object.assign({
    "x-amz-date": datetime,
    "x-amz-glacier-version": `2012-06-01`,
    "x-amz-content-sha256": contentHash || crypto.createHash(`sha256`).update(body || "").digest("hex"),
  }, headers);

  let authHeader = createAuthHeader({
    isoDateTime: datetime,
    method: method,
    host: host,
    path: path,
    args: null,
    headers: headers,
    body: body,
    service: `glacier`,
    region: AWS_REGION,
    accessKeyId: ACCESS_ID,
    secretAccessKey: ACCESS_SECRET,
  });

  headers.Authorization = authHeader;

  return http({
    url: `https://${host}${path}`,
    method: method,
    headers: headers,
    body: body,
  });
}

function initMultipartUpload() {
  return new Promise((resolve, reject) => {
    let pathToUploadId = `${WORK_DIR}/mpupload.id`;

    nullableReadBinaryFile(pathToUploadId)
      .then(savedId => {
        if (savedId !== null) {
          console.log(`Found existing multipart upload`);
          resolve(savedId.toString("ascii"));
        } else {
          let uploadId;
          console.log(`Starting new multipart upload...`);
          awsGlacierHttp({
            method: "POST",
            subpath: "/multipart-uploads",
            headers: {
              "x-amz-part-size": PART_SIZE.toString(),
            },
          })
            .then(res => {
              uploadId = res.headers["x-amz-multipart-upload-id"];
              return writeFile(pathToUploadId, uploadId);
            }).then(() => {
              resolve(uploadId);
            })
            .catch(reject);
        }
      })
      .catch(reject);
  });
}

function calculateTreeAndContentHashesOfFile(path, start, end) {
  return new Promise((resolve, reject) => {
    let hashes = [];
    let contentHash = crypto.createHash("sha256");

    let chunksCount = Math.ceil((end - start + 1) / (1024 * 1024));

    fs.open(path, "r", (err, fd) => {
      if (err) {
        reject(err);
      } else {
        let chunkNo = 0;

        let readChunk = () => {
          let chunkStart = start + chunkNo * 1024 * 1024;
          let chunkEnd = Math.min(chunkStart + 1024 * 1024 - 1, end);
          let chunkSize = chunkEnd - chunkStart + 1;

          let buf = Buffer.allocUnsafe(chunkSize);
          fs.read(fd, buf, 0, chunkSize, chunkStart, (err, _, chunk) => {
            if (err) {
              fs.close(fd, closeerr => {
                reject(closeerr || err);
              });
            } else {
              contentHash.update(chunk);

              let hash = crypto.createHash(`sha256`).update(chunk).digest();
              hashes.push({
                level: 1,
                hash: hash,
              });
              while (hashes.length > 1 && hashes[hashes.length - 1].level === hashes[hashes.length - 2].level) {
                let right = hashes.pop();
                let left = hashes.pop();
                hashes.push({
                  level: right.level + 1,
                  hash: crypto.createHash(`sha256`).update(
                    Buffer.concat([left.hash, right.hash])
                  ).digest(),
                });
              }

              chunkNo++;
              if (chunkNo < chunksCount) {
                readChunk();
              } else {
                fs.close(fd, err => {
                  if (err) {
                    reject(err);
                  } else {
                    while (hashes.length > 1) {
                      let right = hashes.pop();
                      let left = hashes.pop();
                      hashes.push({
                        hash: crypto.createHash(`sha256`).update(
                          Buffer.concat([left.hash, right.hash])
                        ).digest(),
                      });
                    }

                    let treeHash = hashes[0].hash;
                    resolve([treeHash, contentHash.digest()]);
                  }
                });
              }
            }
          });
        };

        readChunk();
      }
    });
  });
}

function _uploadPart({ uploadId, partNo, resolve, reject }) {
  let checksum;
  let start = partNo * PART_SIZE;
  let end = Math.min(fileSize - 1, (partNo + 1) * PART_SIZE - 1);

  console.log(`Calculating hashes for part ${partNo}...`);

  calculateTreeAndContentHashesOfFile(FILE_PATH, start, end)
    .then(([treeHash, contentHash]) => {
      checksum = treeHash;

      console.log(`Uploading part ${partNo}...`);
      return awsGlacierHttp({
        subpath: `/multipart-uploads/${uploadId}`,
        method: "PUT",
        headers: {
          "Content-Length": end - start + 1,
          "Content-Range": `bytes ${start}-${end}/*`,
          "x-amz-sha256-tree-hash": treeHash.toString("hex"),
          "x-amz-content-sha256": contentHash.toString("hex"),
        },
        body: fs.createReadStream(FILE_PATH, {
          start: start,
          end: end,
        }),
        contentHash: contentHash,
      });
    })
    .then(() => {
      resolve(checksum);
    })
    .catch(reject)
    .then(() => {
      if (uploadQueue.length) {
        _uploadPart(uploadQueue.shift());
      } else {
        currentUploads--;
      }
    });
}

function uploadPart(uploadId, partNo) {
  return new Promise((resolve, reject) => {
    if (currentUploads < CONCURRENT_UPLOADS) {
      currentUploads++;
      _uploadPart({ uploadId, partNo, resolve, reject });
    } else {
      uploadQueue.push({
        uploadId, partNo, resolve, reject,
      });
    }
  });
}

function completeMultipartUpload(checksum) {
  return new Promise((resolve, reject) => {
    console.log(`Completing multipart upload...`);
    awsGlacierHttp({
      subpath: `/multipart-uploads/${uploadId}`,
      method: "POST",
      headers: {
        "x-amz-sha256-tree-hash": checksum.toString("hex"),
        "x-amz-archive-size": fileSize,
      },
    })
      .then(res => {
        resolve(res.headers["x-amz-archive-id"]);
      })
      .catch(reject);
  });
}

initMultipartUpload()
  .then(uid => uploadId = uid)
  .then(() => lstat(FILE_PATH))
  .then(fileInfo => {
    if (!fileInfo.isFile()) {
      return Promise.reject(new Error(`Invalid file path`));
    }

    fileSize = fileInfo.size;
    partsNeeded = Math.ceil(fileSize / PART_SIZE);

    if (partsNeeded < 3) {
      return Promise.reject(new Error(`File too small`));
    }

    return Promise.all(new Array(partsNeeded).fill()
      .map((_, partNo) => nullableReadBinaryFile(`${WORK_DIR}/${partNo}.treehash`)));
  })
  .then(savedTreeHashes => {
    return new Promise((resolve, reject) => {
      let treeHashes = [];
      let attempts = {};
      let uploadedCount = 0;

      function isComplete() {
        if (uploadedCount === partsNeeded) {
          resolve(treeHashes);
        }
      }

      function upload(partNo) {
        attempts[partNo] = (attempts[partNo] || 0) + 1;
        uploadPart(uploadId, partNo)
          .then(checksum => {
            treeHashes[partNo] = checksum;
            uploadedCount++;
            return writeFile(`${WORK_DIR}/${partNo}.treehash`, checksum);
          })
          .then(() => {
            console.log(`Uploaded part ${partNo} of ${partsNeeded}`);
            isComplete();
          })
          .catch(err => {
            console.error(`Failed to upload ${partNo}:`);
            console.error(err);
            // Don't exit, retry
            if (attempts[partNo] < MAX_RETRIES_PER_PART) {
              upload(partNo);
            } else {
              reject(new Error(`Failed all ${MAX_RETRIES_PER_PART} attempts to upload ${partNo}`));
            }
          });
      }

      savedTreeHashes.forEach((hash, partNo) => {
        if (hash === null) {
          upload(partNo);
        } else {
          // console.log(`Part ${ partNo } has already been uploaded`);
          treeHashes[partNo] = hash;
          uploadedCount++;
        }
      });

      isComplete();
    });
  })
  .then(treehashes => {
    console.log(`Calculating final treehash...`);
    while (treehashes.length > 1) {
      let newHashes = [];
      for (let i = 0; i < treehashes.length - 1; i += 2) {
        newHashes.push(crypto.createHash(`sha256`).update(
          Buffer.concat(treehashes.slice(i, i + 2))
        ).digest());
      }
      if (treehashes.length % 2 === 1) {
        newHashes.push(treehashes[treehashes.length - 1]);
      }
      treehashes = newHashes;
    }

    return completeMultipartUpload(treehashes[0]);
  })
  .then(id => {
    console.log(`Upload complete: ${id}`);
  })
  .catch(err => {
    console.error(err);
    // Don't exit
  });
