"use strict";

const fs = require(`fs`);
const crypto = require(`crypto`);
const Path = require(`path`);
const request = require(`request`);
const minimist = require(`minimist`);

const args = minimist(process.argv.slice(2));

const ACCOUNT_ID = args.account;
const APPLICATION_KEY = args.key;

const FILE_PATH = args.file;

const BUCKET_ID = args.bucket;
const WORK_DIR = args.workdir;

if (!fs.existsSync(FILE_PATH)) {
  throw new Error(`${FILE_PATH} does not exist`);
}

if (!fs.existsSync(WORK_DIR) || !fs.lstatSync(WORK_DIR).isDirectory()) {
  throw new Error(`${WORK_DIR} is not a directory`);
}

const PART_SIZE = 1024 * 1024 * 256;
const CONCURRENT_UPLOADS = 10;
const MAX_RETRIES_PER_PART = 5;

let uploadId;
let apiUrl;
let authToken;
let uploadQueue = [];
let currentUploads = 0;
let partsNeeded;
let fileSize;

class HTTPBadStatusError extends Error {
  constructor (status, body, url) {
    super(`${url} returned bad HTTP status of ${status}: ${body}`);
    this.statusCode = status;
  }
}

function lstat (file) {
  return new Promise((resolve, reject) => {
    fs.lstat(file, (err, stats) => {
      if (err) {
        reject(err);
      } else {
        resolve(stats);
      }
    });
  });
}

function writeFile (file, data) {
  return new Promise((resolve, reject) => {
    fs.writeFile(file, data, err => {
      if (err) {
        reject(err);
      } else {
        resolve();
      }
    });
  });
}

function nullableReadBinaryFile (file) {
  return new Promise((resolve, reject) => {
    fs.readFile(file, (err, buffer) => {
      if (err && err.code === "ENOENT") {
        resolve(null);
      } else if (err) {
        reject(err);
      } else {
        resolve(buffer);
      }
    });
  });
}

function http ({method, url, headers, body}) {
  return new Promise((resolve, reject) => {
    request({
      url: url,
      method: method,
      headers: headers,
      body: body,
      timeout: 120000, // 2 minutes
    }, (err, res, body) => {
      if (err) {
        reject(err);
      } else if (res.statusCode < 200 || res.statusCode > 299) {
        reject(new HTTPBadStatusError(res.statusCode, res.body, url));
      } else {
        resolve(res);
      }
    });
  });
}

function renewApiAuth () {
  return new Promise((resolve, reject) => {
    console.log(`Requesting API authorisation...`);
    let basicAuth = Buffer.from(`${ACCOUNT_ID}:${APPLICATION_KEY}`).toString(`base64`);
    http({
      method: `GET`,
      url: `https://api.backblazeb2.com/b2api/v1/b2_authorize_account`,
      headers: {
        Accept: `application/json`,
        Authorization: `Basic ${basicAuth}`,
      },
    })
      .then(res => {
        let data = JSON.parse(res.body);
        authToken = data.authorizationToken;
        apiUrl = data.apiUrl;
        resolve();
      })
      .catch(err => {
        console.error(`Failed to renew authorisation`);
        reject(err);
      });
  });
}

function initMultipartUpload () {
  return new Promise((resolve, reject) => {
    let pathToUploadId = `${WORK_DIR}/mpupload.id`;

    nullableReadBinaryFile(pathToUploadId)
      .then(savedId => {
        if (savedId !== null) {
          console.log(`Found existing multipart upload`);
          uploadId = savedId.toString("ascii");
          resolve();
        } else {
          console.log(`Starting new multipart upload...`);
          http({
            method: `POST`,
            url: `${apiUrl}/b2api/v1/b2_start_large_file`,
            headers: {
              Accept: `application/json`,
              Authorization: authToken,
              "Content-Type": `application/json`,
            },
            body: JSON.stringify({
              fileName: Path.basename(FILE_PATH),
              bucketId: BUCKET_ID,
              contentType: `application/octet-stream`,
            }),
          })
            .then(res => {
              let data = JSON.parse(res.body);
              uploadId = data.fileId;
              return writeFile(pathToUploadId, uploadId);
            })
            .then(() => {
              resolve();
            })
            .catch(reject);
        }
      })
      .catch(reject);
  });
}

function calculateSHA1HashOfFile (path, start, end) {
  return new Promise((resolve, reject) => {
    let hash = crypto.createHash(`sha1`);
    let stream = fs.createReadStream(path, {start, end});

    stream.on("error", err => reject(err));
    stream.on("data", chunk => hash.update(chunk));
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}

function _uploadPart ({partNo, resolve, reject}) {
  let checksum;
  let start = partNo * PART_SIZE;
  let end = Math.min(fileSize - 1, (partNo + 1) * PART_SIZE - 1);

  function getUploadPartUrl () {
    return http({
      method: `POST`,
      url: `${apiUrl}/b2api/v1/b2_get_upload_part_url`,
      headers: {
        Accept: `application/json`,
        Authorization: authToken,
        "Content-Type": `application/json`,
      },
      body: JSON.stringify({
        fileId: uploadId,
      }),
    });
  }

  console.log(`Calculating hash for part ${partNo}...`);

  calculateSHA1HashOfFile(FILE_PATH, start, end)
    .then(sha1hashhex => {
      checksum = sha1hashhex;

      console.log(`Initialising part upload ${partNo}...`);

      return getUploadPartUrl();
    })
    .catch(err => {
      if (err instanceof HTTPBadStatusError && err.statusCode === 401) {
        return new Promise((resolve, reject) => {
          console.log(`Failed to get upload URL due to authorisation, re-authorising...`);
          renewApiAuth()
            .then(() => {
              return getUploadPartUrl();
            })
            .then(resolve)
            .catch(reject);
        });
      } else {
        return Promise.reject(err);
      }
    })
    .then(res => {
      let data = JSON.parse(res.body);

      console.log(`Uploading part ${partNo}...`);

      return http({
        method: `POST`,
        url: data.uploadUrl,
        headers: {
          Accept: `application/json`,
          Authorization: data.authorizationToken,
          "X-Bz-Part-Number": partNo + 1,
          "Content-Length": end - start + 1,
          "X-Bz-Content-Sha1": checksum,
        },
        body: fs.createReadStream(FILE_PATH, {
          start: start,
          end: end,
        }),
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

function uploadPart (partNo) {
  return new Promise((resolve, reject) => {
    if (currentUploads < CONCURRENT_UPLOADS) {
      currentUploads++;
      _uploadPart({partNo, resolve, reject});
    } else {
      uploadQueue.push({
        partNo, resolve, reject,
      });
    }
  });
}

function completeMultipartUpload (checksums) {
  return new Promise((resolve, reject) => {
    function finishLargeFile () {
      return http({
        method: `POST`,
        url: `${apiUrl}/b2api/v1/b2_finish_large_file`,
        headers: {
          Accept: `application/json`,
          Authorization: authToken,
          "Content-Type": `application/json`,
        },
        body: JSON.stringify({
          fileId: uploadId,
          partSha1Array: checksums,
        }),
      });
    }

    console.log(`Completing multipart upload...`);

    finishLargeFile()
      .catch(err => {
        if (err instanceof HTTPBadStatusError && err.statusCode === 401) {
          return new Promise((resolve, reject) => {
            console.log(`Failed to finish large upload due to authorisation, re-authorising...`);
            renewApiAuth()
              .then(() => {
                return finishLargeFile();
              })
              .then(resolve)
              .catch(reject);
          });
        } else {
          return Promise.reject(err);
        }
      })
      .then(res => {
        let data = JSON.parse(res.body);
        resolve(data.fileId);
      })
      .catch(reject);
  });
}

renewApiAuth()
  .then(() => initMultipartUpload())
  .then(() => lstat(FILE_PATH))
  .then(fileInfo => {
    if (!fileInfo.isFile()) {
      return Promise.reject(new Error(`Invalid file path`));
    }

    fileSize = fileInfo.size;
    partsNeeded = Math.ceil(fileSize / PART_SIZE);

    if (partsNeeded < 3 || partsNeeded > 10000) {
      return Promise.reject(new Error(`File too small or too large`));
    }

    return Promise.all(new Array(partsNeeded).fill()
      .map((_, partNo) => nullableReadBinaryFile(`${WORK_DIR}/${partNo}.sha1`)));
  })
  .then(savedHashes => {
    return new Promise((resolve, reject) => {
      let hashes = [];
      let attempts = {};
      let uploadedCount = 0;

      function isComplete () {
        if (uploadedCount === partsNeeded) {
          resolve(hashes);
        }
      }

      function upload (partNo) {
        attempts[partNo] = (attempts[partNo] || 0) + 1;
        uploadPart(partNo)
          .then(checksum => {
            hashes[partNo] = checksum;
            uploadedCount++;
            return writeFile(`${WORK_DIR}/${partNo}.sha1`, checksum);
          })
          .then(() => {
            console.log(`Uploaded part ${partNo} of ${partsNeeded} (${Math.round(partNo / partsNeeded * 10000) /
                                                                      100}%)`);
            isComplete();
          })
          .catch(err => {
            console.error(`Failed to upload ${partNo}, attempt ${attempts[partNo]} of ${MAX_RETRIES_PER_PART}:`);
            console.error(err);

            // Don't exit, retry
            if (attempts[partNo] < MAX_RETRIES_PER_PART) {
              upload(partNo);
            } else {
              reject(new Error(`Failed all ${MAX_RETRIES_PER_PART} attempts to upload ${partNo}`));
            }
          });
      }

      savedHashes.forEach((hash, partNo) => {
        if (hash === null) {
          upload(partNo);
        } else {
          // console.log(`Part ${ partNo } has already been uploaded`);
          hashes[partNo] = hash.toString("ascii");
          uploadedCount++;
        }
      });

      isComplete();
    });
  })
  .then(hashes => {
    return completeMultipartUpload(hashes);
  })
  .then(id => {
    console.log(`Upload complete: ${id}`);
  })
  .catch(err => {
    console.log(`An error occurred:`);
    console.error(err);
    // Don't exit
  });
