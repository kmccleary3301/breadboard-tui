import { afterEach, describe, expect, it, vi } from "bun:test";
import {
	getLatestBreadboardRelease,
	getLatestRelease,
	parseReportedVersion,
	resolveLatestBreadboardRelease,
	resolveReleaseBinaryAsset,
	runUpdateCommand,
} from "../../src/cli/update-cli";

type FetchInput = string | URL | Request;
type FetchInit = RequestInit | BunFetchRequestInit;

const PRODUCT_REPOSITORY = "kmccleary3301/breadboard-tui";
const PRODUCT_TAG = "product/breadboard-tui-v0.1.0-rc.3-canonical";

describe("BreadBoard product releases", () => {
	it("selects only the highest published canonical product release", () => {
		const release = resolveLatestBreadboardRelease([
			{ tag_name: "v18.0.1", draft: false, prerelease: false },
			{ tag_name: "product/breadboard-tui-v0.1.0-rc.2-canonical", draft: false, prerelease: true },
			{ tag_name: PRODUCT_TAG, draft: false, prerelease: true },
			{ tag_name: "product/breadboard-tui-v9.0.0-canonical", draft: true, prerelease: false },
			{ tag_name: "product/breadboard-tui-vnot-semver-canonical", draft: false, prerelease: false },
		]);

		expect(release).toEqual({
			tag: PRODUCT_TAG,
			version: "0.1.0-rc.3",
			dist: "binary",
			packages: { pkg: "@oh-my-pi/pi-coding-agent", natives: "@oh-my-pi/pi-natives" },
			repository: PRODUCT_REPOSITORY,
			prerelease: true,
		});
	});

	it("fetches the product repository rather than npm or upstream OMP", async () => {
		const urls: string[] = [];
		const release = await getLatestBreadboardRelease({
			fetchImpl: async input => {
				urls.push(String(input));
				return Response.json([{ tag_name: PRODUCT_TAG, draft: false, prerelease: true }]);
			},
		});

		expect(release.version).toBe("0.1.0-rc.3");
		expect(urls).toEqual([`https://api.github.com/repos/${PRODUCT_REPOSITORY}/releases?per_page=100`]);
	});

	it("validates the exact product prerelease asset and repository", () => {
		const binaryName = "bb-darwin-arm64";
		const url = `https://github.com/${PRODUCT_REPOSITORY}/releases/download/${PRODUCT_TAG}/${binaryName}`;
		const asset = resolveReleaseBinaryAsset(
			{
				tag_name: PRODUCT_TAG,
				draft: false,
				prerelease: true,
				assets: [
					{
						name: binaryName,
						state: "uploaded",
						size: 123,
						digest: `sha256:${"ab".repeat(32)}`,
						browser_download_url: url,
					},
				],
			},
			PRODUCT_TAG,
			binaryName,
			{ repository: PRODUCT_REPOSITORY, prerelease: true },
		);

		expect(asset).toEqual({ url, size: 123, digest: `sha256:${"ab".repeat(32)}` });
	});

	it("parses the exact active product token including prerelease suffixes", () => {
		expect(parseReportedVersion("bb/0.1.0-rc.3 omp/18.0.1 sdk/0.4.0", "bb")).toBe("0.1.0-rc.3");
		expect(parseReportedVersion("omp/18.0.1", "omp")).toBe("18.0.1");
		expect(parseReportedVersion("omp/18.0.1", "bb")).toBeUndefined();
	});
});

describe("runUpdateCommand fetch cancellation", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("checks release metadata with a timeout signal", async () => {
		let requestSignal: AbortSignal | undefined;
		vi.spyOn(console, "log").mockImplementation(() => {});
		const fetchStub = Object.assign(
			async (_input: FetchInput, init?: FetchInit) => {
				requestSignal = init?.signal ?? undefined;
				return Response.json({ version: "999.0.0" });
			},
			{ preconnect: globalThis.fetch.preconnect },
		);
		vi.spyOn(globalThis, "fetch").mockImplementation(fetchStub);

		await runUpdateCommand({ force: false, check: true });

		expect(requestSignal).toBeInstanceOf(AbortSignal);
	});
});

describe("getLatestRelease rename pointers", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	function stubRegistry(manifests: Record<string, unknown>): string[] {
		const urls: string[] = [];
		const fetchStub = Object.assign(
			async (input: FetchInput) => {
				const url = String(input);
				urls.push(url);
				let manifest: unknown;
				for (const pkg in manifests) {
					if (url.includes(pkg)) {
						manifest = manifests[pkg];
						break;
					}
				}
				if (!manifest) return new Response(null, { status: 404, statusText: "Not Found" });
				return Response.json(manifest);
			},
			{ preconnect: globalThis.fetch.preconnect },
		);
		vi.spyOn(globalThis, "fetch").mockImplementation(fetchStub);
		return urls;
	}

	it("follows omp.rename to the new package and resolves version, dist, and names from its manifest", async () => {
		const urls = stubRegistry({
			"@new/omp": { version: "999.1.0", omp: { dist: "npm" } },
			"@oh-my-pi/pi-coding-agent": {
				version: "999.0.0",
				omp: { dist: "binary", rename: { package: "@new/omp", natives: "@new/natives" } },
			},
		});

		const release = await getLatestRelease();

		expect(release.version).toBe("999.1.0");
		expect(release.dist).toBe("npm");
		expect(release.packages).toEqual({ pkg: "@new/omp", natives: "@new/natives" });
		expect(urls).toEqual([
			"https://registry.npmjs.org/@oh-my-pi/pi-coding-agent/latest",
			"https://registry.npmjs.org/@new/omp/latest",
		]);
	});

	it("ignores a rename pointer that cycles back to an already-visited package", async () => {
		const urls = stubRegistry({
			"@oh-my-pi/pi-coding-agent": {
				version: "999.0.0",
				omp: { rename: { package: "@oh-my-pi/pi-coding-agent" } },
			},
		});

		const release = await getLatestRelease();

		expect(urls).toHaveLength(1);
		expect(release.version).toBe("999.0.0");
		expect(release.packages).toEqual({ pkg: "@oh-my-pi/pi-coding-agent", natives: "@oh-my-pi/pi-natives" });
	});
});

describe("getLatestRelease proxy errors", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("translates Bun's UnsupportedProxyProtocol fetch failure into an actionable CLI message", async () => {
		const fetchStub = Object.assign(
			async () => {
				throw new Error(
					'UnsupportedProxyProtocol fetching "https://registry.npmjs.org/@oh-my-pi/pi-coding-agent/latest". ' +
						"For more information, pass `verbose: true` in the second argument to fetch()",
				);
			},
			{ preconnect: globalThis.fetch.preconnect },
		);
		vi.spyOn(globalThis, "fetch").mockImplementation(fetchStub);

		const err = await getLatestRelease({ timeoutMs: 5000 }).then(
			() => null,
			(e: unknown) => e as Error,
		);

		expect(err).toBeInstanceOf(Error);
		// The raw fetch() instruction the CLI user cannot act on must not leak through.
		expect(err?.message).not.toContain("verbose: true");
		expect(err?.message).not.toContain("fetch()");
		// Instead the user gets actionable guidance about supported proxy schemes.
		expect(err?.message).toMatch(/SOCKS/i);
		expect(err?.message).toMatch(/https?:\/\//i);
	});
});
