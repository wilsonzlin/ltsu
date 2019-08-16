import {Context} from "../Context";

const partHashStateKey = (part: number): string => {
  return `${part}.parthash`;
};

export const loadPartHash = async (ctx: Context, part: number): Promise<Buffer | null> => {
  return await ctx.readState(partHashStateKey(part));
};

export const savePartHash = async (ctx: Context, part: number, hash: Buffer): Promise<void> => {
  await ctx.writeState(partHashStateKey(part), hash);
};
