# 🩻 Compact X-Ray

**See what a Midnight smart contract makes public — and what stays private — straight from the compiler.**

On Midnight, a Compact contract mixes private data (witnesses, circuit arguments) with public
ledger state. The line between them is `disclose()`, and it is easy to get wrong: a map key, a
branch on a secret, or a hash of a 4-digit PIN all make information public in ways that are not
obvious from reading the code. Even the official docs disagree with the compiler on some of these
(see [Findings](#findings)).

Compact X-Ray answers one question for every contract: **which private value reaches the public
side, how much of it, and through which line of code?**

```
$ compact-xray private-bid.compact

WHAT BECOMES PUBLIC, circuit by circuit
  constructor
    • minimum → ledger minimumBid: the exact value              line 58
  placeBid
    • witness localSecretKey → ledger bidCommitments: a hash of it   line 88, 105
  revealBid
    • amount → ledger revealedBids: the exact value              line 124

STAYS PRIVATE
  ✓ placeBid(amount)
```

## How it works — nothing is guessed

The x-ray does not re-implement Compact's privacy rules. It asks the official compiler:

1. Compile the contract as written (it must compile).
2. Compile a copy with every `disclose(` blanked out (same length, so every line and column stays
   where it was).
3. The compiler now rejects each place a private value would reach the public side, and says
   **what** value (a parameter, a witness), **how much** of it (the value itself, a hash of it, the
   result of a comparison with it), and the **path** it travels to the ledger or to a token
   operation.
4. Those reports are mapped back to circuits, ledger fields and lines, merged, and explained.

So the x-ray is exactly as right as the compiler, and it stays right when the language changes.

## Install

Requirements: Node.js 22+, and the Compact toolchain on `PATH` (or `COMPACT_BIN=/path/to/compact`).

```bash
curl --proto '=https' --tlsv1.2 -LsSf https://github.com/midnightntwrk/compact/releases/latest/download/compact-installer.sh | sh
compact update 0.31.1          # pin the version your contracts target
git clone https://github.com/elaris-xyz/Compact-X-Ray.git && cd Compact-X-Ray && npm install
npx tsx src/cli.ts path/to/contract.compact
```

## Use it

| Command | What it does |
|---|---|
| `compact-xray <c.compact>` | Report what becomes public, circuit by circuit, plus advice |
| `compact-xray init <c.compact>` | Write `.xray.json`: the disclosures the contract makes today, to review and commit |
| `compact-xray check <c.compact>` | Fail if the contract discloses anything the policy does not allow |
| `compact-xray diff <old> <new>` | What a change makes newly public, or no longer public |

Options: `--format text|json|md|sarif|html`, `--out <file>`, `--policy <file>`,
`--fail-on warning|notice|never`, `--deep`. Exit codes: `0` ok, `1` findings that fail the run,
`2` tool error.

Every report starts **in plain words**, one sentence per circuit, for readers who do not read
Compact:

```
IN PLAIN WORDS
  ● When the contract is deployed, anyone watching the chain learns the exact minimum in minimumBid.
  ● When someone calls placeBid, anyone watching the chain learns a fingerprint (hash) of the private
    value localSecretKey in bidCommitments.
  ● When someone calls revealBid, … the exact amount in revealedBids.
```

### `--deep`: which `disclose()` calls actually matter

With `--deep`, X-Ray also compiles the contract once per `disclose()`, each time with only that one
removed. If it still compiles, the compiler does not need it. Across the 15 official example
contracts this finds 44 `disclose()` calls the compiler does not require, most of them inside
`assert(...)` comparisons, which reveal only pass/fail and never need one.

### The privacy policy (`.xray.json`)

A policy is the list of disclosures the author **intends**. Each entry is a fingerprint without line
numbers, so it survives unrelated edits; `*` is a wildcard.

```json
{
  "contract": "private-bid.compact",
  "allow": [
    "constructor: arg minimum -> ledger minimumBid (value)",
    "placeBid: witness localSecretKey -> ledger bidCommitments (hash)",
    "revealBid: arg amount -> ledger revealedBids (value)"
  ]
}
```

If a later change makes `placeBid` write the bid amount, `check` fails:

```
PRIVACY POLICY
  ✗ not in policy: placeBid: arg amount -> ledger revealedBids (value)   line 106
```

### In CI (GitHub Actions)

```yaml
- uses: actions/checkout@v4
- uses: elaris-xyz/Compact-X-Ray@v0
  with:
    contracts: contracts/**/*.compact
    compact-version: 0.31.1
- uses: github/codeql-action/upload-sarif@v3
  if: always()
  with: { sarif_file: compact-xray.sarif }
```

The action writes a Markdown summary to the job page, fails on unapproved disclosures (and on
warnings by default), and produces SARIF so findings appear inline on the pull request.

### Web UI

```bash
npx tsx src/server.ts          # http://127.0.0.1:4400
```

Paste a contract, drop or open several files (a contract and the files it imports), or load one of
the bundled official examples. The map shows private inputs on the left, public state and token
operations on the right, and a line for every disclosure, coloured by how much leaks: the exact
value, a hash, a decision. Click a finding to jump to its line and unfold the path the compiler
traced (`secretKey L77 → derive L87 → persistentHash L73 → bidder L87 → member L88`).

From the page you can download the report as one self-contained HTML file (the same as
`--format html`), download the privacy policy for CI, or copy a Markdown summary for a pull request.

### VS Code

`vscode/` holds an extension (`npx @vscode/vsce package` → `compact-xray-0.1.0.vsix`). On every save
it marks each line where a private value goes public, shows advice as warnings, puts a code lens
above each circuit (`🩻 publishes amount (exact value) → revealedBids`), and opens the visual report
beside the code. It calls the CLI through `bin/compact-xray`; see `vscode/README.md` for WSL setups.

### Hosting it

```bash
docker build -t compact-xray .            # pins COMPACT_VERSION=0.31.1 (build arg)
docker run --rm -p 4400:4400 compact-xray
```

The image runs as a non-root user, with a per-client rate limit (`XRAY_RATE`, requests/minute) and a
compile timeout (`XRAY_COMPILE_TIMEOUT_MS`). Compiling untrusted contracts runs the official compiler
on them: put the container behind a proxy and give it no secrets.

## Advice it gives

| Finding | Why it matters |
|---|---|
| **Guessable hash** — a hash of a small value (`Boolean`, `Uint<≤32>`) is public, with no secret mixed into the same hash | Anyone can hash every possible value and compare. Use `persistentCommit(value, salt)` |
| **Witness published as-is** | The exact private value reaches the ledger |
| **Decision on a secret** — a ledger update depends on a comparison with a private value | Observers learn the outcome of the comparison |
| **Unapproved disclosure** (with a policy) | A change made something newly public |

## Findings

Measured with compiler 0.31.1, language 0.23, on a local Midnight network (ledger 8):

- **Return values are not published.** The compiler requires `disclose()` to *return* a
  witness-derived value, but a probe contract showed the returned value is **not** in the
  transaction that goes on chain (it goes back to the calling DApp). Returning a circuit *argument*
  needs no `disclose()` at all. X-Ray reports returns as "returned to the caller".
- **Arguments to ledger operations must be disclosed**, even a key used only in `m.member(k)` inside
  an `assert`: ledger lookups are public.
- **The compiler tracks control flow**: `if (secret > 5) { a = 1 } else { a = 2 }` reveals the branch.
- **`assert` on a private value** needs no `disclose()`; it reveals one bit (pass/fail).
- **`persistentCommit(value, salt)`** needs no `disclose()`; `persistentHash(value)` does.

## Limitations

- One contract file per run in the web UI (the CLI copies the contract's directory, so local
  `include`/`import` files resolve).
- Commitments are by design not reported: the compiler considers them hiding. Their safety still
  depends on a fresh, secret salt, which no tool can check.
- Severity heuristics (what is "guessable") read declared types; they cannot see the real entropy
  of a value.

## License

Apache-2.0. Bundled example contracts in `examples/` are from
[midnightntwrk/midnight-examples](https://github.com/midnightntwrk/midnight-examples) (Apache-2.0).
