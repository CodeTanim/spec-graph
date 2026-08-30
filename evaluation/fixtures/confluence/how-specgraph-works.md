# How SpecGraph Works

SpecGraph helps a team notice when a change in one source may leave a connected source out of date. It does not edit code or documentation. It presents reviewable suggestions with evidence so a person can decide what to do.

## Connected source groups

A source group contains the repository and documentation spaces that describe the same product. Every source is an equal member of the group. A team can start with documentation or a repository and connect more sources later.

## Keeping sources current

SpecGraph refreshes connected sources and indexes their current content. Automatic analysis runs on a daily cadence so a burst of edits becomes one understandable review. A person can also start an immediate check when they need an answer now.

## Change suggestions

The Changes view begins with what may need updating. Each suggestion names the potentially affected source and the source item that changed. The changed items, supporting evidence, and analysis explanation stay collapsed until someone asks for more detail.

## Evidence and confidence

Suggestions explain how the connection was found and show an exact supporting excerpt. Confidence describes how strongly the affected item is connected to the change. Unsupported evidence is rejected rather than shown to the user.

## Reviewing suggestions

A reviewer can resolve, dismiss, or reopen an individual suggestion. Bulk actions explicitly apply to every open suggestion for that change. Review decisions persist across reloads and repeated analysis of the same impact.

## Failure recovery

Automatic analysis retries temporary failures a limited number of times. A permanent failure is shown with a safe explanation and a retry action instead of remaining in a processing state forever.

## Source health

The Sources view shows whether each connection is ready, refreshing, disconnected, or needs attention. Refreshing a source fetches its latest content and then analyzes newly captured changes.
