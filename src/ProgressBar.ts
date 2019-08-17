import tty from "tty";
import * as os from "os";

const FILL_CHAR = "=";
const VOID_CHAR = " ";
const BAR_FORMAT_SPECIFIER = ":bar";

export interface ProgressBarTokens {
  percent: number;

  [name: string]: string | number;
}

const tokensEqual = (a: ProgressBarTokens, b: ProgressBarTokens) => {
  const keysA = Object.keys(a);
  const keysB = Object.keys(b);
  return keysA.length == keysB.length &&
    keysA.every(k => b[k] === a[k]);
};

const tokenFormat = (v: string | number): string => {
  if (typeof v == "string") {
    return v;
  }
  let str = v.toFixed(2);
  let dotPos = str.lastIndexOf(".");
  if (dotPos != -1) {
    str = str.replace(/0+$/, "");
  }
  if (dotPos == str.length - 1) {
    str = str.slice(0, -1);
  }
  return str;
};

export class ProgressBar {
  private readonly formatParts: string[];
  private readonly maxWidth: number;
  private readonly stream: tty.WriteStream;
  private tokens: ProgressBarTokens;

  constructor (format: string, maxWidth: number = Infinity) {
    this.formatParts = format.split(BAR_FORMAT_SPECIFIER);
    this.maxWidth = maxWidth;
    this.stream = process.stderr as tty.WriteStream;
    this.tokens = {percent: 0};

    this.stream.on("resize", () => {
      this.update(this.tokens, true);
    });
  }

  private cursorTo (x: number) {
    (this.stream.cursorTo as any)(x);
  }

  private clearLine (dir?: tty.Direction) {
    this.stream.clearLine(dir!);
  }

  update (tokens: ProgressBarTokens, force: boolean = false) {
    if (!force && tokensEqual(tokens, this.tokens)) {
      return;
    }
    this.tokens = tokens;

    const percent = Math.min(100, Math.max(0, this.tokens.percent));
    const [left, right] = this.formatParts.map(unfmtPart => Object.entries(tokens)
      .reduce(
        (fmtPart, [specifier, value]) => fmtPart.replace(`:${specifier}`, tokenFormat(value)),
        unfmtPart
      ));
    const combinedLength = left.length + right.length;
    const availableSpace = this.stream.columns! - combinedLength - ((process.platform == "win32") as any);

    const width = Math.max(0, Math.min(this.maxWidth, availableSpace));

    const filledAmount = Math.floor(width * (percent / 100));
    const filledBlock = FILL_CHAR.repeat(filledAmount);
    const voidBlock = VOID_CHAR.repeat(width - filledAmount);

    const line = [left, filledBlock, voidBlock, right].join("");

    this.cursorTo(0);
    this.stream.write(line);
    this.clearLine(1);
  };

  log (message: any) {
    this.clear();
    this.stream.write(message);
    this.stream.write(os.EOL);
    this.update(this.tokens, true);
  };

  clear () {
    this.clearLine();
    this.cursorTo(0);
  }
}
