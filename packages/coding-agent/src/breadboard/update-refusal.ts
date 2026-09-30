/**
 * Refusal for "bb update" in BreadBoard product mode.
 * 1.0 is Kyle's local source-built daily driver with no public release channel.
 */
import { resolveCliArgv } from "../cli-commands";
import { extractProfileFlags } from "../cli/profile-bootstrap";

export class BreadboardUpdateRefusalError extends Error {
	readonly exitCode = 2;

	constructor(message = formatUpdateRefusal()) {
		super(message);
		this.name = "BreadboardUpdateRefusalError";
	}
}

export function formatUpdateRefusal(): string {
	return `bb: "bb update" is disabled because BreadBoard 1.0 has no public release channel. Build the release from the checkout with scripts/build-product-release.ts and install it with:
  bun scripts/install-product-release.ts install <archive.tar.gz> <destination> [--allow-unsigned-development] [--expected-archive-sha256 <sha256:...>]
or:
  bun scripts/install-product-release.ts update <archive.tar.gz> <destination> [--allow-downgrade] [--allow-unsigned-development] [--expected-archive-sha256 <sha256:...>]`;
}

export function isUpdateCommand(argv: readonly string[]): boolean {
	const { argv: profileCleaned } = extractProfileFlags([...argv]);
	const resolved = resolveCliArgv(profileCleaned);
	const targetArgv = "argv" in resolved ? resolved.argv : profileCleaned;
	return targetArgv[0] === "update";
}
