---
order: 1
anchor: what
label: What it is
number: '01'
title: What it is
lede: >-
  One skill, installed once, that lets Claude and Codex hand work to each other
  and watch it run.
module: features
features:
  - icon: arrows
    title: Works in both directions
    detail: >-
      Claude Code can hand a job to Codex, and Codex can hand one to Claude
      Code. The commands are the same either way.
  - icon: route
    title: Picks the right model
    detail: >-
      Say what the job needs and Transmogrify chooses the model, effort, and
      speed for it, or name the model yourself.
  - icon: branch
    title: One clone per job
    detail: >-
      Every job works in its own clone of your repository, so agents never
      edit the same files, and hands back a commit when it is done.
  - icon: eye
    title: Live in the app
    detail: >-
      Codex jobs show in the ChatGPT app once it is connected to the shared
      runtime; Claude jobs show in the Claude app, on your Mac and your phone.
  - icon: message
    title: Steer while it runs
    detail: >-
      Send a running job more instructions, stop it, or pick it up again
      later. It keeps going after the agent that started it is gone.
  - icon: archive
    title: Cleans up after itself
    detail: >-
      When a job finishes, the agent that started it is woken, collects the
      commit, and archives the job and its clone.
---

Install Transmogrify by pasting the prompt above into either Claude Code or
the ChatGPT desktop app. Once installed, it works in both apps automatically.

Use Transmogrify to easily hand off work between Claude and Codex. Invoke the
skill to create a job and send it to the model you want. Transmogrify knows
each model's strengths, effort levels, and sizes, so it can choose for you or
take the one you name. Bring your own rules for when to use which model, or
use the built-in guidance that routes each kind of work to the model best
suited for it.

Every job runs in its own clone of your repository and shows up in its app:
Codex jobs show up in the ChatGPT app once it is connected to Transmogrify's
runtime, and Claude jobs show up in the Claude app, on your Mac and your phone.
Watch a job work in real time, send it more instructions, and pick up the
commit it hands back. When it finishes, the agent that started it is woken,
collects the result, and archives the job and its clone.

A good way to work: make one agent the orchestrator and let it fan jobs out
across Codex and Claude as the work calls for it. Transmogrify needs no server,
account, or telemetry of its own; your Claude and ChatGPT accounts work as they
already do.
