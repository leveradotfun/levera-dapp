# HoodFrenzy docs (Mintlify)

This folder is a [Mintlify](https://mintlify.com) documentation site. Canonical product math lives in `../HFYC.md`; these pages describe the **live implementation** in `contracts/` and call out where the spec and the bytecode differ.

## Preview locally

Requires Node.js 20.17+.

```bash
npm i -g mint
cd docs
mint dev
```

The CLI prints a local URL (typically `http://localhost:3000`).

## Validate

```bash
cd docs
mint validate
```

## Source of truth

| File | Role |
|---|---|
| `HFYC.md` | Product invariants. Wins over historical `DESIGN.md` / `THESIS.md`. |
| `contracts/src/*.sol` | What actually runs. Occupancy curve, fee split, redeem, oracle age. |
| `contracts/THREAT_MODEL.md` | Trusted roles. |
| `contracts/CLONES.md` | EIP-1167, no in-place upgrade. |

If a sentence here conflicts with the Solidity, the Solidity wins. If it conflicts with `HFYC.md` on a product decision that is not yet wired, the page says so.
