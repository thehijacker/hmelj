# Vendored libraries

Third-party browser bundles, served from this instance rather than from a CDN. Only the
attachment viewer uses them (`public/js/attachmentViewer.js`), and only when a Word or
Excel attachment is actually opened — nothing here is loaded at boot, and none of it is in
the service worker's `SHELL` precache.

They are committed rather than pulled from cdnjs/jsDelivr at runtime for three reasons:

- an install reachable only over a LAN, or an offline one, must still be able to preview an
  attachment — the Android shell in particular usually points at a plain-http LAN address
  with no route to the public internet;
- opening an attachment should not become a request to somebody else's server, which is a
  reasonable thing to expect of a mail client you host yourself;
- cdnjs's newest SheetJS is 0.18.5, which carries CVE-2023-30533 (prototype pollution,
  fixed in 0.19.3). SheetJS stopped publishing to npm after 0.18.5, so the fixed releases
  exist only on `cdn.sheetjs.com`.

The version is part of each filename, so an upgrade changes the URL and can never be served
stale from a cache.

| File | Version | Licence | Used for |
|---|---|---|---|
| `jszip-3.10.1.min.js` | 3.10.1 | MIT (or GPLv3) | docx-preview's zip reader — a `.docx` is a zip |
| `docx-preview-0.4.0.min.js` | 0.4.0 | Apache-2.0 | `.docx` → HTML, with page layout, tables and embedded images |
| `xlsx-0.20.3.full.min.js` | 0.20.3 | Apache-2.0 | `.xlsx/.xlsm/.xlsb/.xls/.csv/.ods` parsing |

SheetJS is the **full** build, not `mini`: the mini build has no BIFF reader, which means no
legacy `.xls`.

## Refreshing them

```sh
cd public/vendor
curl -sL -o jszip-3.10.1.min.js         https://cdn.jsdelivr.net/npm/jszip@3.10.1/dist/jszip.min.js
curl -sL -o docx-preview-0.4.0.min.js   https://cdn.jsdelivr.net/npm/docx-preview@0.4.0/dist/docx-preview.min.js
curl -sL -o xlsx-0.20.3.full.min.js     https://cdn.sheetjs.com/xlsx-0.20.3/package/dist/xlsx.full.min.js
```

Bumping a version means renaming the file **and** the matching constant in
`public/js/attachmentViewer.js` (`VENDOR`), then bumping `VERSION` in `public/sw.js` so
installed clients pick up the changed viewer.
