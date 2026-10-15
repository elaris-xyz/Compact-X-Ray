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

## Setup

The extension calls the Compact X-Ray CLI, which needs the Compact compiler. Set
`compactXray.command`:

| Where the compiler runs | `compactXray.command` |
|---|---|
| Same machine, X-Ray checked out | `/path/to/compact-xray/bin/compact-xray` |
| Windows editor, compiler in WSL | `wsl -d Ubuntu -- bash /mnt/c/path/to/compact-xray/bin/compact-xray` and `compactXray.wslPaths: true` |

## Package

```bash
npx @vscode/vsce package     # → compact-xray-0.1.0.vsix; install with: code --install-extension <file>
```
