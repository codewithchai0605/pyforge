# cordova-plugin-saf

Storage Access Framework access for Android: pick a folder via the system
picker, get a persistent grant to it, and list/read/write/create/delete/
rename documents inside it — all through `DocumentFile`/`ContentResolver`,
never a raw file path. Pure Java + the AndroidX `documentfile` library, no
native C++ — SAF's entire API
surface is Java/Android SDK.

## Why SAF, not just `cordova-plugin-file`

Since Android 10 (API 29), apps can't reliably read/write arbitrary paths
on external storage anymore ("scoped storage") — `cordova-plugin-file`
still covers app-private storage and a few legacy cases fine, but reaching
into a user-chosen folder anywhere else on the device requires SAF's
`ACTION_OPEN_DOCUMENT_TREE` intent and its own URI-based addressing.
`src/fileSystem/index.ts` routes a `content://` URL to this plugin
(`externalFs`) and everything else to `cordova-plugin-file`
(`internalFs`) — see that file's comments.

## Action reference (JS side: `src/native/saf.ts`)

| Action | Args | Returns |
|---|---|---|
| `pickFolder` | — | tree URI string (rejects if cancelled or not writable) |
| `listPersistedFolders` | — | `{url, name}[]` — previously granted folders still valid |
| `releaseFolder` | `url` | — |
| `stat` | `url` | `{name, isDirectory, size, lastModified, mimeType, canWrite}` |
| `listDir` | `url` | array of the same shape, plus `url` per entry |
| `readFile` | `url, encoding?` | file content (`'utf8'` default, or `'base64'`) |
| `writeFile` | `url, content, encoding?` | — |
| `createFile` | `parentUrl, name, mimeType?` | the new entry |
| `createDirectory` | `parentUrl, name` | the new entry |
| `delete` | `url` | — |
| `rename` | `url, newName` | the new entry — **the url may change**, see below |

## The one real SAF gotcha this plugin has to handle

A URL fresh out of `pickFolder()` is a *tree* URI — it doesn't carry a
document id yet. `DocumentFile.fromTreeUri()` is what turns that into the
root document; everything else this plugin hands back (that root's own
`.getUri()`, or any child's `url` from `listDir()`) is already a proper
*document* URI and resolves directly via `fromSingleUri()`.
`SafPlugin.resolveDocumentFile()` tells the two apart with
`DocumentsContract.isDocumentUri()` so the rest of the plugin never has to
think about which shape of URL it was handed.

The other one: `DocumentFile.renameTo()` isn't guaranteed to produce a URI
that's just the old one with a new filename swapped in — `rename()`
re-reads `.getUri()` off the *same* `DocumentFile` instance after the call
succeeds, rather than assuming. `saf.rename()`'s JS-side return type
reflects this: it's the caller's job to start using the returned `url`,
not the one they called it with.

## What was and wasn't verified

This is Java that can only really run on
an actual Android device — there's no SAF, no `DocumentFile`, no real
`ContentResolver` in this sandbox. What *was* checked:

- The JS side (`src/fileSystem/backends/external.ts`) has real tests
  (`src/fileSystem/test/external.test.ts`) confirming it calls
  `cordova.exec` with the right service/action/argument shape for every
  method, against a mocked exec — not a guess, an actual assertion per
  action.
- The Java itself was written by cross-referencing Acode's own
  battle-tested `sdcard` plugin (same `DocumentFile`/`ContentResolver`
  APIs, same general shape) rather than reasoned about from scratch — see
  the top-level README's verification notes for specifics.

What wasn't (and can't be, here): actually compiling against the Android
SDK, or running the picker/read/write flow on a device. That's the next
step once you have Android Studio available.
