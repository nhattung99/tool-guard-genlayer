# ToolGuard

ToolGuard escrows a GEN deposit for short-term equipment rental on GenLayer. The two people agree on a fixed damage payout up front. The owner submits condition evidence before handover, and the renter submits evidence at return. The contract holds the GEN and pays it out only after a binary `NO_DAMAGE` or `DAMAGED` verdict.

> ToolGuard needs GenLayer. An ordinary EVM contract cannot read unstructured condition photos and compare them, and a human arbitrator is too expensive for small peer-to-peer rentals. GenLayer's decentralized AI consensus can do that comparison at near-zero cost.

## The problem

Lending a drill, a bike, a camera, or camping gear between two people gets stuck on one question at return: was the damage already there, or did it happen during the rental? A human referee for every small rental costs too much.

ToolGuard holds the deposit in one intelligent contract:

1. The renter creates the rental, sends GEN as the deposit, names the owner, describes the item, sets the fixed damage payout, and sets a return deadline.
2. The owner submits evidence links from before handover. The status becomes `RENTED`.
3. The renter submits evidence links from the return.
4. `resolve_rental` fetches both sets, asks the AI, and validators accept the result only when they share the same binary verdict and the same side of the confidence threshold of 60.
5. `NO_DAMAGE` refunds the full deposit to the renter. `DAMAGED` pays the owner only the amount both sides fixed in advance, and the renter receives the remainder.
6. Confidence below 60 becomes `DISPUTED` only when the validators are also below 60. The renter can submit clearer evidence and ask again.
7. If the deadline passes and the renter never reports a return, the owner calls `claim_no_return_forfeit` and receives the full deposit. This path does not call the AI.
8. If the deadline passes and the owner never submits handover evidence, the renter calls `claim_missed_handover_refund` and receives the full deposit. This path does not call the AI.
9. `create_rental` rejects a deadline that is not strictly in the future.

## Honest limit

Personal equipment rental has no public registry, insurer, or regulator for the item. The contract cannot check an independent ledger of the equipment.

The comparison comes from the two parties filing evidence at different times: the owner before handover, the renter at return. Neither side alone controls both records. That is a practical form of independence. It is not an official third-party source, and it is not absolute fraud protection. Both sides can still submit untrue photos.

`reference_urls` are optional extra evidence. Failures while fetching those URLs are ignored. The before and after URLs must load.

The AI verdict has two values. The `DAMAGED` payout is the fixed amount both sides chose when the rental was created, not a percentage invented by the model. Validators compare the verdict string and which side of 60 the confidence falls on. Different confidence numbers are accepted when they stay on the same side. The leader's exact score cannot choose the payout by itself.

## Architecture

One contract, `contracts/toolguard.py`, class `ToolGuard`, holds the GEN directly. Runner header:

```python
# v0.2.16
# { "Depends": "py-genlayer:1jb45aa8ynh2a9c9xn3b7qqh8sm5q93hwfp7jqmwsfhh8jpz09h6" }
```

Studio APIs used here:

- Caller: `gl.message.sender_address`
- Incoming GEN: `gl.message.value` on `@gl.public.write.payable`. Studio rejects a non-zero value on a method that is only `@gl.public.write`.
- Outgoing GEN to a normal wallet: the EVM interface `_Wallet(address).emit_transfer(value=u256(amount))`. `gl.get_contract_at` is for another intelligent contract. Studionet returns `Contract not found` when the recipient is a wallet.
- Time: `gl.message.datetime`, converted to Unix seconds with `datetime`
- Not used: `gl.transfer`, `gl.message.sender`, or `gl.block.timestamp`

`retry_resolution` transfers only a side whose `owner_paid` or `renter_refunded` flag is still false. A flag that is already true is never cleared and is never paid again.

## Money

Every amount is an integer number of wei. 1 GEN = 10^18 wei. The contract does not use `float`. The frontend does not use `parseFloat`, `Math.round`, `Math.floor`, or `Math.ceil` next to money values.

| Place | Input | Calculation | Output |
| --- | --- | --- | --- |
| `create_rental` | `gl.message.value` on the payable method | `bigint(int(value))`, reject `<= 0` | `deposit_amount` |
| `create_rental` | `damaged_payout_to_owner` | reject `<= 0` or `>= deposit` | the agreed amount, stored as-is |
| `NO_DAMAGE` | `deposit_amount` | one `emit_transfer` to the renter | full deposit back, `renter_refunded` |
| `DAMAGED` owner | `damaged_payout_to_owner` | one `emit_transfer` while `owner_paid` is false | the fixed amount |
| `DAMAGED` renter | `deposit_amount - damaged_payout_to_owner` | bigint subtraction, `emit_transfer` while `renter_refunded` is false | the remainder |
| Deadline passed, no return | `deposit_amount` | full `emit_transfer` to the owner, no AI | `EXPIRED_FORFEITED`, `owner_paid` |
| Deadline passed, no handover | `deposit_amount` | full `emit_transfer` to the renter, no AI | `REFUNDED_NO_HANDOVER`, `renter_refunded` |
| `create_rental` | `rental_end_deadline` | reject `<=` the transaction time | the rental is not stored |
| `retry_resolution` | the two bool flags | transfer only the side that is still false | no double pay |
| `parseGenToWei` | a GEN string | split integer and fraction, pad to 18 digits, `BigInt` | wei |
| `formatWeiToGen` | wei | divide and mod `10^18` with `BigInt` | a GEN string |
| `payoutWeiFromPercent` | deposit wei and 10, 25, 50, or 75 | `(deposit * percent) / 100n`, drop a result that is not `0 < x < deposit` | a suggested payout |
| `subtractWei` | two wei values | `BigInt` subtraction | the refund preview |
| `deadlineUnix` | a number of days | Unix seconds, not money | `rental_end_deadline` |

`frontend/scripts/check-no-float-money.cjs` scans `frontend/src/**/*.{js,jsx}` and fails if `parseFloat`, `Math.round`, `Math.floor`, or `Math.ceil` sits near a money variable. It runs in `prebuild` so Vercel can execute it when the app root is `frontend`. `scripts/check-no-float-money.js` at the repo root calls that same file.

## Tests

```bash
pip install -r requirements.txt
python -m pytest tests/test_toolguard.py -q
```

Before each nondet transaction, the tests call `sim_install_mocks` for the web and LLM mocks. The suite covers both verdicts, an overdue forfeit, a refund when the owner never hands the item over, a deadline that is now or in the past, a return reported before handover, confidence 59 reopening the dispute and 60 paying out, validators on the same side and on opposite sides of 60, broken web or JSON, an optional reference URL that fails, an invalid payout, a second resolve, and a failed transfer on each branch (`NO_DAMAGE`, `DAMAGED` owner only, renter only, both, forfeit, and missed handover) followed by one retry that does not pay twice.

## Frontend

The Vite app lives in `frontend/`. The chain is `studionet`. `VITE_CONTRACT_ADDRESS` is set in `frontend/.env` and `frontend/.env.production`. If that variable is empty, the page still opens, shows a banner, and does not send a transaction.

```bash
cd frontend
npm install
npm run dev
```

GitHub: `https://github.com/nhattung99/tool-guard-genlayer.git`. The Vercel project is `tool-guard-genlayer`, and the root directory is `frontend`.

## Deployed Contract

`0x8159d1C50E7538E50f16c1E797C81d48131b5D43`

https://genlayer-explorer.vercel.app/address/0x8159d1C50E7538E50f16c1E797C81d48131b5D43

Deploy on [studio.genlayer.com](https://studio.genlayer.com), network studionet. Do not switch the app to testnet.

1. Open Studio and select studionet.
2. Paste `contracts/toolguard.py`. The constructor takes no arguments.
3. Deploy and wait for `Result: SUCCESS`.
4. Write the deployed address into `frontend/.env` as `VITE_CONTRACT_ADDRESS`.

## Known issue

Paying a wallet sends an external message. An immediate failure, such as a zero value, an insufficient balance, or a rejected call, sets `PAYOUT_FAILED`. `retry_resolution` pays only the side that is still unpaid.

If a child message fails after the parent transaction has already been accepted, a flag can be true while the destination wallet has not received the funds. A retry does not touch a side already marked paid, so it does not pay twice, and it also cannot see a child that failed later.
