# 0.37.0 unification — archived legacy layout

This folder contains directories that lived under `.k2so/`
in the pre-0.37.0 (or transitional 0.36.x→0.37.0) layout.
The unification migration already moved active content to
the canonical post-0.37.0 paths:

- `.k2so/agent/AGENT.md`         — primary workspace agent
- `.k2so/agent-templates/<role>/`— role personas (delegate)
- `.k2so/heartbeats/<sched>/`    — workspace-level heartbeats

What's archived here:
- `agents/` — pre-0.37.0 multi-agent root (plural)
- `agent-heartbeats/` — heartbeats nested under the singular
`.k2so/agent/` directory in the half-state

Safe to delete once you've confirmed nothing important got
swept up. Created by k2so-daemon at boot.
