# Enterprise identity

The shared encrypted IdentitySessionStore owns the device account under a cross-Host transaction lock. Window-scoped Hosts own login attempts and verified projections. Renderer only projects revisioned views and sends commands. Local usage is always available without authentication. Old provider OAuth stays retired.

Adapter start/poll/restore responses are validated at the service boundary. Cancellation requires the current attempt ID; missing or stale IDs have no effect on startup restore. Attempt generation is invalidated before valid cancellation/logout. Credential writes are serialized; late results cannot revive identity. Tokens never occur in views/events. Offline restore keeps encrypted data but cannot authenticate from an unverified cached name.

Native code redemption and polling have separate in-flight deduplication. A valid native callback claims redemption immediately; polling loses write/error ownership after that claim. Both paths retain generation and shared revision checks at credential commit.

Internal consumers can use `IdentitySessionStore.withCurrentSession(expectedRecord, operation)` to commit local effects under the same identity transaction as logout/switch. It checks revision and principal, permits token-only renewal, passes the current locked record to the callback, and rejects stale operations with `undefined`. Network IO stays outside this transaction. Provider writes, gateway metadata, and publication form an ordered local commit; a logout that owns the lock first invalidates it, while an already admitted commit completes before the logout tombstone.

Desktop loads public CorpID/AgentID and the HTTPS issuer from a local configuration file. The isolated WeCom embedded view redirects into a bound callback; Main forwards the authorization code, Host exchanges it at the existing issuer and keeps tokens private. Cross-window login/logout advance the shared revision; renewal uses a token conditional write and never broadcasts a renewal loop. A missing configuration is explicit; no mock login exists in production. Local workspaces, history and API keys stay device-owned.
