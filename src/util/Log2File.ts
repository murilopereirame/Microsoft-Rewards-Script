import fs from "fs";
import { loadConfig } from "./Load";

export async function Log2File(content: string) {
  const logFile = loadConfig().logFile;
  if (!logFile) return;

  fs.appendFile(logFile, `${content}\n`, { flag: "a+" }, () => null);
}
