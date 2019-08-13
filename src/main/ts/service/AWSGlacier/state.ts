import {Context} from "../../Context";

const treeHashStateKey = (part: number): string => {
  return `${part}.treehash`;
};

export const loadPartTreeHash = async (ctx: Context, part: number): Promise<Buffer | null> => {
  return await ctx.readState(treeHashStateKey(part));
};

export const savePartTreeHash = async (ctx: Context, part: number, hash: Buffer): Promise<void> => {
  await ctx.writeState(treeHashStateKey(part), hash);
};
