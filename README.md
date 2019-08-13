# ltsu

Long Term Storage Uploader.

CLI for uploading very large single files to "cold" long-term cloud storage services for archival/backup purposes.

Currently supports AWS S3 Glacier and Backblaze B2.

## Features

- Handles server-side errors gracefully and automatically retries.
- Uploads in parts simultaneously to balance performance, rate limits, and significance of errors.
- Saves state during upload to support resuming and out-of-order uploading, even after crashes.

## Status

Worked reliably when tested with 370 GB file uploaded over several days continuously.

Only tested on Ubuntu, but should work cross-platform.

## Setup

To install it as a CLI tool:

```bash
npm i -g ltsu
```

To use it directly without installing:

```bash
npx ltsu --file file --work workdir [...]
```

## Usage

### Common arguments

#### `file`

**Required.**

Path to the file to upload.

#### `work`

**Required.**

Path to the directory that is used to hold state, such as information about resuming uploads.

#### `concurrency`

**Default:** 3.

How many parts to upload at the same time. Too many may cause rate limiting, increased errors, and degraded performance. Too few may result in very slow total upload times.

#### `retries`

**Default:** 5.

How many times to retry uploading a part before failing with an error and aborting the entire process or skipping the part (the process will not complete, but other parts will continue uploading).

#### `service`

**Required: one of** `aws`, `b2`.

Which cloud service to use.

### AWS S3 Glacier

```bash
ltsu \
  --file /path/to/file \
  --work /path/to/working/dir \
  --concurrency 3 \
  --retries 5 \
  --service aws \
  --region AWS_REGION \
  --access AWS_ACCESS_KEY_ID \
  --secret AWS_SECRET_ACCESS_KEY \ 
  --vault MyVaultName
```

If the access ID or secret key is not provided, [environment variables or the shared credentials file](https://docs.aws.amazon.com/sdk-for-javascript/v2/developer-guide/setting-credentials-node.html) will be used. It's possible to choose [which profile](https://docs.aws.amazon.com/sdk-for-javascript/v2/developer-guide/loading-node-credentials-shared.html) in the shared credentials file to use.

The account owning the vault must be the same as the account associated with the credentials.
