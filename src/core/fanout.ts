import type { TierName } from "./config.js";

export interface FanOutResult {
  item: string;
  output: string;
}

export interface FanOutParams {
  template: string;
  items: string[];
  tier?: TierName;
  invoke: (prompt: string, item: string, index: number) => Promise<string>;
}

export async function runFanOut(params: FanOutParams): Promise<FanOutResult[]> {
  if (params.items.length > 20) {
    throw new Error("fan_out accepts at most 20 items");
  }
  if (!params.template.includes("{item}")) {
    throw new Error("fan_out template must contain the literal placeholder {item}");
  }
  return Promise.all(
    params.items.map(async (item, index) => ({
      item,
      output: await params.invoke(params.template.split("{item}").join(item), item, index),
    })),
  );
}
