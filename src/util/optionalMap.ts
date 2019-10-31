export const optionalMap = <I, O> (val: I | undefined, mapper: (v: I) => O): O | undefined => {
  return val == undefined ? undefined : mapper(val);
};
