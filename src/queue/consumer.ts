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
import type { ConsensusConfig, RelayingSafeConfig } from "../config/types.js";
import { encodeMultiSendCall, encodeMultiSendTransactions } from "../safe/multisend.js";
import { encodeSafeRelayTransaction, type SafeRelayCall } from "../safe/relay.js";
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
				config.RELAYING_SAFES[String(chainId)],
				config.MAX_BATCH_GAS,
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
	relayingSafe: RelayingSafeConfig | undefined,
	maxBatchGas: bigint,
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

	// One inner call per (message, consensus config) pair.
	const innerCalls = transactions.flatMap((tx) => consensusConfigs.map((config) => buildInnerCall(config, tx)));

	const submissions =
		relayingSafe !== undefined
			? groupCallsByGasLimit(innerCalls, maxBatchGas).map((group) =>
					encodeRelayedGroup(group, account.address, relayingSafe),
				)
			: innerCalls.map((call) => encodeDirectCall(call));

	const results = await Promise.allSettled(
		submissions.map((submission, index) =>
			submitTransaction(
				walletClient,
				chain,
				account,
				submission.to,
				submission.data,
				submission.gas,
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
// execTransaction's own overhead: pre-validated signature verification plus dispatching the
// inner call(s) - the same fixed overhead is charged whether execTransaction dispatches a
// single call directly or a batch of calls via MultiSend.
const EXEC_TRANSACTION_GAS_OVERHEAD = 100_000n;

// 25 gas/byte = 16 (non-zero calldata, post-Berlin) + 8 (event data) + 1 (overhead)
function calldataGas(callData: Hex): bigint {
	return BigInt(size(callData)) * 25n;
}

// Adds a 20% safety margin on top of an estimated gas requirement.
function withGasBuffer(gas: bigint): bigint {
	return (gas * 120n) / 100n;
}

function encodeProposeCall(
	config: ConsensusConfig,
	details: SafeTransactionWithDomain,
): { data: Hex; executionGas: bigint } {
	if (config.oracle) {
		const data = encodeFunctionData({
			abi: CONSENSUS_FUNCTIONS,
			functionName: "proposeTransaction",
			args: [config.oracle, "0x", details],
		});
		return { data, executionGas: PROPOSE_TRANSACTION_GAS + ORACLE_GAS_OVERHEAD };
	}
	const data = encodeFunctionData({
		abi: BETA_CONSENSUS_FUNCTIONS,
		functionName: "proposeTransaction",
		args: [details],
	});
	return { data, executionGas: PROPOSE_TRANSACTION_GAS };
}

// A single proposeTransaction call, plus the gas its own on-chain execution requires
// (excluding any wrapping/dispatch overhead, which is charged once per top-level submission).
type InnerCall = SafeRelayCall & { executionGas: bigint };

function buildInnerCall(config: ConsensusConfig, details: SafeTransactionWithDomain): InnerCall {
	const { data, executionGas } = encodeProposeCall(config, details);
	return { to: config.address, value: 0n, data, executionGas };
}

function encodeDirectCall(call: InnerCall): { to: Address; data: Hex; gas: bigint } {
	return { to: call.to, data: call.data, gas: withGasBuffer(call.executionGas + calldataGas(call.data)) };
}

// Rough calldata-gas contribution of packing `call` into a MultiSend entry (the
// operation + to + value + length header, plus the call's own data).
function multiSendEntryGas(call: SafeRelayCall): bigint {
	return calldataGas(encodeMultiSendTransactions([call]));
}

// Greedily groups calls so each group's estimated gas (inner execution + MultiSend
// packing + the fixed execTransaction dispatch overhead) stays within maxBatchGas -
// batching whenever it fits, to minimize the number of top-level EOA transactions.
// A call that alone already exceeds the limit is still sent by itself, since an
// atomic on-chain call cannot be split further.
function groupCallsByGasLimit(calls: InnerCall[], maxBatchGas: bigint): InnerCall[][] {
	const groups: InnerCall[][] = [];
	let current: InnerCall[] = [];
	let currentGas = EXEC_TRANSACTION_GAS_OVERHEAD;

	for (const call of calls) {
		const callGas = call.executionGas + multiSendEntryGas(call);
		if (current.length > 0 && currentGas + callGas > maxBatchGas) {
			groups.push(current);
			current = [];
			currentGas = EXEC_TRANSACTION_GAS_OVERHEAD;
		}
		current.push(call);
		currentGas += callGas;
	}
	if (current.length > 0) {
		groups.push(current);
	}
	return groups;
}

// Wraps a group of one or more calls into a single execTransaction addressed to the
// relaying Safe - a lone call is wrapped directly, while multiple calls are first
// packed into one MultiSend delegatecall so they still land in a single execTransaction.
function encodeRelayedGroup(
	group: InnerCall[],
	owner: Address,
	relayingSafe: RelayingSafeConfig,
): { to: Address; data: Hex; gas: bigint } {
	const executionGas = group.reduce((sum, call) => sum + call.executionGas, 0n);
	const relayedCall: SafeRelayCall = group.length === 1 ? group[0] : encodeMultiSendCall(relayingSafe.multiSend, group);

	const data = encodeSafeRelayTransaction(owner, relayedCall);
	const gas = withGasBuffer(executionGas + EXEC_TRANSACTION_GAS_OVERHEAD + calldataGas(data));
	return { to: relayingSafe.safe, data, gas };
}

async function submitTransaction(
	client: ReturnType<typeof createWalletClient>,
	chain: ReturnType<typeof extractChain>,
	account: ReturnType<typeof privateKeyToAccount>,
	to: Address,
	data: Hex,
	gas: bigint,
	maxFeePerGas: bigint,
	maxPriorityFeePerGas: bigint,
	nonce: number,
	chainId: number,
): Promise<void> {
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
