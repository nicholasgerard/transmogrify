---
order: 2
anchor: why
label: Why it matters
number: '02'
title: Why visibility and exact ownership are the whole design
lede: >-
  Two properties decide whether a fleet of coding agents is operable or merely
  running. Everything else in Transmogrify follows from them.
module: prose
footnote: >-
  Both properties are enforced by the tools, not by convention. Routine
  lifecycle output carries no credentials, private paths, provider row dumps,
  or unrelated identifiers.
---

### Visibility is what makes a lane reviewable

A background process you cannot see is a process you cannot supervise.
Transmogrify creates first-class sessions under the exact name the operator
gave them. The current host-to-target matrix, dated native-surface observations,
and remaining compatibility gates are rendered from or linked to their
canonical repository records. The orchestrator does not hide the conversation
behind an unnamed terminal subprocess.

That also means a lane survives its operator. If the orchestrating session
exits mid-flight, the lane is still there, still named, still yours to inspect.

### Exact ownership is what makes automation safe

The dangerous move in fleet automation is the plausible match. A session with
the right name, in the right directory, started at about the right time, is
*probably* the one you meant. Transmogrify never takes that bet.

Before any provider mutation, it reserves the lane ID, operation ID, provider
target, intended name, input digest, and seat claim in a registry held outside
the repository and outside the Git common directory. Only then does the request
go out. Every later command re-resolves that exact record — and rechecks it
again immediately before anything destructive.

The same discipline governs failure. Outcomes are classified as **confirmed**,
**not delivered**, or **unknown**, and an unknown mutation is never replayed. A
spawn whose response was lost, a steer that may or may not have been queued, an
archive that may already have landed: each is reconciled by observing the
provider, not by trying again and hoping. The command line reports this
directly — exit `0` for a confirmed receipt, `2` for a safe refusal, `3` for a
provider, transport, or delivery-unknown failure that must be reconciled before
anything else happens.

Cleanup inherits it too. A worktree is removed only if it was clean when its
output was harvested, its HEAD has not moved, and it is still clean at the
moment of removal. Once a seat is observed dirty or changed, it is permanently
ineligible for automatic cleanup — later cleanliness does not restore it. The
seat waits for a human.
