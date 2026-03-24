import { describe, expect, it } from "vitest";
import { configSchema } from "./schemas.js";

const VALID_PRIVATE_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const TEST_API_KEY = "some_random_api_key";
const SEPOLIA_RPC = "https://sepolia.example.com";
// Checksummed zero address accepted by checkedAddressSchema
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

const BASE_ENV = {
	PRIVATE_KEY: VALID_PRIVATE_KEY,
	SAFE_API_KEY: TEST_API_KEY,
	RPC_URLS: JSON.stringify({ "11155111": SEPOLIA_RPC }),
	CONSENSUS_ADDRESSES: JSON.stringify({ "11155111": [ZERO_ADDRESS] }),
};

describe("configSchema — CHAIN_IDS", () => {
	it("defaults to [11155111] when CHAIN_IDS is absent", () => {
		const result = configSchema.parse(BASE_ENV);
		expect(result.CHAIN_IDS).toEqual([11155111]);
	});

	it("parses a single chain ID string", () => {
		const result = configSchema.parse({ ...BASE_ENV, CHAIN_IDS: "11155111" });
		expect(result.CHAIN_IDS).toEqual([11155111]);
	});

	it("parses multiple comma-separated chain IDs", () => {
		const result = configSchema.parse({
			PRIVATE_KEY: VALID_PRIVATE_KEY,
			SAFE_API_KEY: TEST_API_KEY,
			CHAIN_IDS: "11155111,100",
			RPC_URLS: JSON.stringify({ "11155111": SEPOLIA_RPC, "100": SEPOLIA_RPC }),
			CONSENSUS_ADDRESSES: JSON.stringify({ "11155111": [ZERO_ADDRESS], "100": [ZERO_ADDRESS] }),
		});
		expect(result.CHAIN_IDS).toEqual([11155111, 100]);
	});

	it("trims whitespace around IDs", () => {
		const result = configSchema.parse({ ...BASE_ENV, CHAIN_IDS: " 11155111 " });
		expect(result.CHAIN_IDS).toEqual([11155111]);
	});

	it("rejects an unsupported chain ID", () => {
		expect(() => configSchema.parse({ ...BASE_ENV, CHAIN_IDS: "99999" })).toThrow();
	});
});

describe("configSchema — RPC_URLS / jsonStringToRecord", () => {
	it("parses a valid JSON string", () => {
		const result = configSchema.parse(BASE_ENV);
		expect(result.RPC_URLS).toEqual({ "11155111": SEPOLIA_RPC });
	});

	it("accepts an already-parsed object (non-string pass-through)", () => {
		const result = configSchema.parse({
			...BASE_ENV,
			RPC_URLS: { "11155111": SEPOLIA_RPC },
		});
		expect(result.RPC_URLS).toEqual({ "11155111": SEPOLIA_RPC });
	});

	it("rejects malformed JSON", () => {
		expect(() => configSchema.parse({ ...BASE_ENV, RPC_URLS: "not json" })).toThrow();
	});

	it("rejects non-URL values inside the record", () => {
		expect(() =>
			configSchema.parse({
				...BASE_ENV,
				RPC_URLS: JSON.stringify({ "11155111": "not-a-url" }),
			}),
		).toThrow();
	});
});

describe("configSchema — CONSENSUS_ADDRESSES", () => {
	it("checksums and parses valid addresses from a JSON string", () => {
		// Lowercase address should be accepted and returned as checksummed
		const lowercase = "0x5aaeb6053f3e94c9b9a09f33669435e7ef1beaed";
		const result = configSchema.parse({
			...BASE_ENV,
			CONSENSUS_ADDRESSES: JSON.stringify({ "11155111": [lowercase] }),
		});
		// getAddress() checksums it
		expect(result.CONSENSUS_ADDRESSES["11155111"][0]).toMatch(/^0x/);
	});

	it("accepts multiple addresses per chain", () => {
		const addr1 = "0x5aaeb6053f3e94c9b9a09f33669435e7ef1beaed";
		const addr2 = "0x6b175474e89094c44da98b954eedeac495271d0f";
		const result = configSchema.parse({
			...BASE_ENV,
			CONSENSUS_ADDRESSES: JSON.stringify({ "11155111": [addr1, addr2] }),
		});
		expect(result.CONSENSUS_ADDRESSES["11155111"]).toHaveLength(2);
	});

	it("rejects an empty array of addresses", () => {
		expect(() =>
			configSchema.parse({
				...BASE_ENV,
				CONSENSUS_ADDRESSES: JSON.stringify({ "11155111": [] }),
			}),
		).toThrow();
	});

	it("rejects an invalid address inside the array", () => {
		expect(() =>
			configSchema.parse({
				...BASE_ENV,
				CONSENSUS_ADDRESSES: JSON.stringify({ "11155111": ["not-an-address"] }),
			}),
		).toThrow();
	});
});

describe("configSchema — cross-field validation", () => {
	it("fails when RPC_URLS is missing an entry for a chain in CHAIN_IDS", () => {
		expect(() =>
			configSchema.parse({
				PRIVATE_KEY: VALID_PRIVATE_KEY,
				SAFE_API_KEY: TEST_API_KEY,
				CHAIN_IDS: "11155111,100",
				RPC_URLS: JSON.stringify({ "11155111": SEPOLIA_RPC }), // 100 missing
				CONSENSUS_ADDRESSES: JSON.stringify({ "11155111": [ZERO_ADDRESS], "100": [ZERO_ADDRESS] }),
			}),
		).toThrow(/RPC_URLS missing entry for chain 100/);
	});

	it("fails when CONSENSUS_ADDRESSES is missing an entry for a chain in CHAIN_IDS", () => {
		expect(() =>
			configSchema.parse({
				PRIVATE_KEY: VALID_PRIVATE_KEY,
				SAFE_API_KEY: TEST_API_KEY,
				CHAIN_IDS: "11155111,100",
				RPC_URLS: JSON.stringify({ "11155111": SEPOLIA_RPC, "100": SEPOLIA_RPC }),
				CONSENSUS_ADDRESSES: JSON.stringify({ "11155111": [ZERO_ADDRESS] }), // 100 missing
			}),
		).toThrow(/CONSENSUS_ADDRESSES missing entry for chain 100/);
	});
});
