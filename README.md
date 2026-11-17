# StreamPay

**MA, Yuechen** · Student ID **21346213** · CSIT5760

StreamPay escrows a fixed ERC-20 deposit. The recipient can withdraw the share earned over time. If the sender cancels before the end, the recipient keeps the accrued share and the sender can claim the remainder separately.

## Install, compile and test

Use Node.js 24.22.1 and pnpm 11.25.0, the tested versions.

```sh
pnpm install --frozen-lockfile --ignore-scripts
pnpm compile
pnpm test
pnpm demo
```

Tests and the settlement demo run on local Hardhat chain 31337. The build uses Solidity 0.8.28, Shanghai and 200 optimizer runs. It uses OpenZeppelin Contracts 5.4.0, Hardhat 2.26.3, ethers 6.14.0 and Hardhat Verify 2.1.3. All direct dependency versions are pinned in [package.json](package.json).

## Sepolia deployments

Both contracts are verified on Sepolia (chain ID 11155111).

| Contract | Address | Block | Evidence |
| --- | --- | ---: | --- |
| MockStreamToken | `0x61928f9a74879CeE86D2434D65619E18E8c40912` | 12149158 | [Deployment](https://sepolia.etherscan.io/tx/0x3f80fea19978d222d5d196fe436abc3c2fd27abddcecdec1caa4a95932c909db) · [Verified source](https://sepolia.etherscan.io/address/0x61928f9a74879CeE86D2434D65619E18E8c40912#code) |
| StreamPay | `0x608E8C677C9Ea162dd776E9a35c4c3eE8323188A` | 12149159 | [Deployment](https://sepolia.etherscan.io/tx/0x11b604337b648f9e110a546ad21bcde5dae0b26980d7fbd06c5a3193157d5550) · [Verified source](https://sepolia.etherscan.io/address/0x608E8C677C9Ea162dd776E9a35c4c3eE8323188A#code) |

The records include the deployer, UTC block times, constructor arguments and independent checks of the receipts, bytecode and verified source. [Report](report.pdf) · [Deployment manifest](deployment/sepolia.json) · [Verification evidence](deployment/sepolia-evidence.json)

To deploy a new pair, use a separate project copy and a test wallet funded with Sepolia ETH. Set `SEPOLIA_RPC_URL`, `PRIVATE_KEY` and `ETHERSCAN_API_KEY` in your local shell. Keep credentials out of Git. Move the existing records to a backup directory before deploying.

```sh
backup_dir=$(mktemp -d)
mv deployment/sepolia.json deployment/sepolia-evidence.json "$backup_dir/"
pnpm compile
pnpm deploy:sepolia
pnpm verify:sepolia
```

## Interact

Start a local node with `pnpm exec hardhat node`. In another terminal, run `pnpm deploy:local`. Use local account 0 as the sender and local account 1 as the recipient. Set `RECIPIENT_ADDRESS` to account 1's address from the node output.

```sh
START=$(($(date +%s) + 90))
END=$((START + 300))
ACTION=create SIGNER_INDEX=0 RECIPIENT="$RECIPIENT_ADDRESS" AMOUNT=1000000 START="$START" END="$END" pnpm interact:local
ACTION=query STREAM_ID=1 pnpm interact:local
```

One SPAY equals 1,000,000 raw units. Creation sends an approval and then funds the escrow. A fresh deployment's first stream ID is 1. The recipient can withdraw 100,000 units once the query shows that amount available. The sender can cancel before `END` and claim the available refund.

```sh
ACTION=withdraw SIGNER_INDEX=1 STREAM_ID=1 AMOUNT=100000 pnpm interact:local
ACTION=cancel SIGNER_INDEX=0 STREAM_ID=1 pnpm interact:local
ACTION=refund SIGNER_INDEX=0 STREAM_ID=1 pnpm interact:local
```

On Sepolia, use `pnpm interact:sepolia` with the same actions and the stream ID from `StreamCreated`. Only the deployer receives the initial SPAY supply. The sender needs enough SPAY for the deposit and both accounts need Sepolia ETH for gas. Each signing call uses index 0 with the appropriate sender or recipient key. Queries need only the RPC URL.

## Security and limitations

The escrow checks roles, funding and claim limits. SafeERC20 and ReentrancyGuard protect token operations. The contract supports its fixed test token and uses block timestamps for accrual. Transactions require gas. Lost keys and direct token donations have no recovery path. Addresses, amounts and schedules are public.

The payment model draws on [Sablier Lockup](https://docs.sablier.com/concepts/lockup/overview). The Solidity contracts use OpenZeppelin's ERC-20, SafeERC20, ReentrancyGuard and Math libraries.

Project code is MIT-licensed. [Licence](LICENCE)
