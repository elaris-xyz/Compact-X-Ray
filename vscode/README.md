# Compact X-Ray for VS Code

Shows, in the editor, what a Midnight Compact contract makes public:

- **On every save**, each line where a private value reaches the public side gets an information
  diagnostic (`Public: amount → revealedBids (exact value)`), with the compiler's path as related
  locations. Advice (guessable hashes, `ownPublicKey()` used for authorization, constant salts) shows
  as warnings.
- **Above each circuit**, a code lens: `🩻 publishes amount (exact value) → revealedBids`.
- **Status bar**: number of disclosures and warnings; click it for the visual report beside the code.
- Commands: *Analyze this contract*, *Open visual report*, *Check every disclose()*, *Write privacy
  policy (.xray.json)*.

## Install

1. Download `compact-xray-<version>.vsix` from the
   [releases](https://github.com/elaris-xyz/Compact-X-Ray/releases/latest).
2. In VS Code: **Extensions** view → `…` menu → **Install from VSIX…**, pick the file.
   (Or: `code --install-extension compact-xray-<version>.vsix`.)
3. Open a `.compact` file and save it.

It works with no setup: without a local compiler it uses the online service
(`compact-x-ray.vercel.app`) and asks once before sending a contract there.

## Use your own compiler instead

Install the [X-Ray CLI](https://github.com/elaris-xyz/Compact-X-Ray#install) and set
`compactXray.command` (and `compactXray.engine: local` to never go online):

| Where the compiler runs | `compactXray.command` |
|---|---|
| Same machine, X-Ray checked out | `/path/to/compact-xray/bin/compact-xray` |
| Windows editor, compiler in WSL | `wsl -d Ubuntu -- bash /mnt/c/path/to/compact-xray/bin/compact-xray` and `compactXray.wslPaths: true` |

## Build

```bash
npm run package      # bundles the report page, then → compact-xray-<version>.vsix
```
