import * as AWS from "aws-sdk";
import {getFilePartDetails} from "./getFilePartDetails";

export interface UploadPartArguments {
  service: AWS.Glacier;
  uploadId: string;
  vaultName: string;
  path: string;
  fileSize: number;
  part: number;
  partSize: number;
}

export interface UploadPartResponse {
  part: number;
  treeHash: Buffer;
}

export const uploadPart = async ({service, uploadId, vaultName, path, fileSize, part, partSize}: UploadPartArguments): Promise<UploadPartResponse> => {
  const start = part * partSize;
  const end = Math.min(fileSize - 1, (part + 1) * partSize - 1);

  const {contents, treeHash: localTreeHash} = await getFilePartDetails(path, start, end);

  const res = await service.uploadMultipartPart({
    accountId: "-",
    body: contents,
    checksum: localTreeHash.toString("hex"),
    range: `bytes ${start}-${end}/*`,
    uploadId: uploadId,
    vaultName: vaultName,
  }).promise();

  const serverSentTreeHash = Buffer.from(res.checksum!, "hex");

  if (!localTreeHash.equals(serverSentTreeHash)) {
    throw new Error(`UploadMultipartPart API response tree hash does not match locally computed`);
  }

  return {
    part: part,
    treeHash: serverSentTreeHash,
  };
};
