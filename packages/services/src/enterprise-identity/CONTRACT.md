# Enterprise identity

The shared encrypted IdentitySessionStore owns the device account under a cross-Host transaction lock. Window-scoped Hosts own login attempts and verified projections. Renderer only projects revisioned views and sends commands. Local usage is always available without authentication. Old provider OAuth stays retired.

Adapter start/poll/restore responses are validated at the service boundary. Attempt generation is invalidated before cancellation/logout. Credential writes are serialized; late results cannot revive identity. Tokens never occur in views/events. Offline restore keeps encrypted data but cannot authenticate from an unverified cached name.

Desktop loads public CorpID/AgentID and the HTTPS issuer from a local configuration file. The standard WeCom popup redirects into a bound callback; Main forwards the authorization code, Host exchanges it at the existing issuer and keeps tokens private. Cross-window login/logout advance the shared revision; renewal uses a token conditional write and never broadcasts a renewal loop. A missing configuration is explicit; no mock login exists in production. Local workspaces, history and API keys stay device-owned.
