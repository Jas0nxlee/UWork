# Enterprise identity

Window-scoped Host owns the authenticated profile, login attempt and encrypted session. Renderer only projects revisioned views and sends commands. Local usage is always available without authentication. Old provider OAuth stays retired.

Adapter start/poll/restore responses are validated at the service boundary. Attempt generation is invalidated before cancellation/logout. Credential writes are serialized; late results cannot revive identity. Tokens never occur in views/events. Offline restore keeps encrypted data but cannot authenticate from an unverified cached name.

This release has no production adapter until the existing company's authentication API is supplied. Unconfigured is an explicit product state; no mock login exists in production. Local workspaces, history and API keys stay device-owned.
