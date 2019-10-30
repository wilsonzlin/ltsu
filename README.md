# ltsu

Long Term Storage Uploader.

CLI for uploading very large single files ([up to 40 TB](https://docs.aws.amazon.com/amazonglacier/latest/dev/uploading-archive-mpu.html#qfacts)) to "cold" long-term cloud storage services for archival/backup purposes.

Currently supports AWS S3 Glacier and Backblaze B2.

![Demo run of uploading to AWS S3 Glacier using ltsu](demo.gif)

## Features

<table>
  <tr>
    <td align="center">
      <strong>Smart resilience</strong><br>
      Handles service errors gracefully and automatically retries with exponential backoff.
    </td>
    <td align="center">
      <strong>Efficient transfer</strong><br>
      Uploads in parts simultaneously to balance performance, rate limits, and impact of errors.
    </td>
  </tr>
  <tr>
    <td align="center">
      <strong>Interruption safe</strong><br>
      Saves progress during upload to support resuming and out-of-order uploading.
    </td>
    <td align="center">
      <strong>Memory optimised</strong><br>
      Uses file streams and custom hash tree builder for low memory usage, even for large files.
    </td>
  </tr>
</table>

## Requirements

ltsu is written in TypeScript and requires [Node.js](https://nodejs.org) version 10 or greater, available on Windows, macOS, and Linux.

npm is the default package manager that comes with Node.js and is used to install ltsu or run it on demand using npx.

## Setup

To install it as a CLI tool:

```bash
npm i -g ltsu
```

This creates an executable in the global npm bin folder, so ensure that it's in the `PATH` environment variable. This folder can be found by running `npm bin -g`.

To use it directly without installing:

```bash
npx ltsu --file file --work workdir [...]
```

## Usage

### Common arguments

|Name|Value|Description|
|---|---|---|
|`--file`|**Required**|Path to the file to upload.|
|`--work`|**Required**|Path to the directory that is used to hold state, such as information about resuming uploads.<br>This folder will be filled with many files, so write permissions are required, existing files might be overwritten, and it may get cluttered.<br>It's best to provide an empty directory for the exclusive use of one upload.|
|`--concurrency`|Default: 3|How many parts to upload at the same time. A high value might cause rate limiting, increased errors, and degraded performance. A low value might result in very slow total upload times.|
|`--quiet`|Optional|Hide the progress bar. This option can be used in tandem with `verbose`.|
|`--verbose`|Optional|Log whenever a part has been successfully uploaded. This option can be used in tandem with `quiet`.|
|`--force`|Optional|Always resume existing session, even if file is not the same or has changed since.|
|`--service`|**Required, one of:** `aws`, `b2`|Which cloud service to use.|

### Resuming

To resume an upload, simply run ltsu with the same `--file` and `--work` arguments.

If the file has changed since the last upload session, ltsu will refuse to run. Use `--force` to override this behaviour.

### AWS S3 Glacier

|Name|Description|
|---|---|
|`--region`|Region containing vault.|
|`--access`|Access key ID.|
|`--secret`|Secret access key.|
|`--vault`|Vault name.|

If the access ID or secret key is not provided, [environment variables or the shared credentials file](https://docs.aws.amazon.com/sdk-for-javascript/v2/developer-guide/setting-credentials-node.html) will be used. It's possible to choose which profile in the shared credentials file to use by setting environment variables; see the [documentation](https://docs.aws.amazon.com/sdk-for-javascript/v2/developer-guide/loading-node-credentials-shared.html) for more details.

The account owning the vault must be the same as the account associated with the credentials.

Example:

```bash
ltsu \
  --file /home/user/Archive.img \
  --work /tmp/archive-backup-2019-03-20 \
  --service aws \
  --region us-east-1 \
  --access AKIAIOSFODNN7EXAMPLE \
  --secret  wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY \
  --vault backups
```

### Backblaze B2

An application key is required. Generate one from https://secure.backblaze.com/app_keys.htm. Both master and non-master keys can be used.

A key has two fields of interest: `keyID` and `applicationKey`. These need to be provided to ltsu as arguments.

|Name|Description|
|---|---|
|`--account`|Key ID.|
|`--key`|Application key.|
|`--bucket`|Bucket ID (not name).|

Full command format:

```bash
ltsu \
  --file /path/to/file \
  --work /path/to/working/dir \
  --service b2 \
  --account B2_ACCOUNT_ID \
  --key B2_APPLICATION_KEY \
  --bucket B2_BUCKET_ID
```
