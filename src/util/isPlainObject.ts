export const isPlainObject = (o: any): o is Object => {
  if (o == null) {
    return false;
  }
  const proto = Object.getPrototypeOf(o);
  return proto == Object.prototype || proto == null;
};
