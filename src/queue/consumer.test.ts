import { type Address, encodeFunctionData, zeroAddress } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { beforeEach, describe, expect, it, type Mock, vi } from "vitest";
import { encodeMultiSendCall } from "../safe/multisend.js";
import { encodeSafeRelayTransaction } from "../safe/relay.js";
import type { SafeTransactionWithDomain } from "../safe/types.js";
import { BETA_CONSENSUS_FUNCTIONS, CONSENSUS_FUNCTIONS } from "../utils/abis.js";
import { handleQueueBatch } from "./consumer.js";
import type { QueueMessage } from "./types.js";

// Partially mock viem: keep real utilities (BaseError, encodeFunctionData, etc.)
// but replace the network-connecting client factories with fakes.
vi.mock("viem", async (importOriginal) => {
	const actual = await importOriginal<typeof import("viem")>();
	return {
		...actual,
		createPublicClient: vi.fn(),
		createWalletClient: vi.fn(),
	};
});

// ---- fixtures ---------------------------------------------------------------

const VALID_PRIVATE_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const OPERATOR: Address = privateKeyToAccount(VALID_PRIVATE_KEY).address;
const TEST_API_KEY = "some_random_api_key";
const SEPOLIA_RPC = "https://sepolia.example.com";
const SEPOLIA_ID = "11155111";
// Distinct from the consensus config address used below, so tests can tell a
// relayed call (targets the safe) apart from a direct call (targets the consensus config).
const SAFE_ADDRESS: Address = "0x9999999999999999999999999999999999999999";
const MULTI_SEND_ADDRESS: Address = "0x7777777777777777777777777777777777777777";
const RELAYING_SAFE_ENTRY = { safe: SAFE_ADDRESS, multiSend: MULTI_SEND_ADDRESS };

const ENV = {
	PRIVATE_KEY: VALID_PRIVATE_KEY,
	SAFE_API_KEY: TEST_API_KEY,
	RPC_URLS: JSON.stringify({ [SEPOLIA_ID]: SEPOLIA_RPC }),
	CONSENSUS_CONFIGS: JSON.stringify({ [SEPOLIA_ID]: [{ address: zeroAddress }] }),
	RELAYING_SAFES: JSON.stringify({ [SEPOLIA_ID]: RELAYING_SAFE_ENTRY }),
	CHAIN_IDS: SEPOLIA_ID,
	PROPOSAL_QUEUE: undefined as unknown,
	SAMPLE_RATE: "0",
} as CloudflareBindings;

// A variant of ENV with no relaying Safe configured, exercising the fallback
// path where the consensus contract is called directly, one call per transaction.
const ENV_WITHOUT_RELAY = {
	...ENV,
	RELAYING_SAFES: JSON.stringify({}),
} as CloudflareBindings;

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
	safe: zeroAddress,
	chainId: 1n,
};

const VALID_BODY: QueueMessage = {
	type: "TRANSACTION",
	timestamp: Date.now(),
	data: SAFE_TX,
};

// ---- helpers ----------------------------------------------------------------

function makeMessage(body: unknown = VALID_BODY): Message<QueueMessage> {
	return {
		id: `msg-${Math.random()}`,
		timestamp: new Date(),
		attempts: 1,
		body: body as QueueMessage,
		ack: vi.fn(),
		retry: vi.fn(),
	};
}

function makeBatch(messages: Message<QueueMessage>[]): MessageBatch<QueueMessage> {
	return {
		queue: "safenet-proposals",
		messages,
		ackAll: vi.fn(),
		retryAll: vi.fn(),
	};
}

// ---- mock client setup ------------------------------------------------------

let mockSendTransaction: Mock;
let mockEstimateFeesPerGas: Mock;
let mockGetTransactionCount: Mock;

beforeEach(async () => {
	const viem = await import("viem");

	mockSendTransaction = vi.fn().mockResolvedValue("0xtxhash");
	mockEstimateFeesPerGas = vi.fn().mockResolvedValue({
		maxFeePerGas: 1_000_000_000n,
		maxPriorityFeePerGas: 1_000_000n,
	});
	mockGetTransactionCount = vi.fn().mockResolvedValue(5);

	(viem.createPublicClient as Mock).mockReturnValue({
		estimateFeesPerGas: mockEstimateFeesPerGas,
		getTransactionCount: mockGetTransactionCount,
	});

	(viem.createWalletClient as Mock).mockReturnValue({
		sendTransaction: mockSendTransaction,
	});
});

// ---- tests ------------------------------------------------------------------

describe("handleQueueBatch", () => {
	it("submits one transaction per message and acks all messages (no relaying Safe configured)", async () => {
		const messages = [makeMessage(), makeMessage()];
		await handleQueueBatch(makeBatch(messages), ENV_WITHOUT_RELAY);

		expect(mockSendTransaction).toHaveBeenCalledTimes(2);
		for (const msg of messages) {
			expect(msg.ack).toHaveBeenCalledOnce();
		}
	});

	it("acks all messages even when a message body fails to parse", async () => {
		const valid = makeMessage();
		const invalid = makeMessage({ not: "a valid queue message" });

		await handleQueueBatch(makeBatch([valid, invalid]), ENV);

		// Only the valid message produces a submission
		expect(mockSendTransaction).toHaveBeenCalledTimes(1);
		// Both messages are acked regardless
		expect(valid.ack).toHaveBeenCalledOnce();
		expect(invalid.ack).toHaveBeenCalledOnce();
	});

	it("acks all messages even when sendTransaction rejects", async () => {
		mockSendTransaction.mockRejectedValue(new Error("nonce too low"));

		const messages = [makeMessage()];
		await handleQueueBatch(makeBatch(messages), ENV);

		expect(messages[0].ack).toHaveBeenCalledOnce();
	});

	it("acks all messages even when fee estimation fails for the chain", async () => {
		mockEstimateFeesPerGas.mockRejectedValue(new Error("RPC unreachable"));

		const messages = [makeMessage()];
		await handleQueueBatch(makeBatch(messages), ENV);

		expect(messages[0].ack).toHaveBeenCalledOnce();
	});

	it("submits to all configured chains", async () => {
		const viem = await import("viem");

		const sepoliaSend = vi.fn().mockResolvedValue("0xsepolia");
		const gnosisSend = vi.fn().mockResolvedValue("0xgnosis");

		// Return distinct wallet clients per call so we can track per-chain sends
		(viem.createWalletClient as Mock)
			.mockReturnValueOnce({ sendTransaction: sepoliaSend })
			.mockReturnValueOnce({ sendTransaction: gnosisSend });

		const multiChainEnv = {
			PRIVATE_KEY: VALID_PRIVATE_KEY,
			SAFE_API_KEY: TEST_API_KEY,
			CHAIN_IDS: "11155111,100",
			RPC_URLS: JSON.stringify({ "11155111": SEPOLIA_RPC, "100": "https://gnosis.example.com" }),
			CONSENSUS_CONFIGS: JSON.stringify({
				"11155111": [{ address: zeroAddress }],
				"100": [{ address: zeroAddress }],
			}),
			RELAYING_SAFES: JSON.stringify({ "11155111": RELAYING_SAFE_ENTRY, "100": RELAYING_SAFE_ENTRY }),
			PROPOSAL_QUEUE: undefined as unknown,
			SAMPLE_RATE: "0",
		} as CloudflareBindings;

		const messages = [makeMessage()];
		await handleQueueBatch(makeBatch(messages), multiChainEnv);

		// Each chain should receive exactly one submission
		expect(sepoliaSend).toHaveBeenCalledOnce();
		expect(gnosisSend).toHaveBeenCalledOnce();
		expect(messages[0].ack).toHaveBeenCalledOnce();
	});

	it("passes sequential nonces within a batch (no relaying Safe configured)", async () => {
		mockGetTransactionCount.mockResolvedValue(7);

		const messages = [makeMessage(), makeMessage(), makeMessage()];
		await handleQueueBatch(makeBatch(messages), ENV_WITHOUT_RELAY);

		const nonces = mockSendTransaction.mock.calls.map((args) => (args[0] as { nonce: number }).nonce);
		expect(nonces).toEqual([7, 8, 9]);
	});

	it("submits one transaction per consensus config for each message, with sequential nonces (no relaying Safe configured)", async () => {
		const addr1 = "0x1111111111111111111111111111111111111111";
		const addr2 = "0x2222222222222222222222222222222222222222";

		const multiAddressEnv = {
			PRIVATE_KEY: VALID_PRIVATE_KEY,
			SAFE_API_KEY: TEST_API_KEY,
			CHAIN_IDS: SEPOLIA_ID,
			RPC_URLS: JSON.stringify({ [SEPOLIA_ID]: SEPOLIA_RPC }),
			CONSENSUS_CONFIGS: JSON.stringify({ [SEPOLIA_ID]: [{ address: addr1 }, { address: addr2 }] }),
			RELAYING_SAFES: JSON.stringify({}),
			PROPOSAL_QUEUE: undefined as unknown,
			SAMPLE_RATE: "0",
		} as CloudflareBindings;

		mockGetTransactionCount.mockResolvedValue(7);

		// 2 queue messages x 2 consensus configs = 4 sends
		const messages = [makeMessage(), makeMessage()];
		await handleQueueBatch(makeBatch(messages), multiAddressEnv);

		expect(mockSendTransaction).toHaveBeenCalledTimes(4);
		const calls = mockSendTransaction.mock.calls.map((args) => args[0] as { to: string; nonce: number });
		expect(calls.map((c) => c.to)).toEqual([addr1, addr2, addr1, addr2]);
		expect(calls.map((c) => c.nonce)).toEqual([7, 8, 9, 10]);
		expect(messages[0].ack).toHaveBeenCalledOnce();
		expect(messages[1].ack).toHaveBeenCalledOnce();
	});

	it("falls back to sending directly to the consensus address when no relaying Safe is configured for the chain", async () => {
		const messages = [makeMessage()];
		await handleQueueBatch(makeBatch(messages), ENV_WITHOUT_RELAY);

		expect(mockSendTransaction).toHaveBeenCalledTimes(1);
		expect(mockSendTransaction.mock.calls[0][0].to).toBe(zeroAddress);
	});

	it("submits via the oracle variant of proposeTransaction when the single consensus entry has an oracle configured (no relaying Safe configured)", async () => {
		const consensusAddr = "0x3333333333333333333333333333333333333333";
		const oracleAddr = "0x4444444444444444444444444444444444444444";

		const oracleEnv = {
			PRIVATE_KEY: VALID_PRIVATE_KEY,
			SAFE_API_KEY: TEST_API_KEY,
			CHAIN_IDS: SEPOLIA_ID,
			RPC_URLS: JSON.stringify({ [SEPOLIA_ID]: SEPOLIA_RPC }),
			CONSENSUS_CONFIGS: JSON.stringify({ [SEPOLIA_ID]: [{ address: consensusAddr, oracle: oracleAddr }] }),
			RELAYING_SAFES: JSON.stringify({}),
			PROPOSAL_QUEUE: undefined as unknown,
			SAMPLE_RATE: "0",
		} as CloudflareBindings;

		const expectedData = encodeFunctionData({
			abi: CONSENSUS_FUNCTIONS,
			functionName: "proposeTransaction",
			args: [oracleAddr, "0x", SAFE_TX],
		});

		const messages = [makeMessage()];
		await handleQueueBatch(makeBatch(messages), oracleEnv);

		expect(mockSendTransaction).toHaveBeenCalledTimes(1);
		expect(mockSendTransaction.mock.calls[0][0].to).toBe(consensusAddr);
		expect(mockSendTransaction.mock.calls[0][0].data).toBe(expectedData);
	});

	it("uses a higher gas limit for oracle-configured targets to cover their extra on-chain logic", async () => {
		await handleQueueBatch(makeBatch([makeMessage()]), ENV);
		const plainGas = mockSendTransaction.mock.calls[0][0].gas as bigint;

		mockSendTransaction.mockClear();

		const oracleEnv = {
			PRIVATE_KEY: VALID_PRIVATE_KEY,
			SAFE_API_KEY: TEST_API_KEY,
			CHAIN_IDS: SEPOLIA_ID,
			RPC_URLS: JSON.stringify({ [SEPOLIA_ID]: SEPOLIA_RPC }),
			CONSENSUS_CONFIGS: JSON.stringify({
				[SEPOLIA_ID]: [{ address: zeroAddress, oracle: zeroAddress }],
			}),
			RELAYING_SAFES: JSON.stringify({ [SEPOLIA_ID]: RELAYING_SAFE_ENTRY }),
			PROPOSAL_QUEUE: undefined as unknown,
			SAMPLE_RATE: "0",
		} as CloudflareBindings;

		await handleQueueBatch(makeBatch([makeMessage()]), oracleEnv);
		const oracleGas = mockSendTransaction.mock.calls[0][0].gas as bigint;

		expect(oracleGas).toBeGreaterThan(plainGas);
	});

	it("encodes each consensus config's transaction individually when only some entries have an oracle configured (no relaying Safe configured)", async () => {
		const addr1 = "0x1111111111111111111111111111111111111111";
		const addr2 = "0x2222222222222222222222222222222222222222";
		const oracleAddr = "0x4444444444444444444444444444444444444444";

		const mixedEnv = {
			PRIVATE_KEY: VALID_PRIVATE_KEY,
			SAFE_API_KEY: TEST_API_KEY,
			CHAIN_IDS: SEPOLIA_ID,
			RPC_URLS: JSON.stringify({ [SEPOLIA_ID]: SEPOLIA_RPC }),
			CONSENSUS_CONFIGS: JSON.stringify({
				[SEPOLIA_ID]: [{ address: addr1 }, { address: addr2, oracle: oracleAddr }],
			}),
			RELAYING_SAFES: JSON.stringify({}),
			PROPOSAL_QUEUE: undefined as unknown,
			SAMPLE_RATE: "0",
		} as CloudflareBindings;

		const plainCallData = encodeFunctionData({
			abi: BETA_CONSENSUS_FUNCTIONS,
			functionName: "proposeTransaction",
			args: [SAFE_TX],
		});
		const oracleCallData = encodeFunctionData({
			abi: CONSENSUS_FUNCTIONS,
			functionName: "proposeTransaction",
			args: [oracleAddr, "0x", SAFE_TX],
		});

		const messages = [makeMessage()];
		await handleQueueBatch(makeBatch(messages), mixedEnv);

		expect(mockSendTransaction).toHaveBeenCalledTimes(2);
		expect(mockSendTransaction.mock.calls[0][0].to).toBe(addr1);
		expect(mockSendTransaction.mock.calls[0][0].data).toBe(plainCallData);
		expect(mockSendTransaction.mock.calls[1][0].to).toBe(addr2);
		expect(mockSendTransaction.mock.calls[1][0].data).toBe(oracleCallData);
	});
});

describe("handleQueueBatch — relaying Safe routing", () => {
	it("wraps a lone proposeTransaction call directly in execTransaction, without a MultiSend batch", async () => {
		const innerData = encodeFunctionData({
			abi: BETA_CONSENSUS_FUNCTIONS,
			functionName: "proposeTransaction",
			args: [SAFE_TX],
		});
		const expectedData = encodeSafeRelayTransaction(OPERATOR, { to: zeroAddress, value: 0n, data: innerData });

		const messages = [makeMessage()];
		await handleQueueBatch(makeBatch(messages), ENV);

		expect(mockSendTransaction).toHaveBeenCalledTimes(1);
		expect(mockSendTransaction.mock.calls[0][0].to).toBe(SAFE_ADDRESS);
		expect(mockSendTransaction.mock.calls[0][0].data).toBe(expectedData);
	});

	it("uses a higher gas limit for a relayed call than a direct call, to cover execTransaction's overhead", async () => {
		await handleQueueBatch(makeBatch([makeMessage()]), ENV_WITHOUT_RELAY);
		const directGas = mockSendTransaction.mock.calls[0][0].gas as bigint;

		mockSendTransaction.mockClear();

		await handleQueueBatch(makeBatch([makeMessage()]), ENV);
		const relayedGas = mockSendTransaction.mock.calls[0][0].gas as bigint;

		expect(relayedGas).toBeGreaterThan(directGas);
	});

	it("relays for chains with a configured Safe while falling back to a direct call for chains without one", async () => {
		const viem = await import("viem");

		const relayedSend = vi.fn().mockResolvedValue("0xrelayed");
		const directSend = vi.fn().mockResolvedValue("0xdirect");

		(viem.createWalletClient as Mock)
			.mockReturnValueOnce({ sendTransaction: relayedSend })
			.mockReturnValueOnce({ sendTransaction: directSend });

		const mixedChainEnv = {
			PRIVATE_KEY: VALID_PRIVATE_KEY,
			SAFE_API_KEY: TEST_API_KEY,
			CHAIN_IDS: "11155111,100",
			RPC_URLS: JSON.stringify({ "11155111": SEPOLIA_RPC, "100": "https://gnosis.example.com" }),
			CONSENSUS_CONFIGS: JSON.stringify({
				"11155111": [{ address: zeroAddress }],
				"100": [{ address: zeroAddress }],
			}),
			// Only chain 11155111 has a relaying Safe configured.
			RELAYING_SAFES: JSON.stringify({ "11155111": RELAYING_SAFE_ENTRY }),
			PROPOSAL_QUEUE: undefined as unknown,
			SAMPLE_RATE: "0",
		} as CloudflareBindings;

		const messages = [makeMessage()];
		await handleQueueBatch(makeBatch(messages), mixedChainEnv);

		expect(relayedSend).toHaveBeenCalledOnce();
		expect(relayedSend.mock.calls[0][0].to).toBe(SAFE_ADDRESS);
		expect(directSend).toHaveBeenCalledOnce();
		expect(directSend.mock.calls[0][0].to).toBe(zeroAddress);
	});
});

describe("handleQueueBatch — batching via MultiSend", () => {
	it("batches multiple proposals into a single execTransaction via MultiSend when they fit under MAX_BATCH_GAS", async () => {
		const innerData = encodeFunctionData({
			abi: BETA_CONSENSUS_FUNCTIONS,
			functionName: "proposeTransaction",
			args: [SAFE_TX],
		});
		const innerCall = { to: zeroAddress, value: 0n, data: innerData };
		const expectedData = encodeSafeRelayTransaction(
			OPERATOR,
			encodeMultiSendCall(MULTI_SEND_ADDRESS, [innerCall, innerCall, innerCall]),
		);

		// 3 messages against a single consensus config comfortably fit under the
		// default 5,000,000 gas cap, so they should collapse into one MultiSend batch.
		const messages = [makeMessage(), makeMessage(), makeMessage()];
		await handleQueueBatch(makeBatch(messages), ENV);

		expect(mockSendTransaction).toHaveBeenCalledTimes(1);
		expect(mockSendTransaction.mock.calls[0][0].to).toBe(SAFE_ADDRESS);
		expect(mockSendTransaction.mock.calls[0][0].data).toBe(expectedData);
		for (const msg of messages) {
			expect(msg.ack).toHaveBeenCalledOnce();
		}
	});

	it("uses a single sequential nonce for a batched MultiSend transaction, regardless of how many calls it contains", async () => {
		mockGetTransactionCount.mockResolvedValue(9);

		const messages = [makeMessage(), makeMessage(), makeMessage()];
		await handleQueueBatch(makeBatch(messages), ENV);

		expect(mockSendTransaction).toHaveBeenCalledTimes(1);
		expect(mockSendTransaction.mock.calls[0][0].nonce).toBe(9);
	});

	it("splits proposals into separate execTransaction submissions when MAX_BATCH_GAS is too small to combine them", async () => {
		const tightGasEnv = { ...ENV, MAX_BATCH_GAS: "1" } as CloudflareBindings;
		mockGetTransactionCount.mockResolvedValue(9);

		const messages = [makeMessage(), makeMessage(), makeMessage()];
		await handleQueueBatch(makeBatch(messages), tightGasEnv);

		// Each call alone already exceeds the configured limit, so none are combined -
		// but each is still sent (an over-limit call can't be dropped, only isolated).
		expect(mockSendTransaction).toHaveBeenCalledTimes(3);
		for (const call of mockSendTransaction.mock.calls) {
			expect((call[0] as { to: string }).to).toBe(SAFE_ADDRESS);
		}
		const nonces = mockSendTransaction.mock.calls.map((args) => (args[0] as { nonce: number }).nonce);
		expect(nonces).toEqual([9, 10, 11]);
		for (const msg of messages) {
			expect(msg.ack).toHaveBeenCalledOnce();
		}
	});

	it("does not batch direct (non-relayed) calls, regardless of MAX_BATCH_GAS", async () => {
		const largeBatchGasEnv = { ...ENV_WITHOUT_RELAY, MAX_BATCH_GAS: "50000000" } as CloudflareBindings;

		const messages = [makeMessage(), makeMessage(), makeMessage()];
		await handleQueueBatch(makeBatch(messages), largeBatchGasEnv);

		expect(mockSendTransaction).toHaveBeenCalledTimes(3);
	});
});
