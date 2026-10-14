# ZIP extraction compatibility adapter

Exports one CommonJS async function: `extract(zipPath, options)`.
`options.dir` is absolute. Optional `onEntry(entry, zipfile)`,
`defaultDirMode` and `defaultFileMode` keep the existing consumer contract.
The promise resolves only after all entries and internal links are checked.
Paths and symlink contents are untrusted. Existing links are never used as
write parents or overwritten. Relative links contained within the root are
supported for Electron Framework archives. No network or application state.
The caller exclusively owns the destination during extraction and supplies
trusted callbacks. Other processes with permission to mutate that directory
must be excluded by the caller; this adapter does not implement filesystem
sandboxing against a concurrent privileged local process.

The managed-module acceptance entrypoint is `contract.test.ts`: it loads the
package's published CommonJS entrypoint, exercises `contract.example.ts`, and
checks promise completion, asynchronous callback rejection propagation, and
absolute output directory validation from a consumer's perspective. The existing
`test/extract.test.cjs` suite owns the archive and link attack regression matrix.
Run both with `node --test packages/safe-extract-zip/contract.test.ts packages/safe-extract-zip/test/*.test.cjs`.
