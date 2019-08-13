import {Context} from "../Context";

export type Service<O> = (ctx: Context, opt: O) => Promise<void>;
