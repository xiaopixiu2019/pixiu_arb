# Credential storage

## Providers

The secure setup page offers two explicit providers:

- **OS keychain (recommended):** macOS Keychain, Windows Credential Manager, or a Linux Secret Service-compatible keyring through `@napi-rs/keyring`.
- **Local `.env`:** a gitignored plaintext fallback with owner-only `0600` permissions. It is never selected automatically when the keychain is available.

Each saved account has an isolated credential bundle containing only the Gate API key and secret. SQLite stores only the profile label, selected provider, active-profile pointer, and verification timestamps—not credentials. The `.env` fallback uses separate hashed variable names for additional profiles while retaining the original `GCT_GATE_API_KEY` and `GCT_GATE_API_SECRET` names for the default profile.

Docker cannot access the host keychain. Its explicit fallback is an owner-only `credentials.env` inside the configured persistent data volume. Identify the dedicated volume from the running container and the public [deployment guide](deployment.md), rather than an upstream default name.

## Secure entry flow

React opens `/secure/credentials` as a login-style account window but never renders credential fields itself. The backend-rendered account manager has no JavaScript, uses a restrictive content security policy, disables framing and caching, limits request size, and requires a short-lived one-use CSRF token. It can add, replace, delete, and switch saved accounts.

On submission, the backend:

1. validates local Host/Origin, CSRF, lengths, and characters;
2. locks trading and quiesces locally tracked orders before replacing credentials;
3. verifies the key with one signed `GET /api/v4/crossex/accounts` request;
4. stores the bundle only after successful verification;
5. writes secret-free metadata and an audit event;
6. rolls back the provider and metadata if a later step fails; and
7. makes the verified profile active and invalidates cached authenticated account state.

Account switching, deletion, and provider changes use the same lock, order-quiescence, verification, cache-invalidation, and rollback boundary. Persisted running strategies are paused during a successful credential change so they cannot resume against a different account. A full REST balance snapshot replaces the local balance set, so a venue/coin that is absent from the new account cannot survive from the previous one. Because the plaintext `.env` can be edited outside the app, authenticated portfolio, position, and balance caches are discarded at startup whenever that provider is active.

## Limitations

Managed claims or admission reservations block account switching and equivalent credential changes until responsibility is resolved. A KEEP-stopped task still owns nonzero holdings; stopping automation does not release its account boundary. See [managed positions](managed-positions.md).

OS keychains protect data at rest but not against malware running as the same logged-in user. `.env` is plaintext; filesystem permissions reduce accidental access but do not provide encryption. JavaScript strings cannot be reliably zeroized, so the backend minimizes credential lifetime and references without claiming memory-forensic resistance.
