HQ accepts an explicit, bounded notices configuration and passes it to the
agent-comms broker plugin. Ingestion stays disabled without it. Notice
custody and lease handling live in agent-bot-comms; this does not add a
member operation or change the legacy take_inbox compatibility path.

Refs #123.
