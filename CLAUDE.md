# CLAUDE.md - Safenet Proxy Development Guide

## Project Overview

Safenet Proxy is a Cloudflare Workers-based service that handles blockchain transaction proposals and multisig interactions. It provides endpoints for proposing and managing Safe multisig transactions across multiple blockchain networks.

**Tech Stack:**
- Cloudflare Workers (Wrangler)
- Hono (lightweight web framework)
- TypeScript
- Viem (Ethereum library)
- Biome (linting and formatting)

## Repository Structure

```
src/
├── index.ts                 # Main Hono app entry point
├── config/                  # Configuration and chain definitions
│   ├── chains.ts           # Supported blockchain networks
│   ├── schemas.ts          # Zod validation schemas
│   └── types.ts            # TypeScript type definitions
├── proposals/              # Transaction proposal handling
│   └── handler.ts          # Proposal endpoints
├── safe/                   # Safe multisig interactions
│   ├── service.ts          # Safe contract interactions
│   ├── schemas.ts          # Safe-specific schemas
│   └── types.ts            # Safe types
└── utils/                  # Utility functions
    ├── abis.ts             # Smart contract ABIs
    ├── errors.ts           # Error handling
    └── schemas.ts          # Shared schemas
```

## Development Setup

1. **Install dependencies:**
   ```sh
   npm install
   ```

2. **Environment variables:**
   Required for local development and deployment:
   - `PRIVATE_KEY`: Private key for transaction signing
   - `RPC_URLS`: Ethereum RPC endpoint URL

3. **Generate Cloudflare bindings types:**
   ```sh
   npm run cf-typegen
   ```

## Development Workflow

### Local Development
```sh
npm run dev
```
Starts a local development server on `http://localhost:8787`

### Code Quality

**Linting and Type Checking:**
```sh
npm run check
```
Runs Biome linting and TypeScript type checking

**Auto-fix Issues:**
```sh
npm run fix
```
Automatically fixes Biome linting issues (formatting, imports, etc.)

### Deployment

```sh
npm run deploy
```
Deploys the application to Cloudflare Workers with minification enabled.

Before deploying, ensure:
- All checks pass: `npm run check`
- Required secrets are set (PRIVATE_KEY, RPC_URL)
- Code is committed to the repository

## Testing the Service

Test the `/propose` endpoint:
```sh
curl http://localhost:8787/propose \
    -H "Accept: application/json" \
    -H "content-type: application/json" \
    -d '{"type":"EXECUTED_MULTISIG_TRANSACTION","chainId":"1","address":"0x1280C3d641ad0517918e0E4C41F4Ad25f6b39144","safeTxHash":"0x20e178f2ce590c235d30a6e99a78e799053f36bafe2d2022a642be03cb89058c"}'
```

## Key Guidelines for Development

### Planning
- All tasks should always be planned first
- Add planning information to the `features` folder and follow the [README](./features/README.md) in that folder

### Code Quality
- Run `npm run check` before committing
- Use `npm run fix` to auto-correct formatting issues
- Readable code has priority. In doubt rather create a new method so that it is easier to understand.
- All code must pass TypeScript strict mode checks
- Use Zod for runtime validation of external inputs

### Testing
- All added code should be covered by automated tests
- Use mocks to isolate the test to the relevant code
- Don't oververify mocks, verify observable outcomes (i.e. return values and side effects).

### Type Safety
- Leverage TypeScript's type system - avoid `any` types
- Define types in dedicated `types.ts` files
- Use Zod schemas for API request/response validation

### Git Workflow
- Develop on assigned feature branches (e.g., `claude/create-claude-md-ZF0Wv`)
- Write clear, descriptive commit messages
- Push changes to the designated branch
- Include relevant context in commit messages

### Security Considerations
- Private keys should never be committed to the repository
- All secrets must be set via Cloudflare dashboard or wrangler CLI
- Validate all external inputs with Zod schemas
- Review smart contract interactions in `src/safe/service.ts`

## Important Files for Claude

- **src/index.ts** - Main application entry point, route definitions
- **wrangler.toml** - Cloudflare Workers configuration
- **package.json** - Dependencies and npm scripts
- **tsconfig.json** - TypeScript configuration
- **biome.json** - Linting and formatting configuration

## Common Tasks

### Adding a New Endpoint
1. Create a handler in the appropriate directory (e.g., `src/proposals/`)
2. Define request/response schemas using Zod
3. Register the route in `src/index.ts`
4. Add TypeScript types
5. Test locally with `npm run dev`

### Updating Chain Configuration
- Modify `src/config/chains.ts` to add/update networks
- Update corresponding types in `src/config/types.ts`
- Add validation schemas in `src/config/schemas.ts`

### Working with Safe Contracts
- Smart contract interactions are in `src/safe/service.ts`
- Contract ABIs are defined in `src/utils/abis.ts`
- Use Viem for reading and writing transactions

## Git Branch Naming Convention

Branch names must follow the pattern `<prefix>/<description>` where:

- `<prefix>` is one of: `feat`, `fix`, `docs`, `refactor`, `chore`, `test`, `claude`
- `<description>` is kebab-case and meaningfully describes the specific change being made

### Good examples

```
feat/add-frost-key-rotation
fix/staking-withdrawal-overflow
docs/update-validator-setup-guide
refactor/simplify-consensus-state-machine
chore/bump-viem-to-v3
claude/add-claude-md-branch-rules
```

### Bad examples

```
dev
wip
my-branch
feat/wip
fix/stuff
```

Always use a name that makes the purpose of the branch immediately clear to anyone reading it.

## Troubleshooting

**Build Fails:**
- Run `npm run check` to see type errors
- Run `npm run fix` to auto-correct formatting

**Deployment Issues:**
- Verify secrets are set: `wrangler secret list`
- Check wrangler version: `npm run deploy` uses `^4.4.0`

**Type Generation:**
- Run `npm run cf-typegen` after updating `wrangler.toml`

## References

- [Cloudflare Workers Documentation](https://developers.cloudflare.com/workers/)
- [Hono Documentation](https://hono.dev/)
- [Viem Documentation](https://viem.sh/)
- [Zod Documentation](https://zod.dev/)
