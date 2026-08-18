---
name: dbeaver
description: List DBeaver connections and smoke-test the named one
---

1. Call `dbeaver__list_connections`.
2. If the user named a connection, call `dbeaver__test_connection` with that name. Otherwise test the first connection that has a password.
3. Report names, SSH hops, and whether the test succeeded. Never print passwords.
