# Plan: Add Oracle Transaction Support

Component: `src/config` (chain/consensus configuration) and `src/queue/consumer.ts` (submission process).

---

## Overview

Today each chain in `CONSENSUS_ADDRESSES` maps to a flat list of consensus contract addresses, and every proposed Safe transaction is submitted to all of them via `proposeTransaction` (batched through multicall3 when there is more than one address).

Some consensus contracts require submission through an oracle instead. This epic:

1. Replaces the flat `CONSENSUS_ADDRESSES: Record<chainId, Address[]>` configuration with a `CONSENSUS_CONFIGS: Record<chainId, ConsensusConfig[]>` configuration, where each entry is `{ address, oracle? }`.
2. Changes the submission process so that, for any consensus entry with an `oracle` configured, the transaction is submitted via `proposeOracleTransaction(oracle, oracleData, transaction)` (with `oracleData` hardcoded to `0x`) instead of `proposeTransaction(transaction)`.

The change is split into two sequential PRs: one that restructures configuration only (no submission behavior change), and one that adds the oracle submission path on top of it.

---

## Architecture Decision

**Configuration shape.** `CONSENSUS_ADDRESSES` (`Record<chainId, Address[]>`) becomes `CONSENSUS_CONFIGS` (`Record<chainId, ConsensusConfig[]>`), where `ConsensusConfig = { address: Address; oracle?: Address }`. The value continues to be parsed via the existing `jsonStringToRecord` helper in `src/config/schemas.ts` (same pattern already used for `RPC_URLS` and the current `CONSENSUS_ADDRESSES`), which accepts either a JSON string or an already-parsed object. Only the shape of the array elements changes, from a bare address string to a small object — validated with a new `consensusConfigSchema` (`{ address: checkedAddressSchema, oracle: checkedAddressSchema.optional() }`).

Since all values here are public, the config continues to live in `wrangler.jsonc`'s `vars` (as `CONSENSUS_ADDRESSES` does today), but authored as a **native nested JSONC object** rather than an escaped JSON string. Wrangler's `vars` accept arbitrary JSON values (objects, arrays, booleans, numbers), not just strings, and `jsonStringToRecord` in `src/config/schemas.ts` already passes non-string input straight to `z.record` unchanged (`typeof val === "string" ? JSON.parse(val) : val`) — so no code change is needed to support this, only a change to how the value is authored in `wrangler.jsonc`:

```jsonc
// Mapping of chain ID to a list of consensus configs (address + optional oracle)
"CONSENSUS_CONFIGS": {
  "100": [
    { "address": "0x223624cBF099e5a8f8cD5aF22aFa424a1d1acEE9" },
    { "address": "0x21c2B6C8473051fb6dED83fE6F0609e53747Cbb4", "oracle": "0x..." }
  ]
}
```

This directly addresses the concern that hand-escaping JSON inside a string is error-prone for config changes: as a native object, additions/edits are plain JSONC (with normal syntax highlighting, diffs, and even comments per entry) instead of a single opaque escaped-string blob. The `RPC_URLS` var could in principle be migrated the same way, but that's an existing, unrelated var and is left out of scope here to keep this PR focused on `CONSENSUS_CONFIGS`.

Locally, `.dev.vars` (used by `wrangler dev` / `.dev.vars.sample`) is a flat `KEY=value` file and does **not** support nested objects, so `CONSENSUS_CONFIGS` there still has to be a JSON string on one line — `jsonStringToRecord`'s string-or-object handling is exactly what lets the same schema accept the native-object form in `wrangler.jsonc` and the string form in `.dev.vars` without any branching code.

The cross-field validation already in `configSchema.superRefine` (multicall3 must be available on a chain when it has more than one consensus entry) carries over unchanged, since it only depends on array length, not element shape.

### Alternatives Considered

- **Parallel `CONSENSUS_ORACLES: Record<chainId, Record<address, oracleAddress>>` map** alongside the existing `CONSENSUS_ADDRESSES`. Rejected: two structures that must stay in sync per chain/address are more error-prone to author and validate than a single array of objects, and would need extra cross-field checks to catch typos/mismatches between the two maps.
- **External JSON/TOML file(s) included from `wrangler.jsonc`** (one config file per chain, referenced from the main config). Rejected: Wrangler's config format (JSON/JSONC/TOML) has no built-in `$include`/`extends`-style mechanism for pulling in external files as sub-config — this would require a custom build-time preprocessing step to inline the file(s) before `wrangler deploy`/`dev`, which adds tooling complexity disproportionate to the benefit for a config this small.
- **String-encoded composite value** (e.g. `"address|oracle"` per array entry). Rejected: harder to read and validate than a small JSON object, and Zod already gives us structured, typed validation for free.
- **Keep authoring it as an escaped JSON string in `wrangler.jsonc`** (today's convention for `CONSENSUS_ADDRESSES`/`RPC_URLS`). Rejected for the new var: strictly worse than a native JSONC object for readability/diffs/maintenance with no offsetting benefit, since the parsing layer already supports both forms transparently.

---

## Tech Specs

### Configuration (`src/config`)

- `src/config/schemas.ts`:
  - Add `consensusConfigSchema = z.object({ address: checkedAddressSchema, oracle: checkedAddressSchema.optional() })`.
  - Replace `CONSENSUS_ADDRESSES: jsonStringToRecord(z.array(checkedAddressSchema).nonempty())` with `CONSENSUS_CONFIGS: jsonStringToRecord(z.array(consensusConfigSchema).nonempty())`.
  - Update `superRefine` to read from `config.CONSENSUS_CONFIGS` (same length-based checks as today).
- `src/config/types.ts`: export `ConsensusConfig` (inferred from `consensusConfigSchema`).
- `src/config/schemas.test.ts`: update fixtures/assertions for the renamed env var and object-shaped entries; add cases for an entry with `oracle` set and one without.
- `wrangler.jsonc`: rename `CONSENSUS_ADDRESSES` → `CONSENSUS_CONFIGS`, authored as a native nested JSONC object (see Architecture Decision above) instead of an escaped JSON string.
- `.dev.vars.sample`, `README.md`: rename `CONSENSUS_ADDRESSES` → `CONSENSUS_CONFIGS` and update the documented/example shape to include an optional `oracle` field (still a JSON string in `.dev.vars.sample`, since that file format has no native object support).

### Submission process (`src/queue/consumer.ts`, `src/utils/abis.ts`)

- `src/utils/abis.ts`: add to `CONSENSUS_FUNCTIONS`:
  `"function proposeOracleTransaction(address oracle, bytes oracleData, SafeTransaction transaction) external returns (bytes32 transactionHash)"` (reusing the existing `SafeTransaction` struct alias already defined in this ABI).
- `src/queue/consumer.ts`:
  - `processChainMessages` and `submitTransaction` take `ConsensusConfig[]` instead of `Address[]`.
  - New helper, e.g. `encodeProposeCall(config: ConsensusConfig, details: SafeTransactionWithDomain): Hex`, that returns the `proposeOracleTransaction` encoding (`oracleData = "0x"`) when `config.oracle` is set, otherwise the existing `proposeTransaction` encoding.
  - Single-target path (`consensusConfigs.length === 1`): choose between `proposeTransaction`/`proposeOracleTransaction` based on whether that entry's `oracle` is set.
  - Multicall path (`encodeMulticall`): today all targets share one `callData` (same `proposeTransaction` call to every address). Since different entries on the same chain may now have different oracle configs, each target's `callData` must be encoded individually via `encodeProposeCall`, so `calls` becomes `consensusConfigs.map((config) => ({ target: config.address, allowFailure: false, callData: encodeProposeCall(config, details) }))`.
  - `estimateCallGas`-based multicall gas estimate: sum the per-call estimate for each target's actual encoded call data (oracle calls are larger due to the extra `address` + `bytes` params) instead of assuming one uniform call size for all targets.
- `src/queue/consumer.test.ts`: add cases for (a) a single consensus entry with `oracle` set → `proposeOracleTransaction` is called with `oracleData = "0x"`, (b) a multicall batch mixing entries with and without `oracle` → each target receives its own correctly-encoded call data.

---

## Implementation Phases

### Phase 1 — Config restructuring (PR 1)

Rename `CONSENSUS_ADDRESSES` to `CONSENSUS_CONFIGS` and change its element shape to `{ address, oracle? }`, with no submission behavior change (the `oracle` field is parsed and typed but not yet consumed).

- Files: `src/config/schemas.ts`, `src/config/types.ts`, `src/config/schemas.test.ts`, `wrangler.jsonc`, `.dev.vars.sample`, `README.md`, plus the minimal call-site update in `src/queue/consumer.ts`/`src/queue/consumer.test.ts` needed to keep the build green (reading `.address` off each config entry; behavior identical to today).
- This is a pure config/type change and can be reviewed and merged independently of Phase 2.

### Phase 2 — Oracle submission path (PR 2, depends on Phase 1)

Add `proposeOracleTransaction` to the ABI and implement per-target call-data encoding (single-target and multicall) so entries with `oracle` set submit through the oracle function.

- Files: `src/utils/abis.ts`, `src/queue/consumer.ts`, `src/queue/consumer.test.ts`.
- Depends on the `ConsensusConfig` type and `CONSENSUS_CONFIGS` parsing from Phase 1; not parallelizable with it, but is a small, independently reviewable diff on top.

### Phase 3 — Remove this spec

Once both PRs are merged and deployed, delete `epics/2026_08_06_add_oracle_transaction_support.md`.

---

## Open Questions and Assumptions

- **Full ABI of `proposeOracleTransaction`**: only the signature `function proposeOracleTransaction(address oracle, bytes oracleData, SafeTransaction.T transaction)` was provided, without a return type. Assumption: it returns `bytes32 transactionHash`, mirroring `proposeTransaction`, and the struct is referenced using the existing `SafeTransaction` alias already declared in `CONSENSUS_FUNCTIONS` (rather than introducing a `SafeTransaction.T`-style nested type name, which `viem`'s human-readable ABI parser does not support). Should be confirmed against the actual contract ABI/interface before Phase 2 is implemented.
- **`oracleData`**: hardcoded to `0x` per the request, with no near-term plan to populate it. If a future need arises (e.g. passing a price feed round ID), that would be a separate follow-up epic.
- **No dual-read backward compatibility**: `CONSENSUS_ADDRESSES` → `CONSENSUS_CONFIGS` is treated as a hard rename with no fallback/dual-read shim. Deploying Phase 1 requires updating the Cloudflare var (dashboard or `wrangler`) at the same time the PR is deployed.
- **Absence of `oracle` on an entry** always means "submit via plain `proposeTransaction`" — there is no chain-level or global default oracle fallback.
