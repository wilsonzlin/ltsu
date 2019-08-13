# ltsu

Long Term Storage Uploader.

Node.js scripts for uploading very large single files to "cold" long-term cloud storage services, for archival/backup purposes.

Currently supports AWS Glacier and Backblaze B2.

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
npx ltsu --file file --work work [...]
```

## Usage

### AWS Glacier

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
