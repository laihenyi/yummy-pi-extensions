import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerPiZvecGrep } from "./extension.js";

export default function piZvecGrep(pi: ExtensionAPI): void {
  registerPiZvecGrep(pi);
}

export { registerPiZvecGrep } from "./extension.js";
