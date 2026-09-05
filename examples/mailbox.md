# Lane mailbox: example

This file is an append-only durable record outside the repository. It is not a
message transport and does not expand the packet's authority.

## Directives

- `directive 001` — Re-read packet amendment 1 and run its exact
  `<acceptance-command>` before any optional refactor. Sender: operator. Timestamp: ISO-8601
  timestamp.

## Acknowledgments transcribed by the operator

- `ack 001` — Amendment 1 loaded; `<acceptance-command>` is running. Sender: lane.
  Timestamp: ISO-8601 timestamp. Provider receipt: exact owned lane and
  operation ID.

Keep the full durable text here and send the amendment text itself through
`steer` or boundary `recover --input`, citing `directive 001`. An external
mailbox path alone may be unreadable to a restricted child. The operator host owns writes to this file and transcribes the lane's
acknowledgment from the exact control receipt.
