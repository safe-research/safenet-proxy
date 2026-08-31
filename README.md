## Safenet Proxy

### Development setup

- Install dependencies
```sh
npm install
```

### Cloudflare Proxy Deployment

The following secrets must be set before deployment. This can be done via the Cloudflare dashboard or the wrangler CLI:

```sh
# Hex-encoded private key used to sign transactions
echo "0xabc..." | npm exec -- wrangler secret put PRIVATE_KEY

# JSON object mapping chain ID → RPC URL
echo '{"11155111":"https://sepolia.infura.io/v3/...","100":"https://rpc.gnosischain.com"}' \
  | npm exec -- wrangler secret put RPC_URLS

# JSON object mapping chain ID → list of consensus configs (address + optional oracle).
# Each safe transaction is proposed individually to every address in the list,
# unless a config entry sets an oracle, in which case it is submitted via the oracle instead.
echo '{"11155111":[{"address":"0xAbc..."}],"100":[{"address":"0xDef..."},{"address":"0x123...","oracle":"0x456..."}]}' \
  | npm exec -- wrangler secret put CONSENSUS_CONFIGS

# JSON object mapping chain ID → relaying Safe config (Safe address + its
# MultiSend contract address on that chain). When set for a chain,
# every proposal on that chain is routed through the Safe's execTransaction
# instead of calling the consensus contract directly, so the Safe (not
# PRIVATE_KEY's account) is the onchain proposer and fee payer. Each relaying
# Safe must have PRIVATE_KEY's account as an owner with threshold 1, and must
# be funded on its chain to cover oracle fees. A chain with no entry here
# falls back to calling the consensus contract directly. Proposals routed
# through a relaying Safe are batched into as few execTransaction calls as
# possible via the Safe's MultiSend contract, capped by MAX_BATCH_GAS (a
# non-secret var, defaults to 5,000,000 gas — see wrangler.jsonc) to stay
# clear of the chain's block gas limit.
echo '{"11155111":{"safe":"0xAbc...","multiSend":"0x123..."},"100":{"safe":"0xDef...","multiSend":"0x456..."}}' \
  | npm exec -- wrangler secret put RELAYING_SAFES
```

[For generating/synchronizing types based on your Worker configuration run](https://developers.cloudflare.com/workers/wrangler/commands/#types):

```sh
npm run cf-typegen
```

Pass the `CloudflareBindings` as generics when instantiation `Hono`:

```ts
// src/index.ts
const app = new Hono<{ Bindings: CloudflareBindings }>()
```

Once everything is setup the service can be deployed:

```sh
npm run deploy
```

You can test your service by triggering a request against it:

```sh
curl http://localhost:8787/propose \
    -H "Accept: application/json" \
    -H "content-type: application/json" \
    -d '{"type":"EXECUTED_MULTISIG_TRANSACTION","chainId":"1","address":"0x1280C3d641ad0517918e0E4C41F4AD25f6b39144","safeTxHash":"0x20e178f2ce590c235d30a6e99a78e799053f36bafe2d2022a642be03cb89058c"}'
```

## Planning Epics

When developing larger epics spanning over multiple PRs with an agent (for example a complex feature or big refactor), generate a plan to help guide the agent by outlining the separate phases in the development. It is recommended to use the `/plan-epic` feature from <https://github.com/safe-research/agents> for this.
