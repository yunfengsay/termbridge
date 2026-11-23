# TermBridge Domain Language

## Agent Registry

The Host-local catalog of Agent identities that Brain may start. Each entry has a stable `agentId`, a human name,
runtime, purpose, capabilities, and an optional default workspace. Commands remain private Host configuration and are
not part of the Agent Registry exposed to Brain or clients.

## Route Decision

A durable record of how Brain handled one user request: answer directly, continue an existing Agent, or dispatch a new
Agent. It records the chosen target, model-supplied reason and confidence when available, outcome, and authoritative
Host time. A Route Decision is observability data, not a second execution mechanism.

## Run

One delegated execution owned by an Agent. The current wire-compatible identifier is `taskId`; new lifecycle records
call it `runId`. TermBridge owns the Run lifecycle and result references, while the Agent owns any internal parallelism
or sub-agents.

## Run Event

An append-only authoritative transition for a Run: queued, dispatched, completed, or failed. Clients derive status,
completion time, and notifications from Run Events instead of independently inferring lifecycle facts.

## Deliverable

A validated, typed result reference produced by a Run. The initial vocabulary is preview, report, canvas, diff, file,
and link. A Deliverable may reference an HTTPS URL or a safe workspace-relative path plus the Run session; it never
contains arbitrary model-defined UI.

## Human Decision

The user's review or follow-up after a Run produces a Deliverable. Human Decision remains above Brain and Agent
execution; TermBridge shortens the path from intent to result but does not silently approve work on the user's behalf.

## Phone Action

One enumerated native operation requested through an authenticated app-level Phone Peer. The phone remains the consent
authority: its per-action policy may require the shared in-app confirmation page. Android runtime permissions are
managed ahead of time in Global Settings; an action with a missing permission fails explicitly instead of opening a
permission sheet. A system picker may still define exact user-selected input, and alarm creation may open the system
alarm UI. A Phone Action never accepts arbitrary Intents, shell commands, provider queries, or filesystem paths.

## Selected Asset

An opaque, short-lived handle for one photo explicitly returned by Android's system Photo Picker. It is scoped to one
Phone Action, carries bounded metadata and a content hash, expires after 24 hours, and does not imply access to any other
photo. A selection receipt is not an edit result.

## Execution Fork

One logical child orchestration branch created from a Global text turn or a completed Voice utterance. The Host seeds it
with the bounded authoritative conversation, Agent roster, task state, Memory, source Session, and Tool Catalog captured
for that request. Pi with Qwen3.8 Flash owns the branch, and its final answer rejoins the parent conversation. It is not
an operating-system process fork and it does not transfer tool ownership into the speech model.

## Tool Catalog

The public projection of the Host's one authoritative tool registry. Each entry exposes a stable name, user label,
description, category, execution mode, and approval class. Model schemas, Host execution, progress copy, and native UI
metadata derive from that same registration so text, Voice, Android, and iOS cannot drift into separate tool lists.

## Execution Event

An append-only, UI-safe fact emitted while an Execution Fork runs: fork/model/tool started, completed, or failed. It may
contain a bounded progress summary and tool identity, but never hidden model reasoning, credentials, raw commands, or
unbounded tool payloads. Clients group events by Fork and tool call into one compact live card.
