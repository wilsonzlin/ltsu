import {Context} from "../Context";

export interface Session {
  uploadId: string;
  // TODO
  // filePath: string;
  // fileSize: number;
  // fileLastChanged: number;
  // partSize: number;
}

export const maybeLoadExistingUploadId = async (ctx: Context): Promise<string | null> => {
  const res = await ctx.resumeSession();
  if (res == null) {
    return null;
  }
  return res.uploadId;
};

export const saveUploadIdToSession = async (ctx: Context, uploadId: string): Promise<void> => {
  await ctx.writeSession({uploadId});
};
