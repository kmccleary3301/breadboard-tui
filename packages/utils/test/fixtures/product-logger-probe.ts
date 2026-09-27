import * as fs from "node:fs";
import { getLogPath } from "../../src/dirs";
import * as logger from "../../src/logger";

const resultPath = process.argv[2];
if (!resultPath) throw new Error("expected a result path");

logger.info("mode-product", { product: "active" });
fs.writeFileSync(resultPath, JSON.stringify({ advertisedPath: getLogPath() }));
logger.setTransports({ console: false, file: false });
