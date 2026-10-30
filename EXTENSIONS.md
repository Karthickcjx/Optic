# Optic extension API v1

Open **Extensions** using the puzzle icon in the activity rail. Choose **Install from folder**, review the manifest and permissions, install, then enable. Commands appear on the extension card and return text or table panels. Disable, restart and uninstall are available on each card. To update a bundle, disable it and install the new folder with the same ID; the review screen asks to replace it. Replacements start disabled. **Safe Mode** stops all hosts and persists across restarts without forgetting enabled choices.

Try `examples/extensions/context-summary`. A bundle contains exactly two required files: `optic-extension.json` (up to 20 KB) and `extension.js` (up to 1 MB). Additional files are ignored; compile dependencies into the single JavaScript file. Network imports, Node modules and filesystem access are unavailable.

The manifest declares `apiVersion: 1`, a unique `publisher.name` ID, a name, semantic `major.minor.patch` version, description, permissions, and up to 20 command IDs/titles. Unknown manifest fields and duplicate commands are rejected. The only optional permission is `context.read`: it provides the selected cluster's name and namespace **at command invocation**, not credentials, server addresses or resource data. No permission means an empty context.

Use the `OpticExtensionAPI`, `ExtensionContext` and `ExtensionPanel` types in `src/shared/extensions.ts` when authoring TypeScript. Declare `optic: OpticExtensionAPI` in your source, compile to a browser IIFE and save it as `extension.js`.

```js
optic.registerCommand('hello', async context => ({
  title: 'Hello',
  text: context.clusterName || 'Choose a cluster'
}));
```

Register command IDs declared in the manifest. Each handler receives a frozen context and returns a panel or a Promise of one. Panels support `title`, optional `text`, optional `columns` and `rows`. Output is rendered as escaped text, never HTML. Limits: 20,000 text characters, 10 columns, 200 rows, 1,000 characters per cell and 250 KB serialized result. Commands and activation have a five-second deadline; failures stop that host and show a restart action.

Each enabled extension runs in a hidden, separate Electron sandboxed renderer with no preload, Node integration, network requests, popups, downloads or browser permissions. It receives no main-process IPC bridge. Session storage is ephemeral. Native app code validates all command output. This is a restricted browser environment, not Node's `vm` sandbox. Chromium bugs and resource exhaustion remain possible: install only trusted code. Bundles are unsigned; the review fingerprint verifies content consistency, not publisher identity.

Optic stores reviewed snapshots privately in its profile, verifies their digest on startup, and restores enabled hosts on restart. Invalid stored bundles are not executed. Up to 50 bundles may be installed and 10 may run simultaneously. There is no marketplace, automatic update system, arbitrary React injection, Kubernetes write API, shell API or persistent extension storage in v1.

Development checks: `npm test` and `npm run test:extensions` (builds first and runs a sandbox/lifecycle Electron smoke test in a temporary profile).
