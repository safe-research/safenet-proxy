import { Hono } from "hono";
import { type Address, zeroAddress } from "viem";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { QueueMessage } from "../queue/types.js";
import type { SafeTransactionWithDomain } from "../safe/types.js";
import { handleProposal, handleTx } from "./handler.js";

const { enabledSafes, transactionDetails } = vi.hoisted(() => ({
	enabledSafes: [] as Address[],
	transactionDetails: vi.fn(),
}));

vi.mock("../config/safes.js", () => ({ enabledSafes }));
vi.mock("../safe/service.js", () => ({ transactionDetails }));

// ---- fixtures ---------------------------------------------------------------

const SAFE_ADDRESS: Address = "0x1280C3d641ad0517918e0E4C41F4AD25f6b39144";
const OTHER_SAFE_ADDRESS: Address = "0x9999999999999999999999999999999999999999";
const SAFE_TX_HASH = "0x20e178f2ce590c235d30a6e99a78e799053f36bafe2d2022a642be03cb89058c";

const SAFE_TX: SafeTransactionWithDomain = {
	to: zeroAddress,
	value: 0n,
	data: "0x",
	operation: 0,
	safeTxGas: 0n,
	baseGas: 0n,
	gasPrice: 0n,
	gasToken: zeroAddress,
	refundReceiver: zeroAddress,
	nonce: 0n,
	safe: SAFE_ADDRESS,
	chainId: 11155111n,
};

const BASE_ENV = {
	PRIVATE_KEY: "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
	SAFE_API_KEY: "some_random_api_key",
	RPC_URLS: JSON.stringify({ "11155111": "https://sepolia.example.com" }),
	CONSENSUS_CONFIGS: JSON.stringify({ "11155111": [{ address: zeroAddress }] }),
	CHAIN_IDS: "11155111",
};

const event = (type: string, address: Address = SAFE_ADDRESS) => ({
	type,
	chainId: "11155111",
	address,
	safeTxHash: SAFE_TX_HASH,
});

const serializeTx = (tx: SafeTransactionWithDomain) =>
	JSON.stringify(tx, (_, value) => (typeof value === "bigint" ? value.toString() : value));

// ---- helpers ----------------------------------------------------------------

const app = new Hono<{ Bindings: CloudflareBindings }>();
app.post("/propose", (c) => handleProposal(c));
app.post("/sampled", (c) => handleProposal(c, true));
app.post("/tx", (c) => handleTx(c));
app.post("/tx-sampled", (c) => handleTx(c, true));

async function post(path: string, body: string, env: Record<string, string> = {}): Promise<QueueMessage[]> {
	const sent: QueueMessage[] = [];
	const pending: Promise<unknown>[] = [];
	const bindings = {
		...BASE_ENV,
		...env,
		PROPOSAL_QUEUE: { send: async (message: QueueMessage) => sent.push(message) },
	} as unknown as CloudflareBindings;
	const executionCtx = {
		waitUntil: (promise: Promise<unknown>) => pending.push(promise),
		passThroughOnException: () => {},
		props: {},
	};
	const response = await app.request(path, { method: "POST", body }, bindings, executionCtx);
	expect(response.status).toBe(202);
	await Promise.all(pending);
	return sent;
}

beforeEach(() => {
	enabledSafes.length = 0;
	transactionDetails.mockReset();
	transactionDetails.mockResolvedValue(SAFE_TX);
});

// ---- tests ------------------------------------------------------------------

describe("handleProposal — webhook types", () => {
	it("queues executed transactions by default", async () => {
		const sent = await post("/propose", JSON.stringify(event("EXECUTED_MULTISIG_TRANSACTION")));
		expect(sent).toEqual([expect.objectContaining({ type: "TRANSACTION", data: SAFE_TX })]);
	});

	it("ignores pending transactions by default", async () => {
		const sent = await post("/propose", JSON.stringify(event("PENDING_MULTISIG_TRANSACTION")));
		expect(sent).toEqual([]);
	});

	it("queues pending transactions when configured", async () => {
		const sent = await post("/propose", JSON.stringify(event("PENDING_MULTISIG_TRANSACTION")), {
			WEBHOOK_TYPE: "PENDING_MULTISIG_TRANSACTION",
		});
		expect(sent).toEqual([expect.objectContaining({ type: "TRANSACTION", data: SAFE_TX })]);
	});

	it("ignores executed transactions when only pending transactions are configured", async () => {
		const sent = await post("/propose", JSON.stringify(event("EXECUTED_MULTISIG_TRANSACTION")), {
			WEBHOOK_TYPE: "PENDING_MULTISIG_TRANSACTION",
		});
		expect(sent).toEqual([]);
	});

	it("ignores unsupported webhook types", async () => {
		const sent = await post("/propose", JSON.stringify(event("INCOMING_ETHER")));
		expect(sent).toEqual([]);
	});
});

describe("handleProposal — enabled Safes", () => {
	// A sample rate of 100 ensures sampled requests are never dropped by sampling.
	const SAMPLED_ENV = { SAMPLE_RATE: "100" };

	it("queues transactions of an enabled Safe when sampled", async () => {
		enabledSafes.push(SAFE_ADDRESS);
		const sent = await post(
			"/sampled",
			JSON.stringify(event("EXECUTED_MULTISIG_TRANSACTION", SAFE_ADDRESS)),
			SAMPLED_ENV,
		);
		expect(sent).toHaveLength(1);
	});

	it("matches enabled Safes regardless of address casing", async () => {
		enabledSafes.push(SAFE_ADDRESS.toLowerCase() as Address);
		const sent = await post(
			"/sampled",
			JSON.stringify(event("EXECUTED_MULTISIG_TRANSACTION", SAFE_ADDRESS)),
			SAMPLED_ENV,
		);
		expect(sent).toHaveLength(1);
	});

	it("ignores transactions of a Safe that is not enabled when sampled", async () => {
		enabledSafes.push(OTHER_SAFE_ADDRESS);
		const sent = await post(
			"/sampled",
			JSON.stringify(event("EXECUTED_MULTISIG_TRANSACTION", SAFE_ADDRESS)),
			SAMPLED_ENV,
		);
		expect(sent).toEqual([]);
	});

	it("queues transactions of a Safe that is not enabled when not sampled", async () => {
		enabledSafes.push(OTHER_SAFE_ADDRESS);
		const sent = await post("/propose", JSON.stringify(event("EXECUTED_MULTISIG_TRANSACTION", SAFE_ADDRESS)));
		expect(sent).toHaveLength(1);
	});
});

describe("handleTx — enabled Safes", () => {
	// A sample rate of 0 ensures sampled requests are never dropped by sampling.
	const SAMPLED_ENV = { SAMPLE_RATE: "0" };

	it("queues transactions of any Safe when no Safes are enabled", async () => {
		const sent = await post("/tx-sampled", serializeTx(SAFE_TX), SAMPLED_ENV);
		expect(sent).toEqual([expect.objectContaining({ type: "TRANSACTION", data: SAFE_TX })]);
	});

	it("queues transactions of an enabled Safe when sampled", async () => {
		enabledSafes.push(SAFE_ADDRESS);
		const sent = await post("/tx-sampled", serializeTx(SAFE_TX), SAMPLED_ENV);
		expect(sent).toHaveLength(1);
	});

	it("ignores transactions of a Safe that is not enabled when sampled", async () => {
		enabledSafes.push(OTHER_SAFE_ADDRESS);
		const sent = await post("/tx-sampled", serializeTx(SAFE_TX), SAMPLED_ENV);
		expect(sent).toEqual([]);
	});

	it("queues transactions of a Safe that is not enabled when not sampled", async () => {
		enabledSafes.push(OTHER_SAFE_ADDRESS);
		const sent = await post("/tx", serializeTx(SAFE_TX));
		expect(sent).toHaveLength(1);
	});
});
