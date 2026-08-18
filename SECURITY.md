# Security

This repo stores **no** database passwords, SSH passwords, connection URLs, or dumps.

## What stays on the user's machine

DBeaver Community keeps credentials in its workspace, typically:

- Windows: `%APPDATA%\DBeaverData\workspace6\General\.dbeaver\credentials-config.json`
- macOS: `~/Library/DBeaverData/workspace6/…`
- Linux: `~/.local/share/DBeaverData/workspace6/…`

This plugin decrypts that file **locally** and never writes secrets back to disk or into tool results. `list_connections` only returns `hasPassword` / `hasSshPassword`.

## What is in this repo

`src/decrypt.js` includes DBeaver Community's published AES key (`DefaultSecureStorage.LOCAL_KEY_CACHE` in the DBeaver source). That key is public by design. Anyone with filesystem access to a Community workspace can already read those passwords. DBeaver **EE / PRO** uses a different store; this plugin does not support that.

## Safe to publish

Yes. Clone the plugin, run `npm run setup` on each PC. That PC's own DBeaver connections are used. Do not commit a DBeaver workspace, `.env`, or SQL dumps into this repo.
