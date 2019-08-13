import * as AWS from "aws-sdk";
import {promises as fs} from "fs";

const Glacier = new AWS.Glacier();

export interface IFilePart {
  contents: Buffer,
  treeHash: Buffer;
}

export const getFilePartDetails = async (path: string, start: number, end: number): Promise<IFilePart> => {
  const fd = await fs.open(path, "r");

  const size = end - start + 1;
  const contents = Buffer.allocUnsafe(size);

  await fd.read(contents, 0, size, start);
  await fd.close();

  const checksums = Glacier.computeChecksums(contents);

  return {
    contents: contents,
    treeHash: Buffer.from(checksums.treeHash, "hex"),
  };
};
