import { parseAbi } from "viem";

const SAFE_TRANSACTION_STRUCT =
	"struct SafeTransaction {uint256 chainId; address safe; address to; uint256 value; bytes data; uint8 operation; uint256 safeTxGas; uint256 baseGas; uint256 gasPrice; address gasToken; address refundReceiver; uint256 nonce;}";

// Deprecated consensus contract interface, used for consensus configs without an oracle.
export const BETA_CONSENSUS_FUNCTIONS = parseAbi([
	SAFE_TRANSACTION_STRUCT,
	"function proposeTransaction(SafeTransaction transaction) external returns (bytes32 transactionHash)",
]);

export const CONSENSUS_FUNCTIONS = parseAbi([
	SAFE_TRANSACTION_STRUCT,
	"function proposeTransaction(address oracle, bytes oracleData, SafeTransaction transaction) external returns (bytes32 transactionHash)",
]);
