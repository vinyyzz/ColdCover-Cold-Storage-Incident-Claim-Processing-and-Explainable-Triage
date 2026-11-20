import type { Batch } from "./types";

export function toIstIso(value: string) {
  return new Date(Date.parse(value) + 330 * 60000).toISOString().replace(/\.000Z$/, "+05:30").replace(/Z$/, "+05:30");
}

export function toIstInput(value: string) {
  return toIstIso(value).replace("+05:30", "");
}

export function fromIstInput(value: string) {
  return `${value.length === 16 ? `${value}:00` : value}+05:30`;
}

export function stockPresence(batch: Pick<Batch, "enteredAt" | "exitedAt">, at: string): "present" | "not_entered" | "departed" {
  const time = Date.parse(at);
  if (!Number.isFinite(time)) throw new RangeError("A valid stock lookup timestamp is required.");
  if (Date.parse(batch.enteredAt) > time) return "not_entered";
  if (batch.exitedAt !== null && Date.parse(batch.exitedAt) <= time) return "departed";
  return "present";
}

const inr = new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", minimumFractionDigits: 0, maximumFractionDigits: 2 });
const dates = new Intl.DateTimeFormat("en-IN", { timeZone: "Asia/Kolkata", day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", hour12: true });

export const formatInr = (value: number) => inr.format(value);
export const formatIstDate = (value: string) => dates.format(new Date(value));
