// What encoding to use when saving/loading the upload ID to/from a session.
import {Context} from "../../Context";

const UPLOAD_ID_SESSION_ENCODING = "ascii";

export const maybeLoadExistingUploadId = async (ctx: Context): Promise<string | null> => {
  const res = await ctx.resumeSession();
  if (res == null) {
    return null;
  }
  return res.toString(UPLOAD_ID_SESSION_ENCODING);
};

export const saveUploadIdToSession = async (ctx: Context, uploadId: string): Promise<void> => {
  await ctx.writeSession(Buffer.from(uploadId, "ascii"));
};
