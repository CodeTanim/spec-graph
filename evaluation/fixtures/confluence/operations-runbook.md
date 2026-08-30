# Analysis Operations Runbook

Queued analysis is executed outside the original browser request. Temporary failures retry with increasing delays. Work stops after the configured attempt limit and records a terminal failure that an operator or user can safely retry.

Operational signals include queue age, job duration, retry count, source identity, and provider delivery identity. A run must never be completed by two workers at the same time.
