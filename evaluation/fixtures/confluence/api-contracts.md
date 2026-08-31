# API Contract Coverage

SpecGraph understands API paths, operations, request bodies, response bodies, and named schemas. When a contract changes, documentation covering the same operation or schema may need review.

## Start an analysis run

`POST /analysis-runs` uses the `startAnalysisRun` operation. Its request body uses the `StartAnalysisRun` schema and requires `sourceGroupId`.

```json
{
  "sourceGroupId": "group_123"
}
```

The analysis should distinguish a change to one operation from unrelated endpoints in the same contract. A newly required request field should flag examples that omit it, while a response-only change should not flag unrelated request documentation.
