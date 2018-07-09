# ltsu

Long Term Storage Uploader.

Node.js scripts for uploading very large single files to "cold" long-term cloud storage services, for archival/backup purposes.

Currently supports AWS Glacier and Backblaze B2.

## Features

- Handles server-side errors gracefully.
- Uploads in parts simultaneously to balance performance, rate limits, and severity of errors.
- Saves state during upload to support resuming and out-of-order uploading, even after crashes or state corruption.
- Automatic retries and backoffs.

## Status

Worked reliably when tested with 370 GB file uploaded over several days continuously.

API is not as friendly as it should be; it's a little raw currently. Works perfectly fine though.

Only tested on Ubuntu, but should work cross-platform.

## Setup

1. Install Node.js if not installed already.
1. Clone/download this repo.
1. Open a terminal/command prompt and change into the directory.
1. `npm install` to install dependencies.

## Usage

### AWS Glacier

```bash
node glacier/glacier.js \
  --region 'the-region-1' \
  --id 'ACCESSKEYID' \
  --secret 'secretaccesskey' \
  --file 'path/to/file/to/upload' \
  --vault 'glacier-vault-name' \
  --workdir 'dir/to/store/state'
```

### Backblaze B2

```bash
node b2/b2.js \
  --account 'ACCOUNTID' \
  --key 'APP_KEY' \
  --file 'path/to/file/to/upload' \
  --bucket 'bucket-id' \
  --workdir 'dir/to/store/state'
```
