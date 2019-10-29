export class AssertionError extends Error {
  constructor (details: string) {
    super(`This should not happen: ${details}`);
  }
}

export class UnreachableError extends AssertionError {
  constructor (val: any) {
    // Use String as other ways of converting Symbols may throw an exception.
    super(String(val));
  }
}

export const assertExists = <T> (val: T | null | undefined): T => {
  if (val == null) {
    throw new AssertionError(`Unexpected null or undefined`);
  }
  return val;
};

export const assertTrue = (b: boolean): void => {
  if (!b) {
    throw new AssertionError(`Unexpected false`);
  }
};
