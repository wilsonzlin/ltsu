import leftPad from "./leftPad";

export default function getISOTime(): string {
  let d = new Date();
  return [
    leftPad(d.getUTCFullYear(), 4),
    leftPad(d.getUTCMonth() + 1, 2),
    leftPad(d.getUTCDate(), 2),
    `T`,
    leftPad(d.getUTCHours(), 2),
    leftPad(d.getUTCMinutes(), 2),
    leftPad(d.getUTCSeconds(), 2),
    `Z`
  ].join("");
}
