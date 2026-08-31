import {
	type Address,
	BaseError,
	createPublicClient,
	createWalletClient,
	encodeFunctionData,
	extractChain,
	type Hex,
	http,
	size,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { supportedChains } from "../config/chains.js";
import { configSchema } from "../config/schemas.js";
import type { ConsensusConfig } from "../config/types.js";
import type { SafeTransactionWithDomain } from "../safe/types.js";
import { BETA_CONSENSUS_FUNCTIONS, CONSENSUS_FUNCTIONS } from "../utils/abis.js";
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
				config.CONSENSUS_CONFIGS[String(chainId)],
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
	consensusConfigs: ConsensusConfig[],
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

	// One transaction per (message, consensus config) pair.
	const submissions = transactions.flatMap((tx) => consensusConfigs.map((config) => ({ tx, config })));

	const results = await Promise.allSettled(
		submissions.map((submission, index) =>
			submitTransaction(
				walletClient,
				chain,
				account,
				submission.config,
				submission.tx,
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

// Base gas requirement for proposeTransaction's onchain execution.
const PROPOSE_TRANSACTION_GAS = 60_000n;
// The oracle variant of proposeTransaction performs an additional call to the oracle to prepare the request.
const ORACLE_GAS_OVERHEAD = 250_000n;

// 25 gas/byte = 16 (non-zero calldata, post-Berlin) + 8 (event data) + 1 (overhead)
function calldataGas(callData: Hex): bigint {
	return BigInt(size(callData)) * 25n;
}

function encodeProposeCall(config: ConsensusConfig, details: SafeTransactionWithDomain): { data: Hex; gas: bigint } {
	if (config.oracle) {
		const data = encodeFunctionData({
			abi: CONSENSUS_FUNCTIONS,
			functionName: "proposeTransaction",
			args: [config.oracle, "0x", details],
		});
		return { data, gas: PROPOSE_TRANSACTION_GAS + ORACLE_GAS_OVERHEAD + calldataGas(data) };
	}
	const data = encodeFunctionData({
		abi: BETA_CONSENSUS_FUNCTIONS,
		functionName: "proposeTransaction",
		args: [details],
	});
	return { data, gas: PROPOSE_TRANSACTION_GAS + calldataGas(data) };
}

function encodeSingleTransaction(
	config: ConsensusConfig,
	details: SafeTransactionWithDomain,
): { data: Hex; gas: bigint } {
	const { data, gas } = encodeProposeCall(config, details);
	return { data, gas: (gas * 120n) / 100n };
}

async function submitTransaction(
	client: ReturnType<typeof createWalletClient>,
	chain: ReturnType<typeof extractChain>,
	account: ReturnType<typeof privateKeyToAccount>,
	config: ConsensusConfig,
	details: SafeTransactionWithDomain,
	maxFeePerGas: bigint,
	maxPriorityFeePerGas: bigint,
	nonce: number,
	chainId: number,
): Promise<void> {
	const { data, gas } = encodeSingleTransaction(config, details);
	const to: Address = config.address;

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
