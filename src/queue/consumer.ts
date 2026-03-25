import {
	type Address,
	BaseError,
	createPublicClient,
	createWalletClient,
	encodeFunctionData,
	extractChain,
	type Hex,
	http,
	multicall3Abi,
	size,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { supportedChains } from "../config/chains.js";
import { configSchema } from "../config/schemas.js";
import type { SafeTransactionWithDomain } from "../safe/types.js";
import { CONSENSUS_FUNCTIONS } from "../utils/abis.js";
import { queueMessageSchema } from "./schemas.js";
import type { QueueMessage } from "./types.js";

export async function handleQueueBatch(batch: MessageBatch<QueueMessage>, env: CloudflareBindings): Promise<void> {
	const config = configSchema.parse(env);
	const account = privateKeyToAccount(config.PRIVATE_KEY);

	// Parse all messages upfront; always ack everything at the end (no retry policy)
	const transactions: SafeTransactionWithDomain[] = [];
	for (const message of batch.messages) {
		const parsed = queueMessageSchema.safeParse(message.body);
		if (parsed.success) {
			transactions.push(parsed.data.data);
		} else {
			console.error(`Failed to parse message ${message.id}: ${parsed.error.message}`);
		}
	}

	// Submit all transactions to each chain in parallel; settle independently per chain
	const chainResults = await Promise.allSettled(
		config.CHAIN_IDS.map((chainId) =>
			processChainMessages(
				chainId,
				config.RPC_URLS[String(chainId)],
				config.CONSENSUS_ADDRESSES[String(chainId)],
				account,
				transactions,
			),
		),
	);

	for (const [i, result] of chainResults.entries()) {
		if (result.status === "rejected") {
			const errorMessage = result.reason instanceof BaseError ? result.reason.shortMessage : String(result.reason);
			console.error(`Chain ${config.CHAIN_IDS[i]} batch failed: ${errorMessage}`);
		}
	}

	for (const message of batch.messages) {
		message.ack();
	}
}

async function processChainMessages(
	chainId: (typeof supportedChains)[number]["id"],
	rpcUrl: string,
	consensusAddresses: Address[],
	account: ReturnType<typeof privateKeyToAccount>,
	transactions: SafeTransactionWithDomain[],
): Promise<void> {
	const chain = extractChain({ chains: supportedChains, id: chainId });
	const walletClient = createWalletClient({ chain, account, transport: http(rpcUrl) });
	const publicClient = createPublicClient({ chain, transport: http(rpcUrl) });

	// Fetch EIP-1559 fee data once for the entire batch to avoid N redundant RPC calls
	const { maxFeePerGas, maxPriorityFeePerGas } = await publicClient.estimateFeesPerGas();
	// Double maxFeePerGas to guard against price movement during batch processing
	const bufferedMaxFeePerGas = maxFeePerGas * 2n;

	// Fetch the current nonce once and manually increment per transaction.
	// Note: this could theoretically cause skipped transactions if a concurrent sender
	// submits between our getTransactionCount call and our sends, but it is less prone
	// to getting stuck than viem's nonceManager since there is currently no retry logic.
	const baseNonce = await publicClient.getTransactionCount({ address: account.address, blockTag: "latest" });

	const results = await Promise.allSettled(
		transactions.map((tx, index) =>
			submitTransaction(
				walletClient,
				chain,
				account,
				consensusAddresses,
				tx,
				bufferedMaxFeePerGas,
				maxPriorityFeePerGas,
				baseNonce + index,
				chainId,
			),
		),
	);

	for (const [index, result] of results.entries()) {
		if (result.status === "rejected") {
			const errorMessage = result.reason instanceof BaseError ? result.reason.shortMessage : String(result.reason);
			console.error(`Error submitting tx ${index} to chain ${chainId}: ${errorMessage}`);
		}
	}
}

// Base formula: 60,000 base + 25 gas/byte, with 20% safety buffer.
// 25 gas/byte = 16 (non-zero calldata, post-Berlin) + 8 (ExecutionSuccess event) + 1 (overhead)
function estimateCallGas(callData: Hex): bigint {
	return 60_000n + BigInt(size(callData)) * 25n;
}

function encodeProposeTransaction(details: SafeTransactionWithDomain): Hex {
	return encodeFunctionData({
		abi: CONSENSUS_FUNCTIONS,
		functionName: "proposeTransaction",
		args: [details],
	});
}

function encodeTransaction(details: SafeTransactionWithDomain): { data: Hex; gas: bigint } {
	const data = encodeProposeTransaction(details);
	return { data, gas: (estimateCallGas(data) * 120n) / 100n };
}

function encodeMulticall(
	details: SafeTransactionWithDomain,
	consensusAddresses: Address[],
	multicall3Address: Address,
): { to: Address; data: Hex; gas: bigint } {
	const callData = encodeProposeTransaction(details);
	const calls = consensusAddresses.map((target) => ({ target, allowFailure: false, callData }));

	const data = encodeFunctionData({
		abi: multicall3Abi,
		functionName: "aggregate3",
		args: [calls],
	});

	// Per-call cost plus multicall3 overhead, with 20% safety buffer
	const estimated = 30_000n + estimateCallGas(callData) * BigInt(consensusAddresses.length);
	return { to: multicall3Address, data, gas: (estimated * 120n) / 100n };
}

async function submitTransaction(
	client: ReturnType<typeof createWalletClient>,
	chain: ReturnType<typeof extractChain>,
	account: ReturnType<typeof privateKeyToAccount>,
	consensusAddresses: Address[],
	details: SafeTransactionWithDomain,
	maxFeePerGas: bigint,
	maxPriorityFeePerGas: bigint,
	nonce: number,
	chainId: number,
): Promise<void> {
	let to: Address;
	let data: Hex;
	let gas: bigint;

	if (consensusAddresses.length === 1) {
		({ data, gas } = encodeTransaction(details));
		to = consensusAddresses[0];
	} else {
		// multicall3 availability is validated at config parse time
		// biome-ignore lint/style/noNonNullAssertion: guaranteed by configSchema
		({ to, data, gas } = encodeMulticall(details, consensusAddresses, chain.contracts!.multicall3!.address));
	}

	const transactionHash = await client.sendTransaction({
		chain,
		account,
		to,
		data,
		gas,
		maxFeePerGas,
		maxPriorityFeePerGas,
		nonce,
	});
	console.info(`Transaction submitted to chain ${chainId}: ${transactionHash} (nonce: ${nonce})`);
}
