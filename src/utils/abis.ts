import { parseAbi } from "viem";

export const CONSENSUS_FUNCTIONS = parseAbi([
	// 1. Errors
	"error InvalidRollover()",
	"error GroupNotInitialized()",
	"error GroupNotCommitted()",
	"error InvalidMessage()",
	"error NotSigned()",
	"error WrongSignature()",

	// 2. Enum (Define this before the struct)
	"struct SafeTransaction {uint256 chainId; address safe; address to; uint256 value; bytes data; uint8 operation; uint256 safeTxGas; uint256 baseGas; uint256 gasPrice; address gasToken; address refundReceiver; uint256 nonce;}",

	// 3. Functions
	"function proposeEpoch(uint64 proposedEpoch, uint64 rolloverBlock, bytes32 group) external",
	"function stageEpoch(uint64 proposedEpoch, uint64 rolloverBlock, bytes32 group, bytes32 signature) external",
	"function attestTransaction(uint64 epoch, bytes32 transactionHash, bytes32 signature) external",
	"function proposeTransaction(SafeTransaction transaction) external returns (bytes32 transactionHash)",
	"function proposeOracleTransaction(address oracle, bytes oracleData, SafeTransaction transaction) external returns (bytes32 transactionHash)",
]);
