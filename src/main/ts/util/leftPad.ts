export default function leftPad(str: any, width: number, char: string = '0'): string {
  str = "" + str;
  return char.repeat(Math.max(0, width - str.length)) + str;
}
