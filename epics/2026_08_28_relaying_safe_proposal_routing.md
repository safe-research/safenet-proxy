# Plan: Route Consensus Proposals Through a Relaying Safe

Component: safenet-proxy Cloudflare Worker (`src/queue/consumer.ts`, `src/config/*`, `src/safe/*`, `src/utils/abis.ts`)

---

## Overview

The default oracle used by our consensus contracts charges a fee to the "proposer", defined as `msg.sender` on the `proposeTransaction` call. Today `msg.sender` is either:

- the raw operator EOA (`PRIVATE_KEY`), when a chain has a single consensus config, or
- the shared `multicall3` contract address, when a chain has multiple consensus configs and calls are batched via `aggregate3`.

Neither is the account we actually want to be charged: the raw EOA is a hot signing key that should not need to hold funds, and the multicall3 address is a shared, canonical contract not controlled or funded by us at all. This epic fixes fee attribution by introducing a dedicated **relaying Safe** per chain that becomes the on-chain proposer (and fee payer) for every consensus submission, while the operator EOA remains the sole signer, acting as a threshold-1 owner of that Safe.

Steps (phases):

1. Remove multicall3 support for all paths — submit one transaction per consensus config instead of aggregating.
2. Add a reusable capability to execute a Safe transaction where the threshold is 1 and our account is an owner (single-signature `execTransaction`, no coordination needed).
3. Add configuration for a relaying Safe per chain.
4. Route every consensus proposal through the relaying Safe's `execTransaction`, so the Safe — not the EOA or multicall3 — is `msg.sender` on the consensus contract and holds the funds needed to pay oracle fees.
5. Remove this epic spec once the above has shipped.

---

## Architecture Decision

Move fee-paying/calling responsibility from the raw operator EOA (optionally batched via multicall3) to a single dedicated relaying Safe per chain. The operator EOA keeps signing, but now signs Safe transactions rather than calling consensus contracts directly. Because the relaying Safe's threshold is 1 and the EOA is one of its owners, a single EIP-712 signature is sufficient to satisfy `execTransaction`'s signature check — no additional co-signers, no Safe Transaction Service round-trip, and no change to the fully-automated nature of the service.

This makes the relaying Safe the account the oracle sees as "proposer", so it is the account that must hold funds to cover oracle fees — decoupling fee funding from the raw signer key and from whatever multicall3 aggregation happened to apply previously.

Multicall3 batching is dropped entirely: once every proposal is wrapped in its own Safe transaction, aggregating multiple `proposeTransaction` calls into one `aggregate3` call no longer serves its original purpose (reducing the number of top-level EOA transactions) and it is what caused `msg.sender` to become the multicall3 contract in the first place. Removing it also removes the multicall3-chain-support constraint currently enforced in `configSchema`.

### Alternatives Considered

- **Keep multicall3, but call it from inside the Safe via `delegatecall`.** This would preserve `msg.sender == relayingSafe` for a batched call. Rejected: Safe `operation = 1` (delegatecall) transactions can clobber the Safe's own storage and are broadly considered unsafe unless the target contract is purpose-built for delegatecall — multicall3 is not. Instead, each `RELAYING_SAFES` entry configures a per-chain Safe `MultiSend` contract address alongside the Safe address: `MultiSend` *is* purpose-built for this (it never writes storage, only loops over calls), so it lets a batch of wrapped `proposeTransaction` calls still land in a single `execTransaction` without the storage-clobbering risk multicall3-via-delegatecall would carry.
- **Keep using the Safe Transaction Service (propose + confirm) even though threshold is 1.** Rejected: adds an external dependency and network round-trip for a case where a single local signature already satisfies the Safe's threshold on-chain — `execTransaction` can be called directly.
- **Fund the raw EOA directly instead of introducing a Safe.** Rejected per the explicit requirement that transactions be proposed via a Safe that holds the funds, which keeps the hot signing key from also being a custody target.

---

## Tech Specs

- **New Safe ABI functions** (`src/utils/abis.ts`): `execTransaction`, `nonce()`, and `getOwners()` / `getThreshold()` for a runtime sanity check.
- **Signing**: `execTransaction` needs a signature over the Safe's EIP-712 `SafeTx` typehash. With a single threshold-1 owner, one EOA signature (via `signTypedData`) is sufficient; no signature aggregation is needed.
- **New config — `RELAYING_SAFES`**: `chainId -> { safe, multiSend }` (both `checkedAddressSchema`), following the same `jsonStringToRecord` pattern as `RPC_URLS`, but optional per chain (unlike `RPC_URLS`/`CONSENSUS_CONFIGS`) — a chain with no entry falls back to the current direct-call behavior instead of failing config validation. This lets chains adopt a relaying Safe incrementally. `multiSend` is the chain's deployed Safe `MultiSend` contract address, stored alongside `safe` so Phase 4 can batch multiple wrapped calls into a single `execTransaction` via `MultiSend`.
- **Runtime invariant check**: before use, confirm the configured relaying Safe has threshold `1` and that the operator account is among its owners; log and skip that chain's submissions on violation, consistent with the existing error-tolerant pattern in `consumer.ts` (log + continue, no retries).
- **Nonce handling**: the relaying Safe has its own on-chain nonce namespace, separate from the EOA's transaction nonce. It needs to be fetched and incremented per batch the same way `baseNonce` is handled today for the EOA.
- **Gas estimation**: current flat constants (`PROPOSE_TRANSACTION_GAS`, `ORACLE_GAS_OVERHEAD`) size the inner consensus call only; they need a further fixed overhead added for the wrapping `execTransaction` (signature verification + inner call dispatch).
- **Docs**: update `README.md`'s `CONSENSUS_CONFIGS` description (currently states proposals are aggregated "via a single multicall3 transaction") and secrets list to document `RELAYING_SAFES`, and note that the relaying Safe(s) must be funded to cover oracle fees.

---

## Implementation Phases

### Phase 1 — Remove multicall3 support
*Independent PR. Can run in parallel with Phases 2 and 3.*

- `src/queue/consumer.ts`: remove `encodeMulticall` and the `multicall3Abi` import; submit one transaction per consensus config instead of aggregating into `aggregate3`.
- `src/config/schemas.ts`: remove the multicall3-chain-support `superRefine` check.
- `src/config/schemas.test.ts`, `src/queue/consumer.test.ts`: remove multicall-specific assertions, add coverage for "submits one transaction per consensus config" and updated per-transaction nonce sequencing (a batch of *K* queue messages × *C* consensus configs now yields *K*×*C* sends per chain instead of *K*).
- `README.md`: update the `CONSENSUS_CONFIGS` description to drop the multicall3 reference.

### Phase 2 — Safe `execTransaction` execution capability
*Independent PR, additive only, not wired into `consumer.ts` yet. Can run in parallel with Phases 1 and 3.*

- New module (e.g. `src/safe/relay.ts`): build a Safe transaction envelope for an arbitrary `(to, data)` call, sign it for threshold-1 execution with the operator account, and produce `execTransaction` calldata.
- `src/utils/abis.ts`: add `execTransaction`, `nonce`, `getOwners`, `getThreshold`.
- Unit tests for signature construction and calldata encoding using mocked clients, following the mocking conventions already established in `consumer.test.ts`.

### Phase 3 — Relaying Safe configuration
*Independent PR, config-only. Can run in parallel with Phases 1 and 2.*

- `src/config/schemas.ts`: add `RELAYING_SAFES` (`jsonStringToRecord(relayingSafeConfigSchema)`, defaulting to `{}`, where `relayingSafeConfigSchema` is `{ safe: checkedAddressSchema, multiSend: checkedAddressSchema }`) — no cross-field requirement; a missing entry for a chain is valid and means that chain has no relaying Safe configured.
- `.dev.vars.sample`, `README.md`: document the new secret.
- `src/config/schemas.test.ts`: cover parsing and validation errors for the new field.
- No behavioral change — the config is parsed but unused until Phase 4.

### Phase 4 — Route proposals through the relaying Safe
*Depends on Phases 1–3 being merged first.*

- `src/queue/consumer.ts`: build the inner `proposeTransaction` calldata as today (minus multicall), then use Phase 2's relay helper to wrap it as an `execTransaction` call to `RELAYING_SAFES[chainId]`, signed by the operator account, instead of sending directly to the consensus contract. If a chain has no `RELAYING_SAFES` entry, fall back to sending the `proposeTransaction` call directly (today's behavior) rather than skipping the chain.
- Add the runtime owner/threshold sanity check from the Tech Specs against the configured relaying Safe.
- Update gas estimation constants to include `execTransaction` overhead.
- Update `consumer.test.ts` cases (direct-address send, oracle gas overhead, etc.) to assert calls now target the relaying Safe with `execTransaction` calldata wrapping the inner `proposeTransaction` call.
- `README.md` / `.dev.vars.sample`: document the final relationship between `PRIVATE_KEY` (a threshold-1 owner of the relaying Safe), `RELAYING_SAFES`, and `CONSENSUS_CONFIGS`, and the requirement that the relaying Safe hold funds for oracle fees.

### Phase 5 — Remove this epic spec
- Delete `epics/2026_08_28_relaying_safe_proposal_routing.md` once Phases 1–4 have shipped and been verified.

---

## Open Questions and Assumptions

- **Granularity of `RELAYING_SAFES`**: assumed one relaying Safe per chain, matching the granularity of `RPC_URLS`. If different consensus configs on the same chain need isolated fee funding, `RELAYING_SAFES` would instead need to key off consensus config rather than chain.
- **Use of `multiSend` in Phase 4**: Phase 3 only stores the per-chain `MultiSend` address; whether Phase 4 actually batches multiple wrapped `proposeTransaction` calls into one `execTransaction` via `MultiSend`, or keeps sending one `execTransaction` per call and holds `multiSend` in reserve, is a Phase 4 design decision.
- **Invariant check frequency**: assumed checking the relaying Safe's threshold/owner status once per cold start (cached) rather than on every batch, to avoid an extra RPC round-trip per invocation; needs confirmation.
- **Relaying Safe nonce source**: assumed fetched fresh via `nonce()` per batch (mirroring the current `getTransactionCount` pattern for the EOA), assuming no other party submits transactions through the same relaying Safe concurrently.
- **Funding operations**: which relaying Safe(s) get funded, on which chains, and with what token for oracle fees is an operational concern out of scope for this epic, but the funding requirement must be documented in the README.
