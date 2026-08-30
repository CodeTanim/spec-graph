# Security and Access

Every signed-in person receives an isolated workspace. Repositories, documentation, runs, findings, and review actions are always resolved through that workspace.

Provider credentials remain on the server and are encrypted before durable storage. The browser receives source metadata and authorization state, never the provider token itself.

Incoming provider events must carry a valid signature. Repeated deliveries are recognized so the same event cannot create duplicate work. Manual checks and provider callbacks are bounded and authorized before data is read.
