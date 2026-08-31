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

// Subset of the Safe contract interface needed to relay a call through a threshold-1 Safe.
export const SAFE_RELAY_FUNCTIONS = parseAbi([
	"function execTransaction(address to, uint256 value, bytes data, uint8 operation, uint256 safeTxGas, uint256 baseGas, uint256 gasPrice, address gasToken, address refundReceiver, bytes signatures) external payable returns (bool success)",
	"function nonce() external view returns (uint256)",
	"function getOwners() external view returns (address[] owners)",
	"function getThreshold() external view returns (uint256)",
]);

// Safe's MultiSend library, used to batch multiple calls into a single `execTransaction`
// by having the Safe `delegatecall` into it.
export const MULTI_SEND_FUNCTIONS = parseAbi(["function multiSend(bytes memory transactions) public payable"]);
