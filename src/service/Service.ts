import fs from "fs";

export interface PartStreamFactory {
  (highWaterMark?: number): fs.ReadStream;
}

export interface Part {
  number: number;
  start: number;
  end: number;
}

export interface Service<O, S> {
  readonly minParts: number;
  readonly maxParts: number;
  readonly minPartSize: number;
  readonly maxPartSize: number;

  fromOptions (options: O): Promise<S>;

  idealPartSize (s: S, fileSize: number): Promise<number>;

  initiateNewUpload (s: S, fileName: string, partSize: number): Promise<string>;

  uploadPart (s: S, uploadId: string, psf: PartStreamFactory, details: Part): Promise<Buffer>;

  completeUpload (s: S, uploadId: string, fileSize: number, partHashes: Buffer[]): Promise<void>;
}
