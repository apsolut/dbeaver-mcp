---
name: dbeaver
description: List DBeaver connections and smoke-test the named one
---

1. Call `dbeaver__list_connections`.
2. If the user named a connection, call `dbeaver__test_connection` with that name. Otherwise test the first connection that has a password.
3. Report names, SSH hops, and whether the test succeeded. Never print passwords.
4. For more than one SELECT, one `dbeaver__execute_query` is enough.
5. After a restore, `dbeaver__inspect_sequences` before serial inserts; `dbeaver__fix_sequences`
   (dry run first) to repair them.
6. If a tunnel fails with "Unknown SSH host key", call `dbeaver__trust_ssh_host`, show the
   fingerprint to the user, and only record it once **they** confirm it.
7. Destructive SQL needs `confirm: true`. State what will be destroyed and get agreement first.
