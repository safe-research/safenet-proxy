import { describe, expect, it } from "vitest";
import { configSchema } from "./schemas.js";

const VALID_PRIVATE_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const TEST_API_KEY = "some_random_api_key";
const SEPOLIA_RPC = "https://sepolia.example.com";
// Checksummed zero address accepted by checkedAddressSchema
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
const RELAYING_SAFE_ENTRY = { safe: ZERO_ADDRESS, multiSend: ZERO_ADDRESS };

const BASE_ENV = {
	PRIVATE_KEY: VALID_PRIVATE_KEY,
	SAFE_API_KEY: TEST_API_KEY,
	RPC_URLS: JSON.stringify({ "11155111": SEPOLIA_RPC }),
	CONSENSUS_CONFIGS: JSON.stringify({ "11155111": [{ address: ZERO_ADDRESS }] }),
	RELAYING_SAFES: JSON.stringify({ "11155111": RELAYING_SAFE_ENTRY }),
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
			CONSENSUS_CONFIGS: JSON.stringify({
				"11155111": [{ address: ZERO_ADDRESS }],
				"100": [{ address: ZERO_ADDRESS }],
			}),
			RELAYING_SAFES: JSON.stringify({ "11155111": RELAYING_SAFE_ENTRY, "100": RELAYING_SAFE_ENTRY }),
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

describe("configSchema — CONSENSUS_CONFIGS", () => {
	it("checksums and parses a valid address from a JSON string", () => {
		// Lowercase address should be accepted and returned as checksummed
		const lowercase = "0x5aaeb6053f3e94c9b9a09f33669435e7ef1beaed";
		const result = configSchema.parse({
			...BASE_ENV,
			CONSENSUS_CONFIGS: JSON.stringify({ "11155111": [{ address: lowercase }] }),
		});
		expect(result.CONSENSUS_CONFIGS["11155111"]).toStrictEqual([
			{ address: "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed" },
		]);
	});

	it("accepts multiple entries per chain and checksums all addresses", () => {
		const addr1 = "0x5aaeb6053f3e94c9b9a09f33669435e7ef1beaed";
		const addr2 = "0x6b175474e89094c44da98b954eedeac495271d0f";
		const result = configSchema.parse({
			...BASE_ENV,
			CONSENSUS_CONFIGS: JSON.stringify({ "11155111": [{ address: addr1 }, { address: addr2 }] }),
		});
		expect(result.CONSENSUS_CONFIGS["11155111"]).toStrictEqual([
			{ address: "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed" },
			{ address: "0x6B175474E89094C44Da98b954EedeAC495271d0F" },
		]);
	});

	it("accepts and checksums an entry with an oracle address set", () => {
		const address = "0x5aaeb6053f3e94c9b9a09f33669435e7ef1beaed";
		const oracle = "0x6b175474e89094c44da98b954eedeac495271d0f";
		const result = configSchema.parse({
			...BASE_ENV,
			CONSENSUS_CONFIGS: JSON.stringify({ "11155111": [{ address, oracle }] }),
		});
		expect(result.CONSENSUS_CONFIGS["11155111"]).toStrictEqual([
			{
				address: "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed",
				oracle: "0x6B175474E89094C44Da98b954EedeAC495271d0F",
			},
		]);
	});

	it("rejects an empty array of consensus configs", () => {
		expect(() =>
			configSchema.parse({
				...BASE_ENV,
				CONSENSUS_CONFIGS: JSON.stringify({ "11155111": [] }),
			}),
		).toThrow();
	});

	it("rejects an entry with an invalid address", () => {
		expect(() =>
			configSchema.parse({
				...BASE_ENV,
				CONSENSUS_CONFIGS: JSON.stringify({ "11155111": [{ address: "not-an-address" }] }),
			}),
		).toThrow();
	});

	it("rejects an entry with an invalid oracle address", () => {
		expect(() =>
			configSchema.parse({
				...BASE_ENV,
				CONSENSUS_CONFIGS: JSON.stringify({
					"11155111": [{ address: ZERO_ADDRESS, oracle: "not-an-address" }],
				}),
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
				CONSENSUS_CONFIGS: JSON.stringify({
					"11155111": [{ address: ZERO_ADDRESS }],
					"100": [{ address: ZERO_ADDRESS }],
				}),
				RELAYING_SAFES: JSON.stringify({ "11155111": RELAYING_SAFE_ENTRY, "100": RELAYING_SAFE_ENTRY }),
			}),
		).toThrow(/RPC_URLS missing entry for chain 100/);
	});

	it("fails when CONSENSUS_CONFIGS is missing an entry for a chain in CHAIN_IDS", () => {
		expect(() =>
			configSchema.parse({
				PRIVATE_KEY: VALID_PRIVATE_KEY,
				SAFE_API_KEY: TEST_API_KEY,
				CHAIN_IDS: "11155111,100",
				RPC_URLS: JSON.stringify({ "11155111": SEPOLIA_RPC, "100": SEPOLIA_RPC }),
				CONSENSUS_CONFIGS: JSON.stringify({ "11155111": [{ address: ZERO_ADDRESS }] }), // 100 missing
				RELAYING_SAFES: JSON.stringify({ "11155111": RELAYING_SAFE_ENTRY, "100": RELAYING_SAFE_ENTRY }),
			}),
		).toThrow(/CONSENSUS_CONFIGS missing entry for chain 100/);
	});

	it("accepts multiple consensus configs for a chain without multicall3 support", () => {
		// Anvil (31337) does not have multicall3 configured
		const result = configSchema.parse({
			PRIVATE_KEY: VALID_PRIVATE_KEY,
			SAFE_API_KEY: TEST_API_KEY,
			CHAIN_IDS: "31337",
			RPC_URLS: JSON.stringify({ "31337": SEPOLIA_RPC }),
			CONSENSUS_CONFIGS: JSON.stringify({ "31337": [{ address: ZERO_ADDRESS }, { address: ZERO_ADDRESS }] }),
		});
		expect(result.CONSENSUS_CONFIGS["31337"]).toHaveLength(2);
	});

	it("succeeds when RELAYING_SAFES is missing an entry for a chain in CHAIN_IDS", () => {
		const result = configSchema.parse({
			PRIVATE_KEY: VALID_PRIVATE_KEY,
			SAFE_API_KEY: TEST_API_KEY,
			CHAIN_IDS: "11155111,100",
			RPC_URLS: JSON.stringify({ "11155111": SEPOLIA_RPC, "100": SEPOLIA_RPC }),
			CONSENSUS_CONFIGS: JSON.stringify({
				"11155111": [{ address: ZERO_ADDRESS }],
				"100": [{ address: ZERO_ADDRESS }],
			}),
			RELAYING_SAFES: JSON.stringify({ "11155111": RELAYING_SAFE_ENTRY }), // 100 missing — falls back to a direct call
		});
		expect(result.RELAYING_SAFES).toEqual({ "11155111": RELAYING_SAFE_ENTRY });
	});
});

describe("configSchema — RELAYING_SAFES", () => {
	it("parses a valid JSON string and checksums the safe and multiSend addresses", () => {
		const safe = "0x5aaeb6053f3e94c9b9a09f33669435e7ef1beaed";
		const multiSend = "0x6b175474e89094c44da98b954eedeac495271d0f";
		const result = configSchema.parse({
			...BASE_ENV,
			RELAYING_SAFES: JSON.stringify({ "11155111": { safe, multiSend } }),
		});
		expect(result.RELAYING_SAFES).toEqual({
			"11155111": {
				safe: "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed",
				multiSend: "0x6B175474E89094C44Da98b954EedeAC495271d0F",
			},
		});
	});

	it("accepts an already-parsed object (non-string pass-through)", () => {
		const result = configSchema.parse({
			...BASE_ENV,
			RELAYING_SAFES: { "11155111": RELAYING_SAFE_ENTRY },
		});
		expect(result.RELAYING_SAFES).toEqual({ "11155111": RELAYING_SAFE_ENTRY });
	});

	it("rejects malformed JSON", () => {
		expect(() => configSchema.parse({ ...BASE_ENV, RELAYING_SAFES: "not json" })).toThrow();
	});

	it("rejects an entry with an invalid safe address", () => {
		expect(() =>
			configSchema.parse({
				...BASE_ENV,
				RELAYING_SAFES: JSON.stringify({ "11155111": { safe: "not-an-address", multiSend: ZERO_ADDRESS } }),
			}),
		).toThrow();
	});

	it("rejects an entry with an invalid multiSend address", () => {
		expect(() =>
			configSchema.parse({
				...BASE_ENV,
				RELAYING_SAFES: JSON.stringify({ "11155111": { safe: ZERO_ADDRESS, multiSend: "not-an-address" } }),
			}),
		).toThrow();
	});

	it("rejects an entry missing the multiSend address", () => {
		expect(() =>
			configSchema.parse({
				...BASE_ENV,
				RELAYING_SAFES: JSON.stringify({ "11155111": { safe: ZERO_ADDRESS } }),
			}),
		).toThrow();
	});

	it("defaults to an empty record when omitted entirely", () => {
		const { RELAYING_SAFES, ...envWithoutRelayingSafes } = BASE_ENV;
		const result = configSchema.parse(envWithoutRelayingSafes);
		expect(result.RELAYING_SAFES).toEqual({});
	});
});
