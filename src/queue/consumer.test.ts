import { encodeFunctionData, multicall3Abi, zeroAddress } from "viem";
import { beforeEach, describe, expect, it, type Mock, vi } from "vitest";
import type { SafeTransactionWithDomain } from "../safe/types.js";
import { CONSENSUS_FUNCTIONS } from "../utils/abis.js";
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
const TEST_API_KEY = "some_random_api_key";
const SEPOLIA_RPC = "https://sepolia.example.com";
const SEPOLIA_ID = "11155111";
const MULTICALL3_ADDRESS = "0xcA11bde05977b3631167028862bE2a173976CA11";

const ENV = {
	PRIVATE_KEY: VALID_PRIVATE_KEY,
	SAFE_API_KEY: TEST_API_KEY,
	RPC_URLS: JSON.stringify({ [SEPOLIA_ID]: SEPOLIA_RPC }),
	CONSENSUS_ADDRESSES: JSON.stringify({ [SEPOLIA_ID]: [zeroAddress] }),
	CHAIN_IDS: SEPOLIA_ID,
	PROPOSAL_QUEUE: undefined as unknown,
	SAMPLE_RATE: "0",
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
	it("submits one transaction per message and acks all messages", async () => {
		const messages = [makeMessage(), makeMessage()];
		await handleQueueBatch(makeBatch(messages), ENV);

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
			CONSENSUS_ADDRESSES: JSON.stringify({ "11155111": [zeroAddress], "100": [zeroAddress] }),
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

	it("passes sequential nonces within a batch", async () => {
		mockGetTransactionCount.mockResolvedValue(7);

		const messages = [makeMessage(), makeMessage(), makeMessage()];
		await handleQueueBatch(makeBatch(messages), ENV);

		const nonces = mockSendTransaction.mock.calls.map((args) => (args[0] as { nonce: number }).nonce);
		expect(nonces).toEqual([7, 8, 9]);
	});

	it("sends a single multicall transaction when multiple consensus addresses are configured", async () => {
		const addr1 = "0x1111111111111111111111111111111111111111";
		const addr2 = "0x2222222222222222222222222222222222222222";

		const multiAddressEnv = {
			PRIVATE_KEY: VALID_PRIVATE_KEY,
			SAFE_API_KEY: TEST_API_KEY,
			CHAIN_IDS: SEPOLIA_ID,
			RPC_URLS: JSON.stringify({ [SEPOLIA_ID]: SEPOLIA_RPC }),
			CONSENSUS_ADDRESSES: JSON.stringify({ [SEPOLIA_ID]: [addr1, addr2] }),
			PROPOSAL_QUEUE: undefined as unknown,
			SAMPLE_RATE: "0",
		} as CloudflareBindings;

		const proposeCallData = encodeFunctionData({
			abi: CONSENSUS_FUNCTIONS,
			functionName: "proposeTransaction",
			args: [SAFE_TX],
		});
		const expectedData = encodeFunctionData({
			abi: multicall3Abi,
			functionName: "aggregate3",
			args: [
				[
					{ target: addr1, allowFailure: false, callData: proposeCallData },
					{ target: addr2, allowFailure: false, callData: proposeCallData },
				],
			],
		});

		const messages = [makeMessage()];
		await handleQueueBatch(makeBatch(messages), multiAddressEnv);

		// One sendTransaction call (not two), targeting the multicall3 contract with encoded aggregate3 data
		expect(mockSendTransaction).toHaveBeenCalledTimes(1);
		expect((mockSendTransaction.mock.calls[0][0].to as string).toLowerCase()).toBe(MULTICALL3_ADDRESS.toLowerCase());
		expect(mockSendTransaction.mock.calls[0][0].data).toBe(expectedData);
		expect(messages[0].ack).toHaveBeenCalledOnce();
	});

	it("sends directly to the consensus address when only one is configured", async () => {
		const messages = [makeMessage()];
		await handleQueueBatch(makeBatch(messages), ENV);

		// With a single address, should send directly (not to multicall3)
		expect(mockSendTransaction).toHaveBeenCalledTimes(1);
		expect(mockSendTransaction.mock.calls[0][0].to).toBe(zeroAddress);
	});
});
