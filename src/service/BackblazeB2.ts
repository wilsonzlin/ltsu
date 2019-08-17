import {Part, PartStreamFactory, Service} from "./Service";
import {http, HTTPBadStatusError} from "../util/http";
import {CLIArgs} from "../CLI";
import {sha1File} from "../util/sha1File";

class AuthenticatedAPI {
  private readonly accountId: string;
  private readonly applicationKey: string;
  // Promises returned are resolved/rejected at once.
  private renewSync: { resolve: () => void, reject: (e: Error) => void }[] = [];

  constructor (accountId: string, applicationKey: string) {
    this.accountId = accountId;
    this.applicationKey = applicationKey;
  }

  // It's possible for these values to change due to authentication expiry and renewal.
  private _authToken: string = "";

  // Ensure that multiple calls to renew() only causes one request and all

  get authToken (): string {
    return this._authToken;
  }

  private _url: string = "";

  get url (): string {
    return this._url;
  }

  private _recommendedPartSize: number = -1;

  get recommendedPartSize (): number {
    return this._recommendedPartSize;
  }

  renew (): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this.renewSync.push({resolve, reject}) > 1) {
        return;
      }

      const basicAuth = Buffer.from(`${this.accountId}:${this.applicationKey}`).toString(`base64`);
      http({
        method: `GET`,
        url: `https://api.backblazeb2.com/b2api/v1/b2_authorize_account`,
        headers: {
          Accept: `application/json`,
          Authorization: `Basic ${basicAuth}`,
        },
      })
        .then(res => {
          this._authToken = res.authorizationToken;
          this._url = res.url;
          this._recommendedPartSize = res.recommendedPartSize;
          for (const {resolve} of this.renewSync) {
            resolve();
          }
        }, err => {
          for (const {reject} of this.renewSync) {
            reject(err);
          }
        })
        .then(() => {
          this.renewSync = [];
        });
    });
  }
}

export interface BackblazeB2Options {
  accountId: string;
  applicationKey: string;
  bucketId: string;
}

export const parseBackblazeB2Options = (args: CLIArgs): BackblazeB2Options => {
  const accountId = args.account.toString();
  const applicationKey = args.key.toString();
  const bucketId = args.bucket.toString();

  return {
    accountId, applicationKey, bucketId,
  };
};

export interface BackblazeB2State {
  readonly api: AuthenticatedAPI;
  readonly bucketId: string;
}

const getUploadPartUrl = async (apiUrl: string, authToken: string, uploadId: string): Promise<string> => {
  const res = await http({
    method: `POST`,
    url: `${apiUrl}/b2api/v1/b2_get_upload_part_url`,
    headers: {
      Accept: `application/json`,
      Authorization: authToken,
      "Content-Type": `application/json`,
    },
    body: {
      fileId: uploadId,
    },
  });
  return res.uploadUrl;
};

export const BackblazeB2: Service<BackblazeB2Options, BackblazeB2State> = {
  minParts: 2,
  maxParts: 10000,
  minPartSize: 1024 * 1024 * 5, // 5 MiB.
  maxPartSize: 1024 * 1024 * 1024 * 5, // 5 GiB.

  async fromOptions (options: BackblazeB2Options) {
    const api = new AuthenticatedAPI(options.accountId, options.applicationKey);
    await api.renew();
    return {
      api,
      bucketId: options.bucketId,
    };
  },

  async completeUpload (s: BackblazeB2State, uploadId: string, _: number, partHashes: Buffer[]): Promise<void> {
    return http({
      method: `POST`,
      url: `${s.api.url}/b2api/v1/b2_finish_large_file`,
      headers: {
        Accept: `application/json`,
        Authorization: s.api.authToken,
        "Content-Type": `application/json`,
      },
      body: {
        fileId: uploadId,
        partSha1Array: partHashes.map(h => h.toString("hex")),
      },
    });
  },

  async idealPartSize (s: BackblazeB2State, fileSize: number): Promise<number> {
    // Use recommended part size provided by server if it is able to split the file into a valid amount of parts.
    if (Math.ceil(fileSize / s.api.recommendedPartSize) <= this.maxParts) {
      return s.api.recommendedPartSize;
    }
    return Math.ceil(fileSize / this.maxParts);
  },

  async initiateNewUpload (s: BackblazeB2State, fileName: string, _: number): Promise<string> {
    const res = await http({
      method: `POST`,
      url: `${s.api.url}/b2api/v1/b2_start_large_file`,
      headers: {
        Accept: `application/json`,
        Authorization: s.api.authToken,
        "Content-Type": `application/json`,
      },
      body: {
        fileName,
        bucketId: s.bucketId,
        contentType: `application/octet-stream`,
      },
    });
    return res.fileId;
  },

  async uploadPart (s: BackblazeB2State, uploadId: string, psf: PartStreamFactory, {number, start, end}: Part): Promise<Buffer> {
    let uploadUrl: string;
    try {
      uploadUrl = await getUploadPartUrl(s.api.url, s.api.authToken, uploadId);
    } catch (err) {
      if (err instanceof HTTPBadStatusError && err.statusCode === 401) {
        // Failed to get upload URL due to authorisation, reauthorise.
        await s.api.renew();
      }
      // Still fail, even if had to renew and was successful.
      throw err;
    }

    const hash = await sha1File(psf());
    const contents = psf();
    await http({
      method: `POST`,
      url: uploadUrl,
      headers: {
        Accept: `application/json`,
        Authorization: s.api.authToken,
        "X-Bz-Part-Number": number + 1,
        "Content-Length": end - start + 1,
        "X-Bz-Content-Sha1": hash.toString("hex"),
      },
      body: contents,
    });

    return hash;
  }
};
